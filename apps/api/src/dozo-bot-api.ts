import { randomUUID } from "node:crypto";
import type { RouterClient } from "@orpc/server";
import { createRouterClient, ORPCError, onError } from "@orpc/server";
import type { Actor, ThreadMessage } from "@rakazo/contracts";
import { IsoDate, THREAD_MESSAGE_TEXT_MAX_LENGTH } from "@rakazo/contracts";
import { dozoTokenNonce } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem, runAsTenant, takeDozoApiMinute, touchDozoAccessToken } from "@rakazo/db";
import { bestEffort, enrichLogContext } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import * as z from "zod";
import type { DozoTokenCaller } from "./dozo-access-tokens.js";
import { dozoTokenAuthenticator } from "./dozo-access-tokens.js";
import type { DozoSettledRun, DozoStreamFrame } from "./dozo-bot-api-stream.js";
import { DOZO_SETTLED_RUN_STATUSES, dozoRunStream, sseFrame } from "./dozo-bot-api-stream.js";
import { messageBody } from "./dozo-chat-markdown.js";
import { readBoundedBody } from "./http-body.js";
import type { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";
import { isStopMessage } from "./thread-stop.js";
import { windowCounter } from "./window-counter.js";

export const DOZO_BOT_API_PREFIX = "/api/v1/dozo";

/** Requests one token may make a minute, across every API instance. */
export const DOZO_BOT_API_REQUESTS_PER_MINUTE = 60;
/** Messages one account may send a minute with all its tokens together, across every instance. */
export const DOZO_BOT_API_SENDS_PER_MINUTE = 20;
/** Requests one address may make a minute before its token is even looked up, in each process. */
export const DOZO_BOT_API_ADDRESS_PER_MINUTE = 120;
/** Streams one token may hold open at once, in each API process. */
export const DOZO_BOT_API_STREAMS_PER_TOKEN = 3;
/** A stream ends after this with `status: running`; the client resumes from the last id it saw. */
export const DOZO_BOT_API_STREAM_MAX_MS = 10 * 60_000;
const MAX_BODY_BYTES = 256 * 1024;
const EVENT_STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  // Proxies pass each frame on at once instead of collecting the answer.
  "x-accel-buffering": "no",
};

type AppClient = RouterClient<ReturnType<typeof createRouter>>;

/** The only procedures a token reaches. Settings, billing, members and tokens are not among them. */
export type DozoBotApiClient = {
  bots: Pick<AppClient["bots"], "list">;
  threads: Pick<AppClient["threads"], "head" | "send" | "messages" | "subscribe">;
  dozoChatExport: Pick<AppClient["dozoChatExport"], "markdown">;
};

export type DozoBotApiContext = {
  actor: Actor;
  signal: AbortSignal;
  /** Asked again while a stream is open, so a revoked token ends it. */
  stillAuthorized: () => Promise<boolean>;
};

export type DozoBotApiDeps = {
  authenticate: (authorization: string | undefined) => Promise<DozoTokenCaller | null>;
  /** The app's own procedures, called in process as the token's member. */
  connect: (context: DozoBotApiContext) => DozoBotApiClient;
  /** A run's status, if the run is in the thread; read as the member. */
  runStatus: (actor: Actor, threadId: string, runId: string) => Promise<string | null>;
  touch: (tokenId: string) => Promise<void>;
  /** Counts one for `key` this minute, shared by every instance; false past `limit`. */
  take: (key: string, limit: number) => Promise<boolean>;
  clientIp: (c: Context) => string | undefined;
  now?: () => number;
  streamMaxMs?: number;
};

/** The app's router as the bot API's client: errors are translated as the RPC handler does. */
export function dozoRouterConnector(router: ReturnType<typeof createRouter>) {
  return (context: DozoBotApiContext): DozoBotApiClient =>
    createRouterClient(router, {
      context,
      interceptors: [onError((error, { path, signal }) => handleRpcError(error, path, signal))],
    });
}

/** The production dependencies: tokens and runs in Postgres. */
export function dozoBotApiDeps(
  prisma: PrismaClient,
  router: ReturnType<typeof createRouter>,
  clientIp: DozoBotApiDeps["clientIp"],
): DozoBotApiDeps {
  return {
    authenticate: dozoTokenAuthenticator(prisma),
    connect: dozoRouterConnector(router),
    runStatus: async (actor, threadId, runId) =>
      (
        await runAsTenant(actor, () =>
          prisma.run.findFirst({
            where: { id: runId, threadId, spaceId: actor.spaceId },
            select: { status: true },
          }),
        )
      )?.status ?? null,
    touch: (tokenId) =>
      runAsSystem("mark an access token used", () => touchDozoAccessToken(prisma, tokenId)),
    take: (key, limit) =>
      runAsSystem("count bot API requests", () => takeDozoApiMinute(prisma, key, limit)),
    clientIp,
  };
}

const IdParam = z.string().min(1).max(200);
const Cursor = z.coerce.number().int().min(-1);
const SendBody = z.object({ text: z.string().trim().min(1).max(THREAD_MESSAGE_TEXT_MAX_LENGTH) });
const ExportQuery = z.object({
  since: IsoDate.optional(),
  timeZone: z.string().max(64).optional(),
});

class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 413 | 415 | 429,
    message: string,
  ) {
    super(message);
  }
}

/** A message as the API shows it: its Markdown text, never the cards that carry secrets. */
function apiMessage(message: ThreadMessage) {
  const text = messageBody(message);
  if (!text) return null;
  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    ...(message.botId ? { botId: message.botId } : {}),
    ...(message.author ? { author: message.author.name } : {}),
    ...(message.runId ? { runId: message.runId } : {}),
    createdAt: message.createdAt,
    text,
  };
}

/**
 * The bot API under /api/v1/dozo: list the bots, send one a message and follow the reply as
 * server-sent events, read the chat, and export it. Every call carries a personal access token as
 * a bearer and runs the app's own procedures as its member, in its Space, so access, approvals
 * and limits are the app's. A token limited to one bot sees only that bot. OpenAPI:
 * dozo/api/openapi.yaml.
 */
export function mountDozoBotApi(app: Hono, deps: DozoBotApiDeps) {
  const addresses = windowCounter(60_000, deps.now);
  const openStreams = new Map<string, number>();
  const streamMaxMs = deps.streamMaxMs ?? DOZO_BOT_API_STREAM_MAX_MS;

  type Caller = DozoTokenCaller & {
    client: DozoBotApiClient;
    context: Omit<DozoBotApiContext, "signal">;
  };

  const caller = async (c: Context): Promise<Caller> => {
    // Guessing tokens costs a lookup each: an address is held back before any is made.
    if (addresses(deps.clientIp(c) ?? "unknown") > DOZO_BOT_API_ADDRESS_PER_MINUTE)
      throw new ApiError(429, "Too many requests");
    const authorization = c.req.header("authorization");
    const found = await deps.authenticate(authorization);
    if (!found) throw new ApiError(401, "Unauthorized");
    if (!(await deps.take(`token:${found.tokenId}`, DOZO_BOT_API_REQUESTS_PER_MINUTE)))
      throw new ApiError(429, "Too many requests");
    enrichLogContext({ "user.id": found.actor.userId, "space.id": found.actor.spaceId });
    void bestEffort("bot api token last used", deps.touch(found.tokenId));
    const context = {
      actor: found.actor,
      stillAuthorized: async () =>
        (await deps.authenticate(authorization))?.tokenId === found.tokenId,
    };
    return { ...found, context, client: deps.connect({ ...context, signal: c.req.raw.signal }) };
  };

  /** The bot in the path, when the token may reach it; any other answers as a missing bot. */
  const botFor = (found: Caller, c: Context) => {
    const botId = IdParam.safeParse(c.req.param("botId"));
    if (!botId.success || (found.botId && found.botId !== botId.data))
      throw new ApiError(404, "Bot not found");
    return botId.data;
  };

  /** Holds one of the token's stream places until the stream closes. */
  const holdStream = (tokenId: string) => {
    const open = openStreams.get(tokenId) ?? 0;
    if (open >= DOZO_BOT_API_STREAMS_PER_TOKEN) throw new ApiError(429, "Too many open streams");
    openStreams.set(tokenId, open + 1);
    return () => {
      const left = (openStreams.get(tokenId) ?? 1) - 1;
      if (left > 0) openStreams.set(tokenId, left);
      else openStreams.delete(tokenId);
    };
  };

  const stream = (
    c: Context,
    found: Caller,
    input: {
      botId: string;
      runId: string;
      cursor: number;
      first?: DozoStreamFrame[];
      settled?: DozoSettledRun;
      /** A place already held for this stream; otherwise one is taken now. */
      release?: () => void;
    },
  ) => {
    const release = input.release ?? holdStream(found.tokenId);
    const body = dozoRunStream({
      runId: input.runId,
      first: input.first,
      settled: input.settled,
      signal: c.req.raw.signal,
      maxMs: streamMaxMs,
      onClose: release,
      // Its own client, so the stream's end (its time, or the reader leaving) ends the follow too.
      events: (signal) => ({
        async *[Symbol.asyncIterator]() {
          yield* await deps
            .connect({ ...found.context, signal })
            .threads.subscribe({ botId: input.botId, cursor: input.cursor }, { signal });
        },
      }),
    });
    return new Response(body, { headers: EVENT_STREAM_HEADERS });
  };

  const route =
    (handler: (c: Context, found: Caller) => Promise<Response>) => async (c: Context) => {
      try {
        return await handler(c, await caller(c));
      } catch (error) {
        if (error instanceof ApiError) {
          const headers: Record<string, string> = { "cache-control": "no-store" };
          if (error.status === 401) headers["www-authenticate"] = "Bearer";
          if (error.status === 429) headers["retry-after"] = "60";
          return c.json({ error: error.message }, error.status, headers);
        }
        // The app's own answer: its message for the caller's mistakes, a plain one for outages.
        if (error instanceof ORPCError && error.status !== 500) {
          const message = error.status < 500 ? error.message : "Try again later";
          return c.json({ error: message }, error.status as 400, { "cache-control": "no-store" });
        }
        throw error;
      }
    };

  const json = (c: Context, value: unknown, status: 200 | 202 = 200) =>
    c.json(value, status, { "cache-control": "no-store" });

  app.get(
    `${DOZO_BOT_API_PREFIX}/bots`,
    route(async (c, found) => {
      const bots = await found.client.bots.list();
      return json(c, {
        bots: bots
          .filter((bot) => !found.botId || bot.id === found.botId)
          .map((bot) => ({ id: bot.id, name: bot.name })),
      });
    }),
  );

  app.post(
    `${DOZO_BOT_API_PREFIX}/bots/:botId/messages`,
    route(async (c, found) => {
      const botId = botFor(found, c);
      // JSON only: a page on another site cannot send that without asking the browser first.
      if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json"))
        throw new ApiError(415, "Send JSON");
      const raw = await readBoundedBody(c.req.raw, MAX_BODY_BYTES);
      if (raw === null) throw new ApiError(413, "Message is too large");
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        throw new ApiError(400, "Body is not JSON");
      }
      const body = SendBody.safeParse(parsedJson);
      if (!body.success) throw new ApiError(400, "Give the message as text");
      // In the app a stop word stops every run in the chat, the owner's too; a token may not.
      if (isStopMessage({ text: body.data.text })) throw new ApiError(400, "Stop a run in the app");
      if (!(await deps.take(`sends:${found.actor.userId}`, DOZO_BOT_API_SENDS_PER_MINUTE)))
        throw new ApiError(429, "Too many messages");
      const key = c.req.header("idempotency-key")?.trim();
      if (key && key.length > 190) throw new ApiError(400, "Idempotency-Key is too long");
      // The stream's place is taken before the send, so a refused stream never sent anything.
      const streaming = c.req.header("accept")?.includes("text/event-stream") === true;
      const release = streaming ? holdStream(found.tokenId) : undefined;
      let sent: Awaited<ReturnType<DozoBotApiClient["threads"]["send"]>>;
      try {
        sent = await found.client.threads.send({
          botId,
          text: body.data.text,
          // Always marked as sent with a token (the run gate reads it); a retried request with
          // the same key is the same message, not a second one.
          clientNonce: dozoTokenNonce(key || randomUUID()),
        });
      } catch (error) {
        release?.();
        throw error;
      }
      const started = { runId: sent.runId, seq: sent.seq };
      if (!release) return json(c, started, 202);
      return stream(c, found, {
        botId,
        runId: sent.runId,
        cursor: sent.seq,
        first: [{ id: sent.seq, event: "run", data: started }],
        release,
      });
    }),
  );

  app.get(
    `${DOZO_BOT_API_PREFIX}/bots/:botId/runs/:runId/events`,
    route(async (c, found) => {
      const botId = botFor(found, c);
      const runId = IdParam.safeParse(c.req.param("runId"));
      const after = c.req.header("last-event-id") ?? c.req.query("after");
      const cursor = after === undefined ? undefined : Cursor.safeParse(after);
      if (!runId.success || cursor?.success === false)
        throw new ApiError(400, "Give a run id and a whole number for after");
      const head = await found.client.threads.head({ botId });
      const status = await deps.runStatus(found.actor, head.threadId, runId.data);
      if (!status) throw new ApiError(404, "Run not found");
      const settled = DOZO_SETTLED_RUN_STATUSES.has(status);
      // A settled run with nothing after the client's place has only its status to say, so a
      // client that reconnects after the last frame is answered at once instead of held open.
      if (settled && (cursor === undefined || cursor.data >= head.cursor))
        return new Response(sseFrame({ event: "status", data: { status } }), {
          headers: EVENT_STREAM_HEADERS,
        });
      return stream(c, found, {
        botId,
        runId: runId.data,
        cursor: cursor?.data ?? head.cursor,
        // The events up to now are replayed, then the stream ends with the run's status.
        ...(settled ? { settled: { status, headSeq: head.cursor } } : {}),
      });
    }),
  );

  app.get(
    `${DOZO_BOT_API_PREFIX}/bots/:botId/messages`,
    route(async (c, found) => {
      const botId = botFor(found, c);
      const before = c.req.query("before");
      const cursor = before === undefined ? undefined : Cursor.safeParse(before);
      if (cursor?.success === false || (cursor?.data ?? 0) < 0)
        throw new ApiError(400, "before must be a whole number");
      const page = await found.client.threads.messages({ botId, before: cursor?.data });
      return json(c, {
        messages: page.messages.flatMap((message) => apiMessage(message) ?? []),
        before: page.olderCursor ?? null,
      });
    }),
  );

  app.get(
    `${DOZO_BOT_API_PREFIX}/bots/:botId/export`,
    route(async (c, found) => {
      const botId = botFor(found, c);
      const query = ExportQuery.safeParse(c.req.query());
      if (!query.success) throw new ApiError(400, "since must be an ISO date");
      return json(c, await found.client.dozoChatExport.markdown({ botId, ...query.data }));
    }),
  );
}
