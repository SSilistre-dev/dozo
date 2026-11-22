// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startCall } from "../../lib/call-session";
import { rpc } from "../../lib/rpc";
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
vi.mock("../../lib/call-session", () => ({
  isLeavingSession: vi.fn(() => false),
  prepareCallAudio: vi.fn(),
  startCall: vi.fn(),
  useCallSession: () => null,
}));
// The check's file is gone from the server, as after a deploy under an open tab.
vi.mock("../../lib/dozo-call-start", () => {
  throw new TypeError("Failed to fetch dynamically imported module");
});
vi.mock("../../lib/monitoring", () => ({ reportClientError: vi.fn() }));
vi.mock("../../lib/rpc", () => ({
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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", class {});
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("answers the call when the check cannot be loaded", async () => {
  vi.mocked(rpc.threads.answerCall).mockResolvedValue({ opening: "Ready?", reason: "Review" });
  const onAnswered = vi.fn();
  act(() => root.render(<IncomingCall bots={[bot]} onAnswered={onAnswered} />));
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Answer")!
      .click();
  });
  expect(rpc.threads.answerCall).toHaveBeenCalledOnce();
  expect(startCall).toHaveBeenCalledWith(expect.objectContaining({ botId: "bot-1" }));
  expect(onAnswered).toHaveBeenCalledWith("bot-1");
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
