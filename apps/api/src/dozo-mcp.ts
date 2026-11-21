import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { DozoMcpOperations, DozoMcpSendResult } from "@rakazo/adapters";
import {
  DOZO_MCP_CHAT_MAX_CHARS,
  DOZO_MCP_REPLY_MAX_CHARS,
  handleDozoMcpRequest,
} from "@rakazo/adapters";
import type { Actor, ProductEvent } from "@rakazo/contracts";
import { ClientError, deadlineSignal, dozoTokenNonce } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsTenant } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import type { DozoBotApiClient, DozoBotApiDeps } from "./dozo-bot-api.js";
import {
  DOZO_BOT_API_REQUESTS_PER_MINUTE,
  DOZO_BOT_API_SENDS_PER_MINUTE,
  DOZO_BOT_API_TOKEN_SENDS_PER_MINUTE,
  dozoBotApiDeps,
} from "./dozo-bot-api.js";
import { exportChat } from "./dozo-chat-export.js";
import { messageBody } from "./dozo-chat-markdown.js";
import { requestBodyLimit } from "./request-body-limit.js";
import type { createRouter } from "./router.js";
import { isStopMessage } from "./thread-stop.js";
import { throttleKey, windowCounter } from "./window-counter.js";

export const DOZO_MCP_PATH = "/api/v1/dozo/mcp";
/** RFC 9728: the endpoint's path inserted after the well-known prefix. */
export const DOZO_MCP_METADATA_PATH = `/.well-known/oauth-protected-resource${DOZO_MCP_PATH}`;

/** One JSON-RPC message; a bot's message is at most 16,000 characters of it. */
export const DOZO_MCP_MAX_BODY_BYTES = 64 * 1024;
/** How long a send waits for the bot's answer before it says the bot is still working. */
export const DOZO_MCP_REPLY_WAIT_MS = 45_000;

const MINUTE_MS = 60_000;
// Refused tokens one address presents, counted in this instance before any lookup. A token's
// requests and an account's messages share the Bot API's budgets, counted across instances.
const REFUSED_PER_ADDRESS_PER_MINUTE = 20;
const MAX_LOCKED_ADDRESSES = 10_000;

/** The Bot API's token check and in-process client, which this endpoint shares. */
export type DozoMcpDeps = Pick<
  DozoBotApiDeps,
  "authenticate" | "connect" | "touch" | "take" | "clientIp"
> & {
  prisma: PrismaClient;
  /** The origin clients reach the API at, as the web app's own proxy serves it. */
  publicOrigin: string;
  trustedOrigin: (origin: string) => boolean;
  version: string;
  now?: () => number;
};

/** The production dependencies: the Bot API's tokens and the app's own procedures. */
export function dozoMcpDeps(
  prisma: PrismaClient,
  router: ReturnType<typeof createRouter>,
  options: Omit<DozoMcpDeps, "authenticate" | "connect" | "touch" | "take" | "prisma">,
): DozoMcpDeps {
  const { authenticate, connect, touch, take } = dozoBotApiDeps(prisma, router, options.clientIp);
  return { authenticate, connect, touch, take, prisma, ...options };
}

/**
 * The MCP endpoint, for outside clients acting with one person's access token. It is an OAuth
 * resource server only: the token is made in the app, and the metadata names no authorization
 * server. Every request is authenticated on its own, as the protocol's stateless mode expects.
 */
export function mountDozoMcp(app: Hono, deps: DozoMcpDeps) {
  const now = deps.now ?? Date.now;
  const refused = windowCounter(MINUTE_MS, now);
  // Addresses past the refusal limit, until when: checked before a presented token is looked up.
  const lockedUntil = new Map<string, number>();
  const locked = (address: string) => {
    const until = lockedUntil.get(address);
    if (until !== undefined && until <= now()) lockedUntil.delete(address);
    return until !== undefined && until > now();
  };
  const lock = (address: string) => {
    if (lockedUntil.size >= MAX_LOCKED_ADDRESSES) {
      const oldest = lockedUntil.keys().next().value;
      if (oldest !== undefined) lockedUntil.delete(oldest);
    }
    lockedUntil.set(address, now() + MINUTE_MS);
  };
  const resource = new URL(DOZO_MCP_PATH, deps.publicOrigin).href;
  const metadata = new URL(DOZO_MCP_METADATA_PATH, deps.publicOrigin).href;
  const challenge = (extra = "") => `Bearer resource_metadata="${metadata}"${extra}`;

  app.get(DOZO_MCP_METADATA_PATH, (c) =>
    c.json({ resource, bearer_methods_supported: ["header"] }),
  );

  app.use(DOZO_MCP_PATH, requestBodyLimit(DOZO_MCP_MAX_BODY_BYTES));
  app.all(DOZO_MCP_PATH, async (c) => {
    // A web page may not drive this endpoint through someone's browser (DNS rebinding included).
    const origin = c.req.header("origin");
    if (origin && !deps.trustedOrigin(origin)) return jsonRpcError(c, 403, "Origin not allowed");
    const address = throttleKey(deps.clientIp(c));
    const authorization = c.req.header("authorization");
    if (!authorization?.trim())
      return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": challenge() });
    // An address that keeps presenting refused tokens waits a minute before any is looked up.
    if (locked(address)) return tooMany(c);
    const caller = await deps.authenticate(authorization);
    if (!caller) {
      if (refused(address) >= REFUSED_PER_ADDRESS_PER_MINUTE) lock(address);
      return c.json({ error: "invalid_token" }, 401, {
        "WWW-Authenticate": challenge(', error="invalid_token"'),
      });
    }
    const { tokenId, actor } = caller;
    if (!(await deps.take(`token:${tokenId}`, DOZO_BOT_API_REQUESTS_PER_MINUTE))) return tooMany(c);
    void bestEffort("mcp token last used", deps.touch(tokenId));
    const client = deps.connect({
      actor,
      signal: c.req.raw.signal,
      // A token revoked, or its owner deactivated, while a send waits ends the wait.
      stillAuthorized: async () => (await deps.authenticate(authorization))?.tokenId === tokenId,
    });
    const operations = dozoMcpOperations(deps.prisma, actor, caller.botId, client, async () => {
      // The same two budgets as a Bot API send: this token's share, and the account's total.
      if (
        !(await deps.take(`sends:token:${tokenId}`, DOZO_BOT_API_TOKEN_SENDS_PER_MINUTE)) ||
        !(await deps.take(`sends:${actor.userId}`, DOZO_BOT_API_SENDS_PER_MINUTE))
      )
        throw new ClientError("TOO_MANY_REQUESTS", "Too many messages. Wait a minute.");
    });
    getLogger().info("dozo.mcp.request", { "token.id": tokenId, "user.id": actor.userId });
    return handleDozoMcpRequest(c.req.raw, operations, { version: deps.version });
  });
}

/**
 * What the token's owner may do, through the app's own procedures: the same access checks, plan
 * limits and validation as a message typed in the app. Only bots the owner made are reachable, and
 * only the one bot when the token is for one.
 */
export function dozoMcpOperations(
  prisma: PrismaClient,
  actor: Actor,
  onlyBotId: string | null,
  client: DozoBotApiClient,
  countSend: () => Promise<void>,
): DozoMcpOperations {
  // Bots are rows of the owner's Space: read them as the owner, as the app's procedures do.
  const asOwner = <T>(work: () => Promise<T>) => refusals(() => runAsTenant(actor, work));
  const reachable = { spaceId: actor.spaceId, userId: actor.userId, archivedAt: null };
  const ownBot = async (botId: string) => {
    const bot =
      (onlyBotId === null || onlyBotId === botId) &&
      (await prisma.bot.findFirst({ where: { id: botId, ...reachable }, select: { id: true } }));
    if (!bot) throw new ClientError("NOT_FOUND", "No such bot.");
  };
  return {
    listBots: () =>
      asOwner(async () => {
        const [bots, own] = await Promise.all([
          client.bots.list(),
          prisma.bot.findMany({
            where: { ...reachable, ...(onlyBotId === null ? {} : { id: onlyBotId }) },
            select: { id: true },
          }),
        ]);
        const ids = new Set(own.map((bot) => bot.id));
        return bots
          .filter((bot) => ids.has(bot.id))
          .map((bot) => ({ id: bot.id, name: bot.name, description: bot.description }));
      }),
    sendMessage: (botId, text, signal) =>
      asOwner(async () => {
        // In the app a stop word stops every run in the chat, the owner's too; a token may not.
        if (isStopMessage({ text })) throw new ClientError("BAD_REQUEST", "Stop a run in the app.");
        await ownBot(botId);
        await countSend();
        // The token mark: the run this message starts or reaches asks before any outside effect,
        // and nothing it names is taken as the owner's own word (dozo-token-run.ts).
        const sent = await client.threads.send(
          { botId, text, clientNonce: dozoTokenNonce(randomUUID()) },
          { signal },
        );
        const outcome = await runOutcome(client, botId, sent, signal);
        if (outcome !== "completed") return { status: outcome };
        return reply(client, botId, sent.runId);
      }),
    readChat: (botId) =>
      asOwner(async () => {
        await ownBot(botId);
        const chat = await exportChat(prisma, actor, { botId }, DOZO_MCP_CHAT_MAX_CHARS);
        return { markdown: chat.markdown };
      }),
  };
}

type WaitOutcome = "completed" | "working" | "waiting_for_you" | "failed";

/**
 * Follows the chat from the sent message until its run ends or waits on its person. A question or
 * an approval is answered in the app, so the call returns at once rather than hold the client.
 */
async function runOutcome(
  client: DozoBotApiClient,
  botId: string,
  sent: { runId: string; seq: number },
  signal: AbortSignal,
): Promise<WaitOutcome> {
  const deadline = deadlineSignal(DOZO_MCP_REPLY_WAIT_MS, signal);
  try {
    const events = await client.threads.subscribe(
      { botId, cursor: sent.seq },
      { signal: deadline },
    );
    for await (const event of events) {
      const outcome = eventOutcome(event, sent.runId);
      if (outcome) return outcome;
    }
  } catch (error) {
    if (!deadline.aborted) throw error;
  }
  return "working";
}

function eventOutcome(event: ProductEvent, runId: string): WaitOutcome | undefined {
  if (event.runId !== runId) return undefined;
  switch (event.type) {
    case "run.completed":
      return "completed";
    case "run.failed":
    case "run.cancelled":
      return "failed";
    case "run.waiting_input":
    case "computer.takeover.requested":
      return "waiting_for_you";
    default:
      return undefined;
  }
}

/**
 * What the bot said in the run, as the chat shows it, within the reply's size limit. Only the
 * newest page is read: a run that wrote more than a page loses its start here, not in the chat.
 */
async function reply(
  client: DozoBotApiClient,
  botId: string,
  runId: string,
): Promise<DozoMcpSendResult> {
  const page = await client.threads.messages({ botId });
  const text = page.messages
    .filter((message) => message.role === "bot" && message.runId === runId)
    .flatMap((message) => messageBody(message) ?? [])
    .join("\n\n");
  const truncated = text.length > DOZO_MCP_REPLY_MAX_CHARS;
  return {
    status: "replied",
    reply: truncated ? text.slice(0, DOZO_MCP_REPLY_MAX_CHARS) : text,
    truncated,
  };
}

/** The app's answer to a refused call, as a refusal the client is told about. */
async function refusals<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ORPCError && error.status < 500)
      throw new ClientError(refusalKind(error.status), error.message, error.code, { cause: error });
    throw error;
  }
}

function refusalKind(status: number) {
  if (status === 403) return "FORBIDDEN" as const;
  if (status === 404) return "NOT_FOUND" as const;
  if (status === 409) return "CONFLICT" as const;
  if (status === 429) return "TOO_MANY_REQUESTS" as const;
  return "BAD_REQUEST" as const;
}

function tooMany(c: Context) {
  return jsonRpcError(c, 429, "Too many requests", { "Retry-After": "60" });
}

function jsonRpcError(
  c: Context,
  status: 403 | 429,
  message: string,
  headers?: Record<string, string>,
) {
  return c.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, status, headers);
}
