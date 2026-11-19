import type { ModelCatalogEntry, ModelRole } from "@rakazo/contracts";
import { modelSupportsRole } from "@rakazo/contracts";
import { fetchFresh } from "@rakazo/core/query";
import type { QueryClient } from "@tanstack/react-query";
import { isCancelledError, queryOptions } from "@tanstack/react-query";
import type { SpaceQueries } from "../../lib/query";
import { spaceQueries } from "../../lib/query";
import type { RpcClient } from "../../lib/rpc";
import { selectedSpaceId } from "../../lib/rpc";

type CatalogReads = { models: Pick<RpcClient["models"], "forRole"> };
type WholeRead = () => Promise<ModelCatalogEntry[]>;

/** How long a read of the whole catalog serves the role lists that load after it. */
export const SHARED_CATALOG_MS = 5_000;

/**
 * The approval role's list is the whole catalog: every chat model plus the decision models. The
 * chat catalog and every other role's list are that list filtered by `modelSupportsRole`, as the
 * server builds them, so one read serves the Models screen instead of one per list.
 */
function wholeCatalog(queries: SpaceQueries, read: WholeRead) {
  const { queryKey } = queryOptions({
    queryKey: [...queries.models.forRole.queryKey({ input: { role: "approval" } }), "whole"],
    queryFn: read,
  });
  return { queryKey, queryFn: read };
}

export function roleCatalog(whole: ModelCatalogEntry[], role: ModelRole): ModelCatalogEntry[] {
  return whole.filter((entry) => modelSupportsRole(entry, role));
}

/**
 * The chat catalog the Models screen loads on every refresh. A refresh after a change must not
 * reuse a read sent before it, so the whole catalog is read again here.
 */
export async function readChatCatalog(
  queryClient: QueryClient,
  queries: SpaceQueries,
  rpc: CatalogReads,
): Promise<ModelCatalogEntry[]> {
  const read = () => rpc.models.forRole({ role: "approval" });
  return roleCatalog(await fetchFresh(queryClient, wholeCatalog(queries, read)), "main");
}

/**
 * One role's list. It joins a read of the whole catalog in flight, or takes one answered moments
 * ago, which is the read the screen's own refresh sent; otherwise it reads the catalog itself.
 * Without a selected space the screen reads through the unscoped client, which answers for the
 * account's own Space.
 */
export async function readRoleCatalog(
  queryClient: QueryClient,
  userId: string,
  spaceId: string,
  rpc: CatalogReads,
  role: ModelRole,
  now: () => number = Date.now,
): Promise<ModelCatalogEntry[]> {
  const scopes = [spaceQueries(userId, spaceId)];
  // Settings can be bound to another Space while none is selected, so the unscoped read counts
  // only when the account it loaded says it answers for this Space.
  const unscoped = spaceQueries(userId, null);
  if (
    selectedSpaceId() === null &&
    queryClient.getQueryData(unscoped.me.queryKey())?.spaceId === spaceId
  ) {
    scopes.push(unscoped);
  }
  const read = () => rpc.models.forRole({ role: "approval" }, { context: { spaceId } });
  for (let attempt = 0; ; attempt += 1) {
    try {
      return roleCatalog(await sharedRead(queryClient, scopes, read, now, attempt > 0), role);
    } catch (error) {
      // A refresh after a change cancelled the read this joined, so only a read sent from now on
      // will do: the retry joins the refresh's new read or sends one the refresh then joins.
      if (!isCancelledError(error) || attempt > 0) throw error;
    }
  }
}

function sharedRead(
  queryClient: QueryClient,
  scopes: SpaceQueries[],
  read: WholeRead,
  now: () => number,
  afterChange: boolean,
): Promise<ModelCatalogEntry[]> {
  for (const scope of afterChange ? [] : scopes) {
    const options = wholeCatalog(scope, read);
    const state = queryClient.getQueryState(options.queryKey);
    // A fetch with no freshness allowed joins the one in flight.
    if (state?.fetchStatus === "fetching")
      return queryClient.fetchQuery({ ...options, staleTime: 0 });
    if (state?.data && now() - state.dataUpdatedAt < SHARED_CATALOG_MS) {
      return Promise.resolve(state.data);
    }
  }
  return queryClient.fetchQuery({ ...wholeCatalog(scopes[0]!, read), staleTime: 0 });
}
