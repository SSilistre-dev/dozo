import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging/best-effort";
import type { QueryClient } from "@tanstack/react-query";
import type { SpaceQueries } from "../../lib/query/query";
import type { RpcClient } from "../../lib/query/rpc";

type ConnectionReads = { connections: Pick<RpcClient["connections"], "list" | "catalog"> };

export type ComposerConnections = {
  catalog: ConnectionCatalogItem[] | null;
  connections: Connection[] | null;
};

/**
 * What the composer's mentions and the sidebar's app marks read when the shell opens. The catalog
 * is the slow call the Apps screen makes, so an account without connections never waits for it
 * here: it uses the catalog Apps last loaded, if any. With connections the catalog still runs
 * first, because it reconciles their rows, and they are listed again after it.
 */
export async function loadComposerConnections(
  rpc: ConnectionReads,
  queryClient: QueryClient,
  queries: SpaceQueries,
): Promise<ComposerConnections> {
  const connections = (await bestEffort("list connections", rpc.connections.list())) ?? null;
  if (!connections?.length) {
    const apps = queryClient.getQueryData<{ catalog?: ConnectionCatalogItem[] }>([
      ...queries.connections.catalog.queryKey({ input: {} }),
      "integrations",
    ]);
    return { catalog: apps?.catalog ?? null, connections };
  }
  const catalog = (await bestEffort("read the connection catalog", rpc.connections.catalog({}))) ?? null;
  const reconciled = (await bestEffort("list connections again", rpc.connections.list())) ?? null;
  return { catalog, connections: reconciled ?? connections };
}
