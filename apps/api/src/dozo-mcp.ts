import type { RouterClient as OrpcRouterClient } from "@orpc/server";
import { createRouterClient, ORPCError, onError } from "@orpc/server";
import type { DozoMcpOperations, DozoMcpSendResult } from "@rakazo/adapters";
import {
  DOZO_MCP_CHAT_MAX_CHARS,
  DOZO_MCP_REPLY_MAX_CHARS,
  handleDozoMcpRequest,
} from "@rakazo/adapters";
import type { Actor, ProductEvent } from "@rakazo/contracts";
import { ClientError, deadlineSignal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError, requireMembership, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import { exportChat } from "./dozo-chat-export.js";
import { blockMarkdown } from "./dozo-chat-markdown.js";
import type { DozoTokenGrant, DozoTokenVerifier } from "./dozo-token-grant.js";
import { requestBodyLimit } from "./request-body-limit.js";
import type { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";
import { throttleKey, windowCounter } from "./window-counter.js";

export const DOZO_MCP_PATH = "/api/v1/dozo/mcp";
/** RFC 9728: the endpoint's path inserted after the well-known prefix. */
export const DOZO_MCP_METADATA_PATH = `/.well-known/oauth-protected-resource${DOZO_MCP_PATH}`;

/** One JSON-RPC message; a bot's message is at most 16,000 characters of it. */
export const DOZO_MCP_MAX_BODY_BYTES = 64 * 1024;
/** How long a send waits for the bot's answer before it says the bot is still working. */
export const DOZO_MCP_REPLY_WAIT_MS = 45_000;

const MINUTE_MS = 60_000;
// Burst guards, counted per API instance: a token's requests, the messages one bot gets, and the
// refused tokens one address presents. Model use is limited by the account's plan, as in the app.
const REQUESTS_PER_MINUTE = 120;
const SENDS_PER_BOT_PER_MINUTE = 10;
const SENDS_PER_TOKEN_PER_MINUTE = 30;
const REFUSED_PER_ADDRESS_PER_MINUTE = 20;
const MAX_LOCKED_ADDRESSES = 10_000;

type Router = ReturnType<typeof createRouter>;
type RouterClient = OrpcRouterClient<Router>;

export type DozoMcpDeps = {
  prisma: PrismaClient;
  router: Router;
  verify: DozoTokenVerifier;
  /** The origin clients reach the API at, as the web app's own proxy serves it. */
  publicOrigin: string;
  trustedOrigin: (origin: string) => boolean;
  clientIp: (c: Context) => string | undefined;
  version: string;
  now?: () => number;
};

/**
 * The MCP endpoint, for outside clients acting with one person's access token. It is an OAuth
 * resource server only: the token is made in the app, and the metadata names no authorization
 * server. Every request is authenticated on its own, as the protocol's stateless mode expects.
 */
export function mountDozoMcp(app: Hono, deps: DozoMcpDeps) {
  const now = deps.now ?? Date.now;
  const requests = windowCounter(MINUTE_MS, now);
  const sends = windowCounter(MINUTE_MS, now);
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
    const token = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1];
    if (!token) return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": challenge() });
    // An address that keeps presenting refused tokens waits a minute before any is looked up.
    if (locked(address)) return tooMany(c);
    const grant = await deps.verify(token);
    const owner = grant && (await tokenOwner(deps.prisma, grant));
    if (!grant || !owner) {
      if (refused(address) >= REFUSED_PER_ADDRESS_PER_MINUTE) lock(address);
      return c.json({ error: "invalid_token" }, 401, {
        "WWW-Authenticate": challenge(', error="invalid_token"'),
      });
    }
    if (requests(`token:${grant.id}`) > REQUESTS_PER_MINUTE) return tooMany(c);
    const signal = c.req.raw.signal;
    const client = createRouterClient(deps.router, {
      context: {
        actor: owner,
        signal,
        // A token revoked, or an owner removed from the Space, while a send waits ends the wait.
        stillAuthorized: async () => {
          const current = await deps.verify(token);
          return current?.id === grant.id && Boolean(await tokenOwner(deps.prisma, current));
        },
      },
      interceptors: [onError((error, { path }) => handleRpcError(error, path, signal))],
    });
    const operations = dozoMcpOperations(deps.prisma, owner, grant.botId, client, (botId) => {
      if (
        sends(`bot:${botId}`) > SENDS_PER_BOT_PER_MINUTE ||
        sends(`token:${grant.id}`) > SENDS_PER_TOKEN_PER_MINUTE
      )
        throw new ClientError("TOO_MANY_REQUESTS", "Too many messages to this bot. Wait a minute.");
    });
    getLogger().info("dozo.mcp.request", { "token.id": grant.id, "user.id": owner.userId });
    return handleDozoMcpRequest(c.req.raw, operations, { version: deps.version });
  });
}

/** The token's owner, still a member of its Space and still allowed to use the account. */
async function tokenOwner(prisma: PrismaClient, grant: DozoTokenGrant): Promise<Actor | null> {
  const user = await prisma.user.findUnique({
    where: { id: grant.userId },
    select: { id: true, email: true, deactivatedAt: true },
  });
  if (!user || user.deactivatedAt) return null;
  return requireMembership(prisma, user, grant.spaceId).catch((error: unknown) => {
    if (error instanceof IsolationError) return null;
    throw error;
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
  client: RouterClient,
  countSend: (botId: string) => void,
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
        await ownBot(botId);
        countSend(botId);
        const sent = await client.threads.send({ botId, text }, { signal });
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
  client: RouterClient,
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

/** What the bot said in the run, as the chat shows it, within the reply's size limit. */
async function reply(
  client: RouterClient,
  botId: string,
  runId: string,
): Promise<DozoMcpSendResult> {
  const page = await client.threads.messages({ botId });
  const text = page.messages
    .filter((message) => message.role === "bot" && message.runId === runId)
    .flatMap((message) => message.blocks.flatMap((block) => blockMarkdown(block) ?? []))
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
