// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
