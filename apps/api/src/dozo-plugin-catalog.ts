import {
  CATALOG_IMAGE_TYPE,
  createPersistentPluginMarketplace,
  storedCatalogImage,
} from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import type { Hono } from "hono";
import type { RouterDeps } from "./router.js";

/** Where catalog logos and site icons are served from, on the app's own domain. */
export const CATALOG_IMAGE_PATH = "/api/dozo/catalog-images";

/** The plugin catalog the Apps page browses, kept in Postgres and warmed when the API starts. */
export function dozoPluginMarketplace(
  deps: Pick<RouterDeps, "prisma" | "pluginMarketplaceRead" | "env">,
) {
  const origin = deps.env.webOrigin.replace(/\/+$/, "");
  return createPersistentPluginMarketplace({
    prisma: deps.prisma,
    read: deps.pluginMarketplaceRead,
    // Absolute, because the mobile app draws it without a page to resolve it against.
    imageUrl: (file) => `${origin}${CATALOG_IMAGE_PATH}/${file}`,
  });
}

/**
 * Serves a stored image by its content hash. Public, like the catalog's own pictures were: a name
 * is only ever a hash the catalog listed, so nothing else can be asked for, and the bytes behind a
 * name never change, so browsers and the CDN keep them for a year.
 */
export function mountDozoCatalogImages(app: Hono, prisma: Pick<PrismaClient, "dozoCatalogImage">) {
  app.get(`${CATALOG_IMAGE_PATH}/:file`, async (c) => {
    const body = await storedCatalogImage(prisma, c.req.param("file"));
    const headers = { "x-content-type-options": "nosniff" };
    if (!body) return c.body(null, 404, { ...headers, "cache-control": "no-store" });
    return c.body(body, 200, {
      ...headers,
      "content-type": CATALOG_IMAGE_TYPE,
      "cache-control": "public, max-age=31536000, immutable",
    });
  });
}
