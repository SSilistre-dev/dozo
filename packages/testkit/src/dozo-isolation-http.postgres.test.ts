// Cross-tenant isolation beyond the RPC procedures: every raw HTTP route the app registers, the bot
// API and its MCP endpoint, the account export link, paired computers, live streams and what the
// sign-in endpoints tell about an address. The world, canaries and snapshot are the RPC matrix's
// (dozo-isolation.test-support.ts); a canary in a foreign caller's answer or its headers, a P or
// S id in its headers, or a changed row of P or S, is a leak, and a leak stays red.
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
  readAnswer,
  rpc,
  sendAndWait,
  signup,
  snapshot,
  snapshotDiff,
  startIsolationApp,
} from "./dozo-isolation.test-support.js";
import type {
  Answer,
  HttpCaller,
  HttpRequest,
  OpenStream,
  TargetIds,
} from "./dozo-isolation-http.test-support.js";
import {
  AUTH_ENDPOINTS,
  authRequests,
  eventType,
  foreignLeaks,
  headerText,
  json,
  openStream,
  peer,
  pool,
  rawRoutes,
  requestsFor,
  send,
  sendRequest,
  shape,
  streamEvents,
  targetIds,
} from "./dozo-isolation-http.test-support.js";
import {
  AUTH_ENDPOINT_DATA,
  AUTH_ENDPOINT_EXEMPTIONS,
  HTTP_ROUTE_EXEMPTIONS,
  ROUTE_DATA,
} from "./dozo-isolation-http-exemptions.js";
import { asSystem } from "./system-db.js";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

/** apps/api/src/routes/shared.ts: a stream re-checks its session this often while it delivers. */
const SESSION_RECHECK_MS = 10_000;
/** apps/api/src/routes/shared.ts: an idle stream sends a heartbeat (and re-checks) after this. */
const HEARTBEAT_MS = 20_000;
/** How long B's notification stream is watched after A's last action ends. */
const QUIET_WINDOW_MS = 5_000;
const MCP_ACCEPT = "application/json, text/event-stream";

/** Path words a route serving a file, picture or attachment would carry. */
const FILE_ROUTE = /artifact|attachment|avatar|logo|upload|download|file|media|image|picture/i;
/** File routes reviewed: the plugin catalog's own pictures, the same for every caller. */
const REVIEWED_FILE_ROUTES = ["GET /api/dozo/catalog-images/:file"];

/** Waits until no stream of `streams` has had a frame for `ms`, so a connect burst is over. */
async function settle(streams: OpenStream[], ms = 1_500) {
  await vi.waitFor(
    () => {
      for (const stream of streams) {
        const last = stream.state.frames.at(-1)?.at ?? 0;
        if (!last || Date.now() - last < ms) throw new Error("the stream is still talking");
      }
    },
    { timeout: 15_000, interval: 100 },
  );
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
    /** Per target, a run of its extra chat: the generated requests name that chat too. */
    const chatRuns = {} as Record<"P" | "S", string>;
    const idsOf = (target: Target): TargetIds => ({
      ...target.ids,
      runId: chatRuns[target.label as "P" | "S"] ?? target.ids.runId,
      deviceId: devices.aId,
      ...extra,
    });

    /** A new person who joins S through an invite and makes a token there. */
    const joinS = async (label: string) => {
      const { A, S } = world;
      const email = `iso-${label.toLowerCase()}-${Date.now()}@rakazo.test`;
      const cookie = await signup(world.app, email, `Iso ${label}`);
      await confirmIdentity(world.app, cookie);
      const user = await world.db.user.findUniqueOrThrow({ where: { email } });
      const home = await world.db.space.findFirstOrThrow({
        where: { createdByUserId: user.id, isDefault: true },
      });
      const who: Person = {
        label,
        email,
        cookie,
        userId: user.id,
        spaceId: home.id,
        organizationId: home.organizationId,
      };
      await joinWithInvite(world, A, who, S.spaceId);
      return { who, token: await createToken(who, S.spaceId) };
    };

    /** Each chat from its head, as the app follows one after reading it. */
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
      for (const target of [P, S]) {
        const run = await world.db.run.findFirstOrThrow({ where: { threadId: target.ids.chatId } });
        chatRuns[target.label as "P" | "S"] = run.id;
      }
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
        ids: readonly string[] = [],
      ) => {
        const got = await answer;
        const leaked = foreignLeaks(got, scan, ids);
        if (got.status !== 404 || leaked.length)
          problems.push(`${name}: ${got.status} ${leaked.join(",")} ${got.text.slice(0, 120)}`);
      };
      /** The same request the owner's token makes, done after the snapshot: it reaches. */
      const ownerChecks: {
        name: string;
        token: string;
        path: string;
        write: boolean;
        scan: readonly string[];
      }[] = [];
      const owners = { P: tokens.aInP, S: tokens.aInS };
      for (const [label, token] of [
        ["bound to B's bot", tokens.apiBound],
        ["every bot of B", tokens.apiAll],
      ] as const)
        for (const target of [P, S]) {
          const { botId, chatId, runId } = target.ids;
          const scan = target.canaries;
          const ids = targetIds(target);
          const name = (what: string) => `${label}, ${target.label}: ${what}`;
          const same = [
            ["messages", `/bots/${botId}/messages`, false],
            ["messages ?chat", `/bots/${botId}/messages?chat=${chatId}`, false],
            ["chats", `/bots/${botId}/chats`, false],
            ["export", `/bots/${botId}/export`, false],
            ["export ?chat", `/bots/${botId}/export?chat=${chatId}`, false],
            ["run events", `/bots/${botId}/runs/${runId}/events`, false],
            ["send", `/bots/${botId}/messages`, true],
            ["send ?chat", `/bots/${botId}/messages?chat=${chatId}`, true],
          ] as const;
          for (const [what, path, write] of same) {
            await expectMissing(
              name(what),
              write ? post(token, path) : api(token, path),
              scan,
              ids,
            );
            if (label === "every bot of B")
              ownerChecks.push({
                name: `${target.label}: ${what}`,
                token: owners[target.label as "P" | "S"],
                path,
                write,
                scan: what === "run events" || write ? [] : scan,
              });
          }
          await expectMissing(
            name("own bot, its chat"),
            api(token, `/bots/${own}/messages?chat=${chatId}`),
            scan,
            ids,
          );
          await expectMissing(
            name("own bot, its chat export"),
            api(token, `/bots/${own}/export?chat=${chatId}`),
            scan,
            ids,
          );
          await expectMissing(
            name("own bot, its run"),
            api(token, `/bots/${own}/runs/${runId}/events`),
            scan,
            ids,
          );
          await expectMissing(
            name("own bot, send to its chat"),
            post(token, `/bots/${own}/messages?chat=${chatId}`),
            scan,
            ids,
          );
          const list = await api(token, "/bots");
          expect(list.status).toBe(200);
          for (const id of [target.ids.botId, target.ids.secondBotId])
            if (list.text.includes(id!)) problems.push(name(`bot list names ${id}`));
          if (foreignLeaks(list, scan, ids).length) problems.push(name("bot list leaked"));
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
          foreignLeaks(answer, [...P.canaries, ...S.canaries], [...targetIds(P), ...targetIds(S)])
            .length
        )
          problems.push(`cursor ${what}: ${answer.status} ${answer.text.slice(0, 120)}`);
        if (answer.text.includes(aHead.id)) problems.push(`cursor ${what}: names A's message`);
      }
      const after = await snapshot(world.db, scopeOf(P, S));
      expect(problems).toEqual([]);
      expect(snapshotDiff(before, after), `rows of P or S changed (A is ${A.userId})`).toEqual([]);

      // Owner controls: the owner's token with the very request B was refused reaches the code
      // behind it, so B's 404 is a refusal and not a request that would reach nothing.
      const unreached: string[] = [];
      for (const check of ownerChecks) {
        const answer = check.write
          ? await post(check.token, check.path)
          : await api(check.token, check.path);
        // A send is reached when it is accepted, or refused as a conflict: the API says the bot is
        // being taught only after it found the bot and chat as the caller's (B got 404 there).
        const reached = check.write ? [202, 409].includes(answer.status) : answer.status === 200;
        if (!reached || (check.scan.length && !findCanaries(answer.text, check.scan).length))
          unreached.push(`${check.name}: ${answer.status} ${answer.text.slice(0, 120)}`);
      }
      console.log(
        `[isolation-http] bot API owner controls: ${ownerChecks.length - unreached.length}/${ownerChecks.length} of B's refused requests reach for the owner`,
      );
      if (unreached.length) console.log(`[isolation-http] not reached:\n${unreached.join("\n")}`);
      expect(unreached, "B's refused requests the owner's token does not reach").toEqual([]);
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
          error?: { message?: string };
          result?: { isError?: boolean; content?: { text?: string }[] };
        };
        const refused = Boolean(parsed.error) || parsed.result?.isError === true;
        const message = parsed.error?.message ?? parsed.result?.content?.[0]?.text ?? "";
        return { ...answer, refused, message: refused ? message : "" };
      };
      const problems: string[] = [];
      const ownerChecks: {
        name: string;
        target: Target;
        method: string;
        params: unknown;
        write: boolean;
        /** What B was answered with for the same call. */
        refusal: string;
      }[] = [];
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
            foreignLeaks(answer, scan, targetIds(target)).length ||
            ids.some((each) => answer.text.includes(each))
          )
            problems.push(`${target.label} ${what}: ${answer.status} ${answer.text.slice(0, 160)}`);
        }
        const targeted = [
          ["list_chats", "tools/call", { name: "list_chats", arguments: { bot_id: botId } }, false],
          [
            "send_message",
            "tools/call",
            { name: "send_message", arguments: { bot_id: botId, text: "iso-probe" } },
            true,
          ],
          [
            "send_message to its chat",
            "tools/call",
            {
              name: "send_message",
              arguments: { bot_id: botId, text: "iso-probe", chat_id: chatId },
            },
            true,
          ],
          ["read chat", "resources/read", { uri: `dozo-chat://${botId}` }, false],
          [
            "read its extra chat",
            "resources/read",
            { uri: `dozo-chat://${botId}/${chatId}` },
            false,
          ],
        ] as const;
        const ownBot = [
          [
            "send_message, own bot, its chat",
            "tools/call",
            {
              name: "send_message",
              arguments: { bot_id: own, text: "iso-probe", chat_id: chatId },
            },
          ],
          ["read own bot, its chat", "resources/read", { uri: `dozo-chat://${own}/${chatId}` }],
        ] as const;
        const refusals = new Map<string, string>();
        for (const [what, method, params] of [...targeted, ...ownBot]) {
          const answer = await mcp(tokens.mcpAll, method, params);
          refusals.set(what, answer.message);
          if (!answer.refused || foreignLeaks(answer, scan, targetIds(target)).length)
            problems.push(`${target.label} ${what}: ${answer.status} ${answer.text.slice(0, 160)}`);
        }
        for (const [what, method, params, write] of targeted)
          ownerChecks.push({
            name: `${target.label} ${what}`,
            target,
            method,
            params,
            write,
            refusal: refusals.get(what) ?? "",
          });
      }
      expect(problems).toEqual([]);
      // Owner controls: the owner's token with the same tool and the same arguments reaches it
      // (a read shows the chat's canary), so B's refusals are not a wrong argument's error.
      const unreached: string[] = [];
      for (const check of ownerChecks) {
        const token = check.target.label === "P" ? tokens.aInP : tokens.aInS;
        const answer = await mcp(token, check.method, check.params);
        const shown = check.write || findCanaries(answer.text, check.target.canaries).length > 0;
        // A send refused for a reason B never got (the bot is being taught) passed the check
        // that stopped B: B's answer for the very same call was another one.
        const passed = !answer.refused || (check.write && answer.message !== check.refusal);
        if (!passed || !shown)
          unreached.push(`${check.name}: ${answer.status} ${answer.text.slice(0, 160)}`);
      }
      console.log(
        `[isolation-http] MCP owner controls: ${ownerChecks.length - unreached.length}/${ownerChecks.length} of B's refused calls reach for the owner`,
      );
      if (unreached.length) console.log(`[isolation-http] not reached:\n${unreached.join("\n")}`);
      expect(unreached, "B's refused calls the owner's token does not reach").toEqual([]);
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
        return { status: response.status, text: files.join("\n"), headers: headerText(response) };
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
      const ids = [...targetIds(P), ...targetIds(S)];
      expect(foreignLeaks(anonymous, scan, ids), "B's archive").toEqual([]);
      expect(foreignLeaks(again, scan, ids), "B's used link").toEqual([]);
      expect(foreignLeaks(asA, scan, ids), "B's archive fetched with A's session").toEqual([]);
      console.log(
        `[isolation-http] export headers of B's archive: ${anonymous.headers.replace(/\n/g, " | ")}`,
      );
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
      expect(foreignLeaks(listB, scan, scan), "B's computer list").toEqual([]);
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
        Object.entries(answers).flatMap(([name, answer]) =>
          foreignLeaks(answer, scan, [...scan, A.userId]).map((leak) => `${name}: ${leak}`),
        ),
        "A's computer in B's answers",
      ).toEqual([]);
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
      const { who: F, token: fToken } = await joinS("F");
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
          foreignLeaks({ status: 200, text: "", headers: stream.headers }, scan, ids),
          name,
        ).toEqual([]);
        expect(
          ids.filter((value) => stream.state.text.includes(value)),
          name,
        ).toEqual([]);
      }
    }, 120_000);

    it("the notification stream signals A's actions to A and S's members, and nothing to B", async () => {
      const { A, B, C, P, S } = world;
      // Finished replies alert: the seeded bots have it off, so it is turned on for the second
      // bots while this runs. A completion alerts every member of the bot's Space.
      const notify = (target: Target, on: boolean) =>
        rpc(
          world,
          A.cookie,
          "bots/update",
          { botId: target.ids.secondBotId, notifyOnFinish: on },
          target.spaceId,
        );
      await notify(P, true);
      await notify(S, true);
      try {
        const streams = {
          aP: await openStream(world, A.cookie, "notifications/subscribe", undefined, P.spaceId),
          cS: await openStream(world, C.cookie, "notifications/subscribe", undefined, S.spaceId),
          bB: await openStream(world, B.cookie, "notifications/subscribe", undefined, B.spaceId),
        };
        // Each stream signals once when it opens; the window starts when that burst is over.
        await settle(Object.values(streams));
        const windowStart = Date.now();
        const inP = canary("A", "alert");
        const inS = canary("S", "alert");
        await sendAndWait(world, A.cookie, { botId: P.ids.secondBotId! }, `${inP} now`, P.spaceId);
        await sendAndWait(world, A.cookie, { botId: S.ids.secondBotId! }, `${inS} now`, S.spaceId);
        const alerted = (stream: OpenStream, botId: string) =>
          streamEvents(stream.state).some(
            (event) =>
              event.at >= windowStart &&
              eventType(event.value) === "alert" &&
              JSON.stringify(event.value).includes(botId),
          );
        await vi.waitFor(
          () => {
            if (!alerted(streams.aP, P.ids.secondBotId!)) throw new Error("no alert for A in P");
            if (!alerted(streams.cS, S.ids.secondBotId!)) throw new Error("no alert for C in S");
          },
          { timeout: 15_000, interval: 100 },
        );
        const actionsEnded = Date.now();
        await vi.waitFor(
          () => {
            if (Date.now() - actionsEnded < QUIET_WINDOW_MS) throw new Error("still watching");
          },
          { timeout: QUIET_WINDOW_MS + 2_000, interval: 100 },
        );
        const windowEnd = Date.now();
        for (const stream of Object.values(streams)) await stream.stop();
        const during = (stream: OpenStream) =>
          streamEvents(stream.state).filter(
            (event) => event.at >= windowStart && event.at <= windowEnd,
          );
        const kinds = (stream: OpenStream) => during(stream).map((event) => eventType(event.value));
        console.log(
          `[isolation-http] notification window ${windowEnd - windowStart} ms (A's two sends, then ${QUIET_WINDOW_MS} ms): A on P got ${kinds(streams.aP).join(",")}; C on S got ${kinds(streams.cS).join(",")}; B got ${kinds(streams.bB).join(",") || "nothing"}`,
        );
        // B: no event at all in the window, not even a content-free signal. A heartbeat is the
        // stream's own keep-alive after HEARTBEAT_MS of silence, not news of anything; it would
        // be named here if one fell inside the window.
        expect(
          during(streams.bB).filter((event) => eventType(event.value) !== "heartbeat"),
          "events on B's stream while A acted in P and S",
        ).toEqual([]);
        const scan = [...P.canaries, ...S.canaries, inP, inS];
        const ids = [...targetIds(P), ...targetIds(S), P.ids.secondBotId!, S.ids.secondBotId!];
        expect(findCanaries(streams.bB.state.text, scan), "B's stream").toEqual([]);
        expect(
          ids.filter((value) => streams.bB.state.text.includes(value)),
          "P or S ids on B's stream",
        ).toEqual([]);
        expect(
          foreignLeaks({ status: 200, text: "", headers: streams.bB.headers }, scan, ids),
          "B's stream headers",
        ).toEqual([]);
      } finally {
        await notify(P, false);
        await notify(S, false);
      }
    }, 120_000);

    it("a removed member's open chat stream gets nothing written after the removal", async () => {
      const { A, S } = world;
      const { who: G } = await joinS("G");
      const bot = { botId: S.ids.secondBotId! };
      // Opened just before the removal, so the removal falls inside the stream's session re-check
      // interval: the worst case a removal can meet, and the one a member reading the chat meets.
      const gChat = await followChat(G, bot.botId, S.spaceId);
      const openedAt = Date.now();
      const beforeRemoval = canary("S", "beforeremoval");
      await sendAndWait(world, A.cookie, bot, `${beforeRemoval} now`, S.spaceId);
      await vi.waitFor(
        () => {
          if (!gChat.state.text.includes(beforeRemoval)) throw new Error("not delivered yet");
        },
        { timeout: 10_000, interval: 50 },
      );
      await rpc(world, A.cookie, "spaces/members/remove", { spaceId: S.spaceId, userId: G.userId });
      const removedAt = Date.now();
      const afterRemoval = canary("S", "afterremoval");
      await sendAndWait(world, A.cookie, bot, `${afterRemoval} now`, S.spaceId);
      const sentAt = Date.now();
      await vi.waitFor(
        () => {
          if (!gChat.state.endedAt) throw new Error("G's chat stream is still open");
        },
        { timeout: HEARTBEAT_MS + SESSION_RECHECK_MS + 5_000, interval: 100 },
      );
      const late = gChat.state.frames.filter((frame) => frame.at > removedAt);
      const leaked = late.filter((frame) => findCanaries(frame.text, [afterRemoval]).length);
      console.log(
        `[isolation-http] removed member's chat stream: removal ${removedAt - openedAt} ms after it opened, A's message sent ${sentAt - removedAt} ms after the removal, stream ended ${gChat.state.endedAt - removedAt} ms after it; ${late.length} chunks after the removal, ${leaked.length} with the new message (first at +${(leaked[0]?.at ?? removedAt) - removedAt} ms): ${leaked
          .map((frame) => frame.text.replace(/\s+/g, " ").slice(0, 200))
          .join(" || ")}`,
      );
      // Control: while G was a member, the stream carried A's message.
      expect(gChat.state.text).toContain(beforeRemoval);
      expect(gChat.state.text, "G's chat stream ends refused").toContain("UNAUTHORIZED");
      expect(
        leaked.map((frame) => `+${frame.at - removedAt}ms`),
        "A's message written after G's removal, on G's open chat stream",
      ).toEqual([]);
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
      // Every route and called auth endpoint is classified once (what it returns), and only those.
      const classified = new Map(ROUTE_DATA.map((item) => [item.route, item]));
      const authClassified = new Map(AUTH_ENDPOINT_DATA.map((item) => [item.route, item]));
      const authRoutes = [
        ...new Set(AUTH_ENDPOINTS.map((item) => `${item.method} ${item.path.split("?")[0]}`)),
      ];
      expect(
        routes.filter((route) => !exempt.has(route) && !classified.has(route)),
        "raw routes with no entry in ROUTE_DATA",
      ).toEqual([]);
      expect(
        [...classified.keys()].filter((route) => !routes.includes(route)),
        "ROUTE_DATA entries for routes the app no longer registers",
      ).toEqual([]);
      expect(
        [
          ...authRoutes.filter((route) => !authClassified.has(route)),
          ...[...authClassified.keys()].filter((route) => !authRoutes.includes(route)),
        ],
        "AUTH_ENDPOINTS and AUTH_ENDPOINT_DATA differ",
      ).toEqual([]);

      const calls: (HttpRequest & { caller: HttpCaller; target: Target })[] = [];
      for (const target of [P, S]) {
        const ids = idsOf(target);
        const requests = [
          ...routes
            .filter((route) => !exempt.has(route))
            .flatMap((route) => requestsFor(route, ids)),
          ...authRequests(ids),
        ];
        for (const caller of callers)
          for (const request of requests) calls.push({ caller, target, ...request });
      }
      const before = await snapshot(world.db, scopeOf(P, S));
      const outcomes = await pool(calls, async (call) => {
        const answer = await sendRequest(world, call.caller, call);
        const scan = [...call.target.canaries, devices.aName, devices.aId, A.email];
        return {
          ...call,
          status: answer.status,
          leaks: foreignLeaks(answer, scan, targetIds(call.target)),
        };
      });
      const after = await snapshot(world.db, scopeOf(P, S));
      const called = new Set(outcomes.map((outcome) => outcome.route));
      const statuses = new Map<string, Set<number>>();
      for (const outcome of outcomes) {
        const key = `${outcome.route} as ${outcome.caller.name}`;
        statuses.set(key, (statuses.get(key) ?? new Set()).add(outcome.status));
      }
      console.log(
        `[isolation-http] ${routes.length} raw routes: ${routes.length - exempt.size} called by generated requests, ${exempt.size} exempted (auth wildcards, called as ${AUTH_ENDPOINTS.length} endpoints; ${AUTH_ENDPOINT_EXEMPTIONS.length} self-only auth endpoints called anonymously); ${outcomes.length} requests, bodies and headers scanned`,
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
        .filter((outcome) => outcome.leaks.length)
        .map(
          (outcome) =>
            `${outcome.method} ${outcome.url} as ${outcome.caller.name} (${outcome.target.label}): ${outcome.status} leaked ${outcome.leaks.join(", ")}`,
        );
      expect(leaks).toEqual([]);
      expect(snapshotDiff(before, after), `rows of P or S changed (A is ${A.userId})`).toEqual([]);
      // A is still signed in: no foreign call ended A's session.
      const session = await send(world, "/api/auth/get-session", {
        headers: { cookie: A.cookie, origin: ORIGIN },
      });
      expect(session.text).toContain(A.userId);

      // Owner control: every route that returns its owner's data, called by P's owner with the
      // very requests generated above, shows P's data; a route that is not served refuses the
      // owner too. So the refusals above are refusals, and the scan sees what the route returns.
      const owners: Record<"session" | "token", HttpCaller> = {
        session: {
          name: "A session on P",
          headers: { cookie: A.cookie, "x-rakazo-space-id": P.spaceId, origin: ORIGIN },
          from: 36,
        },
        token: {
          name: "A token in P",
          headers: { authorization: `Bearer ${tokens.aInP}` },
          from: 37,
        },
      };
      const ids = idsOf(P);
      const ownerScan = [...P.canaries, devices.aName];
      const ownMarks = [A.userId, A.email, P.organizationId, extra.accountId];
      const missed: string[] = [];
      const reached: string[] = [];
      const check = async (item: (typeof ROUTE_DATA)[number], requests: HttpRequest[]) => {
        for (const request of requests) {
          if (item.kind === "not-served") {
            const answer = await sendRequest(world, owners.session, request);
            if (answer.status < 400)
              missed.push(
                `${request.method} ${request.url}: not served, owner got ${answer.status}`,
              );
            continue;
          }
          if (item.kind !== "owner-data" && item.kind !== "own-account") continue;
          const answer = await sendRequest(world, owners[item.owner ?? "session"], request);
          const marks =
            item.kind === "owner-data"
              ? findCanaries(answer.text, ownerScan)
              : ownMarks.filter((mark) => answer.text.includes(mark));
          if (marks.length) reached.push(item.route);
          else
            missed.push(
              `${item.route} (${item.kind}, ${item.owner}): ${answer.status} ${answer.text.slice(0, 160)}`,
            );
        }
      };
      for (const item of ROUTE_DATA) await check(item, requestsFor(item.route, ids));
      const authReads = authRequests(ids);
      for (const item of AUTH_ENDPOINT_DATA)
        await check(
          item,
          authReads.filter((request) => request.route === item.route),
        );
      const kinds = new Map<string, number>();
      for (const item of [...ROUTE_DATA, ...AUTH_ENDPOINT_DATA])
        kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1);
      console.log(
        `[isolation-http] route classes: ${[...kinds].map(([kind, n]) => `${kind} ${n}`).join(", ")}; the owner's own data shows through ${[...new Set(reached)].sort().join(" ")}`,
      );
      if (missed.length) console.log(`[isolation-http] not reached:\n${missed.join("\n")}`);
      expect(missed, "routes that return the owner's data but did not for the owner").toEqual([]);
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
        return {
          status: response.status,
          text: await response.text(),
          headers: headerText(response),
        };
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
