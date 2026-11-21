import type { PrismaClient } from "@rakazo/db";
import { recordUsage } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

/** The usage records' provider for generated images and videos, whichever service made them. */
export const DOZO_MEDIA_USAGE_PROVIDER = "media";

type MediaUsageRun = { id?: string; botId?: string; userId: string; spaceId: string };
type MediaUsageTool = "generate_image" | "generate_video" | "avatar_image";

/**
 * The write itself. The media service reports no price, so the cost stays unknown rather than
 * guessed. The record is keyed by the generation, so writing it twice records it once. A picture
 * drawn for an avatar belongs to no run or bot (`avatar_image`), so those two may be absent.
 */
function writeMediaUsage(
  prisma: Pick<PrismaClient, "$transaction">,
  run: MediaUsageRun,
  tool: MediaUsageTool,
  generationId: string,
) {
  const callId = `media:${generationId}`;
  return recordUsage(
    prisma,
    {
      type: "usage",
      provider: DOZO_MEDIA_USAGE_PROVIDER,
      model: tool,
      callId,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      usageSource: "generated",
    },
    {
      spaceId: run.spaceId,
      userId: run.userId,
      ...(run.botId ? { botId: run.botId } : {}),
      ...(run.id ? { runId: run.id } : {}),
      operationId: callId,
    },
  );
}

/**
 * One usage record per generated image or video, once it is stored and shown, so generations
 * appear in usage beside model calls. A failed write only loses the record, never the delivered
 * media.
 */
export async function dozoRecordMediaUsage(
  prisma: Pick<PrismaClient, "$transaction">,
  run: MediaUsageRun,
  tool: MediaUsageTool,
  generationId: string,
): Promise<void> {
  await bestEffort("media generation usage", writeMediaUsage(prisma, run, tool, generationId));
}

/**
 * The record of a generation, written before the service is called, for a limit that counts
 * records: whatever the call does afterwards, it has been counted, and it is the only record the
 * generation leaves. A failed write is the caller's to handle, never swallowed: without the record
 * the call must not start.
 */
export async function dozoReserveMediaUsage(
  prisma: Pick<PrismaClient, "$transaction">,
  run: MediaUsageRun,
  tool: MediaUsageTool,
  generationId: string,
): Promise<void> {
  await writeMediaUsage(prisma, run, tool, generationId);
}
