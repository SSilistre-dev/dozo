// Cross-tenant isolation beyond the RPC procedures: every raw HTTP route the app registers, the bot
// API and its MCP endpoint, the account export link, paired computers, live streams, and what the
// sign-in endpoints tell about an address. The world, canaries and snapshot are the RPC matrix's
// (dozo-isolation.test-support.ts); a canary in a foreign caller's answer, or a changed row of P or
// S, is a leak, and a leak stays red.
import { EmailEmulator } from "@rakazo/adapters";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IsolationWorld, Person, Target } from "./dozo-isolation.test-support.js";
import {
  buildIsolationWorld,
  canary,
  confirmIdentity,
  findCanaries,
  ISOLATION_LOGINS,
  joinWithInvite,
  ORIGIN,
  rawRpc,
  readAnswer,
  rpc,
  STREAM_READ_MS,
  sendAndWait,
  signup,
  snapshot,
  snapshotDiff,
  startIsolationApp,
} from "./dozo-isolation.test-support.js";
import {
  AUTH_ENDPOINT_EXEMPTIONS,
  HTTP_ROUTE_EXEMPTIONS,
} from "./dozo-isolation-http-exemptions.js";
import { asSystem } from "./system-db.js";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

/** apps/api/src/routes/shared.ts: a stream re-checks its session this often while it delivers. */
const SESSION_RECHECK_MS = 10_000;
/** apps/api/src/routes/shared.ts: an idle stream sends a heartbeat (and re-checks) after this. */
const HEARTBEAT_MS = 20_000;
const CONCURRENCY = 8;
const MCP_ACCEPT = "application/json, text/event-stream";

// --- HTTP ----------------------------------------------------------------------------------------

type Answer = { status: number; text: string };

/** A socket peer for the in-process request, so routes that limit per address can tell one. */
const peer = (n: number) => ({
  incoming: {
    socket: { remoteAddress: `198.51.100.${n}`, remotePort: 40_000, remoteFamily: "IPv4" },
  },
});

/** The answer as text, read for at most `ms`: a stream is cut there, as a client hanging up. */
async function readBody(response: Response, ms: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const hangUp = AbortSignal.timeout(ms);
  const cancel = () => void reader.cancel();
  hangUp.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
  } finally {
    hangUp.removeEventListener("abort", cancel);
  }
  return text;
}

async function send(
  world: IsolationWorld,
  path: string,
  init: RequestInit = {},
  from = 1,
  ms = STREAM_READ_MS,
): Promise<Answer> {
  const controller = new AbortController();
  const response = await world.handles.app.request(
    path,
    { ...init, signal: controller.signal },
    peer(from),
  );
  const text = await readBody(response, ms);
  controller.abort();
  return { status: response.status, text };
}

const json = (body: unknown) => ({
  "content-type": "application/json",
  body: JSON.stringify(body),
});

async function pool<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

/** A stream read in the background until it ends or is stopped. */
function follow(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const state = { text: "", endedAt: 0, frames: [] as { at: number; text: string }[] };
  const done = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const text = decoder.decode(next.value, { stream: true });
      state.text += text;
      state.frames.push({ at: Date.now(), text });
    }
    state.endedAt = Date.now();
  })();
  return {
    state,
    done,
    async stop() {
      await reader.cancel();
      await done;
    },
  };
}

async function openStream(
  world: IsolationWorld,
  cookie: string,
  procedure: string,
  input: unknown,
  spaceId: string,
) {
  const controller = new AbortController();
  const response = await rawRpc(world.app, cookie, procedure, input, spaceId, controller.signal);
  expect(response.status, `${procedure} opened`).toBe(200);
  const stream = follow(response);
  return {
    state: stream.state,
    done: stream.done,
    async stop() {
      controller.abort();
      await stream.stop();
    },
  };
}

// --- Routes --------------------------------------------------------------------------------------

type RouteEntry = { method: string; path: string; handler: { length: number } };

/**
 * The routes the app answers itself, as `METHOD /path`: middleware (a handler that takes `next`)
 * is left out, as Hono's own route inspector does, and so is `/rpc/*`, which the RPC matrix covers.
 */
function rawRoutes(world: IsolationWorld): string[] {
  const routes = (world.handles.app as unknown as { routes: RouteEntry[] }).routes;
  return [
    ...new Set(
      routes
        .filter((route) => route.handler.length < 2 && !route.path.startsWith("/rpc/"))
        .map((route) => `${route.method} ${route.path}`),
    ),
  ].sort();
}

/**
 * Auth endpoints called one by one: the session, account and Space readers, and the ones that take
 * an id a foreign caller could swap in. `{org}`, `{account}` and `{session}` become the target's.
 */
const AUTH_ENDPOINTS: { method: "GET" | "POST"; path: string; body?: Record<string, string> }[] = [
  { method: "GET", path: "/api/auth/get-session" },
  { method: "GET", path: "/api/auth/list-sessions" },
  { method: "GET", path: "/api/auth/list-accounts" },
  { method: "GET", path: "/api/auth/account-info?accountId={account}" },
  { method: "GET", path: "/api/auth/account-security" },
  { method: "GET", path: "/api/auth/passkey/list-user-passkeys" },
  { method: "GET", path: "/api/auth/organization/list" },
  { method: "GET", path: "/api/auth/organization/get-full-organization?organizationId={org}" },
  { method: "GET", path: "/api/auth/organization/list-members?organizationId={org}" },
  { method: "GET", path: "/api/auth/organization/get-active-member" },
  { method: "GET", path: "/api/auth/dozo/email-link?v={account}" },
  { method: "GET", path: "/api/auth/dozo/hosted-login/keys" },
  { method: "POST", path: "/api/auth/organization/set-active", body: { organizationId: "{org}" } },
  {
    method: "POST",
    path: "/api/auth/organization/remove-member",
    body: { memberIdOrEmail: "{owner}", organizationId: "{org}" },
  },
  {
    method: "POST",
    path: "/api/auth/unlink-account",
    body: { providerId: "credential", accountId: "{account}" },
  },
  { method: "POST", path: "/api/auth/revoke-session", body: { token: "{session}" } },
  { method: "POST", path: "/api/auth/passkey/delete-passkey", body: { id: "{account}" } },
  { method: "POST", path: "/api/auth/request-identity-code" },
];

type HttpCaller = { name: string; headers: Record<string, string>; from: number };
type HttpCall = { caller: HttpCaller; route: string; method: string; url: string; body?: string };
type TargetIds = Target["ids"] & { deviceId?: string; accountId?: string; session?: string };

/** One request per method a route answers, every id in it the target's. */
function requestsFor(
  route: string,
  ids: TargetIds,
): { method: string; url: string; body?: string }[] {
  const [method = "", path = ""] = route.split(" ");
  const param: Record<string, string | undefined> = {
    botId: ids.botId,
    runId: ids.runId,
    deviceId: ids.deviceId,
    token: ids.pageId,
    file: ids.artifactId,
    surface: "web",
    provider: "fake",
  };
  const url = path
    .replace(/:(\w+)/g, (_match, name: string) => param[name] ?? ids.botId ?? "x")
    .replace(/\*/g, ids.botId ?? "x");
  const query = new URLSearchParams({
    botId: ids.botId ?? "",
    chat: ids.chatId ?? "",
    chatId: ids.chatId ?? "",
    spaceId: ids.spaceId ?? "",
    organizationId: ids.organizationId ?? "",
    token: ids.pageId ?? "",
    after: "-1",
  });
  const body = JSON.stringify({
    botId: ids.botId,
    chatId: ids.chatId,
    threadId: ids.threadId,
    runId: ids.runId,
    spaceId: ids.spaceId,
    organizationId: ids.organizationId,
    userId: ids.ownerUserId,
    deviceId: ids.deviceId,
    artifactId: ids.artifactId,
    text: "iso-probe",
  });
  const methods = method === "ALL" ? ["GET", "POST"] : [method];
  return methods.map((each) => ({
    method: each,
    url: `${url}?${query}`,
    ...(each === "GET" || each === "HEAD" ? {} : { body }),
  }));
}

function authRequests(ids: TargetIds) {
  const fill = (text: string) =>
    text
      .replace("{org}", ids.organizationId ?? "")
      .replace("{account}", ids.accountId ?? "")
      .replace("{owner}", ids.ownerUserId ?? "")
      .replace("{session}", ids.session ?? "");
  return AUTH_ENDPOINTS.map((endpoint) => ({
    route: `${endpoint.method} ${endpoint.path.split("?")[0]}`,
    method: endpoint.method,
    url: fill(endpoint.path),
    ...(endpoint.method === "POST" ? { body: fill(JSON.stringify(endpoint.body ?? {})) } : {}),
  }));
}

/** Path words a route serving a file, picture or attachment would carry. */
const FILE_ROUTE = /artifact|attachment|avatar|logo|upload|download|file|media|image|picture/i;
/** File routes reviewed: the plugin catalog's own pictures, the same for every caller. */
const REVIEWED_FILE_ROUTES = ["GET /api/dozo/catalog-images/:file"];

// --- Sign-in answers -------------------------------------------------------------------------------

/** What an answer looks like without its values: status and the JSON's keys and value types. */
function shape(answer: Answer): string {
  const outline = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(outline);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, outline(item)]),
      );
    return typeof value;
  };
  let body: unknown = answer.text;
  try {
    body = outline(JSON.parse(answer.text));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return JSON.stringify({ status: answer.status, body });
}

describeWithDatabase.each(ISOLATION_LOGINS)(
  "cross-tenant isolation over raw HTTP routes, tokens and live streams ($name)",
  (login) => {
    let world: IsolationWorld;
    const tokens = {} as Record<
      "routesBound" | "routesAll" | "apiBound" | "apiAll" | "mcpAll" | "aInS" | "aInP",
      string
    >;
    const devices = {} as {
      aId: string;
      aToken: string;
      aName: string;
      bId: string;
      bToken: string;
    };
    const extra = {} as { accountId: string; session: string };

    const scopeOf = (...targets: Target[]) => ({
      spaceIds: targets.map((target) => target.spaceId),
      organizationIds: [...new Set(targets.map((target) => target.organizationId))],
      userIds: [world.A.userId],
    });

    const createToken = async (who: Person, spaceId: string, botId?: string) => {
      await confirmIdentity(world.app, who.cookie);
      const made = await rpc<{ token: string }>(
        world,
        who.cookie,
        "dozoAccessTokens/create",
        {
          name: `iso-${who.label.toLowerCase()}-${botId ? "bot" : "all"}`,
          ...(botId ? { botId } : {}),
        },
        spaceId,
      );
      return made.token;
    };

    const pair = async (who: Person, name: string) => {
      const answer = await send(world, "/api/devices/pair", {
        method: "POST",
        headers: { cookie: who.cookie, origin: ORIGIN, ...json({}) },
        body: JSON.stringify({ name, platform: "linux" }),
      });
      expect(answer.status, answer.text).toBe(201);
      return JSON.parse(answer.text) as { deviceId: string; token: string };
    };

    beforeAll(async () => {
      world = await buildIsolationWorld(login.url());
      const { A, B, P, S, Bown } = world;
      tokens.routesBound = await createToken(B, B.spaceId, Bown.ids.botId);
      tokens.routesAll = await createToken(B, B.spaceId);
      tokens.apiBound = await createToken(B, B.spaceId, Bown.ids.botId);
      tokens.apiAll = await createToken(B, B.spaceId);
      tokens.mcpAll = await createToken(B, B.spaceId);
      tokens.aInS = await createToken(A, S.spaceId, S.ids.botId);
      tokens.aInP = await createToken(A, P.spaceId);
      // A's computer through the real pairing route, as the desktop app pairs one.
      devices.aName = canary("A", "device");
      const aDevice = await pair(A, devices.aName);
      const bDevice = await pair(B, "iso-b-device");
      Object.assign(devices, {
        aId: aDevice.deviceId,
        aToken: aDevice.token,
        bId: bDevice.deviceId,
        bToken: bDevice.token,
      });
      const account = await world.db.account.findFirstOrThrow({ where: { userId: A.userId } });
      const session = await world.db.session.findFirstOrThrow({ where: { userId: A.userId } });
      Object.assign(extra, { accountId: account.accountId, session: session.token });
    }, 240_000);

    afterAll(async () => {
      await world?.stop();
    });

    it("the bot API answers B's tokens on A's bots, chats and runs as missing", async () => {
      const { A, P, S, Bown } = world;
      const own = Bown.ids.botId!;
      const before = await snapshot(world.db, scopeOf(P, S));
      const api = (token: string, path: string, init: RequestInit = {}, ms?: number) =>
        send(
          world,
          `/api/v1/dozo${path}`,
          { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } },
          21,
          ms,
        );
      const post = (token: string, path: string) =>
        api(token, path, {
          method: "POST",
          headers: json({}),
          body: JSON.stringify({ text: "iso-probe" }),
        });
      const problems: string[] = [];
      const expectMissing = async (
        name: string,
        answer: Promise<Answer>,
        scan: readonly string[],
      ) => {
        const { status, text } = await answer;
        const leaked = findCanaries(text, scan);
        if (status !== 404 || leaked.length)
          problems.push(`${name}: ${status} ${leaked.join(",")} ${text.slice(0, 120)}`);
      };
      for (const [label, token] of [
        ["bound to B's bot", tokens.apiBound],
        ["every bot of B", tokens.apiAll],
      ] as const)
        for (const target of [P, S]) {
          const { botId, chatId, runId } = target.ids;
          const scan = target.canaries;
          const name = (what: string) => `${label}, ${target.label}: ${what}`;
          await expectMissing(name("messages"), api(token, `/bots/${botId}/messages`), scan);
          await expectMissing(
            name("messages ?chat"),
            api(token, `/bots/${botId}/messages?chat=${chatId}`),
            scan,
          );
          await expectMissing(name("chats"), api(token, `/bots/${botId}/chats`), scan);
          await expectMissing(name("export"), api(token, `/bots/${botId}/export`), scan);
          await expectMissing(
            name("run events"),
            api(token, `/bots/${botId}/runs/${runId}/events`),
            scan,
          );
          await expectMissing(name("send"), post(token, `/bots/${botId}/messages`), scan);
          await expectMissing(
            name("own bot, its chat"),
            api(token, `/bots/${own}/messages?chat=${chatId}`),
            scan,
          );
          await expectMissing(
            name("own bot, its chat export"),
            api(token, `/bots/${own}/export?chat=${chatId}`),
            scan,
          );
          await expectMissing(
            name("own bot, its run"),
            api(token, `/bots/${own}/runs/${runId}/events`),
            scan,
          );
          await expectMissing(
            name("own bot, send to its chat"),
            post(token, `/bots/${own}/messages?chat=${chatId}`),
            scan,
          );
          const list = await api(token, "/bots");
          expect(list.status).toBe(200);
          for (const id of [target.ids.botId, target.ids.secondBotId])
            if (list.text.includes(id!)) problems.push(name(`bot list names ${id}`));
          if (findCanaries(list.text, scan).length) problems.push(name("bot list leaked"));
        }

      // A token bound to one bot of S reaches that bot only, not S's other bot.
      const bound = tokens.aInS;
      const control = await api(bound, `/bots/${S.ids.botId}/messages`);
      expect(control.status).toBe(200);
      expect(
        findCanaries(control.text, S.canaries).length,
        "the bound bot's own chat",
      ).toBeGreaterThan(0);
      const other = S.ids.secondBotId!;
      for (const [what, answer] of [
        ["messages", api(bound, `/bots/${other}/messages`)],
        ["chats", api(bound, `/bots/${other}/chats`)],
        ["export", api(bound, `/bots/${other}/export`)],
        ["run events", api(bound, `/bots/${other}/runs/${S.ids.runId}/events`)],
        ["send", post(bound, `/bots/${other}/messages`)],
      ] as const)
        await expectMissing(`A's token bound to S's bot, on S's other bot: ${what}`, answer, []);

      // A run of B's own extra chat is not a run of B's main chat.
      const chatRun = await world.db.run.findFirstOrThrow({ where: { threadId: Bown.ids.chatId } });
      await expectMissing(
        "B's chat run on B's main chat",
        api(tokens.apiAll, `/bots/${own}/runs/${chatRun.id}/events`),
        [],
      );
      const inChat = await api(
        tokens.apiAll,
        `/bots/${own}/runs/${chatRun.id}/events?chat=${Bown.ids.chatId}`,
      );
      expect(inChat.status, "the same run in its own chat").toBe(200);

      // A cursor read off A's chat moves B's place in B's own run, never into A's chat.
      const aHead = await world.db.message.findFirstOrThrow({
        where: { threadId: P.ids.threadId },
        orderBy: { seq: "desc" },
      });
      const bRun = await world.db.run.findFirstOrThrow({
        where: { threadId: Bown.ids.threadId, status: "completed" },
      });
      for (const [what, path, headers] of [
        [
          "Last-Event-ID",
          `/bots/${own}/runs/${bRun.id}/events`,
          { "last-event-id": String(aHead.seq) },
        ],
        ["after", `/bots/${own}/runs/${bRun.id}/events?after=${aHead.seq}`, {}],
        ["after=-1", `/bots/${own}/runs/${bRun.id}/events?after=-1`, {}],
        ["after=0", `/bots/${own}/runs/${bRun.id}/events?after=0`, {}],
      ] as const) {
        const answer = await api(tokens.apiAll, path, { headers });
        if (
          answer.status !== 200 ||
          findCanaries(answer.text, [...P.canaries, ...S.canaries]).length
        )
          problems.push(`cursor ${what}: ${answer.status} ${answer.text.slice(0, 120)}`);
        if (answer.text.includes(aHead.id)) problems.push(`cursor ${what}: names A's message`);
      }
      const after = await snapshot(world.db, scopeOf(P, S));
      expect(problems).toEqual([]);
      expect(snapshotDiff(before, after), `rows of P or S changed (A is ${A.userId})`).toEqual([]);
    }, 120_000);

    it("the MCP endpoint refuses B's token on A's bots and chats", async () => {
      const { P, S, Bown } = world;
      let id = 0;
      const mcp = async (token: string, method: string, params: unknown = {}) => {
        const answer = await send(
          world,
          "/api/v1/dozo/mcp",
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, accept: MCP_ACCEPT, ...json({}) },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          },
          22,
          5_000,
        );
        const parsed = JSON.parse(answer.text) as {
          error?: unknown;
          result?: { isError?: boolean };
        };
        return { ...answer, refused: Boolean(parsed.error) || parsed.result?.isError === true };
      };
      const problems: string[] = [];
      const own = Bown.ids.botId!;
      const tools = await mcp(tokens.mcpAll, "tools/list");
      expect(tools.status, tools.text).toBe(200);
      expect(tools.text).toContain("send_message");
      for (const target of [P, S]) {
        const scan = target.canaries;
        const { botId, chatId } = target.ids;
        const ids = [target.ids.botId!, target.ids.secondBotId!, target.ids.chatId!];
        for (const [what, method, params] of [
          ["list_bots", "tools/call", { name: "list_bots", arguments: {} }],
          ["resources/list", "resources/list", {}],
        ] as const) {
          const answer = await mcp(tokens.mcpAll, method, params);
          if (
            answer.status !== 200 ||
            findCanaries(answer.text, scan).length ||
            ids.some((each) => answer.text.includes(each))
          )
            problems.push(`${target.label} ${what}: ${answer.status} ${answer.text.slice(0, 160)}`);
        }
        for (const [what, method, params] of [
          ["list_chats", "tools/call", { name: "list_chats", arguments: { bot_id: botId } }],
          [
            "send_message",
            "tools/call",
            { name: "send_message", arguments: { bot_id: botId, text: "iso-probe" } },
          ],
          [
            "send_message to its chat",
            "tools/call",
            {
              name: "send_message",
              arguments: { bot_id: botId, text: "iso-probe", chat_id: chatId },
            },
          ],
          [
            "send_message, own bot, its chat",
            "tools/call",
            {
              name: "send_message",
              arguments: { bot_id: own, text: "iso-probe", chat_id: chatId },
            },
          ],
          ["read chat", "resources/read", { uri: `dozo-chat://${botId}` }],
          ["read its extra chat", "resources/read", { uri: `dozo-chat://${botId}/${chatId}` }],
          ["read own bot, its chat", "resources/read", { uri: `dozo-chat://${own}/${chatId}` }],
        ] as const) {
          const answer = await mcp(tokens.mcpAll, method, params);
          if (!answer.refused || findCanaries(answer.text, scan).length)
            problems.push(`${target.label} ${what}: ${answer.status} ${answer.text.slice(0, 160)}`);
        }
      }
      // The owner's token reads the same chat, so the refusals above are not a broken endpoint.
      const control = await mcp(tokens.aInP, "resources/read", {
        uri: `dozo-chat://${P.ids.botId}`,
      });
      expect(control.refused, control.text.slice(0, 200)).toBe(false);
      expect(findCanaries(control.text, P.canaries).length).toBeGreaterThan(0);
      expect(problems).toEqual([]);
    }, 120_000);

    it("an account export link works once and holds only its own account", async () => {
      const { A, B, P, S } = world;
      const scan = [...P.canaries, ...S.canaries];
      const issue = async (who: Person) => {
        await confirmIdentity(world.app, who.cookie);
        return (
          await rpc<{ token: string }>(world, who.cookie, "export/accountToken", {}, who.spaceId)
        ).token;
      };
      const download = async (token: string, cookie?: string) => {
        const response = await world.handles.app.request(
          `/api/account/export?token=${encodeURIComponent(token)}`,
          { headers: cookie ? { cookie } : {} },
          peer(23),
        );
        const bytes = new Uint8Array(await response.arrayBuffer());
        const files =
          response.status === 200
            ? Object.values(unzipSync(bytes)).map((file) => Buffer.from(file).toString("utf8"))
            : [Buffer.from(bytes).toString("utf8")];
        return { status: response.status, text: files.join("\n") };
      };
      const first = await issue(B);
      const anonymous = await download(first);
      const again = await download(first);
      const asA = await download(await issue(B), A.cookie);
      const own = await download(await issue(A), A.cookie);
      console.log(
        `[isolation-http] export link: anonymous ${anonymous.status}, second use ${again.status}, B's link with A's session ${asA.status} (a bearer link by design)`,
      );
      expect(again.status, "a used link").toBe(410);
      expect(findCanaries(anonymous.text, scan), "B's archive").toEqual([]);
      expect(findCanaries(asA.text, scan), "B's archive fetched with A's session").toEqual([]);
      // A's own archive carries P's canaries, so the scan of B's can see them.
      expect(own.status).toBe(200);
      expect(findCanaries(own.text, P.canaries).length).toBeGreaterThan(0);
    }, 120_000);

    it("keeps A's paired computer from B's session and B's computer", async () => {
      const { A, B } = world;
      const scan = [devices.aName, devices.aId];
      const as = (headers: Record<string, string>) => ({ headers: { origin: ORIGIN, ...headers } });
      const listB = await send(world, "/api/devices", as({ cookie: B.cookie }));
      expect(listB.status).toBe(200);
      expect(listB.text).toContain(devices.bId);
      expect(scan.filter((value) => listB.text.includes(value))).toEqual([]);
      const listA = await send(world, "/api/devices", as({ cookie: A.cookie }));
      expect(
        scan.every((value) => listA.text.includes(value)),
        "A sees A's own computer",
      ).toBe(true);

      const bDevice = `Bearer ${devices.bToken}`;
      const aDevice = `Bearer ${devices.aToken}`;
      const answers = {
        "B's session removes A's computer": await send(world, `/api/devices/${devices.aId}`, {
          method: "DELETE",
          ...as({ cookie: B.cookie }),
        }),
        "B's computer removes A's computer": await send(world, `/api/devices/${devices.aId}`, {
          method: "DELETE",
          ...as({ authorization: bDevice }),
        }),
        "B's computer tied to A's sign-in": await send(world, "/api/devices/self/session", {
          method: "POST",
          ...as({ authorization: bDevice, cookie: A.cookie }),
        }),
        "A's computer tied to B's sign-in": await send(world, "/api/devices/self/session", {
          method: "POST",
          ...as({ authorization: aDevice, cookie: B.cookie }),
        }),
      };
      expect(
        Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, answer.status])),
      ).toEqual({
        "B's session removes A's computer": 404,
        "B's computer removes A's computer": 401,
        "B's computer tied to A's sign-in": 403,
        "A's computer tied to B's sign-in": 403,
      });
      // B's computer removing itself removes only itself.
      const self = await send(world, "/api/devices/self", {
        method: "DELETE",
        ...as({ authorization: bDevice }),
      });
      expect(self.status).toBe(204);
      const rows = await world.db.userDevice.findMany({
        where: { id: { in: [devices.aId, devices.bId] } },
        select: { id: true, revokedAt: true },
      });
      expect(rows.find((row) => row.id === devices.aId)?.revokedAt, "A's computer").toBeNull();
      expect(rows.find((row) => row.id === devices.bId)?.revokedAt, "B's computer").not.toBeNull();
    }, 60_000);

    it("live streams carry nothing of A's to B, and end for a member A removes", async () => {
      const { A, B, C, P, S, Bown } = world;
      // F joins S through an invite, makes a token there, then is removed through the real path.
      const stamp = `${Date.now()}`;
      const email = `iso-f-${stamp}@rakazo.test`;
      const cookie = await signup(world.app, email, "Iso F");
      await confirmIdentity(world.app, cookie);
      const user = await world.db.user.findUniqueOrThrow({ where: { email } });
      const home = await world.db.space.findFirstOrThrow({
        where: { createdByUserId: user.id, isDefault: true },
      });
      const F: Person = {
        label: "F",
        email,
        cookie,
        userId: user.id,
        spaceId: home.id,
        organizationId: home.organizationId,
      };
      await joinWithInvite(world, A, F, S.spaceId);
      const fToken = await createToken(F, S.spaceId);
      const fBots = await send(
        world,
        "/api/v1/dozo/bots",
        { headers: { authorization: `Bearer ${fToken}` } },
        24,
      );
      expect(fBots.status, "F's token while F is a member").toBe(200);
      expect(fBots.text).toContain(S.ids.botId);

      const fStream = await openStream(
        world,
        F.cookie,
        "notifications/subscribe",
        undefined,
        S.spaceId,
      );
      const openedAt = Date.now();
      const bAlerts = await openStream(
        world,
        B.cookie,
        "notifications/subscribe",
        undefined,
        B.spaceId,
      );
      // Each chat from its head, as the app follows one after reading it.
      const followChat = async (who: Person, botId: string, spaceId: string) => {
        const head = await rpc<{ cursor: number }>(
          world,
          who.cookie,
          "threads/head",
          { botId },
          spaceId,
        );
        return openStream(
          world,
          who.cookie,
          "threads/subscribe",
          { botId, cursor: head.cursor },
          spaceId,
        );
      };
      // The second bots: the first ones are being taught a skill, which holds new messages.
      const bThread = await followChat(B, Bown.ids.secondBotId!, B.spaceId);
      const aThread = await followChat(A, P.ids.secondBotId!, P.spaceId);
      const cThread = await followChat(C, S.ids.secondBotId!, S.spaceId);
      const inP = canary("A", "live");
      const inS = canary("S", "live");
      const ownWords = `iso-b-live-${stamp}`;
      await sendAndWait(world, A.cookie, { botId: P.ids.secondBotId! }, `${inP} now`, P.spaceId);
      await sendAndWait(world, A.cookie, { botId: S.ids.secondBotId! }, `${inS} now`, S.spaceId);
      await sendAndWait(world, B.cookie, { botId: Bown.ids.secondBotId! }, ownWords, B.spaceId);

      // Removed once the stream is old enough to re-check its session on the next frame.
      await vi.waitFor(
        () => {
          if (Date.now() - openedAt < SESSION_RECHECK_MS + 500) throw new Error("too young");
        },
        { timeout: SESSION_RECHECK_MS + 5_000, interval: 100 },
      );
      await rpc(world, A.cookie, "spaces/members/remove", { spaceId: S.spaceId, userId: F.userId });
      const removedAt = Date.now();
      // A writes in S after the removal: nothing of it may reach F's stream while it stays open.
      const afterRemoval = canary("S", "afterremoval");
      await sendAndWait(
        world,
        A.cookie,
        { botId: S.ids.secondBotId! },
        `${afterRemoval} now`,
        S.spaceId,
      );
      await vi.waitFor(
        () => {
          if (!fStream.state.endedAt) throw new Error("F's stream is still open");
        },
        { timeout: HEARTBEAT_MS + SESSION_RECHECK_MS + 5_000, interval: 100 },
      );
      const endedAfter = fStream.state.endedAt - removedAt;
      const fAfter = await send(
        world,
        "/api/v1/dozo/bots",
        { headers: { authorization: `Bearer ${fToken}` } },
        24,
      );
      for (const stream of [bAlerts, bThread, aThread, cThread]) await stream.stop();
      console.log(
        `[isolation-http] removed member's stream ended ${endedAfter} ms after removal (opened ${removedAt - openedAt} ms before it); token answered ${fAfter.status}; B's alert stream ${bAlerts.state.text.length} chars, B's chat stream ${bThread.state.text.length} chars`,
      );

      expect(fStream.state.text, "F's stream ends refused").toContain("UNAUTHORIZED");
      const late = fStream.state.frames.filter((frame) => frame.at > removedAt);
      console.log(
        `[isolation-http] F's frames after removal: ${late.map((frame) => `+${frame.at - removedAt}ms ${frame.text.replace(/\s+/g, " ").slice(0, 160)}`).join(" || ")}`,
      );
      expect(
        findCanaries(fStream.state.text, [afterRemoval, ...S.canaries]),
        "S after F's removal",
      ).toEqual([]);
      const sIds = [S.spaceId, S.ids.botId!, S.ids.secondBotId!, S.ids.threadId!, A.userId];
      expect(
        late.flatMap((frame) => sIds.filter((value) => frame.text.includes(value))),
        "S's ids reaching F after the removal",
      ).toEqual([]);
      expect(
        late.filter((frame) => /"type":"alert"/.test(frame.text)),
        "S's alerts reaching F after the removal",
      ).toEqual([]);
      // At worst a heartbeat's silence after the last re-check, which follows the removal.
      expect(endedAfter).toBeLessThan(HEARTBEAT_MS + SESSION_RECHECK_MS + 2_000);
      expect(fAfter.status, "F's token after F's removal").toBe(401);
      // Controls: each Space's own readers see the message, so the scan of B's streams can.
      expect(aThread.state.text).toContain(inP);
      expect(cThread.state.text).toContain(inS);
      expect(bThread.state.text, "B's own chat stream carries B's own message").toContain(ownWords);
      const scan = [...P.canaries, ...S.canaries, inP, inS];
      const ids = [
        P.spaceId,
        S.spaceId,
        P.organizationId,
        A.userId,
        P.ids.botId!,
        S.ids.botId!,
        P.ids.secondBotId!,
        S.ids.secondBotId!,
        P.ids.threadId!,
        S.ids.threadId!,
      ];
      for (const [name, stream] of [
        ["B's alerts", bAlerts],
        ["B's chat", bThread],
      ] as const) {
        expect(findCanaries(stream.state.text, scan), name).toEqual([]);
        expect(
          ids.filter((value) => stream.state.text.includes(value)),
          name,
        ).toEqual([]);
      }
    }, 120_000);

    it("serves artifacts, avatars and logos through RPC only, never a raw file route", async () => {
      const { A, B, P } = world;
      const fileRoutes = rawRoutes(world).filter((route) => FILE_ROUTE.test(route));
      expect(fileRoutes, "raw routes that name a file").toEqual(REVIEWED_FILE_ROUTES);
      const input = { botId: P.ids.botId, artifactId: P.ids.artifactId };
      const own = await readAnswer(world.app, A.cookie, "artifacts/get", input, P.spaceId);
      expect(own.status).toBe(200);
      expect(findCanaries(own.text, P.canaries).length, "A reads A's file").toBeGreaterThan(0);
      for (const [name, cookie, spaceId] of [
        ["B", B.cookie, B.spaceId],
        ["B with P's header", B.cookie, P.spaceId],
        ["anonymous", undefined, P.spaceId],
      ] as const) {
        const answer = await readAnswer(world.app, cookie, "artifacts/get", input, spaceId);
        expect(answer.status, name).toBeGreaterThanOrEqual(400);
        expect(findCanaries(answer.text, P.canaries), name).toEqual([]);
      }
      for (const cookie of [B.cookie, undefined]) {
        const answer = await send(world, `/api/dozo/catalog-images/${P.ids.artifactId}`, {
          headers: cookie ? { cookie } : {},
        });
        expect(answer.status).toBeGreaterThanOrEqual(400);
        expect(findCanaries(answer.text, P.canaries)).toEqual([]);
      }
    });

    it("without mail, a wrong password says the same for a known and an unknown address", async () => {
      const { A } = world;
      const post = (path: string, body: unknown) =>
        send(world, path, {
          method: "POST",
          headers: { origin: ORIGIN, ...json({}) },
          body: JSON.stringify(body),
        });
      const unknown = `iso-unknown-${Date.now()}@rakazo.test`;
      const wrong = { password: "wrong-password-1" };
      const known = await post("/api/auth/sign-in/email", { email: A.email, ...wrong });
      const missing = await post("/api/auth/sign-in/email", { email: unknown, ...wrong });
      expect(shape(known)).toBe(shape(missing));
      // A known finding, recorded and not asserted: without mail, sign-up says the address is taken.
      const taken = await post("/api/auth/sign-up/email", {
        email: A.email,
        password: "password12",
        name: "Iso K",
      });
      console.log(
        `[isolation-http] KNOWN without mail, sign-up with a taken address: ${taken.status} ${taken.text.slice(0, 120)}`,
      );
    });

    // Last: it calls every route, the auth library's included, with foreign ids.
    it("calls every raw route as B's session, B's tokens and anonymously without a leak", async () => {
      const { A, B, P, S } = world;
      const routes = rawRoutes(world);
      const exempt = new Set(HTTP_ROUTE_EXEMPTIONS.map((item) => item.route));
      expect(routes.length).toBeGreaterThan(40);
      expect(
        [...exempt].filter((route) => !routes.includes(route)),
        "exemptions for routes the app no longer registers",
      ).toEqual([]);
      // An exempted auth endpoint must still exist: the library answers an unknown one with 404.
      const missing: string[] = [];
      for (const item of AUTH_ENDPOINT_EXEMPTIONS) {
        const [method = "", path = ""] = item.route.split(" ");
        const answer = await send(world, path, {
          method,
          headers: { origin: ORIGIN, ...json({}) },
          body: "{}",
        });
        if (answer.status === 404) missing.push(item.route);
      }
      expect(missing, "auth exemptions the library no longer answers").toEqual([]);

      const callers: HttpCaller[] = [
        {
          name: "B session",
          headers: { cookie: B.cookie, "x-rakazo-space-id": B.spaceId, origin: ORIGIN },
          from: 31,
        },
        {
          name: "B session, P's header",
          headers: { cookie: B.cookie, "x-rakazo-space-id": P.spaceId, origin: ORIGIN },
          from: 32,
        },
        {
          name: "B token bound to B's bot",
          headers: { authorization: `Bearer ${tokens.routesBound}` },
          from: 33,
        },
        {
          name: "B token, every bot",
          headers: { authorization: `Bearer ${tokens.routesAll}` },
          from: 34,
        },
        { name: "anonymous", headers: { origin: ORIGIN }, from: 35 },
      ];
      const calls: (HttpCall & { target: Target })[] = [];
      for (const target of [P, S]) {
        const ids: TargetIds = { ...target.ids, deviceId: devices.aId, ...extra };
        const requests = [
          ...routes
            .filter((route) => !exempt.has(route))
            .flatMap((route) => requestsFor(route, ids).map((request) => ({ route, ...request }))),
          ...authRequests(ids),
        ];
        for (const caller of callers)
          for (const request of requests) calls.push({ caller, target, ...request });
      }
      const before = await snapshot(world.db, scopeOf(P, S));
      const outcomes = await pool(calls, async (call) => {
        const answer = await send(
          world,
          call.url,
          {
            method: call.method,
            headers: {
              ...call.caller.headers,
              ...(call.body ? json({}) : {}),
              "last-event-id": "-1",
            },
            ...(call.body ? { body: call.body } : {}),
          },
          call.caller.from,
        );
        const scan = [...call.target.canaries, devices.aName];
        return { ...call, status: answer.status, matched: findCanaries(answer.text, scan) };
      });
      const after = await snapshot(world.db, scopeOf(P, S));
      const called = new Set(outcomes.map((outcome) => outcome.route));
      const statuses = new Map<string, Set<number>>();
      for (const outcome of outcomes) {
        const key = `${outcome.route} as ${outcome.caller.name}`;
        statuses.set(key, (statuses.get(key) ?? new Set()).add(outcome.status));
      }
      console.log(
        `[isolation-http] ${routes.length} raw routes: ${routes.length - exempt.size} called by generated requests, ${exempt.size} exempted (auth wildcards, called as ${AUTH_ENDPOINTS.length} endpoints; ${AUTH_ENDPOINT_EXEMPTIONS.length} self-only auth endpoints called anonymously); ${outcomes.length} requests`,
      );
      console.log(
        `[isolation-http] statuses\n${[...statuses]
          .map(([key, set]) => `${key}: ${[...set].sort().join(",")}`)
          .join("\n")}`,
      );
      expect(
        routes.filter((route) => !exempt.has(route) && !called.has(route)),
        "routes never called",
      ).toEqual([]);
      const leaks = outcomes
        .filter((outcome) => outcome.matched.length)
        .map(
          (outcome) =>
            `${outcome.method} ${outcome.url} as ${outcome.caller.name} (${outcome.target.label}): ${outcome.status} leaked ${outcome.matched.join(", ")}`,
        );
      expect(leaks).toEqual([]);
      expect(snapshotDiff(before, after), `rows of P or S changed (A is ${A.userId})`).toEqual([]);
      // A is still signed in: no foreign call ended A's session.
      const session = await send(world, "/api/auth/get-session", {
        headers: { cookie: A.cookie, origin: ORIGIN },
      });
      expect(session.text).toContain(A.userId);

      // Control: the same generated reads made by P's owner find P's canaries, so the requests
      // above reach the code behind each route and the scan sees what it returns.
      const owners: HttpCaller[] = [
        {
          name: "A session on P",
          headers: { cookie: A.cookie, "x-rakazo-space-id": P.spaceId, origin: ORIGIN },
          from: 36,
        },
        { name: "A token in P", headers: { authorization: `Bearer ${tokens.aInP}` }, from: 37 },
      ];
      const ids: TargetIds = { ...P.ids, deviceId: devices.aId, ...extra };
      const reads = routes
        .filter((route) => !exempt.has(route))
        .flatMap((route) => requestsFor(route, ids).map((request) => ({ route, ...request })))
        .filter((request) => request.method === "GET");
      const found = new Set<string>();
      for (const caller of owners)
        for (const request of reads) {
          const answer = await send(
            world,
            request.url,
            { headers: { ...caller.headers, "last-event-id": "-1" } },
            caller.from,
          );
          if (findCanaries(answer.text, P.canaries).length) found.add(request.route);
        }
      console.log(
        `[isolation-http] control: P's owner finds canaries through ${[...found].sort().join(" ")}`,
      );
      expect([...found]).toEqual(
        expect.arrayContaining([
          "GET /api/audit-events/export",
          "GET /api/v1/dozo/bots/:botId/messages",
          "GET /api/v1/dozo/bots/:botId/export",
        ]),
      );
    }, 300_000);
  },
);

describeWithDatabase.each(ISOLATION_LOGINS)(
  "sign-in endpoints answer the same for a known and an unknown address ($name)",
  (login) => {
    let stop: (() => Promise<void>) | undefined;
    afterAll(async () => {
      await stop?.();
    });

    it("password reset, sign-in code, verification mail and a wrong password", async () => {
      const mail = new EmailEmulator();
      const { handles, cleanup } = await startIsolationApp(login.url(), { email: mail });
      stop = cleanup;
      const app = handles.app;
      const stamp = `${Date.now()}`;
      const post = async (path: string, body: unknown) => {
        const response = await app.request(path, {
          method: "POST",
          headers: { origin: ORIGIN, ...json({}) },
          body: JSON.stringify(body),
        });
        return { status: response.status, text: await response.text() };
      };
      // With mail on, a sign-up leaves an unverified account and no session. A second account is
      // marked verified through the system client, as its emailed link would.
      const unverified = `iso-known-${stamp}@rakazo.test`;
      const verified = `iso-verified-${stamp}@rakazo.test`;
      const unknown = `iso-unknown-${stamp}@rakazo.test`;
      for (const email of [unverified, verified]) {
        const made = await post("/api/auth/sign-up/email", {
          email,
          password: "password12",
          name: "Iso K",
        });
        expect(made.status, made.text).toBeLessThan(400);
      }
      await asSystem(handles.prisma).user.update({
        where: { email: verified },
        data: { emailVerified: true },
      });

      const probes: Record<string, (email: string) => Promise<Answer>> = {
        "request-password-reset": (email) =>
          post("/api/auth/request-password-reset", {
            email,
            redirectTo: `${ORIGIN}/reset-password`,
          }),
        "email-otp sign-in code": (email) =>
          post("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" }),
        "send-verification-email": (email) =>
          post("/api/auth/send-verification-email", { email, callbackURL: `${ORIGIN}/` }),
        "sign-in, wrong password": (email) =>
          post("/api/auth/sign-in/email", { email, password: "wrong-password-1" }),
      };
      const differences: string[] = [];
      for (const [name, probe] of Object.entries(probes)) {
        const answers = {
          unknown: await probe(unknown),
          unverified: await probe(unverified),
          verified: await probe(verified),
        };
        console.log(
          `[isolation-http] ${name}: ${Object.entries(answers)
            .map(([who, answer]) => `${who} ${answer.status} ${answer.text.slice(0, 100)}`)
            .join(" | ")}`,
        );
        for (const who of ["unverified", "verified"] as const)
          if (shape(answers[who]) !== shape(answers.unknown))
            differences.push(
              `${name}: ${who} ${shape(answers[who])} vs unknown ${shape(answers.unknown)}`,
            );
      }
      // A known finding, recorded and not asserted: sign-up with a taken address.
      const taken = await post("/api/auth/sign-up/email", {
        email: verified,
        password: "password12",
        name: "Iso K",
      });
      const fresh = await post("/api/auth/sign-up/email", {
        email: `iso-fresh-${stamp}@rakazo.test`,
        password: "password12",
        name: "Iso K",
      });
      console.log(
        `[isolation-http] KNOWN sign-up with a taken address: ${shape(taken)} ${taken.text.slice(0, 120)} | fresh address: ${shape(fresh)}`,
      );
      expect(differences).toEqual([]);
    }, 120_000);
  },
);
