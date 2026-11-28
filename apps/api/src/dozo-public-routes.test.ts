import { DOZO_SHARE_LINK_API_PREFIX } from "@rakazo/contracts";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { CATALOG_IMAGE_PATH } from "./dozo-plugin-catalog.js";
import { mountDozoPublicRoutes } from "./dozo-public-routes.js";

it("mounts the catalog's logos and the share links, signed out", async () => {
  const prisma = {
    dozoCatalogImage: { findFirst: vi.fn(async () => ({ body: new Uint8Array([1]) })) },
    $queryRaw: vi.fn(async () => []),
  };
  const app = new Hono();
  mountDozoPublicRoutes(app, prisma as never, () => "203.0.113.9");
  expect((await app.request(`${CATALOG_IMAGE_PATH}/${"c".repeat(64)}.webp`)).status).toBe(200);
  const shared = await app.request(`${DOZO_SHARE_LINK_API_PREFIX}${"A".repeat(43)}`);
  expect(shared.status).toBe(404);
  expect(prisma.$queryRaw).toHaveBeenCalledOnce();
});
