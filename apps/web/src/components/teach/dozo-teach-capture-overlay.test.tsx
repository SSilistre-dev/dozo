// @vitest-environment jsdom

import type { TaughtSkill } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TeachCaptureOverlay } from "./dozo-teach-capture-overlay";

const computerInput = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("../../lib/rpc", () => ({ rpc: { computer: { input: computerInput } } }));

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
  await vi.waitFor(() => expect(computerInput).toHaveBeenCalled());
  expect(computerInput).toHaveBeenCalledWith({
    botId: "bot-1",
    kind: "key",
    payload: { key: "a" },
  });
});

it("keeps keys aimed at a focused control out of the recording until the screen is clicked", async () => {
  const { header } = await mount();
  header.focus();
  await act(async () => {
    header.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
  });
  expect(computerInput).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "key" }));
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
