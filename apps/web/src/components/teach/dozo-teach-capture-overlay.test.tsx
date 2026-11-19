// @vitest-environment jsdom

import type { TaughtSkill } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TeachCaptureOverlay } from "./dozo-teach-capture-overlay";

const computerInput = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const keys = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("../../lib/rpc", () => ({
  rpc: { computer: { input: computerInput }, dozoTeach: { keys } },
}));

const skill = {
  id: "skill-1",
  botId: "bot-1",
  name: "Export",
  goal: "Export weekly CRM list",
  status: "recording",
  recording: { events: [], snapshots: [] },
} as unknown as TaughtSkill;

afterEach(() => {
  computerInput.mockClear();
  keys.mockClear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const header = document.createElement("button");
  document.body.append(header);
  const root = createRoot(container);
  await act(async () => {
    root.render(<TeachCaptureOverlay botId="bot-1" skill={skill} enabled />);
  });
  const overlay = container.querySelector<HTMLElement>('[data-testid="teach-capture-overlay"]');
  if (!overlay) throw new Error("overlay missing");
  overlay.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400 }) as DOMRect;
  overlay.setPointerCapture = () => undefined;
  return { container, header, overlay };
}

it("lets a focused page control go when the screen is clicked, so typing is recorded", async () => {
  const { header, overlay } = await mount();
  header.focus();
  expect(document.activeElement).toBe(header);
  await act(async () => {
    overlay.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
  });
  expect(document.activeElement).toBe(document.body);
  computerInput.mockClear();
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  });
  await vi.waitFor(() => expect(keys).toHaveBeenCalled());
  expect(keys).toHaveBeenCalledWith(
    { botId: "bot-1", keys: ["a"], order: { page: expect.any(String), seq: expect.any(Number) } },
    undefined,
  );
});

it("sends keys typed in a row together, once, and a click between them keeps its place", async () => {
  const { overlay } = await mount();
  computerInput.mockClear();
  const typed = (key: string) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  await act(async () => {
    typed("a");
    typed("b");
    overlay.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
    typed("c");
    typed("Enter");
  });
  await vi.waitFor(() => expect(keys).toHaveBeenCalledTimes(2));
  expect(keys.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
    expect.objectContaining({ botId: "bot-1", keys: ["a", "b"] }),
    expect.objectContaining({ botId: "bot-1", keys: ["c", "Enter"] }),
  ]);
  // Upstream's own listener never sent them one by one.
  expect(computerInput).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "key" }));
  expect(computerInput).toHaveBeenCalledWith(expect.objectContaining({ kind: "pointer" }));
});

it("closes the batch on a scroll or protected input, and sends what is left as the page goes", async () => {
  const { overlay } = await mount();
  const first = deferred<{ ok: boolean }>();
  keys.mockImplementationOnce(() => first.promise);
  const typed = (key: string) =>
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  await act(async () => {
    typed("a");
  });
  await act(async () => {
    overlay.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true }));
    typed("b");
    const form = document.createElement("form");
    document.body.append(form);
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    typed("c");
    window.dispatchEvent(new Event("pagehide"));
  });
  // Each names the batch before it, the first the one still in flight.
  const [inFlight] = keys.mock.calls.map(
    (call) => (call as unknown[])[0] as { order: { seq: number } },
  );
  const seq = inFlight?.order.seq ?? 0;
  expect(keys.mock.calls.slice(1).map((call) => call as unknown[])).toEqual([
    [
      expect.objectContaining({ keys: ["b"], order: expect.objectContaining({ after: seq }) }),
      { context: { keepalive: true } },
    ],
    [
      expect.objectContaining({ keys: ["c"], order: expect.objectContaining({ after: seq + 1 }) }),
      { context: { keepalive: true } },
    ],
  ]);
  await act(async () => first.resolve({ ok: true }));
  // Sent as the page went: not again.
  expect(keys).toHaveBeenCalledTimes(3);
});

it("keeps keys aimed at a focused control out of the recording until the screen is clicked", async () => {
  const { header } = await mount();
  header.focus();
  await act(async () => {
    header.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  });
  expect(computerInput).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "key" }));
});

it("takes keys typed on the page, not shortcuts with a modifier", async () => {
  await mount();
  const plain = document.createElement("div");
  document.body.append(plain);
  await act(async () => {
    plain.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }));
    plain.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
  });
  await vi.waitFor(() => expect(keys).toHaveBeenCalledOnce());
  expect(keys).toHaveBeenCalledWith(
    expect.objectContaining({ botId: "bot-1", keys: ["x"] }),
    undefined,
  );
});

it("does nothing to focus when nothing but the page has it", async () => {
  const { overlay } = await mount();
  expect(document.activeElement).toBe(document.body);
  await act(async () => {
    overlay.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  expect(document.activeElement).toBe(document.body);
});

it("takes no layout box of its own", async () => {
  const { container } = await mount();
  expect((container.firstElementChild as HTMLElement).style.display).toBe("contents");
});
