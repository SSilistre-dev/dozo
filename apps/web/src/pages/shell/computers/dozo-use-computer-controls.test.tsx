// @vitest-environment jsdom
import type { Bot } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => ({ onOpenComputer: vi.fn(), calls: [] as unknown[] }));
vi.mock("./use-computer-controls", () => ({
  useComputerControls: (options: unknown) => {
    upstream.calls.push(options);
    return { onOpenComputer: upstream.onOpenComputer, computerOpen: false };
  },
}));

import type { DozoWallShell } from "./dozo-use-computer-controls";
import { useComputerControls, useDozoWallShell } from "./dozo-use-computer-controls";

type Options = Parameters<typeof useComputerControls>[0];
const rpc = {} as Options["rpc"];
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let seen: DozoWallShell | null = null;
let returned: unknown;

function Shell({ bots }: { bots: Bot[] }) {
  returned = useComputerControls({ bots, rpc } as unknown as Options);
  return null;
}
function Wall() {
  seen = useDozoWallShell();
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  upstream.onOpenComputer.mockReset();
  upstream.calls = [];
  seen = null;
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("hands the wall the shell's bots and full view while the shell is open, and nothing after", async () => {
  const bots = [{ id: "a" }] as Bot[];
  await act(async () =>
    root.render(
      <>
        <Shell bots={bots} />
        <Wall />
      </>,
    ),
  );
  expect(returned).toEqual({ onOpenComputer: upstream.onOpenComputer, computerOpen: false });
  expect(upstream.calls[0]).toEqual({ bots, rpc });
  expect(seen?.bots).toBe(bots);
  expect(seen?.rpc).toBe(rpc);
  seen?.openComputer("a");
  expect(upstream.onOpenComputer).toHaveBeenCalledExactlyOnceWith("a");

  const next = [{ id: "a" }, { id: "b" }] as Bot[];
  await act(async () =>
    root.render(
      <>
        <Shell bots={next} />
        <Wall />
      </>,
    ),
  );
  expect(seen?.bots).toBe(next);
  await act(async () => root.render(<Wall />));
  expect(seen).toBeNull();
});
