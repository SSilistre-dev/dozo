import type { Connection, ConnectionCatalogItem } from "@rakazo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { spaceQueries } from "../../lib/query";
import { loadComposerConnections } from "./dozo-composer-connections";

const queries = spaceQueries("user_1", "space_1");
const appsKey = [...queries.connections.catalog.queryKey({ input: {} }), "integrations"];
const row = { id: "conn_1", provider: "mail", status: "connected" } as Connection;
const item = { connectorId: "c", slug: "mail", name: "Mail" } as ConnectionCatalogItem;

function reads(lists: Array<Connection[] | Error>, catalog: ConnectionCatalogItem[] | Error) {
  const list = vi.fn(async () => {
    const next = lists.shift();
    if (!next || next instanceof Error) throw next ?? new Error("no more lists");
    return next;
  });
  const catalogCall = vi.fn(async () => {
    if (catalog instanceof Error) throw catalog;
    return catalog;
  });
  return { list, catalog: catalogCall, rpc: { connections: { list, catalog: catalogCall } } };
}

describe("loadComposerConnections", () => {
  it("never calls the catalog for an account without connections", async () => {
    const fake = reads([[]], [item]);
    await expect(
      loadComposerConnections(fake.rpc as never, new QueryClient(), queries),
    ).resolves.toEqual({ catalog: null, connections: [] });
    expect(fake.catalog).not.toHaveBeenCalled();
  });

  it("uses the catalog Apps already loaded", async () => {
    const client = new QueryClient();
    client.setQueryData(appsKey, { catalog: [item], connections: [] });
    const fake = reads([[]], [item]);
    await expect(loadComposerConnections(fake.rpc as never, client, queries)).resolves.toEqual({
      catalog: [item],
      connections: [],
    });
    expect(fake.catalog).not.toHaveBeenCalled();
  });

  it("skips the catalog when the list fails, as an empty composer menu", async () => {
    const fake = reads([new Error("down")], [item]);
    await expect(
      loadComposerConnections(fake.rpc as never, new QueryClient(), queries),
    ).resolves.toEqual({ catalog: null, connections: null });
    expect(fake.catalog).not.toHaveBeenCalled();
  });

  it("reconciles existing connections through the catalog and lists them again", async () => {
    const reconciled = { ...row, displayName: "Work mail" } as Connection;
    const fake = reads([[row], [reconciled]], [item]);
    await expect(
      loadComposerConnections(fake.rpc as never, new QueryClient(), queries),
    ).resolves.toEqual({ catalog: [item], connections: [reconciled] });
    expect(fake.list).toHaveBeenCalledTimes(2);
  });

  it("keeps the first list when the catalog or the second list fails", async () => {
    const fake = reads([[row], new Error("down")], new Error("provider down"));
    await expect(
      loadComposerConnections(fake.rpc as never, new QueryClient(), queries),
    ).resolves.toEqual({ catalog: null, connections: [row] });
  });
});
