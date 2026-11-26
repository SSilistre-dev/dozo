import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";

vi.mock("./query/query", () => ({ queryClient: new QueryClient() }));

import { spaceChanged } from "./query/space-changes";

it("a runs change reads what waits for a bot again, and a routines change does not", async () => {
  const client = new QueryClient();
  const queue = [["user:user-1", "space:space-1", "dozoQueue", "list"], { type: "query" }];
  client.setQueryData(queue, { items: [] });
  await spaceChanged("routines", client);
  expect(client.getQueryState(queue)?.isInvalidated).toBe(false);
  await spaceChanged("runs", client);
  expect(client.getQueryState(queue)?.isInvalidated).toBe(true);
});
