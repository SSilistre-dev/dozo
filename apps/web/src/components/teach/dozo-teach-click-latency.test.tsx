// @vitest-environment jsdom

import type { TaughtSkill } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TeachCaptureOverlay } from "./dozo-teach-capture-overlay";
import { enqueueTeachComputerInput } from "./teach-computer-input-chain";

// Repeatable timing of one click, on a clock the test owns: the page's own queue and request
// count are the real code; the network and the server's handler are fixed delays, so the result
// is the same every run. The server's own share (a recording write and one action on the
// computer per input) is in dozo-teach-input-cost.postgres.test.ts.
const ROUND_TRIP_MS = 80;
const HANDLER_MS = 120;

const computerInput = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ ok: true })));
vi.mock("../../lib/rpc", () => ({
  rpc: { computer: { input: computerInput }, dozoTeach: { keys: vi.fn() } },
}));

const skill = {
  id: "skill-1",
  botId: "bot-1",
  status: "recording",
  recording: { events: [], snapshots: [] },
} as unknown as TaughtSkill;

afterEach(() => {
  computerInput.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A request that lands on the computer after the handler ran; it is answered a round trip later. */
function slowServer(landed: Array<{ type: unknown; at: number }>) {
  computerInput.mockImplementation(async (input: unknown) => {
    await new Promise((resolve) => setTimeout(resolve, ROUND_TRIP_MS / 2 + HANDLER_MS));
    landed.push({
      type: (input as { payload: { type: unknown } }).payload.type,
      at: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, ROUND_TRIP_MS / 2));
    return { ok: true };
  });
}

it("lands a click on the computer one round trip sooner than a press and a release", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const landed: Array<{ type: unknown; at: number }> = [];
  slowServer(landed);
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(<TeachCaptureOverlay botId="bot-1" skill={skill} enabled />);
  });
  const overlay = container.querySelector<HTMLElement>('[data-testid="teach-capture-overlay"]');
  if (!overlay) throw new Error("overlay missing");
  overlay.setPointerCapture = () => undefined;
  overlay.hasPointerCapture = () => false;

  // The click: a release at time zero, measured to the action landing on the computer.
  const start = Date.now();
  await act(async () => {
    for (const type of ["pointerdown", "pointerup"]) {
      overlay.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
    await vi.runAllTimersAsync();
  });
  const afterMs = (landed.at(-1)?.at ?? 0) - start;

  // The same click as upstream sent it: a press, then a release, one request each in turn.
  landed.length = 0;
  const before = Date.now();
  await act(async () => {
    for (const type of ["down", "up"]) {
      void enqueueTeachComputerInput("bot-1", async () => {
        await (await import("../../lib/rpc")).rpc.computer.input({
          botId: "bot-1",
          kind: "pointer",
          payload: { x: 0, y: 0, button: "left", type },
        } as never);
      });
    }
    await vi.runAllTimersAsync();
  });
  const beforeMs = (landed.at(-1)?.at ?? 0) - before;

  expect(afterMs).toBe(ROUND_TRIP_MS / 2 + HANDLER_MS);
  expect(beforeMs).toBe(ROUND_TRIP_MS + 2 * HANDLER_MS + ROUND_TRIP_MS / 2);
  expect(afterMs).toBeLessThan(beforeMs);
});
