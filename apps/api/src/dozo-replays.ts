import { randomUUID } from "node:crypto";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import { hasSiteSessions, listSiteSessions, toComputerRef } from "@rakazo/adapters";
import type { Actor, DozoReplayDraftStep, DozoShareLink } from "@rakazo/contracts";
import {
  DOZO_REPLAY_KIND,
  DOZO_SHARE_LINK_API_PREFIX,
  DOZO_SHARE_LINK_WEB_PREFIX,
  DOZO_SHARE_LINKS_LIVE_MAX,
  storedImageMimeType,
} from "@rakazo/contracts";
import { ClientError, deadlineSignal } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { Context, Hono } from "hono";
import type { OwnReply, ReplaySelection } from "./dozo-replay-kind.js";
import { findOwnReply, replayFrame, stepsOf } from "./dozo-replay-kind.js";
import { framesLeftOut } from "./dozo-replay-steps.js";
import { createShareLink, openSharedLink } from "./dozo-share-links.js";
import { throttleKey, windowCounter } from "./http/window-counter.js";
import type { RouterContext } from "./routes/context.js";

const SITE_SESSIONS_WAIT_MS = 5_000;
const MINUTE_MS = 60_000;
const FRAME_READS_PER_IP_PER_MINUTE = 240;
const FRAME_INDEX = /^\d{1,3}$/;
const HEADERS = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
};

type Deps = RouterContext["deps"];

/**
 * The reply cannot be published by the caller: not theirs, not in their own chat with their own
 * bot, not finished, without steps, or not there at all. Each is the same answer.
 */
export class ReplayUnavailableError extends ClientError {
  constructor() {
    super(
      "NOT_FOUND",
      "Only a finished reply in your own chat with your bot can be shared",
      "REPLAY_UNAVAILABLE",
    );
  }
}

async function ownReply(prisma: PrismaClient, actor: Actor, messageId: string): Promise<OwnReply> {
  const reply = await findOwnReply(prisma, actor, messageId);
  if (!reply) throw new ReplayUnavailableError();
  return reply;
}

/**
 * The sites the bot's browser is signed in to, while its computer runs and can tell; none
 * otherwise. Only the review's starting choices read it, so a slow or failed answer is no answer.
 */
async function signedInSites(deps: Deps, actor: Actor, botId: string): Promise<string[]> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId },
    select: { computer: true },
  });
  const computer = bot?.computer;
  if (!computer?.providerRef || computer.state !== "running" || !hasSiteSessions(computer.kind))
    return [];
  const context = {
    ...createAdapterContext(actor, botId, "replay.site-sessions"),
    signal: deadlineSignal(SITE_SESSIONS_WAIT_MS),
  };
  const sites = await bestEffort(
    "read signed-in sites for a replay review",
    listSiteSessions(deps.sandbox, toComputerRef(computer), botId, context),
  );
  return (sites ?? []).map((session) => session.site.toLowerCase());
}

async function frameDataUrl(
  deps: Deps,
  actor: Actor,
  reply: OwnReply,
  artifactId: string,
): Promise<string | null> {
  const artifact = await deps.prisma.artifact.findFirst({
    where: { id: artifactId, spaceId: actor.spaceId, runId: reply.runId },
    select: { storageKey: true, mimeType: true },
  });
  const mimeType = artifact && storedImageMimeType(artifact.mimeType);
  if (!artifact || !mimeType) return null;
  const bytes = await deps.artifacts.get(
    artifact.storageKey,
    createAdapterContext(actor, reply.botId, "replay.preview-frame"),
  );
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** The member's live replay links to this reply, newest first. */
async function replyLinks(
  prisma: PrismaClient,
  actor: Actor,
  messageId: string,
): Promise<DozoShareLink[]> {
  const rows = await prisma.$queryRaw<
    Array<Pick<DozoShareLink, "id" | "kind" | "targetId"> & { createdAt: Date; expiresAt: Date }>
  >`
    SELECT l."id", l."kind", l."targetId", l."createdAt" AT TIME ZONE 'UTC' AS "createdAt",
      l."expiresAt" AT TIME ZONE 'UTC' AS "expiresAt"
    FROM dozo_share_links l JOIN dozo_replays r ON r."id" = l."targetId"
    WHERE l."kind" = ${DOZO_REPLAY_KIND} AND r."messageId" = ${messageId}
      AND l."userId" = ${actor.userId} AND l."spaceId" = ${actor.spaceId}
      AND l."revokedAt" IS NULL AND l."expiresAt" > CURRENT_TIMESTAMP
    ORDER BY l."createdAt" DESC, l."id" DESC LIMIT ${DOZO_SHARE_LINKS_LIVE_MAX}`;
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: null,
  }));
}

/**
 * Everything of the reply a replay could show, for its owner to review: each step's line, its
 * screenshot, and whether that screenshot starts left out.
 */
export async function previewReplay(
  deps: Deps,
  actor: Actor,
  messageId: string,
): Promise<{ steps: DozoReplayDraftStep[]; links: DozoShareLink[] }> {
  const reply = await ownReply(deps.prisma, actor, messageId);
  const sites = await signedInSites(deps, actor, reply.botId);
  const steps = stepsOf(reply, sites);
  if (steps.length === 0) throw new ReplayUnavailableError();
  const leftOut = framesLeftOut(steps);
  const drafts = await Promise.all(
    steps.map(async (step, index) => ({
      line: step.line,
      frame: step.frameArtifactId
        ? await frameDataUrl(deps, actor, reply, step.frameArtifactId)
        : null,
      sensitive: leftOut[index] ?? true,
    })),
  );
  return { steps: drafts, links: await replyLinks(deps.prisma, actor, messageId) };
}

/**
 * Publishes the reply's steps but those left out as a new replay and its link, with the
 * screenshots of the chosen steps only. Only positions are kept. A link the member cannot have
 * (too many live) takes its replay with it.
 */
export async function publishReplay(
  prisma: PrismaClient,
  actor: Actor,
  input: { messageId: string; omit: number[]; frames: number[]; days: number },
) {
  const reply = await ownReply(prisma, actor, input.messageId);
  const omit = new Set(input.omit);
  const frames = new Set(input.frames);
  const selection: ReplaySelection = stepsOf(reply).flatMap((step, index) =>
    omit.has(index) ? [] : [{ index, frame: frames.has(index) && Boolean(step.frameArtifactId) }],
  );
  if (selection.length === 0) throw new ReplayUnavailableError();
  const id = randomUUID();
  await prisma.$executeRaw`
    INSERT INTO dozo_replays ("id", "userId", "spaceId", "botId", "messageId", "steps")
    VALUES (${id}, ${actor.userId}, ${actor.spaceId}, ${reply.botId}, ${reply.id},
      ${JSON.stringify(selection)}::jsonb)`;
  try {
    return await createShareLink(prisma, actor, {
      kind: DOZO_REPLAY_KIND,
      targetId: id,
      days: input.days,
    });
  } catch (error) {
    await bestEffort(
      "remove a replay whose link was not made",
      prisma.$executeRaw`DELETE FROM dozo_replays WHERE "id" = ${id}`,
    );
    throw error;
  }
}

export function dozoReplayRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoReplays: {
      preview: authed.dozoReplays.preview.handler(({ context, input }) =>
        previewReplay(deps, context.actor, input.messageId),
      ),
      publish: authed.dozoReplays.publish.handler(async ({ context, input }) => {
        const { link, token } = await publishReplay(deps.prisma, context.actor, input);
        const url = new URL(`${DOZO_SHARE_LINK_WEB_PREFIX}${token}`, deps.env.webOrigin).href;
        return { link, url };
      }),
    },
  };
}

/**
 * A replay's screenshots, for anyone holding its link: `<link's read address>/frames/<n>`, the
 * numbers its payload names. Every refusal is the same 404 as the link's own read.
 */
export function mountDozoReplayFrames(
  app: Hono,
  prisma: PrismaClient,
  clientIp: (c: Context) => string | undefined,
  artifacts: ArtifactStore,
) {
  const reads = windowCounter(MINUTE_MS);
  app.get(`${DOZO_SHARE_LINK_API_PREFIX}:token/frames/:n`, async (c) => {
    if (reads(throttleKey(clientIp(c))) > FRAME_READS_PER_IP_PER_MINUTE) {
      return c.json({ error: "Too many requests" }, 429, { ...HEADERS, "retry-after": "60" });
    }
    const n = c.req.param("n");
    const opened = FRAME_INDEX.test(n) ? await openSharedLink(prisma, c.req.param("token")) : null;
    const frame =
      opened?.kind === DOZO_REPLAY_KIND
        ? await runAsSystem("replay frame read", () => replayFrame(prisma, opened.target, Number(n)))
        : null;
    const mimeType = frame && storedImageMimeType(frame.mimeType);
    if (!frame || !mimeType || !opened) return c.json({ error: "Not found" }, 404, HEADERS);
    const { spaceId, userId } = opened.target;
    const operationId = "replay-frame-read";
    const bytes = await artifacts.get(frame.storageKey, {
      operationId,
      traceId: operationId,
      spaceId,
      userId,
      signal: new AbortController().signal,
    });
    return c.body(new Uint8Array(bytes), 200, {
      ...HEADERS,
      "content-type": mimeType,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    });
  });
}
