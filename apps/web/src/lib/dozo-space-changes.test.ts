import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";

// Runs on the branded tree only: a brand rule adds the cache share and the usage breakdown to the
// reads a run change covers.

vi.mock("./query/query", () => ({ queryClient: new QueryClient() }));

import { spaceChanged } from "./space-changes";

it("reads the cache share again when a run changes", async () => {
  const client = new QueryClient();
  const key = [["user:user-1", "space:space-1", "dozoUsage", "cacheSavings"], { type: "query" }];
  client.setQueryData(key, null);
  await spaceChanged("routines", client);
  expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  await spaceChanged("runs", client);
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
});

it("reads the usage breakdown again when a run changes, whatever it is grouped by", async () => {
  const client = new QueryClient();
  const key = [
    ["user:user-1", "space:space-1", "dozoUsage", "breakdown"],
    { type: "query", input: { by: "routine" } },
  ];
  client.setQueryData(key, []);
  await spaceChanged("routines", client);
  expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  await spaceChanged("runs", client);
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
});
