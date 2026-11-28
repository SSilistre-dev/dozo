// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("../../lib/query/rpc", () => {
  const rpc = { routines: { list: api.list } };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => "space-1",
  };
});

import { QueryUserProvider, useSpaceQueries } from "../../lib/query/query";
import { useDozoRoutineSync } from "./dozo-routine-sync";

const setRoutines = vi.fn();
let client: QueryClient;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Probe({ botId, listedBotId }: { botId: string | undefined; listedBotId: string | null }) {
  useDozoRoutineSync(useSpaceQueries(), botId, listedBotId, setRoutines);
  return null;
}

async function render(listedBotId: string | null, botId: string | null = "bot-1") {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <QueryUserProvider value="user-1">
          <Probe botId={botId ?? undefined} listedBotId={listedBotId} />
        </QueryUserProvider>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockReset().mockResolvedValue([{ id: "r1", active: true }]);
  setRoutines.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("useDozoRoutineSync", () => {
  it("hands the panel list the routines a save made stale, once it shows this bot", async () => {
    await render("bot-1");
    await vi.waitFor(() => expect(setRoutines).toHaveBeenCalledWith([{ id: "r1", active: true }]));
    api.list.mockResolvedValue([{ id: "r1", active: false }]);
    await act(async () => {
      await client.invalidateQueries();
    });
    await vi.waitFor(() =>
      expect(setRoutines).toHaveBeenLastCalledWith([{ id: "r1", active: false }]),
    );
  });

  it("leaves the list alone while it still shows another bot's routines", async () => {
    await render("bot-2");
    await vi.waitFor(() => expect(api.list).toHaveBeenCalled());
    expect(setRoutines).not.toHaveBeenCalled();
  });

  it("reads nothing while no bot is open", async () => {
    await render(null, null);
    expect(api.list).not.toHaveBeenCalled();
    expect(setRoutines).not.toHaveBeenCalled();
  });
});
