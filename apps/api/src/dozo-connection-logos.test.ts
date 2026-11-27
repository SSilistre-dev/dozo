import { createRouterClient } from "@orpc/server";
import type { PrismaClient } from "@rakazo/db";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router-test-support.js";

const origin = "https://app.dozo.test";
const settle: Array<() => Promise<void>> = [];

vi.mock("@rakazo/adapters", async (original) => {
  const adapters = await original<typeof import("@rakazo/adapters")>();
  return {
    ...adapters,
    createConnectionLogos: (options: Parameters<typeof adapters.createConnectionLogos>[0]) => {
      const logos = adapters.createConnectionLogos({
        ...options,
        fetchImage: async () =>
          new Uint8Array(
            await sharp({
              create: { width: 64, height: 64, channels: 4, background: "#888" },
            })
              .png()
              .toBuffer(),
          ),
      });
      settle.push(logos.settled);
      return logos;
    },
  };
});

function client() {
  const rows = new Map<string, { source: string; hash: string | null; checkedAt: Date }>();
  const provider = {
    describe: () => ({ id: "apps" }),
    catalog: async () =>
      ["gmail", "slack"].map((slug) => ({
        connectorId: "apps",
        slug,
        name: slug,
        logo: `https://logos.example.test/api/${slug}`,
        connected: false,
        noAuth: false,
      })),
  };
  const prisma = {
    dozoCatalogImage: {
      findMany: async () => [...rows.values()],
      upsert: async ({ create }: { create: { source: string; hash: string | null } }) => {
        rows.set(create.source, { ...create, checkedAt: new Date() });
      },
    },
  } as unknown as PrismaClient;
  return createRouterClient(
    createRouter({
      prisma,
      connectors: { managed: () => provider },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: origin,
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
    } as unknown as RouterDeps),
    {
      context: {
        actor: {
          spaceId: "workspace-1",
          userId: "user-1",
          email: "user@rakazo.test",
          isDeploymentOwner: true,
        },
      } as never,
    },
  );
}

describe("connections.catalog", () => {
  it("never hands a client a logo on another host, and serves it from ours once stored", async () => {
    const api = client();
    const first = await api.connections.catalog({ connectorId: "apps" });
    expect(first.filter((item) => item.logo !== null)).toEqual([]);
    await Promise.all(settle.map((done) => done()));
    const second = await api.connections.catalog({ connectorId: "apps" });
    expect(second).toHaveLength(2);
    for (const item of second)
      expect(item.logo).toMatch(new RegExp(`^${origin}/api/dozo/catalog-images/[a-f0-9]{64}\\.webp$`));
  });
});
