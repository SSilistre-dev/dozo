import { PLUGIN_SUBMISSIONS_PATH } from "@rakazo/contracts";
import { Hono } from "hono";
import { pluginSubmissionRoutes as upstreamRoutes } from "./plugin-submissions.js";

/**
 * Upstream's plugin submission routes. With DOZO_PLUGIN_SUBMISSIONS=closed (the production compose
 * file's default) the public submission form answers 403 and stores nothing; the rest is unchanged.
 * The API decides it, so it holds whichever way a request arrives.
 */
export function pluginSubmissionRoutes(
  deps: Parameters<typeof upstreamRoutes>[0],
  closed = process.env.DOZO_PLUGIN_SUBMISSIONS === "closed",
) {
  const routes = upstreamRoutes(deps);
  if (!closed) return routes;
  const app = new Hono();
  app.post(PLUGIN_SUBMISSIONS_PATH, (c) => c.json({ error: "Plugin submissions are closed" }, 403));
  app.route("/", routes);
  return app;
}
