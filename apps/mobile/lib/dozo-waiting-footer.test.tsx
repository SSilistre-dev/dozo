// @vitest-environment jsdom
import type { DozoQueueItem } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ui = vi.hoisted(() => ({
  items: [] as DozoQueueItem[],
  run: vi.fn(),
  pending: false,
  os: "ios",
  alert: vi.fn(),
  sheet: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray) => strings[0],
  }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: ui.alert },
  Platform: {
    get OS() {
      return ui.os;
    },
  },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => (
    <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("./ios-action-sheet", () => ({ showIOSActionSheet: ui.sheet }));
vi.mock("../components/thread/thread-list-controls", () => ({
  ThreadWorkingFooter: ({ label }: { label: string }) => <div role="status">{label}</div>,
}));
vi.mock("./dozo-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dozo-queue")>()),
  useDozoQueue: () => ({ items: ui.items, cancel: { run: ui.run, pending: ui.pending } }),
}));

import { DozoWaitingFooter } from "../components/thread/dozo-waiting-footer";

const item = (over: Partial<DozoQueueItem>): DozoQueueItem => ({
  id: "run-1",
  kind: "run",
  botId: "bot-1",
  position: 1,
  mine: true,
  reason: "bot_busy",
  waitingFor: null,
  label: null,
  ...over,
});

let root: Root;
let container: HTMLDivElement;
const footer = (target?: { botId: string }) => (
  <DozoWaitingFooter bots={[]} label="Working…" atBottom target={target} />
);
const render = (node: ReactNode) => act(() => root.render(node));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  ui.items = [];
  ui.pending = false;
  ui.os = "ios";
  ui.run.mockReset();
  ui.alert.mockReset();
  ui.sheet.mockReset();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

it("is the plain working line without a target or while nothing of yours waits", () => {
  render(footer());
  expect(container.textContent).toBe("Working…");
  render(footer({ botId: "bot-1" }));
  expect(container.textContent).toBe("Working…");
  ui.items = [item({ mine: false })];
  render(footer({ botId: "bot-1" }));
  expect(container.textContent).toBe("Working…");
  expect(container.querySelector("button")).toBeNull();
});

it("opens a native sheet that lists what waits and stops your own", () => {
  ui.items = [item({ id: "other", mine: false }), item({ id: "mine", position: 2, label: "Report" })];
  render(footer({ botId: "bot-1" }));
  expect(container.textContent).toBe("Waiting in line… · Busy elsewhere · #2");
  act(() => container.querySelector("button")?.click());
  const [options, pick] = ui.sheet.mock.calls[0] ?? [];
  expect(options).toEqual({
    message: "1  Another task\n2  Report",
    options: ["Stop waiting · Report", "Cancel"],
    cancelButtonIndex: 1,
  });
  act(() => pick(1));
  expect(ui.run).not.toHaveBeenCalled();
  act(() => pick(0));
  expect(ui.run).toHaveBeenCalledWith(expect.objectContaining({ id: "mine" }));
  ui.run.mockReset();
  ui.pending = true;
  render(footer({ botId: "bot-1" }));
  act(() => container.querySelector("button")?.click());
  act(() => ui.sheet.mock.calls[1]?.[1](0));
  expect(ui.run).not.toHaveBeenCalled();
});

it("uses an alert off iOS, and never offers to stop another's work", () => {
  ui.os = "android";
  ui.items = [item({ id: "other", mine: false }), item({ id: "mine", position: 2 })];
  render(footer({ botId: "bot-1" }));
  act(() => container.querySelector("button")?.click());
  const [title, message, buttons] = ui.alert.mock.calls[0] ?? [];
  expect(title).toBe("Waiting in line… · Busy elsewhere · #2");
  expect(message).toBe("1  Another task\n2  Busy elsewhere");
  expect(buttons.map((button: { text: string }) => button.text)).toEqual(["Stop waiting", "Cancel"]);
  buttons[0].onPress();
  expect(ui.run).toHaveBeenCalledWith(expect.objectContaining({ id: "mine" }));
});
