import { crc32, deflateSync } from "node:zlib";
import { createRouterClient } from "@orpc/server";
import type { AdapterContext, GeneratedMedia, MediaGenerationProvider } from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import { dozoAvatarImageBytes } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { DOZO_AVATAR_GENERATE_ERRORS } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import type * as Db from "@rakazo/db";
import type { TestSink } from "@rakazo/logging";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DozoAvatarGenerateWiring } from "./dozo-avatar-generate.js";
import {
  DOZO_AVATAR_GENERATE_PER_DAY,
  dozoAvatarGenerateRoutes,
  dozoAvatarGenerateWiring,
} from "./dozo-avatar-generate.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

// The lease takes a row with raw SQL, which a fake database answers with nothing; this one keeps
// the contract that matters here: one holder per key, and the next may start once it settles.
vi.mock("@rakazo/db", async (original) => {
  const db = await original<typeof Db>();
  const held = new Set<string>();
  return {
    ...db,
    withLease: async (
      _prisma: unknown,
      key: string,
      options: { signal?: AbortSignal },
      work: (lease: { key: string; fence: number; signal: AbortSignal }) => Promise<unknown>,
    ) => {
      options.signal?.throwIfAborted();
      if (held.has(key)) throw new db.LeaseHeldError(key);
      held.add(key);
      try {
        return await work({
          key,
          fence: 1,
          signal: options.signal ?? new AbortController().signal,
        });
      } finally {
        held.delete(key);
      }
    },
  };
});

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
/** Distinct enough that finding it anywhere it must not be is no accident. */
const SECRET = "zq-quiet-fox-wearing-a-moss-green-scarf";
const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "person@example.test",
  isDeploymentOwner: false,
};

/** A real PNG, wider than tall, so the square crop is seen. */
function wideImage(width = 64, height = 32) {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const frame = Buffer.alloc(4);
    frame.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([frame, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

/** A WebP's size from its header: lossy, lossless or extended. */
function webpSize(bytes: Uint8Array): [number, number] {
  const b = Buffer.from(bytes);
  const kind = b.toString("ascii", 12, 16);
  if (kind === "VP8 ") return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  if (kind === "VP8X") return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
  const bits = b.readUInt32LE(21);
  return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
}

type Setup = {
  provider?: Partial<Pick<MediaGenerationProvider, "capabilities">> | null;
  /** Usage records the person already has today. */
  used?: number;
  /** A server that bills, and what the person's organization pays with. */
  plan?: "free" | "paid" | "self-hosted";
  deadlineMs?: number;
};

const usageRows: Array<Record<string, unknown>> = [];
const count = vi.fn(async (_query: unknown) => 0);
const generateImage =
  vi.fn<(input: { prompt: string }, context: AdapterContext) => Promise<GeneratedMedia>>();
let sink: TestSink;

function prismaFor(plan: NonNullable<Setup["plan"]>) {
  const tx = {
    usageRecord: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        for (const row of data)
          if (!usageRows.some((kept) => kept.callId === row.callId)) usageRows.push(row);
        return { count: data.length };
      }),
    },
    modelCreditEntry: { findUnique: vi.fn(async () => null) },
  };
  return {
    usageRecord: { count },
    $transaction: async <T>(work: (client: typeof tx) => Promise<T>) => work(tx),
    space: { findUnique: vi.fn(async () => ({ organizationId: "org-1" })) },
    member: { findUnique: vi.fn(async () => (plan === "paid" ? { role: "owner" } : null)) },
    organization: {
      findUnique: vi.fn(async () => ({
        billing: { status: "active" },
        modelCredits: null,
        dozoPlanGrant: null,
      })),
    },
  };
}

function routes(setup: Setup = {}) {
  const plan = setup.plan ?? "self-hosted";
  count.mockResolvedValue(setup.used ?? 0);
  const provider =
    setup.provider === null
      ? undefined
      : ({
          id: "stub",
          capabilities: { images: true, video: false, offline: true },
          ...setup.provider,
          generateImage,
        } as unknown as MediaGenerationProvider);
  const wiring: DozoAvatarGenerateWiring = {
    mediaGeneration: provider,
    billingEnabled: plan !== "self-hosted",
  };
  const deps = {
    prisma: prismaFor(plan),
    ...dozoAvatarGenerateWiring(wiring),
  } as unknown as RouterDeps;
  return dozoAvatarGenerateRoutes(createRouterContext(deps), {
    now: () => NOW,
    deadlineMs: setup.deadlineMs,
  });
}

function caller(built = routes()) {
  return createRouterClient(built, { context: { actor } });
}

beforeEach(async () => {
  usageRows.length = 0;
  generateImage.mockReset().mockImplementation(async (_input, context) => {
    context.signal.throwIfAborted();
    return { mimeType: "image/png", bytes: wideImage() };
  });
  sink = createTestSink();
  installLogger(createLogger({ service: "rakazo-api", sinks: [sink] }));
});
afterEach(() => installLogger(createLogger({ service: "rakazo-api", level: "off", sinks: [] })));

/** What the caller, the logs and the usage rows hold: the description must be in none of them. */
function expectNoPromptAnywhere(...seen: unknown[]) {
  const everything = JSON.stringify([...seen, sink.events, usageRows]);
  expect(everything).not.toContain(SECRET);
}

describe("status", () => {
  it("is available on a server without billing, and counts today's own pictures", async () => {
    await expect(caller().dozoAvatarGenerate.status()).resolves.toEqual({
      available: true,
      reason: null,
    });
    expect(count).toHaveBeenCalledWith({
      where: {
        spaceId: "space-1",
        userId: "user-1",
        provider: "media",
        model: "avatar_image",
        createdAt: { gte: new Date(NOW - DAY_MS) },
      },
    });
  });

  it("is available to an organization that pays", async () => {
    await expect(caller(routes({ plan: "paid" })).dozoAvatarGenerate.status()).resolves.toEqual({
      available: true,
      reason: null,
    });
  });

  it("says unavailable without an image service, or one that draws no images", async () => {
    const none = { available: false, reason: "unavailable" };
    await expect(caller(routes({ provider: null })).dozoAvatarGenerate.status()).resolves.toEqual(
      none,
    );
    await expect(
      caller(
        routes({ provider: { capabilities: { images: false, video: true, offline: false } } }),
      ).dozoAvatarGenerate.status(),
    ).resolves.toEqual(none);
    // Not even a count is read for a server that cannot draw.
    expect(count).not.toHaveBeenCalled();
  });

  it("says plan on Free", async () => {
    await expect(caller(routes({ plan: "free" })).dozoAvatarGenerate.status()).resolves.toEqual({
      available: false,
      reason: "plan",
    });
  });

  it("says limit once today's allowance is used", async () => {
    const used = (n: number) => caller(routes({ used: n })).dozoAvatarGenerate.status();
    await expect(used(DOZO_AVATAR_GENERATE_PER_DAY - 1)).resolves.toMatchObject({
      available: true,
    });
    await expect(used(DOZO_AVATAR_GENERATE_PER_DAY)).resolves.toEqual({
      available: false,
      reason: "limit",
    });
  });

  it("is unavailable when the server was built without the wiring", async () => {
    const bare = dozoAvatarGenerateRoutes(
      createRouterContext({ prisma: prismaFor("free") } as unknown as RouterDeps),
    );
    await expect(caller(bare).dozoAvatarGenerate.status()).resolves.toEqual({
      available: false,
      reason: "unavailable",
    });
  });
});

describe("generate: refusals", () => {
  it.each([
    ["no image service", { provider: null }, "NOT_FOUND", DOZO_AVATAR_GENERATE_ERRORS.unavailable],
    ["Free", { plan: "free" as const }, "FORBIDDEN", DOZO_AVATAR_GENERATE_ERRORS.plan],
    [
      "today's allowance used",
      { used: DOZO_AVATAR_GENERATE_PER_DAY },
      "TOO_MANY_REQUESTS",
      DOZO_AVATAR_GENERATE_ERRORS.limit,
    ],
  ] satisfies Array<[string, Setup, string, string]>)(
    "refuses with %s before the image service is called",
    async (_name, setup, kind, code) => {
      const error = await caller(routes(setup))
        .dozoAvatarGenerate.generate({ prompt: SECRET })
        .catch((thrown: unknown) => thrown);
      expect(error).toMatchObject({ kind, code });
      expect(generateImage).not.toHaveBeenCalled();
      expect(usageRows).toEqual([]);
      expectNoPromptAnywhere(String((error as Error).message));
    },
  );

  it("refuses an empty, blank or oversized description before anything runs", async () => {
    for (const prompt of ["", "   ", "x".repeat(301)])
      await expect(caller().dozoAvatarGenerate.generate({ prompt })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe("generate: the image service goes wrong", () => {
  it("answers one general failure, records nothing and tells nothing of the description", async () => {
    generateImage.mockRejectedValue(new MediaGenerationError("authentication"));
    const error = await caller()
      .dozoAvatarGenerate.generate({ prompt: SECRET })
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({
      kind: "SERVICE_UNAVAILABLE",
      code: DOZO_AVATAR_GENERATE_ERRORS.failed,
    });
    // Neither the service's own reason nor a cause that could carry it goes with the answer.
    expect((error as Error).message).not.toMatch(/authentication|Media generation/i);
    expect((error as Error).cause).toBeUndefined();
    expect(usageRows).toEqual([]);
    expectNoPromptAnywhere((error as Error).message);
  });

  it("lets a failure that is not the image service's own propagate", async () => {
    generateImage.mockRejectedValue(new Error("a bug"));
    await expect(caller().dozoAvatarGenerate.generate({ prompt: "a fox" })).rejects.toThrow(
      "a bug",
    );
  });

  it("refuses a picture that is too large, or not a PNG, as a failure of the service", async () => {
    generateImage.mockResolvedValueOnce({
      mimeType: "image/png",
      bytes: new Uint8Array(10 * 1024 * 1024 + 1),
    });
    await expect(caller().dozoAvatarGenerate.generate({ prompt: SECRET })).rejects.toMatchObject({
      code: DOZO_AVATAR_GENERATE_ERRORS.failed,
    });
    generateImage.mockResolvedValueOnce({
      mimeType: "image/svg+xml" as "image/png",
      bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"),
    });
    await expect(caller().dozoAvatarGenerate.generate({ prompt: SECRET })).rejects.toMatchObject({
      code: DOZO_AVATAR_GENERATE_ERRORS.failed,
    });
    generateImage.mockResolvedValueOnce({ mimeType: "image/png", bytes: new Uint8Array() });
    await expect(caller().dozoAvatarGenerate.generate({ prompt: SECRET })).rejects.toMatchObject({
      code: DOZO_AVATAR_GENERATE_ERRORS.failed,
    });
    expectNoPromptAnywhere();
  });

  it.each([
    ["text", () => Buffer.from("this is not a picture")],
    [
      "an SVG with a script",
      () => Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"),
    ],
    ["a web page", () => Buffer.from("<html><body onload=alert(1)></body></html>")],
    ["only a PNG signature", () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])],
  ])("refuses %s named a PNG, as an upload of it would be", async (_name, bytes) => {
    generateImage.mockResolvedValueOnce({ mimeType: "image/png", bytes: bytes() });
    const error = await caller()
      .dozoAvatarGenerate.generate({ prompt: SECRET })
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ kind: "BAD_REQUEST", code: "avatar_image" });
    // The service ran and may have charged, so the picture counts even though it is not used.
    expect(usageRows).toHaveLength(1);
    expectNoPromptAnywhere((error as Error).message);
  });
});

describe("generate: one at a time", () => {
  it("calls the image service once for two at once, then lets the next one through", async () => {
    const held = deferred<GeneratedMedia>();
    generateImage.mockImplementationOnce(() => held.promise);
    const built = routes();
    const first = caller(built).dozoAvatarGenerate.generate({ prompt: "a fox" });
    await flush();
    await expect(
      caller(built).dozoAvatarGenerate.generate({ prompt: "a fox" }),
    ).rejects.toMatchObject({ kind: "CONFLICT", code: DOZO_AVATAR_GENERATE_ERRORS.busy });
    expect(generateImage).toHaveBeenCalledTimes(1);
    held.resolve({ mimeType: "image/png", bytes: wideImage() });
    await first;
    expect(usageRows).toHaveLength(1);

    await caller(built).dozoAvatarGenerate.generate({ prompt: "a fox" });
    expect(generateImage).toHaveBeenCalledTimes(2);
    expect(usageRows).toHaveLength(2);
  });

  it("does not hold up someone else", async () => {
    const held = deferred<GeneratedMedia>();
    generateImage.mockImplementationOnce(() => held.promise);
    const built = routes();
    const first = caller(built).dozoAvatarGenerate.generate({ prompt: "a fox" });
    await flush();
    const other = createRouterClient(built, { context: { actor: { ...actor, userId: "user-2" } } });
    await other.dozoAvatarGenerate.generate({ prompt: "an owl" });
    held.resolve({ mimeType: "image/png", bytes: wideImage() });
    await first;
    expect(generateImage).toHaveBeenCalledTimes(2);
  });

  it("lets a failed one be tried again at once", async () => {
    generateImage.mockRejectedValueOnce(new MediaGenerationError("provider_failure"));
    const built = routes();
    await expect(
      caller(built).dozoAvatarGenerate.generate({ prompt: "a fox" }),
    ).rejects.toMatchObject({ code: DOZO_AVATAR_GENERATE_ERRORS.failed });
    await expect(caller(built).dozoAvatarGenerate.generate({ prompt: "a fox" })).resolves.toEqual({
      image: expect.stringMatching(/^data:image\/webp;base64,/),
    });
  });
});

describe("generate: the caller leaves or the service is slow", () => {
  /** A service that works until its signal aborts, as a real one's request does. */
  function untilAborted() {
    generateImage.mockImplementationOnce(
      (_input, context) =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          });
        }),
    );
  }

  it("stops the image service when the caller disconnects, and records nothing", async () => {
    untilAborted();
    const built = routes();
    const leaving = new AbortController();
    const pending = createRouterClient(built, { context: { actor } }).dozoAvatarGenerate.generate(
      { prompt: SECRET },
      { signal: leaving.signal },
    );
    const outcome = pending.catch((thrown: unknown) => thrown);
    await flush();
    expect(generateImage).toHaveBeenCalledTimes(1);
    const { signal } = generateImage.mock.calls[0]![1];
    expect(signal.aborted).toBe(false);
    leaving.abort();
    const error = await outcome;
    expect(signal.aborted).toBe(true);
    expect(error).not.toMatchObject({ code: DOZO_AVATAR_GENERATE_ERRORS.failed });
    expect(usageRows).toEqual([]);
    expectNoPromptAnywhere((error as Error).message);
    // Nothing is held after it: the person can ask again.
    await expect(caller(built).dozoAvatarGenerate.generate({ prompt: "a fox" })).resolves.toEqual({
      image: expect.any(String),
    });
  });

  it("gives up on a slow image service with the general failure, and records nothing", async () => {
    untilAborted();
    const error = await caller(routes({ deadlineMs: 20 }))
      .dozoAvatarGenerate.generate({ prompt: SECRET })
      .catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({
      kind: "SERVICE_UNAVAILABLE",
      code: DOZO_AVATAR_GENERATE_ERRORS.failed,
    });
    expect(usageRows).toEqual([]);
    expectNoPromptAnywhere((error as Error).message);
  });
});

describe("generate: a picture", () => {
  it("comes back as the server's own square 256 px WebP, which an upload's checks accept", async () => {
    const { image } = await caller().dozoAvatarGenerate.generate({ prompt: "  a fox  " });
    expect(image.startsWith("data:image/webp;base64,")).toBe(true);
    const bytes = dozoAvatarImageBytes(image);
    expect(bytes).not.toBeNull();
    expect(webpSize(bytes!)).toEqual([256, 256]);
  });

  it("asks for a square picture of the description, and sends the call's scope", async () => {
    await caller().dozoAvatarGenerate.generate({ prompt: "  a fox  " });
    expect(generateImage).toHaveBeenCalledTimes(1);
    const [input, context] = generateImage.mock.calls[0]!;
    expect(input.prompt).toMatch(/^a fox\b/);
    expect(input.prompt).toMatch(/square/i);
    expect(input.prompt).toMatch(/cent(er|re)/i);
    expect(context).toMatchObject({ spaceId: "space-1", userId: "user-1" });
    expect(context.botId).toBeUndefined();
    expect(context.runId).toBeUndefined();
  });

  it("is recorded once in usage, as its own kind of generation, with no cost it does not know", async () => {
    await caller().dozoAvatarGenerate.generate({ prompt: SECRET });
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      provider: "media",
      model: "avatar_image",
      spaceId: "space-1",
      userId: "user-1",
      botId: undefined,
      runId: undefined,
      costUsd: null,
      inputTokens: null,
    });
    expect(String(usageRows[0]?.callId)).toMatch(/^media:avatar:/);
  });

  it("gives each picture its own usage record", async () => {
    const built = routes();
    await caller(built).dozoAvatarGenerate.generate({ prompt: "a fox" });
    await caller(built).dozoAvatarGenerate.generate({ prompt: "a fox" });
    expect(new Set(usageRows.map((row) => row.callId)).size).toBe(2);
  });

  it("keeps the description out of every log, answer and record", async () => {
    const answer = await caller().dozoAvatarGenerate.generate({ prompt: SECRET });
    expectNoPromptAnywhere(answer);
  });
});
