// @vitest-environment jsdom

import type { ComputerStatus } from "@rakazo/contracts";
import { SCREEN_RECONNECT_DELAY_MS } from "@rakazo/core";
import { deferred } from "@rakazo/core/test-async";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Runs on the branded tree: the wait is laid into upstream's computer controls by brand rules.

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  Spinner: () => null,
}));
vi.mock("../../components/ComputerMaintenanceActions", () => ({
  ComputerMaintenanceActions: () => null,
}));
vi.mock("../../components/SubscriptionGate", () => ({
  useBilling: () => ({ status: null, showPlans: () => undefined }),
}));

import { SCREEN_WAIT_MS, screenAwaited } from "./dozo-screen-wait";
import type { ComputerState } from "./use-computer";
import { useComputerControls, useComputerState } from "./use-computer";

const SCREEN = "https://screen.example.test/view?token=placeholder";
const computerIn = (state: ComputerStatus["state"]) =>
  ({ botId: "bot-1", state, kind: "browser", mode: "shared" }) as unknown as ComputerStatus;
const bot = { id: "bot-1", name: "Fixture" } as never;

let container: HTMLDivElement;
let root: Root;
let state: ComputerState;
let controls: ReturnType<typeof useComputerControls>;
let boot: ReturnType<typeof vi.fn>;
let screenUrl: ReturnType<typeof vi.fn>;
let mountFrame = false;

/** The hooks with the window's middle as the overlay draws it: screen, error, progress or name. */
function Window() {
  const rpc = {
    computer: { boot, screenUrl, heartbeat: vi.fn(async () => ({ ok: true })) },
  } as never;
  state = useComputerState({
    rpc,
    panel: null,
    activeId: "bot-1",
    activeBotId: { current: "bot-1" },
  });
  controls = useComputerControls({
    rpc,
    state,
    panel: null,
    active: bot,
    bots: [bot],
    botsRef: { current: [bot] },
    activeBotId: { current: "bot-1" },
    activeGroupId: { current: undefined },
    runStatus: undefined,
    sandboxProvider: undefined,
    // As upstream's thread refresh: it commits the computer it read and reads the screen beside.
    refreshThread: vi.fn(async (id: string) => {
      state.commitComputer(computerIn("running"));
      void state.refreshComputerScreen(id).catch(() => null);
      return {} as never;
    }),
    refreshGroupThread: vi.fn(),
    onUpgrade: vi.fn(),
  });
  const { computer } = state;
  return (
    <div>
      {computer?.state === "running" &&
      controls.embeddedScreenUrl &&
      !controls.computerScreenError ? (
        <iframe
          key={state.screenFrameKey}
          title="screen"
          ref={mountFrame ? state.setScreenFrame : undefined}
          data-src={controls.embeddedScreenUrl}
        />
      ) : (
        (controls.computerScreenError ?? controls.computerBooting ?? "Team Computer")
      )}
    </div>
  );
}

/** Under fake timers: runs what is due now, and the promise callbacks queued before it. */
const settle = () => vi.advanceTimersByTimeAsync(0);
const shown = () => container.textContent ?? "";
const frame = () => container.querySelector("iframe");
const button = (name: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent === name);

async function render(computer: ComputerStatus) {
  await act(async () => root.render(<Window />));
  await act(async () => state.commitComputer(computer));
}

async function wake() {
  await act(async () => {
    void controls.openComputer("bot-1");
    await settle();
  });
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mountFrame = false;
  boot = vi.fn(async () => computerIn("running"));
  screenUrl = vi.fn(async () => ({ url: SCREEN }));
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it("shows progress, never the bare name, from a late boot answer until the slow screen arrives", async () => {
  const booted = deferred<ComputerStatus>();
  const screen = deferred<{ url: string }>();
  boot.mockImplementation(() => booted.promise);
  screenUrl.mockImplementation(() => screen.promise);
  await render(computerIn("suspended"));
  await wake();
  expect(shown()).toBe("Booting live desktop…");
  await act(async () => {
    booted.resolve(computerIn("running"));
    await settle();
  });
  expect(screenUrl).toHaveBeenCalledTimes(1);
  expect(shown()).toBe("Booting live desktop…");
  // A slow API answers within the wait: the screen shows, with no error on the way.
  await wait(SCREEN_WAIT_MS - 1_000);
  expect(shown()).toBe("Booting live desktop…");
  await act(async () => {
    screen.resolve({ url: SCREEN });
    await settle();
  });
  expect(frame()?.dataset.src).toBe(SCREEN);
});

it("shows progress while a computer woken elsewhere connects, before its first screen read", async () => {
  const connected = deferred<ComputerStatus>();
  boot.mockImplementation(() => connected.promise);
  // The thread said running before this window read any screen.
  await render(computerIn("running"));
  await wake();
  expect(screenUrl).not.toHaveBeenCalled();
  expect(shown()).toBe("Booting live desktop…");
  await act(async () => {
    connected.resolve(computerIn("running"));
    await settle();
  });
  expect(frame()?.dataset.src).toBe(SCREEN);
});

it("ends a screen read that never answers in the screen's error with Retry", async () => {
  screenUrl.mockImplementationOnce(() => new Promise(() => undefined));
  await render(computerIn("suspended"));
  await wake();
  expect(shown()).toBe("Booting live desktop…");
  await wait(SCREEN_WAIT_MS);
  expect(shown()).toContain("Could not connect to the computer screen");
  expect(button("Retry screen")).toBeDefined();
  // Retry reads again and waits from the start.
  await act(async () => {
    button("Retry screen")!.click();
    await settle();
  });
  expect(screenUrl).toHaveBeenCalledTimes(2);
  expect(frame()?.dataset.src).toBe(SCREEN);
});

it("waits again from the start after Retry", async () => {
  screenUrl.mockImplementation(() => new Promise(() => undefined));
  await render(computerIn("suspended"));
  await wake();
  await wait(SCREEN_WAIT_MS);
  await act(async () => {
    button("Retry screen")!.click();
    await settle();
  });
  expect(shown()).toBe("Booting live desktop…");
  await wait(SCREEN_WAIT_MS - 1_000);
  expect(shown()).toBe("Booting live desktop…");
  await wait(1_000);
  expect(button("Retry screen")).toBeDefined();
});

it("still shows a screen that answers after the wait ran out", async () => {
  const late = deferred<{ url: string }>();
  screenUrl.mockImplementationOnce(() => late.promise);
  await render(computerIn("suspended"));
  await wake();
  await wait(SCREEN_WAIT_MS);
  expect(button("Retry screen")).toBeDefined();
  await act(async () => {
    late.resolve({ url: SCREEN });
    await settle();
  });
  expect(frame()?.dataset.src).toBe(SCREEN);
});

it("shows a failed screen read at once, with Retry", async () => {
  screenUrl.mockImplementationOnce(async () => {
    throw new Error("");
  });
  await render(computerIn("suspended"));
  await wake();
  expect(shown()).toContain("Could not connect to the computer screen");
  expect(button("Retry screen")).toBeDefined();
});

it("shows a failed wake with Retry, and Retry wakes it", async () => {
  boot.mockImplementationOnce(async () => {
    throw new Error("");
  });
  await render(computerIn("suspended"));
  await wake();
  expect(shown()).toContain("Computer failed to boot");
  await act(async () => {
    button("Retry screen")!.click();
    await settle();
  });
  expect(boot).toHaveBeenCalledTimes(2);
  expect(frame()?.dataset.src).toBe(SCREEN);
});

it("reconnects a screen that drops after connecting, without the error", async () => {
  mountFrame = true;
  await render(computerIn("suspended"));
  await wake();
  const first = frame()!;
  const report = async (rakazoScreen: string) => {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", { data: { rakazoScreen }, source: frame()!.contentWindow }),
      );
    });
  };
  await report("connected");
  await report("disconnected");
  await wait(SCREEN_RECONNECT_DELAY_MS);
  await act(async () => settle());
  expect(frame()).not.toBe(first);
  expect(controls.computerScreenError).toBeNull();
});

it("waits only for a running computer's own screen in its open window", () => {
  const base = {
    computerOpen: true,
    state: "running",
    runsOnUserMachine: false,
    booting: false,
    embeddedUrl: null,
    screenUrlLoaded: false,
    failed: false,
  };
  expect(screenAwaited(base)).toBe(true);
  expect(screenAwaited({ ...base, computerOpen: false })).toBe(false);
  expect(screenAwaited({ ...base, state: "suspended" })).toBe(false);
  expect(screenAwaited({ ...base, runsOnUserMachine: true })).toBe(false);
  expect(screenAwaited({ ...base, booting: true })).toBe(false);
  expect(screenAwaited({ ...base, embeddedUrl: SCREEN })).toBe(false);
  expect(screenAwaited({ ...base, screenUrlLoaded: true })).toBe(false);
  expect(screenAwaited({ ...base, failed: true })).toBe(false);
});
