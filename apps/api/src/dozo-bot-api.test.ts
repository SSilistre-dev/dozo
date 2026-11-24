import { ORPCError, os } from "@orpc/server";
import type { Actor, ProductEvent } from "@rakazo/contracts";
import { currentDbContext } from "@rakazo/db";
import { Hono } from "hono";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DozoTokenCaller } from "./dozo-access-tokens.js";
import type { DozoBotApiClient, DozoBotApiContext, DozoBotApiDeps } from "./dozo-bot-api.js";
import {
  DOZO_BOT_API_ADDRESS_PER_MINUTE,
  DOZO_BOT_API_REQUESTS_PER_MINUTE,
  DOZO_BOT_API_SENDS_PER_MINUTE,
  DOZO_BOT_API_STREAMS_PER_TOKEN,
  DOZO_BOT_API_TOKEN_SENDS_PER_MINUTE,
  dozoBotApiDeps,
  dozoRouterConnector,
  mountDozoBotApi,
} from "./dozo-bot-api.js";
import { handleHttpError } from "./rpc-errors.js";

const spies = vi.hoisted(() => ({ authenticator: vi.fn(), touch: vi.fn(), take: vi.fn() }));
vi.mock("./dozo-access-tokens.js", () => ({ dozoTokenAuthenticator: () => spies.authenticator }));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  touchDozoAccessToken: spies.touch,
  takeDozoApiMinute: spies.take,
}));

import type * as Db from "@rakazo/db";

const TOKEN = `dozo_pat_${"a".repeat(43)}`;
const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};
const everyBot: DozoTokenCaller = { tokenId: "token-1", actor, botId: null };

function runEvent(type: ProductEvent["type"], seq: number, payload = {}): ProductEvent {
  return {
    id: `e-${seq}`,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq,
    type,
    runId: "run-1",
    createdAt: "2026-11-21T10:00:00.000Z",
    payload,
  };
}

/** One of bot-1's extra chats, as the app lists it to its member. */
const GARDEN = {
  id: "chat-1",
  botId: "bot-1",
  name: "Garden",
  createdAt: "2026-11-20T09:00:00.000Z",
  archivedAt: null as string | null,
  unread: true,
  snoozedUntil: null,
};

function fakeClient() {
  return {
    bots: {
      list: vi.fn(async () => [
        { id: "bot-1", name: "Chef", instructions: "secret instructions" },
        { id: "bot-2", name: "Scout", instructions: "" },
      ]),
    },
    threads: {
      head: vi.fn(async () => ({ threadId: "thread-1", cursor: 40 })),
      send: vi.fn(async () => ({ taskId: "task-1", runId: "run-1", seq: 41 })),
      messages: vi.fn(async () => ({
        threadId: "thread-1",
        olderCursor: 3 as number | null,
        messages: [
          {
            id: "m-1",
            threadId: "thread-1",
            seq: 4,
            role: "user",
            author: { id: "user-1", name: "Ada" },
            blocks: [{ kind: "text", text: "Plan dinner" }],
            createdAt: "2026-11-21T10:00:00.000Z",
          },
          {
            id: "m-2",
            threadId: "thread-1",
            seq: 5,
            role: "bot",
            botId: "bot-1",
            runId: "run-1",
            blocks: [{ kind: "text", text: "Pasta." }],
            createdAt: "2026-11-21T10:00:01.000Z",
          },
          {
            id: "m-3",
            threadId: "thread-1",
            seq: 6,
            role: "system",
            blocks: [{ kind: "text", text: "hidden" }],
            createdAt: "2026-11-21T10:00:02.000Z",
          },
        ],
      })),
      subscribe: vi.fn(async (_input: unknown, _options?: { signal?: AbortSignal }) =>
        (async function* () {
          yield runEvent("thread.progress", 42, { delta: "Pas" });
          yield runEvent("thread.message.created", 43, {
            messageId: "m-2",
            role: "bot",
            blocks: [{ kind: "text", text: "Pasta." }],
          });
          yield runEvent("run.completed", 44);
        })(),
      ),
    },
    dozoChatExport: {
      markdown: vi.fn(async () => ({ markdown: "# Chef\n", truncated: false })),
    },
    dozoChats: {
      // As the app lists one bot's chats for its member: open ones, oldest first.
      list: vi.fn(async (_input: { botId?: string }) => ({
        chats: [GARDEN],
      })),
    },
  };
}

let client: ReturnType<typeof fakeClient>;
let contexts: DozoBotApiContext[];
let runStatus: Mock<DozoBotApiDeps["runStatus"]>;
let authenticate: Mock<DozoBotApiDeps["authenticate"]>;
/** The bots the token's member made in the token's Space; the app may list others of the Space. */
let ownBotIds: Set<string>;
let ownsBot: Mock<DozoBotApiDeps["ownsBot"]>;
/** The shared per-minute counts, as Postgres would keep them for every instance. */
let minutes: Map<string, number>;
const take = (key: string, limit: number) => {
  const count = (minutes.get(key) ?? 0) + 1;
  if (count > limit) return Promise.resolve(false);
  minutes.set(key, count);
  return Promise.resolve(true);
};

function app(overrides: Partial<DozoBotApiDeps> = {}) {
  const hono = new Hono();
  hono.onError(handleHttpError);
  mountDozoBotApi(hono, {
    authenticate,
    connect: (context) => {
      contexts.push(context);
      return client as unknown as DozoBotApiClient;
    },
    runStatus,
    ownBots: async () => ownBotIds,
    ownsBot,
    touch: vi.fn(async () => undefined),
    take,
    clientIp: () => "203.0.113.5",
    ...overrides,
  });
  return hono;
}

const auth = { authorization: `Bearer ${TOKEN}` };
const call = (hono: Hono, path: string, init: RequestInit = {}) =>
  hono.request(`http://api.test/api/v1/dozo${path}`, {
    ...init,
    headers: { ...auth, ...(init.headers as Record<string, string>) },
  });
const send = (hono: Hono, body: unknown, headers: Record<string, string> = {}) =>
  call(hono, "/bots/bot-1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  minutes = new Map();
  ownBotIds = new Set(["bot-1", "bot-2"]);
  ownsBot = vi.fn<DozoBotApiDeps["ownsBot"]>(async (_caller, botId) => ownBotIds.has(botId));
  client = fakeClient();
  contexts = [];
  runStatus = vi.fn<DozoBotApiDeps["runStatus"]>(async () => "running");
  authenticate = vi.fn<DozoBotApiDeps["authenticate"]>(async (header) =>
    header === `Bearer ${TOKEN}` ? everyBot : null,
  );
});

describe("who may call", () => {
  it("answers 401 without a token, with a cookie only, or with the token in the address", async () => {
    const hono = app();
    const anonymous = await hono.request("http://api.test/api/v1/dozo/bots");
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
    expect(anonymous.headers.get("cache-control")).toBe("no-store");
    const cookie = await hono.request("http://api.test/api/v1/dozo/bots", {
      headers: { cookie: "better-auth.session_token=valid-session" },
    });
    expect(cookie.status).toBe(401);
    for (const query of [`?token=${TOKEN}`, `?access_token=${TOKEN}`]) {
      const inAddress = await hono.request(`http://api.test/api/v1/dozo/bots${query}`);
      expect(inAddress.status).toBe(401);
    }
    expect(client.bots.list).not.toHaveBeenCalled();
  });

  it("has no way to trust a marked bot again or to reach the app's settings", async () => {
    const hono = app();
    for (const path of ["/bots/bot-1/trust", "/tokens", "/bots/bot-1/settings"])
      expect((await call(hono, path, { method: "POST" })).status).toBe(404);
  });

  it("never echoes the token in an answer", async () => {
    authenticate.mockResolvedValue(null);
    const refused = await call(app(), "/bots");
    expect(await refused.text()).not.toContain(TOKEN);
  });

  it("runs the app's procedures as the token's member, checking the token again while open", async () => {
    const hono = app();
    expect((await call(hono, "/bots")).status).toBe(200);
    expect(contexts[0]!.actor).toBe(actor);
    expect(contexts[0]!.dozoAccessTokenId).toBe(everyBot.tokenId);
    expect(await contexts[0]!.stillAuthorized()).toBe(true);
    authenticate.mockResolvedValue(null);
    expect(await contexts[0]!.stillAuthorized()).toBe(false);
    authenticate.mockResolvedValue({ ...everyBot, tokenId: "token-2" });
    expect(await contexts[0]!.stillAuthorized()).toBe(false);
  });

  it("limits each token's requests a minute, counted for every instance together", async () => {
    const hono = app();
    for (let index = 0; index < DOZO_BOT_API_REQUESTS_PER_MINUTE; index++)
      expect((await call(hono, "/bots")).status).toBe(200);
    const limited = await call(hono, "/bots");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    // Another token is not held back, and a second instance shares the count.
    authenticate.mockResolvedValue({ ...everyBot, tokenId: "token-2" });
    expect((await call(hono, "/bots")).status).toBe(200);
    authenticate.mockResolvedValue(everyBot);
    expect((await call(app(), "/bots")).status).toBe(429);
  });

  it("counts an IPv6 caller by its /64, so rotating addresses inside it does not help", async () => {
    authenticate.mockResolvedValue(null);
    const hono = app({ clientIp: (c) => c.req.header("x-ip") });
    const from = (ip: string) => call(hono, "/bots", { headers: { "x-ip": ip } });
    for (let index = 0; index < DOZO_BOT_API_ADDRESS_PER_MINUTE; index++)
      expect((await from(`2001:db8:1:2::${(index + 1).toString(16)}`)).status).toBe(401);
    expect((await from("2001:db8:1:2:ffff::1")).status).toBe(429);
    expect((await from("2001:db8:9::1")).status).toBe(401);
  });

  it("holds an address back before looking up any more of its guesses", async () => {
    let now = 0;
    authenticate.mockResolvedValue(null);
    const hono = app({ now: () => now });
    for (let index = 0; index < DOZO_BOT_API_ADDRESS_PER_MINUTE; index++)
      expect((await call(hono, "/bots")).status).toBe(401);
    expect((await call(hono, "/bots")).status).toBe(429);
    expect(authenticate).toHaveBeenCalledTimes(DOZO_BOT_API_ADDRESS_PER_MINUTE);
    // Another address is not held back, and the minute passes.
    const other = app({ now: () => now, clientIp: () => "198.51.100.7" });
    expect((await call(other, "/bots")).status).toBe(401);
    // An address the server cannot tell is refused, so it never shares one window with others.
    const unknown = await call(app({ clientIp: () => undefined }), "/bots");
    expect(unknown.status).toBe(400);
    now += 61_000;
    expect((await call(hono, "/bots")).status).toBe(401);
  });

  it("marks the token used without waiting for it, and a failure there does not fail the call", async () => {
    const touch = vi.fn(async () => {
      throw new Error("database busy");
    });
    expect((await call(app({ touch }), "/bots")).status).toBe(200);
    expect(touch).toHaveBeenCalledWith("token-1");
  });
});

describe("a token limited to one bot", () => {
  beforeEach(() => {
    authenticate.mockResolvedValue({ ...everyBot, botId: "bot-1" });
  });

  it("lists only that bot, with no more than its id and name", async () => {
    const listed = await call(app(), "/bots");
    expect(await listed.json()).toEqual({ bots: [{ id: "bot-1", name: "Chef" }] });
  });

  it("answers any other bot as missing, without calling the app", async () => {
    const hono = app();
    const other = "/bots/bot-2";
    expect((await call(hono, `${other}/messages`)).status).toBe(404);
    expect((await call(hono, `${other}/export`)).status).toBe(404);
    expect((await call(hono, `${other}/runs/run-1/events`)).status).toBe(404);
    const sent = await call(hono, `${other}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(sent.status).toBe(404);
    expect(client.threads.send).not.toHaveBeenCalled();
    expect(client.threads.messages).not.toHaveBeenCalled();
    expect(client.dozoChatExport.markdown).not.toHaveBeenCalled();
  });
});

describe("a member of a shared Space", () => {
  // bot-2 is another member's: the app lists it to this member and lets them talk to it.
  beforeEach(() => {
    ownBotIds = new Set(["bot-1"]);
  });

  it("lists only the bots the token's member made", async () => {
    const listed = await call(app(), "/bots");
    expect(await listed.json()).toEqual({ bots: [{ id: "bot-1", name: "Chef" }] });
  });

  it("answers another member's bot exactly as a missing one, on every call, without calling the app", async () => {
    const hono = app();
    const answers = async (botId: string) => {
      const base = `/bots/${botId}`;
      const all = [
        await call(hono, `${base}/messages`),
        await call(hono, `${base}/chats`),
        await call(hono, `${base}/export`),
        await call(hono, `${base}/runs/run-1/events`),
        await call(hono, `${base}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({ text: "hi" }),
        }),
      ];
      return Promise.all(all.map(async (answer) => [answer.status, await answer.text()]));
    };
    const others = await answers("bot-2");
    expect(others).toEqual(await answers("bot-missing"));
    expect(others.every(([status]) => status === 404)).toBe(true);
    expect(ownsBot).toHaveBeenCalledWith(expect.objectContaining(everyBot), "bot-2");
    for (const procedure of [
      client.threads.send,
      client.threads.messages,
      client.threads.head,
      client.threads.subscribe,
      client.dozoChatExport.markdown,
      client.dozoChats.list,
    ])
      expect(procedure).not.toHaveBeenCalled();
    expect(minutes.has(`sends:token:${everyBot.tokenId}`)).toBe(false);
  });

  it("still reaches the member's own bot", async () => {
    const hono = app();
    expect((await call(hono, "/bots/bot-1/messages")).status).toBe(200);
    expect((await send(hono, { text: "hi" })).status).toBe(202);
    expect(client.threads.send).toHaveBeenCalledOnce();
  });
});

describe("sending a message", () => {
  it("limits each token's messages a minute, and the account's across all its tokens", async () => {
    const hono = app();
    const as = (tokenId: string) => authenticate.mockResolvedValue({ ...everyBot, tokenId });
    for (let index = 0; index < DOZO_BOT_API_TOKEN_SENDS_PER_MINUTE; index++)
      expect((await send(hono, { text: "hi" })).status).toBe(202);
    expect((await send(hono, { text: "hi" })).status).toBe(429);
    // Another token of the account still has room, up to the account's total.
    as("token-2");
    for (
      let index = 0;
      index < DOZO_BOT_API_SENDS_PER_MINUTE - DOZO_BOT_API_TOKEN_SENDS_PER_MINUTE;
      index++
    )
      expect((await send(hono, { text: "hi" })).status).toBe(202);
    as("token-3");
    expect((await send(hono, { text: "hi" })).status).toBe(429);
    expect(client.threads.send).toHaveBeenCalledTimes(DOZO_BOT_API_SENDS_PER_MINUTE);
  });

  it("refuses a stop word, which in the app stops every run in the chat", async () => {
    for (const text of ["stop", "STOP!", "dur"]) {
      const refused = await send(app(), { text });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "Stop a run in the app" });
    }
    expect(client.threads.send).not.toHaveBeenCalled();
  });

  it("sends through the app's own send and answers where the run starts", async () => {
    const sent = await send(app(), { text: "  Plan dinner " }, { "idempotency-key": "abc" });
    expect(sent.status).toBe(202);
    expect(await sent.json()).toEqual({ runId: "run-1", seq: 41 });
    expect(client.threads.send).toHaveBeenCalledWith({
      botId: "bot-1",
      text: "Plan dinner",
      clientNonce: "api:abc",
    });
  });

  it("streams the reply as server-sent events when asked", async () => {
    const sent = await send(app(), { text: "Plan dinner" }, { accept: "text/event-stream" });
    expect(sent.status).toBe(200);
    expect(sent.headers.get("content-type")).toContain("text/event-stream");
    expect(await sent.text()).toBe(
      [
        'id: 41\nevent: run\ndata: {"runId":"run-1","seq":41}\n\n',
        'id: 42\nevent: delta\ndata: {"text":"Pas"}\n\n',
        'id: 43\nevent: message\ndata: {"id":"m-2","text":"Pasta."}\n\n',
        'id: 44\nevent: status\ndata: {"status":"completed"}\n\n',
      ].join(""),
    );
    expect(client.threads.subscribe).toHaveBeenCalledWith(
      { botId: "bot-1", cursor: 41 },
      { signal: expect.any(AbortSignal) },
    );
    // Every message sent with a token is marked so, with a fresh nonce when no key was given.
    expect(client.threads.send).toHaveBeenCalledWith({
      botId: "bot-1",
      text: "Plan dinner",
      clientNonce: expect.stringMatching(/^api:[0-9a-f-]{36}$/),
    });
  });

  it("ends the call when the run stops for an approval, saying so", async () => {
    client.threads.subscribe.mockImplementation(async () =>
      (async function* () {
        yield runEvent("thread.progress", 42, { text: "Asking", activity: true });
        yield runEvent("run.waiting_input", 43);
        yield runEvent("thread.progress", 44, { delta: "after approval" });
      })(),
    );
    const text = await (
      await send(app(), { text: "Delete it" }, { accept: "text/event-stream" })
    ).text();
    expect(text).toContain('event: status\ndata: {"status":"waiting_input"}');
    expect(text).not.toContain("after approval");
  });

  it("gives a stream's place back when the send fails", async () => {
    client.threads.send.mockRejectedValue(new ORPCError("BAD_REQUEST", { message: "No model" }));
    const hono = app();
    for (let index = 0; index <= DOZO_BOT_API_STREAMS_PER_TOKEN; index++)
      expect((await send(hono, { text: "hi" }, { accept: "text/event-stream" })).status).toBe(400);
  });

  it("refuses an idempotency key too long to keep whole", async () => {
    const long = await send(app(), { text: "hi" }, { "idempotency-key": "k".repeat(191) });
    expect(long.status).toBe(400);
    expect(client.threads.send).not.toHaveBeenCalled();
  });

  it("refuses what is not a JSON message", async () => {
    const hono = app();
    const plain = await call(hono, "/bots/bot-1/messages", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: '{"text":"hi"}',
    });
    expect(plain.status).toBe(415);
    expect((await send(hono, "{not json")).status).toBe(400);
    expect((await send(hono, { text: "   " })).status).toBe(400);
    expect((await send(hono, { message: "hi" })).status).toBe(400);
    const huge = await send(hono, { text: "x".repeat(300 * 1024) });
    expect(huge.status).toBe(413);
    expect(client.threads.send).not.toHaveBeenCalled();
  });

  it("answers the app's refusal as its own status and message", async () => {
    client.threads.send.mockRejectedValue(
      new ORPCError("BAD_REQUEST", { message: "Connect a model first" }),
    );
    const refused = await send(app(), { text: "hi" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "Connect a model first" });

    client.threads.send.mockRejectedValue(
      new ORPCError("SERVICE_UNAVAILABLE", { message: "computer host 10.0.0.5 down" }),
    );
    const outage = await send(app(), { text: "hi" });
    expect(outage.status).toBe(503);
    expect(await outage.json()).toEqual({ error: "Try again later" });

    client.threads.send.mockRejectedValue(new Error("boom"));
    const broken = await send(app(), { text: "hi" });
    expect(broken.status).toBe(500);
    expect(await broken.text()).not.toContain("boom");
  });

  it("holds only a few streams open per token", async () => {
    client.threads.subscribe.mockImplementation(async (_input, options) =>
      (async function* () {
        yield runEvent("thread.progress", 42, { delta: "…" });
        await new Promise((resolve) => options?.signal?.addEventListener("abort", resolve));
      })(),
    );
    const hono = app();
    const open: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (let index = 0; index < DOZO_BOT_API_STREAMS_PER_TOKEN; index++) {
      const response = await send(hono, { text: "hi" }, { accept: "text/event-stream" });
      open.push(response.body!.getReader());
    }
    // Reading the first frame starts each stream.
    for (const reader of open) await reader.read();
    const refused = await send(hono, { text: "hi" }, { accept: "text/event-stream" });
    expect(refused.status).toBe(429);
    // The refused stream sent nothing, so a retry cannot send the message twice.
    expect(client.threads.send).toHaveBeenCalledTimes(DOZO_BOT_API_STREAMS_PER_TOKEN);
    await open[0]!.cancel();
    expect((await send(hono, { text: "hi" }, { accept: "text/event-stream" })).status).toBe(200);
  });
});

describe("following a run", () => {
  it("resumes after the last id the client saw", async () => {
    const followed = await call(app(), "/bots/bot-1/runs/run-1/events", {
      headers: { "last-event-id": "42" },
    });
    expect(followed.status).toBe(200);
    expect(runStatus).toHaveBeenCalledWith(actor, "thread-1", "run-1");
    expect(client.threads.subscribe).toHaveBeenCalledWith(
      { botId: "bot-1", cursor: 42 },
      { signal: expect.any(AbortSignal) },
    );
    expect(await followed.text()).toContain('"status":"completed"');
    await call(app(), "/bots/bot-1/runs/run-1/events?after=7");
    expect(client.threads.subscribe).toHaveBeenLastCalledWith(
      { botId: "bot-1", cursor: 7 },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("follows from now without a place to resume from, and settles a finished run at once", async () => {
    await (await call(app(), "/bots/bot-1/runs/run-1/events")).text();
    expect(client.threads.subscribe).toHaveBeenCalledWith(
      { botId: "bot-1", cursor: 40 },
      { signal: expect.any(AbortSignal) },
    );
    runStatus.mockResolvedValue("waiting_input");
    const settled = await call(app(), "/bots/bot-1/runs/run-1/events");
    expect(await settled.text()).toBe('event: status\ndata: {"status":"waiting_input"}\n\n');
    expect(client.threads.subscribe).toHaveBeenCalledTimes(1);
  });

  it("replays a settled run after the client's place, and answers at once from its end", async () => {
    runStatus.mockResolvedValue("completed");
    const replayed = await call(app(), "/bots/bot-1/runs/run-1/events", {
      headers: { "last-event-id": "30" },
    });
    expect(client.threads.subscribe).toHaveBeenCalledWith(
      { botId: "bot-1", cursor: 30 },
      { signal: expect.any(AbortSignal) },
    );
    expect(await replayed.text()).toContain('"status":"completed"');
    // An EventSource reconnects after the last frame: nothing is held open for it.
    const atEnd = await call(app(), "/bots/bot-1/runs/run-1/events", {
      headers: { "last-event-id": "44" },
    });
    expect(await atEnd.text()).toBe('event: status\ndata: {"status":"completed"}\n\n');
    expect(client.threads.subscribe).toHaveBeenCalledTimes(1);
  });

  it("answers a run outside the chat as missing and a bad place as a bad request", async () => {
    runStatus.mockResolvedValue(null);
    expect((await call(app(), "/bots/bot-1/runs/run-9/events")).status).toBe(404);
    runStatus.mockResolvedValue("running");
    expect((await call(app(), "/bots/bot-1/runs/run-1/events?after=x")).status).toBe(400);
    expect((await call(app(), "/bots/bot-1/runs/run-1/events?after=-2")).status).toBe(400);
  });
});

describe("reading the chat", () => {
  it("pages through messages as text, leaving out what the transcript hides", async () => {
    const page = await call(app(), "/bots/bot-1/messages?before=10");
    expect(client.threads.messages).toHaveBeenCalledWith({ botId: "bot-1", before: 10 });
    expect(await page.json()).toEqual({
      messages: [
        {
          id: "m-1",
          seq: 4,
          role: "user",
          author: "Ada",
          createdAt: "2026-11-21T10:00:00.000Z",
          text: "Plan dinner",
        },
        {
          id: "m-2",
          seq: 5,
          role: "bot",
          botId: "bot-1",
          runId: "run-1",
          createdAt: "2026-11-21T10:00:01.000Z",
          text: "Pasta.",
        },
      ],
      before: 3,
    });
    client.threads.messages.mockResolvedValue({
      threadId: "thread-1",
      olderCursor: null,
      messages: [],
    });
    expect(await (await call(app(), "/bots/bot-1/messages")).json()).toEqual({
      messages: [],
      before: null,
    });
    expect((await call(app(), "/bots/bot-1/messages?before=-1")).status).toBe(400);
    expect((await call(app(), "/bots/bot-1/messages?before=abc")).status).toBe(400);
  });

  it("exports the chat through the app's export", async () => {
    const exported = await call(
      app(),
      "/bots/bot-1/export?since=2026-11-01T00:00:00.000Z&timeZone=Europe/Istanbul",
    );
    expect(await exported.json()).toEqual({ markdown: "# Chef\n", truncated: false });
    expect(client.dozoChatExport.markdown).toHaveBeenCalledWith({
      botId: "bot-1",
      since: "2026-11-01T00:00:00.000Z",
      timeZone: "Europe/Istanbul",
    });
    expect((await call(app(), "/bots/bot-1/export?since=yesterday")).status).toBe(400);
  });
});

describe("a bot's other chats", () => {
  const inChat = { chatBotId: "bot-1", chatId: "chat-1" };

  it("lists the bot's open chats with no more than their id, name and start", async () => {
    const listed = await call(app(), "/bots/bot-1/chats");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      chats: [{ id: "chat-1", name: "Garden", createdAt: "2026-11-20T09:00:00.000Z" }],
    });
    expect(client.dozoChats.list).toHaveBeenCalledWith({ botId: "bot-1" });
  });

  it("leaves a chat out of the list if the app hands back an archived one or another bot's", async () => {
    client.dozoChats.list.mockResolvedValue({
      chats: [
        { ...GARDEN, archivedAt: "2026-11-21T00:00:00.000Z" },
        { ...GARDEN, id: "chat-9", botId: "bot-2" },
      ],
    });
    expect(await (await call(app(), "/bots/bot-1/chats")).json()).toEqual({ chats: [] });
    for (const chat of ["chat-1", "chat-9"])
      expect((await call(app(), `/bots/bot-1/messages?chat=${chat}`)).status).toBe(404);
  });

  it("keeps every call without a chat on the main chat, as before, without reading chats", async () => {
    const hono = app();
    await send(hono, { text: "hi" });
    await call(hono, "/bots/bot-1/messages");
    await call(hono, "/bots/bot-1/export");
    await (await call(hono, "/bots/bot-1/runs/run-1/events")).text();
    // Exactly the main chat's send, with no chat field beside it.
    expect(client.threads.send).toHaveBeenCalledWith({
      botId: "bot-1",
      text: "hi",
      clientNonce: expect.stringMatching(/^api:/),
    });
    expect(client.threads.messages).toHaveBeenCalledWith({ botId: "bot-1", before: undefined });
    expect(client.dozoChatExport.markdown).toHaveBeenCalledWith({ botId: "bot-1" });
    expect(client.threads.head).toHaveBeenCalledWith({ botId: "bot-1" });
    expect(client.dozoChats.list).not.toHaveBeenCalled();
  });

  it("sends, streams, reads, follows and exports in the chat named in the query", async () => {
    const hono = app();
    const sent = await call(hono, "/bots/bot-1/messages?chat=chat-1", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ text: "Sow tomatoes?" }),
    });
    expect(sent.status).toBe(200);
    expect(await sent.text()).toContain('"status":"completed"');
    expect(client.threads.send).toHaveBeenCalledWith({
      ...inChat,
      text: "Sow tomatoes?",
      clientNonce: expect.stringMatching(/^api:/),
    });
    expect(client.threads.subscribe).toHaveBeenCalledWith(
      { ...inChat, cursor: 41 },
      { signal: expect.any(AbortSignal) },
    );
    await call(hono, "/bots/bot-1/messages?chat=chat-1&before=9");
    expect(client.threads.messages).toHaveBeenCalledWith({ ...inChat, before: 9 });
    await call(hono, "/bots/bot-1/export?chat=chat-1&timeZone=UTC");
    expect(client.dozoChatExport.markdown).toHaveBeenCalledWith({ ...inChat, timeZone: "UTC" });
    client.threads.head.mockResolvedValue({ threadId: "chat-1", cursor: 40 });
    await (await call(hono, "/bots/bot-1/runs/run-1/events?chat=chat-1")).text();
    expect(client.threads.head).toHaveBeenCalledWith(inChat);
    expect(runStatus).toHaveBeenCalledWith(actor, "chat-1", "run-1");
    expect(client.threads.subscribe).toHaveBeenLastCalledWith(
      { ...inChat, cursor: 40 },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("answers any chat it cannot reach as the same 404, never acting on the main chat", async () => {
    const hono = app();
    // Another bot's chat, an archived one and one that does not exist are all left out of the
    // bot's open chats, so each is the same answer; so are an empty and an overlong id.
    for (const chat of ["chat-9", "chat-archived", "", "x".repeat(201)]) {
      const query = `?chat=${encodeURIComponent(chat)}`;
      const answers = [
        await call(hono, `/bots/bot-1/messages${query}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "hi" }),
        }),
        await call(hono, `/bots/bot-1/messages${query}`),
        await call(hono, `/bots/bot-1/export${query}`),
        await call(hono, `/bots/bot-1/runs/run-1/events${query}`),
      ];
      for (const answer of answers) {
        expect(answer.status).toBe(404);
        expect(await answer.json()).toEqual({ error: "Chat not found" });
        expect(answer.headers.get("cache-control")).toBe("no-store");
      }
    }
    expect(client.threads.send).not.toHaveBeenCalled();
    expect(client.threads.messages).not.toHaveBeenCalled();
    expect(client.threads.head).not.toHaveBeenCalled();
    expect(client.dozoChatExport.markdown).not.toHaveBeenCalled();
  });

  it("spends no message from the budget on a chat it cannot reach", async () => {
    const hono = app();
    for (let index = 0; index <= DOZO_BOT_API_TOKEN_SENDS_PER_MINUTE; index++)
      await call(hono, "/bots/bot-1/messages?chat=chat-9", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
    expect((await send(hono, { text: "hi" })).status).toBe(202);
  });

  it("refuses a chat named in the body, which the message would otherwise leave for the main chat", async () => {
    for (const field of ["chat", "chatId", "chat_id"]) {
      const refused = await send(app(), { text: "hi", [field]: "chat-1" });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "Name the chat in the query: ?chat=" });
    }
    expect(client.threads.send).not.toHaveBeenCalled();
  });

  it("answers another bot's chats as a missing bot for a token limited to one bot", async () => {
    authenticate.mockResolvedValue({ ...everyBot, botId: "bot-1" });
    const hono = app();
    expect((await call(hono, "/bots/bot-2/chats")).status).toBe(404);
    expect((await call(hono, "/bots/bot-2/messages?chat=chat-1")).status).toBe(404);
    expect(client.dozoChats.list).not.toHaveBeenCalled();
  });

  it("answers the app's own refusal to list a bot's chats as it is", async () => {
    client.dozoChats.list.mockRejectedValue(new ORPCError("NOT_FOUND", { message: "Not found" }));
    const refused = await call(app(), "/bots/bot-7/chats");
    expect(refused.status).toBe(404);
  });
});

describe("production wiring", () => {
  it("calls the router in process and translates its domain errors", async () => {
    const router = {
      bots: { list: os.handler(() => [{ id: "bot-1", name: "Chef" }]) },
      threads: {
        head: os.handler(() => {
          throw new (class extends Error {})("plain");
        }),
      },
    };
    const connect = dozoRouterConnector(
      router as unknown as Parameters<typeof dozoRouterConnector>[0],
    );
    const routed = connect({
      actor,
      dozoAccessTokenId: "token-1",
      signal: new AbortController().signal,
      stillAuthorized: async () => true,
    });
    expect(await routed.bots.list()).toEqual([{ id: "bot-1", name: "Chef" }]);
    await expect(routed.threads.head({ botId: "bot-1" })).rejects.toThrow();
  });

  it("reads a run in the member's chat and marks a token used as the system", async () => {
    const findFirst = vi.fn(async () => ({ status: "completed" }));
    const prisma = { run: { findFirst } } as unknown as Parameters<typeof dozoBotApiDeps>[0];
    const clientIp = () => "203.0.113.5";
    const deps = dozoBotApiDeps(prisma, {} as Parameters<typeof dozoBotApiDeps>[1], clientIp);
    expect(deps.clientIp).toBe(clientIp);
    spies.take.mockResolvedValue(true);
    expect(await deps.take("token:token-1", 60)).toBe(true);
    expect(spies.take).toHaveBeenCalledWith(prisma, "token:token-1", 60);
    expect(await deps.runStatus(actor, "thread-1", "run-1")).toBe("completed");
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "run-1", threadId: "thread-1", spaceId: "space-1" },
      select: { status: true },
    });
    findFirst.mockResolvedValue(null as never);
    expect(await deps.runStatus(actor, "thread-1", "run-2")).toBeNull();
    await deps.touch("token-1");
    expect(spies.touch).toHaveBeenCalledWith(prisma, "token-1");
    expect(deps.authenticate).toBe(spies.authenticator);
  });

  it("reaches only the member's own bots in the token's Space, read as the member", async () => {
    const contexts: unknown[] = [];
    const findMany = vi.fn(async () => {
      contexts.push(currentDbContext());
      return [{ id: "bot-1" }];
    });
    const findFirst = vi.fn(async () => ({ id: "bot-1" }) as { id: string } | null);
    const prisma = { bot: { findMany, findFirst } } as unknown as Parameters<
      typeof dozoBotApiDeps
    >[0];
    const deps = dozoBotApiDeps(prisma, {} as Parameters<typeof dozoBotApiDeps>[1], () => "x");
    const own = { spaceId: "space-1", userId: "user-1", archivedAt: null };
    expect([...(await deps.ownBots(everyBot))]).toEqual(["bot-1"]);
    expect(findMany).toHaveBeenCalledWith({ where: own, select: { id: true } });
    expect(contexts).toEqual([{ kind: "tenant", spaceId: "space-1", userId: "user-1" }]);
    expect(await deps.ownsBot(everyBot, "bot-1")).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: "bot-1", ...own },
      select: { id: true },
    });
    findFirst.mockResolvedValue(null);
    expect(await deps.ownsBot(everyBot, "bot-2")).toBe(false);
    // A token for one bot reaches no other, without a lookup.
    findFirst.mockClear();
    expect(await deps.ownsBot({ ...everyBot, botId: "bot-1" }, "bot-2")).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
