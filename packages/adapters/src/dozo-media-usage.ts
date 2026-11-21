import type { PrismaClient } from "@rakazo/db";
import { recordUsage } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";

/** The usage records' provider for generated images and videos, whichever service made them. */
export const DOZO_MEDIA_USAGE_PROVIDER = "media";

/**
 * One usage record per generated image or video, once it is stored and shown, so generations
 * appear in usage beside model calls. The media service reports no price, so the cost stays
 * unknown rather than guessed. The record is keyed by the generation, so a repeated delivery
 * records it once; a failed write only loses the record, never the delivered media.
 */
export async function dozoRecordMediaUsage(
  prisma: Pick<PrismaClient, "$transaction">,
  run: { id: string; botId: string; userId: string; spaceId: string },
  tool: "generate_image" | "generate_video",
  generationId: string,
): Promise<void> {
  const callId = `media:${generationId}`;
  await bestEffort(
    "media generation usage",
    recordUsage(
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
        botId: run.botId,
        runId: run.id,
        operationId: callId,
      },
    ),
  );
}
