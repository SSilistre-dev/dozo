import type { Connection } from "@rakazo/contracts";
import { optionalCatalogFeedProbe } from "../../lib/optional-catalog-feed";
import { rpc } from "../../lib/rpc";

/**
 * What the integrations page lists, with every read sent at once. The catalog call reconciles
 * connection rows with its provider, so when it lists any app the rows read beside it may predate
 * that: they are read again after it and handed to `onReconciled`, rather than the page waiting.
 */
export async function loadIntegrations(onReconciled: (connections: Connection[]) => void) {
  const [catalog, installs, connections, catalogFeed] = await Promise.all([
    rpc.connections.catalog({}),
    rpc.capabilities.list(),
    rpc.connections.list(),
    optionalCatalogFeedProbe(rpc.capabilities.catalogSearch({ query: "" })),
  ]);
  if (catalog.length > 0) {
    // A failed re-read leaves the rows already shown until the page reads again.
    void rpc.connections.list().then(onReconciled, () => undefined);
  }
  return {
    catalog,
    connections,
    sources: installs.filter(
      (install) => install.kind === "mcp" || install.kind === "api" || install.kind === "graphql",
    ),
    plugins: installs.filter((install) => install.kind === "plugin"),
    catalogFeedEnabled: catalogFeed.enabled,
  };
}
