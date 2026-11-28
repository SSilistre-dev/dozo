// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("./shell/dozo-replay-surface", () => ({
  DozoReplaySurface: ({ params }: { params: Record<string, string> }) => (
    <p>replay {params.messageId}</p>
  ),
}));
vi.mock("./shell/computers/dozo-computer-wall", () => ({
  DozoComputerWall: () => <p>computers wall</p>,
}));

import type { DozoSurfaceProps } from "./dozo-surfaces";
import { DozoSurfaceHost, openDozoSurface } from "./dozo-surfaces";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function Board({ params, onClose }: DozoSurfaceProps) {
  return (
    <button type="button" onClick={onClose}>
      board {params.botId}
    </button>
  );
}
const surfaces = { board: async () => Board };

it("loads a surface when it is opened, with its params, and closes it", async () => {
  await act(async () => root.render(<DozoSurfaceHost surfaces={surfaces} />));
  expect(host.textContent).toBe("");
  await act(async () => openDozoSurface("board", { botId: "b1" }));
  expect(host.textContent).toBe("board b1");
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).toBe("");
});

it("opens nothing for a key it does not have", async () => {
  await act(async () => root.render(<DozoSurfaceHost surfaces={surfaces} />));
  await act(async () => openDozoSurface("toString"));
  expect(host.textContent).toBe("");
});

it("does nothing when opened with no shell on screen", () => {
  expect(() => openDozoSurface("board")).not.toThrow();
});

it("opens the replay review from the shell's own surfaces", async () => {
  await act(async () => root.render(<DozoSurfaceHost />));
  await act(async () => openDozoSurface("replay", { messageId: "m-1" }));
  await vi.waitFor(() => expect(host.textContent).toBe("replay m-1"));
});

it("opens the computers wall from its key", async () => {
  await act(async () => root.render(<DozoSurfaceHost />));
  await act(async () => openDozoSurface("computers"));
  await vi.waitFor(() => expect(host.textContent).toBe("computers wall"));
});
