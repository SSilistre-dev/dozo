import type { PrismaClient } from "@rakazo/db";
import type { Context, Hono } from "hono";
import { mountDozoCatalogImages } from "./dozo-plugin-catalog.js";
import { mountDozoShareLinks } from "./dozo-share-links.js";

/**
 * The fork's signed-out HTTP routes, mounted by one anchored rule beside upstream's shared pages,
 * before the session routes. A feature adds one line here; anything that reads private rows checks
 * its own token and limits its own rate, as the share links do.
 */
export function mountDozoPublicRoutes(
  app: Hono,
  prisma: PrismaClient,
  clientIp: (c: Context) => string | undefined,
) {
  mountDozoCatalogImages(app, prisma);
  mountDozoShareLinks(app, prisma, clientIp);
}
