// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isLeavingSession, startCall } from "../../lib/calls/call-session";
import { dozoCheckCall } from "../../lib/dozo-call-start";
import { rpc } from "../../lib/query/rpc";
import { IncomingCall } from "./IncomingCall";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      "message" in parts ? parts.message : String.raw(parts, ...values),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: () => null,
  defaultBotAvatarValue: () => "",
  Button: ({ children, ...props }: { children: ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../../lib/calls/call-session", () => ({
  getSnapshot: vi.fn(() => null),
  isLeavingSession: vi.fn(() => false),
  prepareCallAudio: vi.fn(),
  startCall: vi.fn(),
  useCallSession: () => null,
}));
vi.mock("../../lib/dozo-call-start", () => ({ dozoCheckCall: vi.fn() }));
vi.mock("../../lib/query/rpc", () => ({
  rpc: {
    threads: { answerCall: vi.fn(), endCall: vi.fn() },
    notifications: { declineIncomingCall: vi.fn() },
  },
  selectedSpaceId: () => "space-1",
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const bot = {
  id: "bot-1",
  name: "Test bot",
  incomingCall: {
    callId: "call-1",
    reason: "Review",
    opening: "Ready?",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  },
} as Bot;

async function answer() {
  const onAnswered = vi.fn();
  act(() => root.render(<IncomingCall bots={[bot]} onAnswered={onAnswered} />));
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Answer")!
      .click();
  });
  return onAnswered;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", class {});
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.clearAllMocks();
  vi.mocked(isLeavingSession).mockReturnValue(false);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("leaves a call that cannot be heard ringing: nothing is answered, declined or started", async () => {
  vi.mocked(dozoCheckCall).mockResolvedValue({
    refusal: "Can't call: the model isn't answering.",
    serverDictation: undefined,
  });
  const onAnswered = await answer();
  expect(dozoCheckCall).toHaveBeenCalledWith("bot-1", expect.anything());
  expect(rpc.threads.answerCall).not.toHaveBeenCalled();
  expect(rpc.notifications.declineIncomingCall).not.toHaveBeenCalled();
  expect(startCall).not.toHaveBeenCalled();
  expect(onAnswered).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Can't call: the model isn't answering.",
  );
  const buttons = [...container.querySelectorAll("button")];
  expect(buttons.every((button) => !button.disabled)).toBe(true);
});

it("answers and starts the call, told the speech server hears the caller, once it can be heard", async () => {
  vi.mocked(dozoCheckCall).mockResolvedValue({ refusal: null, serverDictation: true });
  vi.mocked(rpc.threads.answerCall).mockResolvedValue({ opening: "Ready?", reason: "Review" });
  const onAnswered = await answer();
  expect(rpc.threads.answerCall).toHaveBeenCalledOnce();
  expect(startCall).toHaveBeenCalledWith(
    expect.objectContaining({ botId: "bot-1", serverDictation: true }),
  );
  expect(onAnswered).toHaveBeenCalledWith("bot-1");
});

it("answers nothing when the page starts leaving its session while the call is checked", async () => {
  vi.mocked(dozoCheckCall).mockResolvedValue({ refusal: null, serverDictation: true });
  vi.mocked(isLeavingSession).mockReturnValueOnce(false).mockReturnValue(true);
  const onAnswered = await answer();
  expect(rpc.threads.answerCall).not.toHaveBeenCalled();
  expect(startCall).not.toHaveBeenCalled();
  expect(onAnswered).not.toHaveBeenCalled();
});
