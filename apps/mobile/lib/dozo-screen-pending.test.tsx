// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SCREEN_PENDING_MS, screenPending, useScreenPending } from "./dozo-screen-pending";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCREEN = "https://screen.example.test/view";
const running = { state: "running", kind: "docker", screenAvailable: true } as const;

let root: Root;
let container: HTMLDivElement;
let wait: ReturnType<typeof useScreenPending>;

function Probe({ screenUrl }: { screenUrl: string | null }) {
  wait = useScreenPending(running as never, screenUrl, null);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

it("waits only for a running computer that has a screen to show, and never over an error", () => {
  expect(screenPending(running as never, null, null)).toBe(true);
  expect(screenPending(running as never, SCREEN, null)).toBe(false);
  expect(screenPending(running as never, null, "Could not open computer")).toBe(false);
  expect(screenPending({ ...running, state: "suspended" } as never, null, null)).toBe(false);
  expect(screenPending({ ...running, state: "booting" } as never, null, null)).toBe(false);
  expect(screenPending(null, null, null)).toBe(false);
  // The user's own machine has no screen to wait for, by its flag or (older servers) its kind.
  expect(screenPending({ ...running, runsOnUserMachine: true } as never, null, null)).toBe(false);
  expect(screenPending({ ...running, kind: "desktop" } as never, null, null)).toBe(false);
  expect(screenPending({ ...running, screenAvailable: false } as never, null, null)).toBe(false);
});

it("ends the wait after its time, and still takes a link that comes late", async () => {
  await act(async () => root.render(<Probe screenUrl={null} />));
  expect(wait).toEqual({ pending: true, timedOut: false });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SCREEN_PENDING_MS - 1_000);
  });
  expect(wait.pending).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(wait).toEqual({ pending: false, timedOut: true });
  await act(async () => root.render(<Probe screenUrl={SCREEN} />));
  expect(wait).toEqual({ pending: false, timedOut: false });
  // A new wait starts from the beginning.
  await act(async () => root.render(<Probe screenUrl={null} />));
  expect(wait).toEqual({ pending: true, timedOut: false });
});
