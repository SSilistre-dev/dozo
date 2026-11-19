import { deferred, flush } from "@rakazo/core/test-async";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  connections: { catalog: vi.fn(), list: vi.fn() },
  capabilities: { list: vi.fn(), catalogSearch: vi.fn() },
}));
vi.mock("../../lib/rpc", () => ({ rpc: api }));

import { loadIntegrations } from "./dozo-load-integrations";

const app = { connectorId: "managed", slug: "mail", name: "Mail", connected: true };
const row = (status: string) => ({ id: "c1", connectorId: "managed", provider: "mail", status });

beforeEach(() => {
  api.connections.catalog.mockReset().mockResolvedValue([]);
  api.connections.list.mockReset().mockResolvedValue([]);
  api.capabilities.list.mockReset().mockResolvedValue([]);
  api.capabilities.catalogSearch.mockReset().mockResolvedValue({ enabled: true, results: [] });
});

it("sends every read at once, so the connection rows never wait for the catalog", async () => {
  const catalog = deferred<unknown[]>();
  api.connections.catalog.mockReturnValue(catalog.promise);
  const load = loadIntegrations(vi.fn());
  expect(api.connections.list).toHaveBeenCalledTimes(1);
  expect(api.capabilities.list).toHaveBeenCalledTimes(1);
  expect(api.capabilities.catalogSearch).toHaveBeenCalledWith({ query: "" });
  catalog.resolve([]);
  await expect(load).resolves.toEqual({
    catalog: [],
    connections: [],
    sources: [],
    plugins: [],
    catalogFeedEnabled: true,
  });
});

it("splits installs into tool sources and plugins and drops the rest", async () => {
  const installs = ["mcp", "api", "graphql", "plugin", "skill"].map((kind) => ({ id: kind, kind }));
  api.capabilities.list.mockResolvedValue(installs);
  const result = await loadIntegrations(vi.fn());
  expect(result.sources.map((install) => install.kind)).toEqual(["mcp", "api", "graphql"]);
  expect(result.plugins.map((install) => install.kind)).toEqual(["plugin"]);
});

it("reads the rows again after a catalog that lists apps and hands them over", async () => {
  api.connections.catalog.mockResolvedValue([app]);
  api.connections.list
    .mockResolvedValueOnce([row("error")])
    .mockResolvedValueOnce([row("connected")]);
  const onReconciled = vi.fn();
  const result = await loadIntegrations(onReconciled);
  expect(result.connections).toEqual([row("error")]);
  await vi.waitFor(() => expect(onReconciled).toHaveBeenCalledWith([row("connected")]));
  expect(api.connections.list).toHaveBeenCalledTimes(2);
});

it("reads the rows once when the catalog lists nothing", async () => {
  const onReconciled = vi.fn();
  await loadIntegrations(onReconciled);
  await flush();
  expect(api.connections.list).toHaveBeenCalledTimes(1);
  expect(onReconciled).not.toHaveBeenCalled();
});

it("keeps the rows it has when the second read fails", async () => {
  api.connections.catalog.mockResolvedValue([app]);
  api.connections.list
    .mockResolvedValueOnce([row("connected")])
    .mockRejectedValueOnce(new Error("offline"));
  const onReconciled = vi.fn();
  await expect(loadIntegrations(onReconciled)).resolves.toMatchObject({
    connections: [row("connected")],
  });
  await flush();
  expect(onReconciled).not.toHaveBeenCalled();
});

it("treats a failed catalog feed probe as a feed that is off", async () => {
  api.capabilities.catalogSearch.mockRejectedValue(new Error("down"));
  await expect(loadIntegrations(vi.fn())).resolves.toMatchObject({ catalogFeedEnabled: false });
});

it("fails as a whole when the catalog fails", async () => {
  api.connections.catalog.mockRejectedValue(new Error("catalog down"));
  await expect(loadIntegrations(vi.fn())).rejects.toThrow("catalog down");
});
