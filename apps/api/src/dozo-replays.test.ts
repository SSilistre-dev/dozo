import type { Actor } from "@rakazo/contracts";
import { DOZO_SHARE_LINK_API_PREFIX, stepScreenshotMimeType } from "@rakazo/contracts";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const adapters = vi.hoisted(() => ({
  hasSiteSessions: vi.fn((_kind: unknown) => true),
  listSiteSessions: vi.fn(async () => [{ site: "Shop.example.com" }]),
}));
vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hasSiteSessions: adapters.hasSiteSessions,
  listSiteSessions: adapters.listSiteSessions,
  toComputerRef: () => ({ id: "computer-1" }),
}));

import { dozoReplayKind, findOwnReply, replayFrame } from "./dozo-replay-kind.js";
import { replayFingerprint } from "./dozo-replay-steps.js";
import {
  dozoReplayRoutes,
  mountDozoReplayFrames,
  previewFrame,
  previewReplay,
  publishReplay,
  ReplayUnavailableError,
} from "./dozo-replays.js";
import type { RouterContext } from "./routes/context.js";

const actor = { userId: "user-1", spaceId: "space-1", email: "a@example.test" } as Actor;
const link = { userId: "user-1", spaceId: "space-1", targetId: "rep-1" };
const TOKEN = "A".repeat(43);
const PICTURE = new Uint8Array([1, 2, 3]);

function world() {
  const state = {
    message: {
      id: "m-1",
      threadId: "t-1",
      botId: "b-1",
      runId: "r-1",
      blocks: [
        {
          kind: "steps",
          steps: [
            { label: "Browser navigate", count: 1 },
            { label: "Browser snapshot", count: 1 },
          ],
        },
      ],
      toolHistory: JSON.stringify({
        steps: [
          {
            tool: "browser_navigate",
            calls: [{ arguments: '{"url":"https://shop.example.com/a?b=c"}' }],
          },
          { tool: "browser_snapshot", calls: [{ image: { artifactId: "art-1" } }] },
        ],
      }),
    } as Record<string, unknown> | null,
    thread: {
      botId: "b-1",
      userId: "user-1",
      groupId: null,
      helperBotId: null,
      externalConversationId: null,
    } as Record<string, unknown> | null,
    bot: { id: "b-1", userId: "user-1", computer: null as Record<string, unknown> | null } as Record<
      string,
      unknown
    > | null,
    run: { userId: "user-1", status: "completed" } as Record<string, unknown> | null,
    replay: {
      userId: "user-1",
      spaceId: "space-1",
      messageId: "m-1",
      steps: [
        { index: 0, frame: false },
        { index: 1, frame: true },
      ],
      fingerprint: replayFingerprint([
        { line: "Browser navigate · shop.example.com", stored: "Browser navigate" },
        { line: "Browser snapshot", stored: "Browser snapshot", frameArtifactId: "art-1" },
      ]),
    } as Record<string, unknown> | null,
    artifact: {
      storageKey: "key-1",
      mimeType: stepScreenshotMimeType("image/png"),
      spaceId: "space-1",
    } as Record<string, unknown> | null,
    shareRow: {
      id: "link-1",
      kind: "replay",
      targetId: "rep-1",
      createdAt: new Date("2026-11-01T00:00:00Z"),
      expiresAt: new Date("2026-11-08T00:00:00Z"),
      revokedAt: null,
    } as Record<string, unknown> | null,
    statements: [] as string[],
  };
  const sql = (strings: TemplateStringsArray) => strings.join("?").replace(/\s+/g, " ");
  const prisma = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const text = sql(strings);
      state.statements.push(text);
      if (text.includes("FROM dozo_share_links l JOIN"))
        return state.shareRow ? [state.shareRow] : [];
      if (text.includes("INSERT INTO dozo_share_links"))
        return state.shareRow ? [state.shareRow] : [];
      if (text.includes('"tokenHash" =')) return [{ ...link, kind: "replay" }];
      if (text.includes("FROM dozo_replays")) return state.replay ? [state.replay] : [];
      return [];
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
      state.statements.push(sql(strings));
      return 1;
    }),
    message: {
      findFirst: vi.fn(async () => state.message),
      findUnique: vi.fn(async () => state.message),
    },
    thread: { findFirst: vi.fn(async () => state.thread) },
    bot: { findFirst: vi.fn(async () => state.bot) },
    run: { findFirst: vi.fn(async () => state.run) },
    artifact: { findFirst: vi.fn(async () => state.artifact) },
    user: { findUnique: vi.fn(async () => ({ email: "a@example.test" })) },
  };
  const artifacts = { get: vi.fn(async () => PICTURE) };
  const deps = {
    prisma,
    artifacts,
    sandbox: {},
    env: { webOrigin: "https://app.example.test" },
  } as unknown as RouterContext["deps"];
  return { state, prisma: prisma as never, deps, artifacts };
}

beforeEach(() => {
  adapters.hasSiteSessions.mockClear();
  adapters.listSiteSessions.mockClear();
});

describe("findOwnReply", () => {
  it("finds a finished reply to the owner's own run in their own chat with their bot", async () => {
    const { prisma } = world();
    expect(await findOwnReply(prisma, actor, "m-1")).toMatchObject({ id: "m-1", botId: "b-1" });
  });

  it.each([
    ["no reply", (s: ReturnType<typeof world>["state"]) => (s.message = null)],
    ["a group chat", (s: ReturnType<typeof world>["state"]) => (s.thread!.groupId = "g-1")],
    ["another member's chat", (s: ReturnType<typeof world>["state"]) => (s.thread!.userId = "u-2")],
    ["another member's bot", (s: ReturnType<typeof world>["state"]) => (s.bot = null)],
    ["a run still going", (s: ReturnType<typeof world>["state"]) => (s.run!.status = "running")],
    ["another member's run", (s: ReturnType<typeof world>["state"]) => (s.run!.userId = "u-2")],
    ["a helper chat", (s: ReturnType<typeof world>["state"]) => (s.thread!.helperBotId = "b-2")],
    [
      "a chat app's conversation",
      (s: ReturnType<typeof world>["state"]) => (s.thread!.externalConversationId = "x-1"),
    ],
    [
      "a group message delivered into the chat",
      (s: ReturnType<typeof world>["state"]) =>
        (s.message!.blocks = [
          {
            kind: "channel_message",
            provider: "p",
            channelId: "c-1",
            fromAddress: "a",
            fromLabel: "A",
            text: "hi",
          },
        ]),
    ],
  ])("finds nothing for %s", async (_name, change) => {
    const { state, prisma } = world();
    change(state);
    expect(await findOwnReply(prisma, actor, "m-1")).toBeNull();
  });
});

describe("the replay kind", () => {
  it("lets its maker share while they still own the reply, and nobody else", async () => {
    const { state, prisma } = world();
    expect(await dozoReplayKind.canShare(prisma, actor, "rep-1")).toBe(true);
    expect(await dozoReplayKind.canShare(prisma, { ...actor, userId: "u-2" }, "rep-1")).toBe(false);
    state.bot = null;
    expect(await dozoReplayKind.canShare(prisma, actor, "rep-1")).toBe(false);
    state.replay = null;
    expect(await dozoReplayKind.canShare(prisma, actor, "rep-1")).toBe(false);
  });

  it("shows each kept step's line and numbers only the screenshots chosen", async () => {
    const { prisma } = world();
    expect(await dozoReplayKind.load(prisma, link)).toEqual({
      steps: [
        { line: "Browser navigate · shop.example.com", frame: null },
        { line: "Browser snapshot", frame: 0 },
      ],
    });
  });

  it("shows nothing once the replay or its reply is gone", async () => {
    const gone = world();
    gone.state.message = null;
    expect(await dozoReplayKind.load(gone.prisma, link)).toBeNull();
    gone.state.replay = null;
    expect(await dozoReplayKind.load(gone.prisma, link)).toBeNull();
  });

  it("shows nothing once the reply no longer matches what its owner reviewed", async () => {
    const { state, prisma } = world();
    state.message!.blocks = [
      {
        kind: "steps",
        steps: [
          { label: "Web search", count: 1 },
          { label: "Browser navigate", count: 1 },
          { label: "Browser snapshot", count: 1 },
        ],
      },
    ];
    expect(await dozoReplayKind.load(prisma, link)).toBeNull();
    expect(await replayFrame(prisma, link, 0)).toBeNull();
  });

  it("shows nothing for a stored selection it cannot read", async () => {
    const { state, prisma } = world();
    state.replay!.steps = "broken";
    expect(await dozoReplayKind.load(prisma, link)).toBeNull();
  });

  it("serves a chosen screenshot of the reply's own run only", async () => {
    const { state, prisma } = world();
    expect(await replayFrame(prisma, link, 0)).toMatchObject({ storageKey: "key-1" });
    expect(await replayFrame(prisma, link, 1)).toBeNull();
    state.artifact = { ...state.artifact, mimeType: "image/png" };
    expect(await replayFrame(prisma, link, 0)).toBeNull();
  });
});

describe("previewReplay", () => {
  const running = { providerRef: "p", state: "running", kind: "k" };

  it("shows each step with its screenshot and the reply's links, all kept with nothing sensitive", async () => {
    const { state, deps } = world();
    state.bot = { id: "b-1", userId: "user-1", computer: running };
    adapters.listSiteSessions.mockResolvedValueOnce([{ site: "other.com" }]);
    const preview = await previewReplay(deps, actor, "m-1");
    expect(preview.steps).toEqual([
      { line: "Browser navigate · shop.example.com", frame: false, sensitive: false },
      { line: "Browser snapshot", frame: true, sensitive: false },
    ]);
    expect(preview.links.map((row) => row.id)).toEqual(["link-1"]);
  });

  it("leaves the reply's screenshots out after a step on a site the bot is signed in to", async () => {
    const { state, deps } = world();
    state.bot = { id: "b-1", userId: "user-1", computer: running };
    const preview = await previewReplay(deps, actor, "m-1");
    expect(preview.steps.map((step) => step.sensitive)).toEqual([true, true]);
  });

  it.each([
    ["no computer", null],
    ["a stopped computer", { ...running, state: "stopped" }],
  ])(
    "takes the signed-in sites as unknown with %s, leaving the screenshots out",
    async (_n, computer) => {
      const { state, deps } = world();
      state.bot = { id: "b-1", userId: "user-1", computer };
      const preview = await previewReplay(deps, actor, "m-1");
      expect(preview.steps.map((step) => step.sensitive)).toEqual([true, true]);
      expect(adapters.listSiteSessions).not.toHaveBeenCalled();
    },
  );

  it("reads a step's screenshot on its own, and none for a step without one", async () => {
    const { deps } = world();
    const read = (index: number) => previewFrame(deps, actor, { messageId: "m-1", index });
    expect(await read(1)).toEqual({ frame: "data:image/png;base64,AQID" });
    expect(await read(0)).toEqual({ frame: null });
    expect(await read(9)).toEqual({ frame: null });
  });

  it("shows a step without its screenshot when the file is gone or is not a step screenshot", async () => {
    const gone = world();
    gone.artifacts.get.mockRejectedValueOnce(new Error("ENOENT"));
    expect(await previewFrame(gone.deps, actor, { messageId: "m-1", index: 1 })).toEqual({
      frame: null,
    });
    const other = world();
    other.state.artifact = { ...other.state.artifact, mimeType: "image/png" };
    expect(await previewFrame(other.deps, actor, { messageId: "m-1", index: 1 })).toEqual({
      frame: null,
    });
  });

  it("refuses another member a step's screenshot", async () => {
    const { deps } = world();
    await expect(
      previewFrame(deps, { ...actor, userId: "u-2" }, { messageId: "m-1", index: 1 }),
    ).rejects.toBeInstanceOf(ReplayUnavailableError);
  });

  it("refuses a reply without steps and a reply that is not the caller's", async () => {
    const empty = world();
    empty.state.message!.blocks = [{ kind: "text", text: "Hi" }];
    await expect(previewReplay(empty.deps, actor, "m-1")).rejects.toBeInstanceOf(
      ReplayUnavailableError,
    );
    const other = world();
    other.state.bot = null;
    await expect(previewReplay(other.deps, actor, "m-1")).rejects.toMatchObject({
      kind: "NOT_FOUND",
      code: "REPLAY_UNAVAILABLE",
    });
  });
});

describe("publishReplay", () => {
  it("keeps positions only, a screenshot only where the step has one", async () => {
    const { state, prisma } = world();
    const made = await publishReplay(prisma, actor, {
      messageId: "m-1",
      omit: [],
      frames: [0, 1],
      days: 7,
    });
    expect(made.link.id).toBe("link-1");
    expect(
      state.statements.find((text) => text.startsWith(" INSERT INTO dozo_replays")),
    ).toBeTruthy();
    const insert = (prisma as unknown as { $executeRaw: ReturnType<typeof vi.fn> }).$executeRaw.mock
      .calls[0]!;
    expect(insert).toContain('[{"index":0,"frame":false},{"index":1,"frame":true}]');
  });

  it("refuses leaving out every step, storing nothing", async () => {
    const { state, prisma } = world();
    await expect(
      publishReplay(prisma, actor, { messageId: "m-1", omit: [0, 1], frames: [], days: 7 }),
    ).rejects.toBeInstanceOf(ReplayUnavailableError);
    expect(state.statements).toEqual([]);
  });

  it("removes the replay again when its link cannot be made", async () => {
    const { state, prisma } = world();
    state.shareRow = null;
    await expect(
      publishReplay(prisma, actor, { messageId: "m-1", omit: [], frames: [], days: 7 }),
    ).rejects.toMatchObject({ code: "SHARE_LINK_LIMIT" });
    expect(state.statements.some((text) => text.includes("DELETE FROM dozo_replays"))).toBe(true);
  });
});

describe("procedures", () => {
  type Handler = (call: { context: { actor: Actor }; input?: unknown }) => Promise<unknown>;
  const routes = (deps: RouterContext["deps"]) => {
    const authed = new Proxy(
      {},
      { get: () => new Proxy({}, { get: () => ({ handler: (fn: Handler) => fn }) }) },
    );
    return dozoReplayRoutes({ deps, authed } as unknown as RouterContext)
      .dozoReplays as unknown as Record<"preview" | "frame" | "publish", Handler>;
  };

  it("previews and publishes, answering the link's web address", async () => {
    const { deps } = world();
    const preview = (await routes(deps).preview({
      context: { actor },
      input: { messageId: "m-1" },
    })) as {
      steps: unknown[];
    };
    expect(preview.steps).toHaveLength(2);
    expect(
      await routes(deps).frame({ context: { actor }, input: { messageId: "m-1", index: 1 } }),
    ).toEqual({ frame: "data:image/png;base64,AQID" });
    const made = (await routes(deps).publish({
      context: { actor },
      input: { messageId: "m-1", omit: [], frames: [], days: 7 },
    })) as { url: string };
    expect(made.url).toMatch(/^https:\/\/app\.example\.test\/s\/[A-Za-z0-9_-]{43}$/);
  });
});

describe("the frame route", () => {
  function app() {
    const w = world();
    const hono = new Hono();
    mountDozoReplayFrames(hono, w.prisma, () => "203.0.113.5", w.artifacts as never);
    return { ...w, hono };
  }
  const frame = (n: string) => `${DOZO_SHARE_LINK_API_PREFIX}${TOKEN}/frames/${n}`;

  it("serves a chosen screenshot as an image no page can run", async () => {
    const { hono } = app();
    const answer = await hono.request(frame("0"));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("image/png");
    expect(answer.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(new Uint8Array(await answer.arrayBuffer())).toEqual(PICTURE);
  });

  it("answers the same 404 when the stored file is gone", async () => {
    const { hono, artifacts } = app();
    artifacts.get.mockRejectedValueOnce(new Error("ENOENT"));
    expect((await hono.request(frame("0"))).status).toBe(404);
  });

  it("answers the same 404 for a frame not chosen and a number it cannot read", async () => {
    const { hono, prisma } = app();
    expect((await hono.request(frame("1"))).status).toBe(404);
    expect((await hono.request(frame("x"))).status).toBe(404);
    expect(
      (prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw,
    ).toHaveBeenCalled();
  });

  it("slows down one address reading too many frames", async () => {
    const { hono, state } = app();
    state.replay = null;
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await hono.request(frame("x"))).status;
    expect(last).toBe(429);
  });
});
