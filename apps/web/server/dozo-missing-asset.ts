import type { IncomingMessage, ServerResponse } from "node:http";
import { missingAssetMiddleware as upstreamMissingAssetMiddleware } from "./missing-asset.js";

/** A built asset's name carries its content hash, so a copy never goes stale. */
export const IMMUTABLE_ASSET = "public, max-age=31536000, immutable";

/**
 * Upstream's middleware, plus a year-long immutable cache for the hashed assets the current build
 * serves, instead of a revalidation on every load. The static server that answers next keeps a
 * cache-control set here (Vite's sirv merges it, the standalone server reads it back). Missing
 * assets keep upstream's answers: an archived chunk is already immutable, a 404 is never stored.
 */
export function missingAssetMiddleware(...args: Parameters<typeof upstreamMissingAssetMiddleware>) {
  const [, urlPrefix] = args;
  const upstream = upstreamMissingAssetMiddleware(...args);
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    upstream(req, res, () => {
      if (req.url?.startsWith(urlPrefix)) res.setHeader("cache-control", IMMUTABLE_ASSET);
      next();
    });
  };
}
