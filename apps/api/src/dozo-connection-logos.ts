import { createConnectionLogos } from "@rakazo/adapters";
import { CATALOG_IMAGE_PATH } from "./dozo-plugin-catalog.js";
import type { RouterDeps } from "./router.js";

/**
 * Managed app logos for the catalog route: every logo on our own address (stored and served like
 * the plugin catalog's), or none while it is being fetched. A provider's address never reaches a
 * client.
 */
export function dozoConnectionLogos(deps: Pick<RouterDeps, "prisma" | "env">) {
  const origin = deps.env.webOrigin.replace(/\/+$/, "");
  const logos = createConnectionLogos({
    prisma: deps.prisma,
    // Absolute, because the mobile app draws it without a page to resolve it against.
    imageUrl: (file) => `${origin}${CATALOG_IMAGE_PATH}/${file}`,
  });
  return <T extends { logo?: string | null }>(items: T[]) => logos.own(items);
}

export { recordToolConnected } from "./integrations/tool-connect-analytics.js";
