import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { FakeMediaGenerationProvider } from "./media-generation-provider.js";
import { generateMediaFromTool } from "./media-generation-tools.js";

// Runs on the branded tree only: the check is there once the brand rules are applied.

const MB = 1024 * 1024;
const run = { id: "run", threadId: "thread", botId: "bot", spaceId: "space", userId: "owner" };
const context: AdapterContext = {
  ...run,
  operationId: "op",
  traceId: "trace",
  signal: new AbortController().signal,
};

/** A bot about to generate an image, in an organization on Free holding `usedBytes` of files. */
function setup(organization: { billingOn: boolean; usedBytes: number }) {
  const provider = new FakeMediaGenerationProvider();
  const generate = vi.spyOn(provider, "generateImage");
  const row = { id: "local-job", status: "media_submitting", result: { provider: "fake" } };
  const externalEffect = {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(row),
    update: vi.fn().mockResolvedValue(row),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const queries = vi.fn(async () => [{ used: String(organization.usedBytes) }]);
  const prisma = {
    externalEffect,
    artifact: { findFirst: vi.fn().mockResolvedValue(null) },
    deploymentSettings: {
      findUnique: async () => ({ modelCreditsEnabled: organization.billingOn }),
    },
    space: {
      findUnique: async () => ({ organizationId: "org", organization: { billing: null } }),
    },
    $queryRaw: queries,
  } as unknown as PrismaClient;
  const result = generateMediaFromTool({
    name: "generate_image",
    args: { prompt: "draw" },
    executionId: "execution",
    provider,
    prisma,
    context,
    run,
    attach: vi.fn().mockResolvedValue({
      artifactId: "artifact",
      block: { kind: "image", artifactId: "artifact", name: "generated.png" },
    }),
    publish: vi.fn(),
  });
  return { result, generate, externalEffect, queries };
}

describe("media generation and the shared space", () => {
  it("starts nothing when the shared space is full, and says why", async () => {
    const { result, generate, externalEffect } = setup({ billingOn: true, usedBytes: 500 * MB });
    expect(await result).toEqual({
      error: "Shared space is full. Delete files or change the plan.",
      code: "shared_space_full",
    });
    expect(externalEffect.create).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it("generates as before while there is room", async () => {
    const { result, generate } = setup({ billingOn: true, usedBytes: 500 * MB - 1 });
    expect(await result).toEqual({ status: "completed", artifactId: "artifact" });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("asks nothing and generates as before on a server that does not bill", async () => {
    const { result, generate, queries } = setup({ billingOn: false, usedBytes: 50_000 * MB });
    expect(await result).toEqual({ status: "completed", artifactId: "artifact" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(queries).not.toHaveBeenCalled();
  });
});
