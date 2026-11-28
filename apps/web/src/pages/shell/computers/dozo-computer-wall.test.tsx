// @vitest-environment jsdom
import type { Bot, DozoComputerTile } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SCREEN_FRAME_LOAD_TIMEOUT_MS } from "../../../lib/computers/computer-screen";
import { dozoRosterChanged } from "../../../lib/dozo-stream-changed";
import type * as Query from "../../../lib/query/query";
import type { DozoWallShell } from "./dozo-use-computer-controls";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  screenUrl: vi.fn(),
  boot: vi.fn(),
  heartbeat: vi.fn(),
  takeover: vi.fn(),
  shell: null as DozoWallShell | null,
}));

vi.mock("../../../lib/query/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoComputerWall: {
      list: {
        queryOptions: () => ({
          queryKey: [["dozoComputerWall", "list"], { type: "query" }],
          queryFn: () => api.list(),
        }),
      },
    },
  }),
}));
vi.mock("./dozo-use-computer-controls", () => ({ useDozoWallShell: () => api.shell }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));
vi.mock("@rakazo/i18n/computer-usage", () => ({
  computerLabel: (_mode: string, name: string) => `${name}’s computer`,
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & Record<string, string>) => <button type="button" {...props} />,
  BotAvatar: ({ identity }: { identity: string }) => <span data-avatar={identity} />,
}));

import {
  DOZO_WALL_LIVE_MAX,
  DozoComputerWall,
  dozoWallTiles,
  wallScreenUrl,
} from "./dozo-computer-wall";

const bot = (id: string): Bot => ({ id, name: id.toUpperCase(), color: "#888888" }) as Bot;
const tile = (botId: string, state: DozoComputerTile["state"], screen = false) => ({
  botId,
  state,
  screen,
});
const VIEW = "/novnc/session/view/9999999999999.abc/vnc.html";
const CONTROL = "/novnc/session/control/9999999999999.abc/vnc.html";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const onClose = vi.fn();
const openComputer = vi.fn();

function wall(bots: Bot[]) {
  const rpc = {
    computer: {
      screenUrl: api.screenUrl,
      boot: api.boot,
      heartbeat: api.heartbeat,
      takeover: api.takeover,
    },
  };
  api.shell = { bots, rpc: rpc as unknown as DozoWallShell["rpc"], openComputer };
  return act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <DozoComputerWall params={{}} onClose={onClose} />
      </QueryClientProvider>,
    ),
  );
}

const tiles = () =>
  [...container.querySelectorAll('[data-testid="computers-wall-tile"]')].map((node) => ({
    name: node.querySelector("span.truncate")?.textContent,
    state: node.querySelector("span.ms-auto")?.textContent ?? null,
    frame: node.querySelector("iframe")?.getAttribute("src") ?? null,
    opens: node.querySelector("button")?.getAttribute("aria-label") ?? null,
  }));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const fn of [api.list, api.screenUrl, api.boot, api.heartbeat, api.takeover, onClose]) {
    fn.mockReset();
  }
  openComputer.mockReset();
  api.screenUrl.mockResolvedValue({ url: VIEW });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  api.shell = null;
  vi.unstubAllGlobals();
});

it("puts screens first, then running, starting and the rest, and streams at most the cap", () => {
  const bots = ["a", "b", "c", "d", "e", "f", "g"].map(bot);
  const rows = [
    tile("a", "suspended"),
    tile("b", "running", true),
    tile("c", "booting"),
    tile("d", "running", true),
    tile("e", "running", true),
    tile("f", "running", true),
    tile("g", "running", true),
  ];
  const ordered = dozoWallTiles(bots, rows, new Set(["d"]));
  expect(ordered.map((entry) => [entry.bot.id, entry.live])).toEqual([
    ["b", true],
    ["d", false],
    ["e", true],
    ["f", true],
    ["g", true],
    ["c", false],
    ["a", false],
  ]);
  expect(ordered.filter((entry) => entry.live)).toHaveLength(DOZO_WALL_LIVE_MAX);
});

it("shows a bot without a computer as off", () => {
  expect(dozoWallTiles([bot("a")], [], new Set())).toEqual([
    { bot: bot("a"), state: "stopped", live: false },
  ]);
});

it("never frames a single-use sign-in or the control view of someone driving it", () => {
  expect(wallScreenUrl({ url: VIEW })).toBe(`${window.location.origin}${VIEW}`);
  expect(wallScreenUrl({ url: VIEW, singleUseSignIn: { screen: "s" } })).toBeNull();
  expect(wallScreenUrl({ url: CONTROL })).toBeNull();
  expect(wallScreenUrl({ url: null })).toBeNull();
  expect(wallScreenUrl(undefined)).toBeNull();
});

it("streams a running computer view-only, and shows sleeping and absent ones without starting them", async () => {
  api.list.mockResolvedValue([tile("a", "running", true), tile("b", "suspended")]);
  await wall([bot("b"), bot("a"), bot("c")]);
  await vi.waitFor(() => expect(tiles()[0]?.frame).toBe(`${window.location.origin}${VIEW}`));
  expect(tiles()).toEqual([
    { name: "A", state: null, frame: expect.any(String), opens: "A’s computer" },
    { name: "B", state: "Asleep", frame: null, opens: null },
    { name: "C", state: "Off", frame: null, opens: null },
  ]);
  expect(api.screenUrl).toHaveBeenCalledExactlyOnceWith({ botId: "a", preview: true });
  expect(container.querySelector("iframe")?.className).toContain("pointer-events-none");
  for (const fn of [api.boot, api.heartbeat, api.takeover]) expect(fn).not.toHaveBeenCalled();
});

it("opens a running computer's full view and closes the wall", async () => {
  api.list.mockResolvedValue([tile("a", "running", true)]);
  await wall([bot("a")]);
  const open = await vi.waitFor(() => {
    const button = container.querySelector<HTMLButtonElement>('[aria-label="A’s computer"]');
    if (!button) throw new Error("no tile button");
    return button;
  });
  await act(async () => open.click());
  expect(onClose).toHaveBeenCalledOnce();
  expect(openComputer).toHaveBeenCalledExactlyOnceWith("a");
});

it("drops a screen that disconnects back to its bot and reads the list again", async () => {
  api.list.mockResolvedValue([tile("a", "running", true)]);
  await wall([bot("a")]);
  const frame = await vi.waitFor(() => {
    const found = container.querySelector("iframe");
    if (!found) throw new Error("no frame");
    return found;
  });
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { rakazoScreen: "disconnected" },
        source: frame.contentWindow,
      }),
    );
  });
  await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  expect(tiles()).toEqual([{ name: "A", state: "Running", frame: null, opens: "A’s computer" }]);
  expect(api.screenUrl).toHaveBeenCalledOnce();
});

it("keeps a screen that reported in, and drops one still silent at the load timeout", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
  try {
    api.list.mockResolvedValue([tile("a", "running", true), tile("b", "running", true)]);
    await wall([bot("a"), bot("b")]);
    const frames = await vi.waitFor(() => {
      const found = container.querySelectorAll("iframe");
      if (found.length < 2) throw new Error("no frames");
      return found;
    });
    await act(async () => {
      const source = frames[0]!.contentWindow;
      window.dispatchEvent(new MessageEvent("message", { data: { other: true }, source }));
      window.dispatchEvent(
        new MessageEvent("message", { data: { rakazoScreen: "connected" }, source }),
      );
    });
    await act(async () => vi.advanceTimersByTime(SCREEN_FRAME_LOAD_TIMEOUT_MS));
    await vi.waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(1));
  } finally {
    vi.useRealTimers();
  }
  expect(tiles().map((entry) => [entry.name, entry.frame === null])).toEqual([
    ["A", false],
    ["B", true],
  ]);
});

it("leaves a frame alone for another page's messages", async () => {
  api.list.mockResolvedValue([tile("a", "running", true)]);
  await wall([bot("a")]);
  await vi.waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { data: { rakazoScreen: "disconnected" } }));
  });
  expect(container.querySelector("iframe")).not.toBeNull();
  expect(api.list).toHaveBeenCalledOnce();
});

it("adds a computer that started on the roster signal, with no timer of its own", async () => {
  api.list.mockResolvedValueOnce([tile("a", "suspended")]);
  await wall([bot("a")]);
  await vi.waitFor(() => expect(tiles()[0]?.state).toBe("Asleep"));
  api.list.mockResolvedValue([tile("a", "running", true)]);
  await act(() => dozoRosterChanged(client));
  await vi.waitFor(() => expect(tiles()[0]?.frame).not.toBeNull());
  expect(api.list).toHaveBeenCalledTimes(2);
});

it("says so when there are no bots, and offers to read again when the list fails", async () => {
  api.list.mockResolvedValueOnce([]);
  await wall([]);
  await vi.waitFor(() => expect(container.textContent).toContain("No bots"));
  await act(async () => root.unmount());
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.list.mockRejectedValueOnce(new Error("down")).mockResolvedValue([tile("a", "stopped")]);
  await wall([bot("a")]);
  const retry = await vi.waitFor(() => {
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Retry",
    );
    if (!button) throw new Error("no retry");
    return button;
  });
  await act(async () => retry.click());
  await vi.waitFor(() => expect(tiles()).toHaveLength(1));
});

it("closes on Escape and from its close button", async () => {
  api.list.mockResolvedValue([]);
  await wall([]);
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  });
  expect(onClose).toHaveBeenCalledOnce();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click(),
  );
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("shows nothing while no shell is open beneath it", async () => {
  api.list.mockResolvedValue([]);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <DozoComputerWall params={{}} onClose={onClose} />
      </QueryClientProvider>,
    ),
  );
  expect(container.innerHTML).toBe("");
});
