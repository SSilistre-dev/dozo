// @vitest-environment jsdom
import type { ComputerStatus } from "@rakazo/contracts";
import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ stop: vi.fn(), toastError: vi.fn() }));

vi.mock("../../lib/rpc", () => {
  const rpc = { computer: { stop: api.stop } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../../lib/dozo-error-text", () => ({ toastError: api.toastError }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => (
    <button type="button" {...props} />
  ),
}));

import { ComputerSleepButton } from "./dozo-computer-sleep";

const status = (over: Partial<ComputerStatus> = {}) =>
  ({ botId: "bot-1", state: "running", kind: "docker", ...over }) as ComputerStatus;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const refresh = vi.fn(async () => undefined);
const close = vi.fn();

async function render(computer: ComputerStatus | null = status(), busy = false) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ComputerSleepButton
          botId="bot-1"
          computer={computer}
          busy={busy}
          onRefresh={refresh}
          onClose={close}
        />
      </QueryClientProvider>,
    );
  });
}

const sleepButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Sleep"]');

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("stops the bot's running computer, closes its window and reads the state again", async () => {
  const stop = deferred<ComputerStatus>();
  api.stop.mockReturnValueOnce(stop.promise);
  await render();
  expect(sleepButton()?.title).toBe("Sleep");
  await act(async () => sleepButton()?.click());
  expect(api.stop).toHaveBeenCalledWith({ botId: "bot-1" });
  // A second press while the first is in flight sends nothing.
  expect(sleepButton()?.disabled).toBe(true);
  await act(async () => sleepButton()?.click());
  expect(api.stop).toHaveBeenCalledTimes(1);
  await act(async () => stop.resolve(status({ state: "stopped" })));
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(close).toHaveBeenCalledTimes(1);
  expect(api.toastError).not.toHaveBeenCalled();
});

it("says why when the server refuses, and keeps the window open", async () => {
  const refused = new Error("Computer is busy");
  api.stop.mockRejectedValueOnce(refused);
  await render();
  await act(async () => sleepButton()?.click());
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("Failed to stop", refused));
  expect(close).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  expect(sleepButton()?.disabled).toBe(false);
});

it.each([
  ["no computer", null, false],
  ["another bot's computer", status({ botId: "bot-2" }), false],
  ["a computer that is not running", status({ state: "suspended" }), false],
  ["a run or a recording using it", status(), true],
  ["another bot using it", status({ busyBotName: "Kumo" }), false],
  ["another person in control", status({ controlledByOther: true }), false],
  ["the user's own machine", status({ runsOnUserMachine: true }), false],
])("is hidden for %s", async (_case, computer, busy) => {
  await render(computer, busy);
  expect(sleepButton()).toBeNull();
});
