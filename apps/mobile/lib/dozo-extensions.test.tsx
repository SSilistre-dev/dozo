// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DozoBotSettingsRows, DozoSettingsRows } from "../components/dozo-extensions";

vi.mock("../components/dozo-night-notes-row", () => ({ DozoNightNotesRow: () => null }));

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("draws every settings row in order", () => {
  act(() => root.render(<DozoSettingsRows rows={[() => <p>one</p>, () => <p>two</p>]} />));
  expect(host.textContent).toBe("onetwo");
});

it("gives every bot settings row the bot", () => {
  const Row = ({ botId }: { botId: string }) => <p>{botId}</p>;
  act(() => root.render(<DozoBotSettingsRows botId="b1" rows={[Row, Row]} />));
  expect(host.textContent).toBe("b1b1");
});
