import { ORPCError } from "@orpc/server";
import type { DozoMcpOperations, DozoMcpOptions } from "@rakazo/adapters";
import type { Actor, ProductEvent, ThreadMessage } from "@rakazo/contracts";
import { ClientError, isDozoTokenNonce } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { currentDbContext } from "@rakazo/db";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DozoTokenCaller } from "./dozo-access-tokens.js";
import type { DozoBotApiContext } from "./dozo-bot-api.js";
import type { DozoMcpDeps } from "./dozo-mcp.js";
import {
  DOZO_MCP_MAX_BODY_BYTES,
  DOZO_MCP_METADATA_PATH,
  DOZO_MCP_PATH,
  dozoMcpDeps,
  dozoMcpOperations,
  mountDozoMcp,
} from "./dozo-mcp.js";

const spies = vi.hoisted(() => ({
  handle: vi.fn(),
  exportChat: vi.fn(),
  botApiDeps: vi.fn(),
}));
vi.mock("@rakazo/adapters", () => ({
  handleDozoMcpRequest: spies.handle,
  DOZO_MCP_CHAT_MAX_CHARS: 64_000,
  DOZO_MCP_REPLY_MAX_CHARS: 12,
}));
vi.mock("./dozo-chat-export.js", () => ({ exportChat: spies.exportChat }));
vi.mock("./dozo-bot-api.js", () => ({
  dozoBotApiDeps: spies.botApiDeps,
  DOZO_BOT_API_REQUESTS_PER_MINUTE: 60,
  DOZO_BOT_API_SENDS_PER_MINUTE: 20,
}));

const ORIGIN = "https://app.dozo.test";
const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};
const caller: DozoTokenCaller = { tokenId: "tok-1", actor, botId: null };

const findBot = vi.fn();
const findBots = vi.fn();
const prisma = { bot: { findFirst: findBot, findMany: findBots } } as unknown as PrismaClient;

let clock = 0;
function app(
  authenticate = vi.fn(async (authorization: string | undefined) =>
    authorization === "Bearer good" ? caller : null,
  ),
) {
  const hono = new Hono();
  const connect = vi.fn((_context: DozoBotApiContext) => ({}) as never);
  const touch = vi.fn(async () => undefined);
  const take = vi.fn(async (_key: string, _limit: number) => true);
  const deps: DozoMcpDeps = {
    prisma,
    authenticate,
    connect,
    touch,
    take,
    publicOrigin: ORIGIN,
    trustedOrigin: (origin) => origin === ORIGIN,
    clientIp: (c) => c.req.header("x-test-ip") ?? "203.0.113.7",
    version: "abc123",
    now: () => clock,
  };
  mountDozoMcp(hono, deps);
  return { hono, authenticate, connect, touch, take };
}

const post = (headers: Record<string, string> = {}, body = '{"jsonrpc":"2.0"}') =>
  new Request(`http://api.internal${DOZO_MCP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
const bearer = (token = "good") => ({ authorization: `Bearer ${token}` });

beforeEach(() => {
  vi.clearAllMocks();
  clock = 0;
  spies.handle.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
});

describe("the MCP endpoint's HTTP layer", () => {
  it("shares the Bot API's token check, in-process client and last-used mark", () => {
    const shared = {
      authenticate: vi.fn(),
      connect: vi.fn(),
      touch: vi.fn(),
      take: vi.fn(),
      runStatus: vi.fn(),
      clientIp: vi.fn(),
    };
    spies.botApiDeps.mockReturnValue(shared);
    const router = {} as Parameters<typeof dozoMcpDeps>[1];
    const options = {
      publicOrigin: ORIGIN,
      trustedOrigin: () => true,
      clientIp: () => undefined,
      version: "v",
    };
    expect(dozoMcpDeps(prisma, router, options)).toEqual({
      authenticate: shared.authenticate,
      connect: shared.connect,
      touch: shared.touch,
      take: shared.take,
      prisma,
      ...options,
    });
    expect(spies.botApiDeps).toHaveBeenCalledWith(prisma, router, options.clientIp);
  });

  it("publishes its protected resource metadata: its address and the header the token goes in", async () => {
    const response = await app().hono.request(DOZO_MCP_METADATA_PATH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: `${ORIGIN}${DOZO_MCP_PATH}`,
      bearer_methods_supported: ["header"],
    });
  });

  it("challenges a request without a token with where to learn how to get one", async () => {
    const { hono, authenticate } = app();
    const response = await hono.request(post());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}${DOZO_MCP_METADATA_PATH}"`,
    );
    expect(authenticate).not.toHaveBeenCalled();
    expect(spies.handle).not.toHaveBeenCalled();
  });

  it("refuses a token the store does not know, and stops looking up an address that keeps guessing", async () => {
    const { hono, authenticate } = app();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt++) {
      const response = await hono.request(post(bearer("guess")));
      statuses.push(response.status);
      if (attempt === 0)
        expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
    expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
    // The locked address's last attempt was not looked up, even with a real token.
    expect(authenticate).toHaveBeenCalledTimes(20);
    expect((await hono.request(post(bearer()))).status).toBe(429);
    // Another address is not slowed, and the window ends.
    expect(
      (await hono.request(post({ ...bearer("guess"), "x-test-ip": "198.51.100.2" }))).status,
    ).toBe(401);
    clock += 60_000;
    expect((await hono.request(post(bearer("guess")))).status).toBe(401);
  });

  it("refuses a web page from another site, and lets the app's own and non-browser clients in", async () => {
    const { hono } = app();
    const foreign = await hono.request(post({ ...bearer(), origin: "https://evil.example" }));
    expect(foreign.status).toBe(403);
    expect(spies.handle).not.toHaveBeenCalled();
    expect((await hono.request(post({ ...bearer(), origin: ORIGIN }))).status).toBe(200);
    expect((await hono.request(post(bearer()))).status).toBe(200);
  });

  it("refuses a body over the size limit before reading it", async () => {
    const response = await app().hono.request(
      post(bearer(), JSON.stringify({ text: "x".repeat(DOZO_MCP_MAX_BODY_BYTES) })),
    );
    expect(response.status).toBe(413);
    expect(spies.handle).not.toHaveBeenCalled();
  });

  it("counts a token's requests in the Bot API's budget, shared by every instance", async () => {
    const { hono, take } = app();
    expect((await hono.request(post(bearer()))).status).toBe(200);
    expect(take).toHaveBeenCalledWith("token:tok-1", 60);
    take.mockResolvedValueOnce(false);
    const limited = await hono.request(post(bearer()));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("acts as the token's member, marks the token used, and ends a wait when the token is revoked", async () => {
    const { hono, authenticate, connect, touch } = app();
    expect(await (await hono.request(post(bearer()))).json()).toEqual({ ok: true });
    const [request, , options] = spies.handle.mock.calls[0] as [Request, unknown, DozoMcpOptions];
    expect(request.method).toBe("POST");
    expect(options).toEqual({ version: "abc123" });
    expect(touch).toHaveBeenCalledWith("tok-1");
    const context = connect.mock.calls[0]?.[0] as DozoBotApiContext;
    expect(context.actor).toEqual(actor);
    await expect(context.stillAuthorized()).resolves.toBe(true);
    authenticate.mockResolvedValueOnce(null);
    await expect(context.stillAuthorized()).resolves.toBe(false);
  });

  it("counts a send in the account's message budget, shared with the Bot API", async () => {
    const { hono, take } = app();
    await hono.request(post(bearer()));
    const ops = spies.handle.mock.calls[0]?.[1] as DozoMcpOperations;
    findBot.mockResolvedValue({ id: "bot-1" });
    take.mockResolvedValueOnce(false);
    await expect(ops.sendMessage("bot-1", "hi", AbortSignal.abort())).rejects.toThrow(
      "Too many messages. Wait a minute.",
    );
    expect(take).toHaveBeenLastCalledWith("sends:user-1", 20);
  });
});

const event = (type: ProductEvent["type"], runId = "run-1"): ProductEvent => ({
  id: `e-${type}`,
  spaceId: "space-1",
  threadId: "thread-1",
  botId: "bot-1",
  seq: 5,
  type,
  runId,
  createdAt: "2026-11-21T10:00:00.000Z",
  payload: {},
});
const message = (role: "user" | "bot", text: string, runId = "run-1"): ThreadMessage => ({
  id: `m-${text}`,
  threadId: "thread-1",
  seq: 6,
  role,
  blocks: [{ kind: "text", text }],
  runId,
  createdAt: "2026-11-21T10:00:00.000Z",
});

async function* stream(...events: ProductEvent[]) {
  for (const item of events) yield item;
}

function fakeClient(events: AsyncGenerator<ProductEvent> | (() => never) = stream()) {
  return {
    bots: {
      list: vi.fn(async () => [
        { id: "bot-1", name: "Ada", description: "Reports", color: "x" },
        { id: "bot-2", name: "Someone else's", description: "" },
      ]),
    },
    threads: {
      send: vi.fn(async () => ({ taskId: "task-1", runId: "run-1", seq: 4 })),
      subscribe: vi.fn(async () => (typeof events === "function" ? events() : events)),
      messages: vi.fn(async () => ({
        threadId: "thread-1",
        olderCursor: null,
        messages: [
          message("user", "hi"),
          message("bot", "Hello"),
          message("bot", "from a peer run", "run-0"),
          message("bot", "there"),
        ],
      })),
    },
  };
}

function operations(
  client: ReturnType<typeof fakeClient>,
  countSend = vi.fn(async () => undefined),
  onlyBotId: string | null = null,
) {
  return dozoMcpOperations(prisma, actor, onlyBotId, client as never, countSend);
}

describe("what a token's owner may do", () => {
  it("lists only the bots the owner made, through the app's own list, read as the owner", async () => {
    const contexts: unknown[] = [];
    findBots.mockImplementation(async () => {
      contexts.push(currentDbContext());
      return [{ id: "bot-1" }];
    });
    const bots = await operations(fakeClient()).listBots();
    expect(bots).toEqual([{ id: "bot-1", name: "Ada", description: "Reports" }]);
    expect(findBots).toHaveBeenCalledWith({
      where: { spaceId: "space-1", userId: "user-1", archivedAt: null },
      select: { id: true },
    });
    expect(contexts).toEqual([{ kind: "tenant", spaceId: "space-1", userId: "user-1" }]);
  });

  it("reaches only the one bot a token for one bot names", async () => {
    findBots.mockResolvedValue([{ id: "bot-1" }]);
    findBot.mockResolvedValue({ id: "bot-1" });
    const client = fakeClient();
    const ops = operations(client, vi.fn(), "bot-1");
    await ops.listBots();
    expect(findBots).toHaveBeenCalledWith({
      where: { spaceId: "space-1", userId: "user-1", archivedAt: null, id: "bot-1" },
      select: { id: true },
    });
    await expect(ops.readChat("bot-2")).rejects.toThrow("No such bot.");
    expect(findBot).not.toHaveBeenCalled();
  });

  it("sends to an own bot and returns what the bot said in that run, within the size limit", async () => {
    findBot.mockResolvedValue({ id: "bot-1" });
    const client = fakeClient(
      stream(event("run.started"), event("run.completed", "run-0"), event("run.completed")),
    );
    const countSend = vi.fn();
    const signal = new AbortController().signal;
    const result = await operations(client, countSend).sendMessage("bot-1", "hi", signal);
    expect(result).toEqual({ status: "replied", reply: "Hello\n\nthere", truncated: false });
    expect(countSend).toHaveBeenCalledOnce();
    expect(client.threads.send).toHaveBeenCalledWith(
      { botId: "bot-1", text: "hi", clientNonce: expect.any(String) },
      { signal },
    );
    // The token mark the run's gate reads: never the owner's own word, asked before outside effects.
    const [{ clientNonce }] = client.threads.send.mock.calls[0] as unknown as [
      { clientNonce: string },
    ];
    expect(isDozoTokenNonce(clientNonce)).toBe(true);
    expect(client.threads.subscribe).toHaveBeenCalledWith(
      { botId: "bot-1", cursor: 4 },
      { signal: expect.any(AbortSignal) },
    );
    client.threads.messages.mockResolvedValueOnce({
      threadId: "thread-1",
      olderCursor: null,
      messages: [message("bot", "A reply longer than twelve")],
    });
    const long = await operations({
      ...client,
      threads: { ...client.threads, subscribe: vi.fn(async () => stream(event("run.completed"))) },
    }).sendMessage("bot-1", "hi", signal);
    expect(long).toEqual({ status: "replied", reply: "A reply long", truncated: true });
  });

  it.each([
    ["run.failed", "failed"],
    ["run.cancelled", "failed"],
    ["run.waiting_input", "waiting_for_you"],
    ["computer.takeover.requested", "waiting_for_you"],
  ] as const)("ends the wait on %s as %s, without reading a reply", async (type, status) => {
    findBot.mockResolvedValue({ id: "bot-1" });
    const client = fakeClient(stream(event(type)));
    const result = await operations(client).sendMessage(
      "bot-1",
      "hi",
      new AbortController().signal,
    );
    expect(result).toEqual({ status });
    expect(client.threads.messages).not.toHaveBeenCalled();
  });

  it("says the bot is still working when the wait ends first", async () => {
    findBot.mockResolvedValue({ id: "bot-1" });
    const ended = await operations(fakeClient(stream(event("run.started")))).sendMessage(
      "bot-1",
      "hi",
      new AbortController().signal,
    );
    expect(ended).toEqual({ status: "working" });
    const timedOut = await operations(
      fakeClient(() => {
        throw new Error("aborted");
      }),
    ).sendMessage("bot-1", "hi", AbortSignal.abort());
    expect(timedOut).toEqual({ status: "working" });
  });

  it("lets a broken stream fail as the server's error", async () => {
    findBot.mockResolvedValue({ id: "bot-1" });
    const client = fakeClient(() => {
      throw new Error("realtime down");
    });
    await expect(
      operations(client).sendMessage("bot-1", "hi", new AbortController().signal),
    ).rejects.toThrow("realtime down");
  });

  it("refuses a stop word, which in the app would stop every run in the chat", async () => {
    const client = fakeClient();
    await expect(
      operations(client).sendMessage("bot-1", "stop", new AbortController().signal),
    ).rejects.toThrow("Stop a run in the app.");
    expect(client.threads.send).not.toHaveBeenCalled();
  });

  it("refuses a bot the owner did not make before sending anything", async () => {
    findBot.mockResolvedValue(null);
    const client = fakeClient();
    const countSend = vi.fn();
    const ops = operations(client, countSend);
    await expect(ops.sendMessage("bot-2", "hi", new AbortController().signal)).rejects.toThrow(
      new ClientError("NOT_FOUND", "No such bot."),
    );
    await expect(ops.readChat("bot-2")).rejects.toThrow("No such bot.");
    expect(client.threads.send).not.toHaveBeenCalled();
    expect(countSend).not.toHaveBeenCalled();
    expect(spies.exportChat).not.toHaveBeenCalled();
    expect(findBot).toHaveBeenCalledWith({
      where: { id: "bot-2", spaceId: "space-1", userId: "user-1", archivedAt: null },
      select: { id: true },
    });
  });

  it("passes on the app's refusal of a send as one the client can act on, and hides the rest", async () => {
    findBot.mockResolvedValue({ id: "bot-1" });
    const client = fakeClient();
    const statuses = [
      [400, "BAD_REQUEST"],
      [403, "FORBIDDEN"],
      [404, "NOT_FOUND"],
      [409, "CONFLICT"],
      [429, "TOO_MANY_REQUESTS"],
    ] as const;
    for (const [status, kind] of statuses) {
      client.threads.send.mockRejectedValueOnce(
        new ORPCError("PLAN_LIMIT", { status, message: "Add a model first." }),
      );
      const refused = operations(client).sendMessage("bot-1", "hi", new AbortController().signal);
      await expect(refused).rejects.toBeInstanceOf(ClientError);
      await expect(refused).rejects.toMatchObject({ kind, message: "Add a model first." });
    }
    const failure = new ORPCError("INTERNAL_SERVER_ERROR", { status: 500 });
    client.threads.send.mockRejectedValueOnce(failure);
    await expect(
      operations(client).sendMessage("bot-1", "hi", new AbortController().signal),
    ).rejects.toBe(failure);
  });

  it("reads an own bot's chat through the export, with the resource's size limit", async () => {
    findBot.mockResolvedValue({ id: "bot-1" });
    spies.exportChat.mockResolvedValue({ markdown: "# Ada\n", truncated: false });
    await expect(operations(fakeClient()).readChat("bot-1")).resolves.toEqual({
      markdown: "# Ada\n",
    });
    expect(spies.exportChat).toHaveBeenCalledWith(prisma, actor, { botId: "bot-1" }, 64_000);
  });
});
