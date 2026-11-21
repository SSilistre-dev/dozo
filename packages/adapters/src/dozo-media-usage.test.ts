import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { DOZO_MEDIA_USAGE_PROVIDER, dozoRecordMediaUsage } from "./dozo-media-usage.js";
import { FakeMediaGenerationProvider } from "./media-generation-provider.js";
import { generateMediaFromTool } from "./media-generation-tools.js";

// The plans' shared-space check before a generation has its own tests; here there is room.
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  sharedSpaceFull: async () => false,
}));

const run = { id: "run", threadId: "thread", botId: "bot", spaceId: "space", userId: "owner" };

/** A database that keeps the usage rows recordUsage writes, skipping a repeated call id. */
function usageDatabase() {
  const rows: Array<Record<string, unknown>> = [];
  const tx = {
    usageRecord: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        for (const row of data)
          if (!rows.some((kept) => kept.callId === row.callId)) rows.push(row);
        return { count: data.length };
      }),
    },
    modelCreditEntry: { findUnique: vi.fn(async () => null) },
  };
  return { rows, $transaction: async <T>(work: (client: typeof tx) => Promise<T>) => work(tx) };
}

describe("media usage", () => {
  it("records one generation once, with no cost it does not know", async () => {
    const db = usageDatabase();
    await dozoRecordMediaUsage(db as unknown as PrismaClient, run, "generate_image", "job-1");
    await dozoRecordMediaUsage(db as unknown as PrismaClient, run, "generate_image", "job-1");
    expect(db.rows).toEqual([
      expect.objectContaining({
        provider: DOZO_MEDIA_USAGE_PROVIDER,
        model: "generate_image",
        callId: "media:job-1",
        spaceId: "space",
        userId: "owner",
        botId: "bot",
        runId: "run",
        costUsd: null,
        inputTokens: null,
      }),
    ]);
  });

  it("never fails the delivered media when the record cannot be written", async () => {
    const broken = {
      $transaction: async () => {
        throw new Error("database down");
      },
    };
    await expect(
      dozoRecordMediaUsage(broken as unknown as PrismaClient, run, "generate_video", "job-2"),
    ).resolves.toBeUndefined();
  });

  it("is recorded for each image the media tool generates and shows", async () => {
    const db = usageDatabase();
    const context: AdapterContext = {
      ...run,
      operationId: "op",
      traceId: "trace",
      signal: new AbortController().signal,
    };
    const created = { id: "job-3", status: "media_submitting", result: { provider: "fake" } };
    const result = await generateMediaFromTool({
      name: "generate_image",
      args: { prompt: "draw" },
      executionId: "execution",
      provider: new FakeMediaGenerationProvider(),
      prisma: {
        ...db,
        externalEffect: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(created),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
      } as unknown as PrismaClient,
      context,
      run,
      attach: vi.fn().mockResolvedValue({
        artifactId: "artifact",
        block: { kind: "image", artifactId: "artifact", name: "generated.png" },
      }),
      publish: vi.fn(),
    });
    expect(result).toEqual({ status: "completed", artifactId: "artifact" });
    expect(db.rows).toEqual([
      expect.objectContaining({ model: "generate_image", callId: "media:job-3" }),
    ]);
  });
});
