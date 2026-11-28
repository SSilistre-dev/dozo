// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DozoLazyList, dozoLazyEntries } from "./dozo-lazy-list";

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

it("draws every entry with the same props in order, leaving out one whose code fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const entries = dozoLazyEntries<{ botId: string }>([
    async () =>
      ({ botId }) => <p>first {botId}</p>,
    async () => {
      throw new Error("chunk gone");
    },
    async () =>
      ({ botId }) => <p>third {botId}</p>,
  ]);
  await act(async () => root.render(<DozoLazyList entries={entries} props={{ botId: "b1" }} />));
  expect([...host.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
    "first b1",
    "third b1",
  ]);
});
