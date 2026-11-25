// @vitest-environment jsdom

import type { TaughtSkill } from "@rakazo/contracts";
import { buildPlaybookFromRecording } from "@rakazo/core";
import { deferred } from "@rakazo/core/test-async";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TeachCaptureOverlay } from "./dozo-teach-capture-overlay";

type Input = { kind: string; payload: Record<string, unknown> };

const computerInput = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ ok: true })));
const keys = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("../../lib/query/rpc", () => ({
  rpc: { computer: { input: computerInput }, dozoTeach: { keys } },
}));

const skill = {
  id: "skill-1",
  botId: "bot-1",
  status: "recording",
  recording: { events: [], snapshots: [] },
} as unknown as TaughtSkill;

const roots: Root[] = [];

afterEach(async () => {
  // Each test's tree comes down with it, so the click ring's timer is cleared, not left to fire
  // after the test and its page are gone.
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  computerInput.mockReset();
  computerInput.mockImplementation(async () => ({ ok: true }));
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <TeachCaptureOverlay
        botId="bot-1"
        skill={skill}
        enabled
        screenWidth={1280}
        screenHeight={800}
      />,
    );
  });
  const overlay = container.querySelector<HTMLElement>('[data-testid="teach-capture-overlay"]');
  if (!overlay) throw new Error("overlay missing");
  // The overlay shows the screen at half size.
  overlay.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 640, height: 400, right: 640, bottom: 400 }) as DOMRect;
  overlay.setPointerCapture = () => undefined;
  overlay.hasPointerCapture = () => false;
  return { container, overlay };
}

function pointer(
  overlay: HTMLElement,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  x: number,
  y: number,
  options: { button?: number; buttons?: number } = {},
) {
  const buttons = options.buttons ?? (type === "pointerup" ? 0 : 1);
  const init = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: options.button ?? 0,
    buttons,
    // A real browser names the pointer; upstream follows the one that pressed.
    pointerId: 1,
  };
  return act(async () => {
    overlay.dispatchEvent(
      typeof PointerEvent === "function"
        ? new PointerEvent(type, init)
        : new MouseEvent(type, init),
    );
  });
}

const sent = () => computerInput.mock.calls.map((call) => call[0] as Input);
const types = () => sent().map((input) => input.payload.type);

it("sends a plain click as one request, at the spot it began", async () => {
  const { overlay } = await mount();
  await pointer(overlay, "pointerdown", 100, 50);
  // Nothing goes until the release shows it was not a drag.
  expect(computerInput).not.toHaveBeenCalled();
  await pointer(overlay, "pointerup", 101, 51);
  await vi.waitFor(() => expect(computerInput).toHaveBeenCalledOnce());
  expect(sent()).toEqual([
    {
      botId: "bot-1",
      kind: "pointer",
      payload: { x: 200, y: 100, button: "left", type: "click", skillId: "skill-1" },
    },
  ]);
});

it("sends a right click as one right click, and a double click as two clicks in order", async () => {
  const { overlay } = await mount();
  await pointer(overlay, "pointerdown", 10, 10, { button: 2, buttons: 2 });
  await pointer(overlay, "pointerup", 10, 10, { button: 2 });
  await pointer(overlay, "pointerdown", 20, 20);
  await pointer(overlay, "pointerup", 20, 20);
  await pointer(overlay, "pointerdown", 20, 20);
  await pointer(overlay, "pointerup", 20, 20);
  await vi.waitFor(() => expect(computerInput).toHaveBeenCalledTimes(3));
  expect(sent().map((input) => input.payload)).toEqual([
    { x: 20, y: 20, button: "right", type: "click", skillId: "skill-1" },
    { x: 40, y: 40, button: "left", type: "click", skillId: "skill-1" },
    { x: 40, y: 40, button: "left", type: "click", skillId: "skill-1" },
  ]);
});

it("makes no request for movement that stays within a click, and none for a hover", async () => {
  const { overlay } = await mount();
  await pointer(overlay, "pointermove", 30, 30, { buttons: 0 });
  await pointer(overlay, "pointerdown", 100, 50);
  await pointer(overlay, "pointermove", 102, 51);
  await pointer(overlay, "pointermove", 103, 52);
  await pointer(overlay, "pointerup", 103, 52);
  await vi.waitFor(() => expect(computerInput).toHaveBeenCalledOnce());
  expect(types()).toEqual(["click"]);
});

it("hands a real drag to upstream: the press, the newest position, the release, in that order", async () => {
  const { overlay } = await mount();
  await pointer(overlay, "pointerdown", 100, 50);
  await pointer(overlay, "pointermove", 140, 90);
  await pointer(overlay, "pointermove", 200, 150);
  await pointer(overlay, "pointerup", 200, 150);
  await vi.waitFor(() => expect(types().at(-1)).toBe("up"));
  expect(types()[0]).toBe("down");
  expect(types()).not.toContain("click");
  expect(sent()[0]?.payload).toMatchObject({ x: 200, y: 100 });
  expect(sent().at(-1)?.payload).toMatchObject({ x: 400, y: 300 });
});

it("sends nothing for a press that is cancelled", async () => {
  const { overlay } = await mount();
  await pointer(overlay, "pointerdown", 100, 50);
  // A cancelled press is not followed by a release.
  await pointer(overlay, "pointercancel", 100, 50);
  expect(computerInput).not.toHaveBeenCalled();
});

it("keeps clicks in the order they were made while an earlier one is still in flight", async () => {
  const { overlay } = await mount();
  const first = deferred<{ ok: boolean }>();
  computerInput.mockImplementationOnce(() => first.promise);
  await pointer(overlay, "pointerdown", 10, 10);
  await pointer(overlay, "pointerup", 10, 10);
  await pointer(overlay, "pointerdown", 60, 60);
  await pointer(overlay, "pointerup", 60, 60);
  await vi.waitFor(() => expect(computerInput).toHaveBeenCalledOnce());
  expect(sent()[0]?.payload).toMatchObject({ x: 20, y: 20 });
  await act(async () => first.resolve({ ok: true }));
  await vi.waitFor(() => expect(computerInput).toHaveBeenCalledTimes(2));
  expect(sent()[1]?.payload).toMatchObject({ x: 120, y: 120 });
});

it("records the same steps as the press and release it replaces", async () => {
  const { overlay } = await mount();
  await pointer(overlay, "pointerdown", 100, 50);
  await pointer(overlay, "pointerup", 100, 50);
  await pointer(overlay, "pointerdown", 20, 20, { button: 2, buttons: 2 });
  await pointer(overlay, "pointerup", 20, 20, { button: 2 });
  await pointer(overlay, "pointerdown", 300, 300);
  await pointer(overlay, "pointermove", 302, 301);
  await pointer(overlay, "pointerup", 302, 301);
  await vi.waitFor(() => expect(computerInput).toHaveBeenCalledTimes(3));
  const asRecorded = (inputs: Input[]) =>
    inputs.map((input, index) => ({
      at: new Date(index * 1000).toISOString(),
      kind: "pointer" as const,
      ...(input.payload as { x: number; y: number; button: "left" | "right"; type: string }),
    }));
  const now = buildPlaybookFromRecording("Export", asRecorded(sent()));
  // What upstream's listeners sent for the same hand movements: a press and a release each,
  // the release where the pointer ended up, and the moves in between.
  const before = buildPlaybookFromRecording(
    "Export",
    asRecorded([
      { kind: "pointer", payload: { x: 200, y: 100, button: "left", type: "down" } },
      { kind: "pointer", payload: { x: 200, y: 100, button: "left", type: "up" } },
      { kind: "pointer", payload: { x: 40, y: 40, button: "right", type: "down" } },
      { kind: "pointer", payload: { x: 40, y: 40, button: "right", type: "up" } },
      { kind: "pointer", payload: { x: 600, y: 600, button: "left", type: "down" } },
      { kind: "pointer", payload: { x: 604, y: 602, button: "left", type: "move" } },
      { kind: "pointer", payload: { x: 604, y: 602, button: "left", type: "up" } },
    ]),
  );
  expect(now.steps.length).toBe(3);
  expect(now).toEqual(before);
});

it("shows a ring where the press landed at once, and takes it away after a moment", async () => {
  vi.useFakeTimers();
  const { container, overlay } = await mount();
  expect(container.querySelector('[data-testid="teach-click-ring"]')).toBeNull();
  await pointer(overlay, "pointerdown", 100, 50);
  const ring = container.querySelector<HTMLElement>('[data-testid="teach-click-ring"]');
  expect(ring?.style.left).toBe("100px");
  expect(ring?.style.top).toBe("50px");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(449);
  });
  expect(container.querySelector('[data-testid="teach-click-ring"]')).not.toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2);
  });
  expect(container.querySelector('[data-testid="teach-click-ring"]')).toBeNull();
});

it("restarts the ring's time for a second click, and draws none outside a recording", async () => {
  vi.useFakeTimers();
  const { container, overlay } = await mount();
  await pointer(overlay, "pointerdown", 10, 10);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  await pointer(overlay, "pointerdown", 50, 50);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  const ring = container.querySelector<HTMLElement>('[data-testid="teach-click-ring"]');
  expect(ring?.style.left).toBe("50px");
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  await act(async () => {
    root.render(<TeachCaptureOverlay botId="bot-1" skill={null} enabled />);
  });
  expect(document.querySelectorAll('[data-testid="teach-click-ring"]').length).toBe(1);
});

it("lets go of the pointer it captured when the press ends, and ignores a release with no press", async () => {
  const { overlay } = await mount();
  const release = vi.fn();
  overlay.hasPointerCapture = () => true;
  overlay.releasePointerCapture = release;
  await pointer(overlay, "pointerdown", 100, 50);
  await pointer(overlay, "pointermove", 101, 50, { buttons: 0 });
  await pointer(overlay, "pointerup", 100, 50);
  expect(release).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(computerInput).toHaveBeenCalledOnce());
});

it("shows no ring for a press that becomes a drag, and hides the ring from assistive technology", async () => {
  const { container, overlay } = await mount();
  await pointer(overlay, "pointerdown", 100, 50);
  expect(
    container.querySelector('[data-testid="teach-click-ring"]')?.getAttribute("aria-hidden"),
  ).toBe("true");
  await pointer(overlay, "pointermove", 200, 150);
  expect(container.querySelector('[data-testid="teach-click-ring"]')).toBeNull();
  await pointer(overlay, "pointerup", 200, 150);
});
