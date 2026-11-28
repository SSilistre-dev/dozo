import type { ComponentType } from "react";

/** A kind's signed-out page; it checks the payload's shape itself, the server sends it as is. */
export type DozoShareRenderer = ComponentType<{ payload: unknown }>;

/**
 * How each kind of share link draws, loaded only when a link of that kind is opened. A feature adds
 * one line, `<kind>: () => import("./x").then((module) => module.X)`, with the same key as in the
 * server's kind map (`apps/api/src/dozo-share-kinds.ts`). A kind missing here shows the 404.
 */
export const DOZO_SHARE_RENDERERS: Readonly<Record<string, () => Promise<DozoShareRenderer>>> = {
  stats: () => import("./dozo-stats-card").then((module) => module.DozoStatsCard),
};
