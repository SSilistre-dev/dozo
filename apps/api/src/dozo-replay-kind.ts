import type { Actor, DozoReplayPayload } from "@rakazo/contracts";
import { isStepScreenshotMimeType } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  mayBeChannelMessage,
  readJsonColumn,
  storedMessageBlocks,
  withDozoChatBot,
} from "@rakazo/db";
import * as z from "zod";
import type { ReplayStep } from "./dozo-replay-steps.js";
import { parseToolHistory, replaySteps } from "./dozo-replay-steps.js";
import type { DozoShareKind, DozoShareTarget } from "./dozo-share-links.js";

const FINISHED_RUN = ["completed", "failed", "cancelled"];

/** What a published replay keeps: positions in the reply's steps, never their text. */
export const ReplaySelectionSchema = z
  .array(z.object({ index: z.number().int().nonnegative(), frame: z.boolean() }))
  .min(1);
export type ReplaySelection = z.infer<typeof ReplaySelectionSchema>;

export type OwnReply = {
  id: string;
  botId: string;
  runId: string;
  blocks: unknown;
  toolHistory: string | null;
};

/**
 * The finished bot reply `messageId`, when `actor` may publish it: a reply to a run they started,
 * in their own one-to-one chat (main or extra) with a bot of their own. Group chats, messaging-app
 * chats, helper chats, other members' bots and replies to other members' runs are all null.
 */
export async function findOwnReply(
  prisma: PrismaClient,
  actor: Actor,
  messageId: string,
): Promise<OwnReply | null> {
  const message = await prisma.message.findFirst({
    where: { id: messageId, role: "bot", thread: { spaceId: actor.spaceId } },
    select: {
      id: true,
      threadId: true,
      botId: true,
      runId: true,
      blocks: true,
      toolHistory: true,
    },
  });
  if (!message?.botId || !message.runId || mayBeChannelMessage(message)) return null;
  const thread = await withDozoChatBot(
    prisma,
    message.threadId,
    await prisma.thread.findFirst({
      where: { id: message.threadId, spaceId: actor.spaceId },
      select: {
        botId: true,
        userId: true,
        groupId: true,
        helperBotId: true,
        externalConversationId: true,
      },
    }),
  );
  if (
    !thread ||
    thread.groupId ||
    thread.helperBotId ||
    thread.externalConversationId ||
    thread.userId !== actor.userId ||
    thread.botId !== message.botId
  )
    return null;
  const [bot, run] = await Promise.all([
    prisma.bot.findFirst({
      where: { id: message.botId, spaceId: actor.spaceId, userId: actor.userId },
      select: { id: true },
    }),
    prisma.run.findFirst({
      where: { id: message.runId, spaceId: actor.spaceId },
      select: { userId: true, status: true },
    }),
  ]);
  if (!bot || run?.userId !== actor.userId || !FINISHED_RUN.includes(run.status)) return null;
  return {
    id: message.id,
    botId: message.botId,
    runId: message.runId,
    blocks: message.blocks,
    toolHistory: message.toolHistory,
  };
}

export function stepsOf(
  reply: Pick<OwnReply, "id" | "blocks" | "toolHistory">,
  signedInSites?: readonly string[],
): ReplayStep[] {
  return replaySteps(
    storedMessageBlocks(reply),
    parseToolHistory(reply.toolHistory),
    signedInSites,
  );
}

type ReplayRow = { userId: string; spaceId: string; messageId: string; steps: unknown };

async function replayRow(prisma: PrismaClient, id: string): Promise<ReplayRow | undefined> {
  const [row] = await prisma.$queryRaw<ReplayRow[]>`
    SELECT "userId", "spaceId", "messageId", "steps" FROM dozo_replays WHERE "id" = ${id}`;
  return row;
}

/** The published steps of a replay, read as the system, each with its screenshot if it kept one. */
async function publishedSteps(prisma: PrismaClient, link: DozoShareTarget) {
  const row = await replayRow(prisma, link.targetId);
  if (!row || row.userId !== link.userId || row.spaceId !== link.spaceId) return null;
  const selection = readJsonColumn(
    ReplaySelectionSchema,
    row.steps,
    { table: "dozo_replays", column: "steps", id: link.targetId },
    "reject",
  );
  const reply = await prisma.message.findUnique({
    where: { id: row.messageId },
    select: { id: true, runId: true, blocks: true, toolHistory: true },
  });
  if (!reply) return null;
  const steps = stepsOf(reply);
  return {
    runId: reply.runId,
    steps: selection.flatMap(({ index, frame }) => {
      const step = steps[index];
      return step
        ? [{ line: step.line, frameArtifactId: frame ? step.frameArtifactId : undefined }]
        : [];
    }),
  };
}

/**
 * A replay link: its maker must still be the bot's owner with the reply in their own chat, so
 * deleting the reply or the bot, or losing either, closes it. The payload is each kept step's line
 * and its screenshot's number, which the frame route serves under the same link.
 */
export const dozoReplayKind: DozoShareKind = {
  async canShare(prisma, actor, targetId) {
    const row = await replayRow(prisma, targetId);
    if (!row || row.userId !== actor.userId || row.spaceId !== actor.spaceId) return false;
    return (await findOwnReply(prisma, actor, row.messageId)) !== null;
  },
  async load(prisma, link): Promise<DozoReplayPayload | null> {
    const published = await publishedSteps(prisma, link);
    if (!published) return null;
    let frames = 0;
    return {
      steps: published.steps.map((step) => ({
        line: step.line,
        frame: step.frameArtifactId ? frames++ : null,
      })),
    };
  },
};

/**
 * The stored screenshot behind frame `n` of a replay, read as the system: only one the reply's own
 * run kept in the link's Space, and only one its owner chose to publish.
 */
export async function replayFrame(
  prisma: PrismaClient,
  link: DozoShareTarget,
  n: number,
): Promise<{ storageKey: string; mimeType: string; spaceId: string } | null> {
  const published = await publishedSteps(prisma, link);
  const artifactId = published?.steps.flatMap((step) =>
    step.frameArtifactId ? [step.frameArtifactId] : [],
  )[n];
  if (!published || !artifactId) return null;
  const artifact = await prisma.artifact.findFirst({
    where: { id: artifactId, spaceId: link.spaceId, runId: published.runId ?? "" },
    select: { storageKey: true, mimeType: true, spaceId: true },
  });
  return artifact && isStepScreenshotMimeType(artifact.mimeType) ? artifact : null;
}
