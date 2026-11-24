import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { GeneratedMedia } from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import { FakeMediaGenerationProvider } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { DOZO_AVATAR_GENERATE_ERRORS } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DOZO_AVATAR_GENERATE_PER_DAY,
  dozoAvatarGenerateRoutes,
  dozoAvatarGenerateWiring,
} from "./dozo-avatar-generate.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

const HOUR_MS = 60 * 60 * 1000;

// The limit's count and the one-at-a-time lease against a real database with row-level security,
// where the count crosses a person's Spaces, and in every session time zone the gate runs in.
describePostgres("drawing an avatar (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  const users: string[] = [];

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
  });

  afterAll(async () => {
    if (users.length) {
      await system.usageRecord.deleteMany({ where: { userId: { in: users } } });
      await system.organization.deleteMany({ where: { id: { in: users } } });
      await system.user.deleteMany({ where: { id: { in: users } } });
    }
    await db?.pool.end();
  });

  /** A person with their own organization and one Space. */
  async function person(): Promise<Actor> {
    const id = `avatar-generate-${randomUUID()}`;
    users.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name: "Ada", email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({ data: { id, name: "Personal", slug: id, createdAt } });
    await system.member.create({
      data: { id: `m-${id}`, organizationId: id, userId: id, role: "owner", createdAt },
    });
    return { ...(await space(id, id)), email: `${id}@example.test`, isDeploymentOwner: false };
  }

  /** Another Space in the person's organization. */
  async function space(organizationId: string, userId: string) {
    const spaceId = randomUUID();
    await system.space.create({
      data: { id: spaceId, organizationId, name: "Home", createdByUserId: userId },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId,
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    return { userId, spaceId };
  }

  function drawn(actor: Actor, more: { model?: string; provider?: string; ageMs?: number } = {}) {
    return system.usageRecord.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        provider: more.provider ?? "media",
        model: more.model ?? "avatar_image",
        callId: `media:avatar:${randomUUID()}`,
        createdAt: new Date(Date.now() - (more.ageMs ?? 0)),
      },
    });
  }

  const waitForRows = (actor: Actor, n: number) =>
    vi.waitFor(async () => expect(await ownRows(actor)).toHaveLength(n));

  const picture = (context: { signal: AbortSignal }) =>
    new FakeMediaGenerationProvider().generateImage({ prompt: "x" }, context as never);

  const ownRows = (actor: Actor) =>
    system.usageRecord.findMany({
      where: { userId: actor.userId, model: "avatar_image" },
    });

  function client(
    actor: Actor,
    options: {
      provider?: { generateImage: (input: never, context: never) => Promise<GeneratedMedia> };
    } = {},
  ) {
    const provider = Object.assign(new FakeMediaGenerationProvider(), options.provider);
    const ctx = createRouterContext({
      prisma,
      events: { notify: () => undefined, publishSpaceChange: () => undefined },
      env: {},
      ...dozoAvatarGenerateWiring({ mediaGeneration: provider }),
    } as unknown as RouterDeps);
    return createRouterClient(dozoAvatarGenerateRoutes(ctx), { context: { actor } })
      .dozoAvatarGenerate;
  }

  it("draws with the offline provider's picture and leaves exactly one usage record", async () => {
    const ada = await person();
    const { image } = await client(ada).generate({ prompt: "a fox" });
    expect(image.startsWith("data:image/webp;base64,")).toBe(true);
    const rows = await ownRows(ada);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      spaceId: ada.spaceId,
      provider: "media",
      model: "avatar_image",
      botId: null,
      runId: null,
      costUsd: null,
    });
    expect(rows[0]?.callId).toMatch(/^media:avatar:/);
    expect(Math.abs(Date.now() - rows[0]!.createdAt.getTime())).toBeLessThan(60_000);
  });

  it("counts a person's pictures across all their Spaces, in a sliding 24 hours", async () => {
    const ada = await person();
    const other = { ...ada, ...(await space(ada.userId, ada.userId)) };
    // 12 here, 8 in another Space, all inside the day: 20 together.
    for (let n = 0; n < 12; n++) await drawn(ada, { ageMs: n * HOUR_MS });
    for (let n = 0; n < 8; n++) await drawn(other, { ageMs: n * HOUR_MS });
    // Not counted: a day and a minute old, another model, another provider.
    await drawn(ada, { ageMs: 24 * HOUR_MS + 60_000 });
    await drawn(ada, { model: "generate_image" });
    await drawn(ada, { provider: "other" });
    // Counted from either Space the person asks in.
    for (const where of [ada, other])
      await expect(client(where).status()).resolves.toEqual({ available: false, reason: "limit" });
    await expect(client(ada).generate({ prompt: "a fox" })).rejects.toMatchObject({
      kind: "TOO_MANY_REQUESTS",
      code: DOZO_AVATAR_GENERATE_ERRORS.limit,
    });
  });

  it("lets a row age out of the window, and does not count anyone else's", async () => {
    const ada = await person();
    const bob = await person();
    for (let n = 0; n < DOZO_AVATAR_GENERATE_PER_DAY - 1; n++) await drawn(ada);
    // One just inside the day is the 20th, so the limit holds; ...
    await drawn(ada, { ageMs: 24 * HOUR_MS - 60_000 });
    await expect(client(ada).status()).resolves.toMatchObject({ reason: "limit" });
    // ... and it is not Bob's.
    await expect(client(bob).status()).resolves.toEqual({ available: true, reason: null });
  });

  it("counts a try that failed, one the service answered badly, and one cancelled", async () => {
    const ada = await person();
    const failing = {
      generateImage: async (): Promise<GeneratedMedia> => {
        throw new MediaGenerationError("provider_failure");
      },
    };
    await expect(
      client(ada, { provider: failing }).generate({ prompt: "a fox" }),
    ).rejects.toMatchObject({
      code: DOZO_AVATAR_GENERATE_ERRORS.failed,
    });
    const notAPicture = {
      generateImage: async (): Promise<GeneratedMedia> => ({
        mimeType: "image/png",
        bytes: new TextEncoder().encode("<svg><script/></svg>"),
      }),
    };
    await expect(
      client(ada, { provider: notAPicture }).generate({ prompt: "a fox" }),
    ).rejects.toMatchObject({
      code: "avatar_image",
    });
    const leaving = new AbortController();
    const slow = {
      generateImage: (_input: never, context: { signal: AbortSignal }) =>
        new Promise<GeneratedMedia>((_resolve, reject) =>
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          }),
        ),
    };
    const pending = client(ada, { provider: slow })
      .generate({ prompt: "a fox" }, { signal: leaving.signal })
      .catch((thrown: unknown) => thrown);
    await waitForRows(ada, 3);
    leaving.abort();
    await pending;
    expect(await ownRows(ada)).toHaveLength(3);
  });

  it("draws one at a time per person with the database's lease, and not for anyone else", async () => {
    const ada = await person();
    const bob = await person();
    const held = deferred<GeneratedMedia>();
    let calls = 0;
    const slow = {
      generateImage: async (_input: never, context: { signal: AbortSignal }) => {
        calls++;
        if (calls === 1) return held.promise;
        return picture(context);
      },
    };
    const first = client(ada, { provider: slow }).generate({ prompt: "a fox" });
    await waitForRows(ada, 1);
    await expect(
      client(ada, { provider: slow }).generate({ prompt: "a fox" }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
      code: DOZO_AVATAR_GENERATE_ERRORS.busy,
    });
    // The same person asking from another Space is still the same person.
    const elsewhere = { ...ada, ...(await space(ada.userId, ada.userId)) };
    await expect(
      client(elsewhere, { provider: slow }).generate({ prompt: "a fox" }),
    ).rejects.toMatchObject({
      code: DOZO_AVATAR_GENERATE_ERRORS.busy,
    });
    await client(bob, { provider: slow }).generate({ prompt: "an owl" });
    expect(calls).toBe(2);
    held.resolve(await picture({ signal: new AbortController().signal }));
    await first;
    await flush();
    // Released with the work: the next one goes through.
    await client(ada, { provider: slow }).generate({ prompt: "a fox" });
    expect(await ownRows(ada)).toHaveLength(2);
  });
});
