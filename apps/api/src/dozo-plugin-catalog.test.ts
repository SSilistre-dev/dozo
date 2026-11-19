import { createPersistentPluginMarketplace } from "@rakazo/adapters";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  CATALOG_IMAGE_PATH,
  dozoPluginMarketplace,
  mountDozoCatalogImages,
} from "./dozo-plugin-catalog.js";

vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof import("@rakazo/adapters")>()),
  createPersistentPluginMarketplace: vi.fn(() => ({})),
}));

const hash = "c".repeat(64);

function app(body: Uint8Array | null) {
  const findFirst = vi.fn(async () => (body ? { body } : null));
  const server = new Hono();
  mountDozoCatalogImages(server, { dozoCatalogImage: { findFirst } } as never);
  return { server, findFirst };
}

describe("catalog images route", () => {
  it("serves a stored image as WebP with a year-long immutable cache", async () => {
    const { server } = app(new Uint8Array([1, 2, 3]));
    const response = await server.request(`${CATALOG_IMAGE_PATH}/${hash}.webp`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("answers 404, cached briefly, for an unknown hash or a name that is not one", async () => {
    const { server, findFirst } = app(null);
    for (const name of [`${hash}.webp`, "logo.svg", `${hash}.png`]) {
      const response = await server.request(`${CATALOG_IMAGE_PATH}/${name}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    }
    expect(findFirst).toHaveBeenCalledOnce();
  });
});

describe("stored plugin catalog wiring", () => {
  it("links images absolutely on the app's own origin and reads with the configured reader", () => {
    const read = vi.fn();
    const prisma = {};
    dozoPluginMarketplace({
      prisma: prisma as never,
      pluginMarketplaceRead: read,
      env: { webOrigin: "https://app.example.test/" } as never,
    });
    const options = vi.mocked(createPersistentPluginMarketplace).mock.calls[0]![0];
    expect(options.prisma).toBe(prisma);
    expect(options.read).toBe(read);
    expect(options.imageUrl(`${hash}.webp`)).toBe(
      `https://app.example.test/api/dozo/catalog-images/${hash}.webp`,
    );
  });
});
