import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { Context, Hono } from "hono";
import { mountDozoCatalogImages } from "./dozo-plugin-catalog.js";
import { mountDozoReplayFrames } from "./dozo-replays.js";
import { mountDozoShareLinks } from "./dozo-share-links.js";

/**
 * The fork's signed-out HTTP routes, mounted by one anchored rule beside upstream's shared pages,
 * before the session routes, with the artifact store for a route that serves stored files. A
 * feature adds one line here; anything that reads private rows checks its own token and limits its
 * own rate, as the share links do.
 */
export function mountDozoPublicRoutes(
  app: Hono,
  prisma: PrismaClient,
  clientIp: (c: Context) => string | undefined,
  artifacts: ArtifactStore,
) {
  mountDozoCatalogImages(app, prisma);
  mountDozoShareLinks(app, prisma, clientIp);
  mountDozoReplayFrames(app, prisma, clientIp, artifacts);
}
