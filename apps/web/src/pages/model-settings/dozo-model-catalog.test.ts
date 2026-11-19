import type { ModelCatalogEntry } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { spaceQueries } from "../../lib/query";

const { selected } = vi.hoisted(() => ({ selected: vi.fn<() => string | null>(() => null) }));
vi.mock("../../lib/rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/rpc")>()),
  selectedSpaceId: selected,
}));

import {
  readChatCatalog,
  readRoleCatalog,
  roleCatalog,
  SHARED_CATALOG_MS,
} from "./dozo-model-catalog";

const entry = (id: string, extra: Partial<ModelCatalogEntry> = {}) =>
  ({ provider: "p", id, label: id, billing: "", ...extra }) as ModelCatalogEntry;
const chat = entry("chat");
const blind = entry("blind", { images: false });
const decision = entry("decision", { protocol: "decisions" });
const whole = [chat, blind, decision];

function server(...answers: Array<Promise<ModelCatalogEntry[]>>) {
  const forRole = vi.fn(
    (_input: unknown, _options?: unknown) => answers.shift() ?? Promise.resolve(whole),
  );
  return { forRole, rpc: { models: { forRole } } as never };
}

beforeEach(() => selected.mockReturnValue(null));

describe("roleCatalog", () => {
  it("filters the whole catalog as the server does for each list", () => {
    expect(roleCatalog(whole, "approval")).toEqual(whole);
    expect(roleCatalog(whole, "main")).toEqual([chat, blind]);
    expect(roleCatalog(whole, "computer")).toEqual([chat]);
  });
});

describe("one catalog read for the Models screen", () => {
  it("serves the chat list and every role list from one read", async () => {
    const client = new QueryClient();
    const { forRole, rpc } = server();
    await expect(readChatCatalog(client, spaceQueries("u", "s"), rpc)).resolves.toEqual([
      chat,
      blind,
    ]);
    await expect(readRoleCatalog(client, "u", "s", rpc, "main")).resolves.toEqual([chat, blind]);
    await expect(readRoleCatalog(client, "u", "s", rpc, "computer")).resolves.toEqual([chat]);
    await expect(readRoleCatalog(client, "u", "s", rpc, "approval")).resolves.toEqual(whole);
    expect(forRole).toHaveBeenCalledTimes(1);
    expect(forRole).toHaveBeenCalledWith({ role: "approval" });
  });

  it("joins a read still in flight", async () => {
    const client = new QueryClient();
    const answer = deferred<ModelCatalogEntry[]>();
    const { forRole, rpc } = server(answer.promise);
    const list = readChatCatalog(client, spaceQueries("u", "s"), rpc);
    await flush();
    const role = readRoleCatalog(client, "u", "s", rpc, "computer");
    answer.resolve(whole);
    await expect(list).resolves.toEqual([chat, blind]);
    await expect(role).resolves.toEqual([chat]);
    expect(forRole).toHaveBeenCalledTimes(1);
  });

  it("reads the catalog of the space it names when the last read is old", async () => {
    const client = new QueryClient();
    const { forRole, rpc } = server();
    await readRoleCatalog(client, "u", "s", rpc, "main");
    expect(forRole).toHaveBeenLastCalledWith({ role: "approval" }, { context: { spaceId: "s" } });
    await readRoleCatalog(client, "u", "s", rpc, "main", () => Date.now() + SHARED_CATALOG_MS);
    expect(forRole).toHaveBeenCalledTimes(2);
  });

  it("shares the screen's unscoped read only while no space is selected", async () => {
    const client = new QueryClient();
    const { forRole, rpc } = server();
    await readChatCatalog(client, spaceQueries("u", null), rpc);
    await readRoleCatalog(client, "u", "s", rpc, "main");
    expect(forRole).toHaveBeenCalledTimes(1);
    selected.mockReturnValue("s");
    await readRoleCatalog(client, "u", "other", rpc, "main");
    expect(forRole).toHaveBeenCalledTimes(2);
  });

  it("after a change, joins the refresh's new read rather than keeping the old one", async () => {
    const client = new QueryClient();
    const changed = deferred<ModelCatalogEntry[]>();
    const { forRole, rpc } = server(Promise.resolve(whole), changed.promise);
    const queries = spaceQueries("u", "s");
    await readChatCatalog(client, queries, rpc);
    const refresh = readChatCatalog(client, queries, rpc);
    await flush();
    const role = readRoleCatalog(client, "u", "s", rpc, "approval");
    changed.resolve([chat]);
    await expect(refresh).resolves.toEqual([chat]);
    await expect(role).resolves.toEqual([chat]);
    expect(forRole).toHaveBeenCalledTimes(2);
  });

  it("reads again when the read it joined is cancelled before any answer", async () => {
    const client = new QueryClient();
    const first = deferred<ModelCatalogEntry[]>();
    const { forRole, rpc } = server(first.promise, Promise.resolve([chat]));
    const role = readRoleCatalog(client, "u", "s", rpc, "approval");
    await flush();
    await client.cancelQueries();
    await expect(role).resolves.toEqual([chat]);
    expect(forRole).toHaveBeenCalledTimes(2);
  });

  it("passes on a failed read", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rpc } = server(Promise.reject(new Error("down")));
    await expect(readRoleCatalog(client, "u", "s", rpc, "main")).rejects.toThrow("down");
  });
});
