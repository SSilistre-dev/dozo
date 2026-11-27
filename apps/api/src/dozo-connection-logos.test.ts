import { createRouterClient } from "@orpc/server";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { withOwnLogosOnly } from "./dozo-connection-logos.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router-test-support.js";

const origin = "https://app.dozo.test";

describe("withOwnLogosOnly", () => {
  it("keeps our own address and drops every other one", () => {
    const items = [
      { slug: "a", logo: `${origin}/api/dozo/catalog-images/${"c".repeat(64)}.webp` },
      { slug: "b", logo: "https://logos.example.test/api/gmail" },
      { slug: "c", logo: `${origin}.evil.test/x.png` },
      { slug: "d", logo: null },
    ];
    expect(withOwnLogosOnly(items, `${origin}/`).map((item) => item.logo)).toEqual([
      items[0]?.logo,
      null,
      null,
      null,
    ]);
  });
});

describe("connections.catalog", () => {
  it("never hands a client a logo on another host", async () => {
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
    const client = createRouterClient(
      createRouter({
        prisma: {} as PrismaClient,
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
    const catalog = await client.connections.catalog({ connectorId: "apps" });
    expect(catalog).toHaveLength(2);
    expect(catalog.filter((item) => item.logo !== null)).toEqual([]);
  });
});
