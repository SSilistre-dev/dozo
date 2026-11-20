import { probeOpenAiCompatibleModels } from "@rakazo/adapters";
import { DOZO_LOCAL_MODEL_SERVERS, deadlineSignal } from "@rakazo/core";
import { mayUsePrivateEndpoint } from "./mcp-servers.js";
import type { RouterContext } from "./routes/context.js";

/** A running local server answers at once; one that is not running refuses the connection. */
const LOOK_MS = 2_000;

/**
 * The model servers running on this computer, each with the models its `/v1/models` lists. Only a
 * deployment that may reach private addresses looks: a hosted one answers that none are available
 * without sending a request, so no member can make it reach its own network.
 */
export function dozoLocalModelsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoLocalModels: {
      servers: authed.dozoLocalModels.servers.handler(async ({ context }) => {
        if (!mayUsePrivateEndpoint(deps)) return { available: false, servers: [] };
        const signal = deadlineSignal(LOOK_MS, context.signal);
        const found = await Promise.allSettled(
          DOZO_LOCAL_MODEL_SERVERS.map(async (server) => ({
            ...server,
            models: await probeOpenAiCompatibleModels(
              { baseUrl: server.baseUrl },
              deps.modelConnectionFetch,
              signal,
              { allowPrivate: true },
            ),
          })),
        );
        context.signal?.throwIfAborted();
        // A server that refused, timed out or answered with something else is not running here.
        return {
          available: true,
          servers: found.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
        };
      }),
    },
  };
}
