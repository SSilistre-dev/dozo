// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  botMark: vi.fn(),
  trustBot: vi.fn(),
  confirmed: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/rpc", () => {
  const rpc = { dozoAccessTokens: { trustBot: api.trustBot, botMark: api.botMark } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../../components/ConfirmIdentityDialog", () => ({
  useIdentityConfirmation: () => ({
    withIdentityConfirmation: <T,>(action: () => Promise<T>) => {
      api.confirmed();
      return action();
    },
    identityDialog: <div data-testid="identity-dialog" />,
  }),
}));
vi.mock("../../lib/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  ContextMenuItem: (props: ComponentProps<"button">) => <button type="button" {...props} />,
  toast: { error: api.toastError },
}));

import { queryClient as client } from "../../lib/query";
import { DozoTrustBotHost, DozoTrustBotItem } from "./dozo-trust-bot";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const rpc = { dozoAccessTokens: { botMark: api.botMark } } as never;

async function render(node: ReactNode) {
  await act(async () =>
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) mock.mockReset();
  // The app's own client, as the shell and the loaded dialog share it.
  client.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const item = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === "Trust this bot again");

it("shows nothing in the menu for a bot that is not marked", async () => {
  api.botMark.mockResolvedValue({ marked: false });
  await render(<DozoTrustBotItem rpc={rpc} botId="bot-1" onClose={() => undefined} />);
  await vi.waitFor(() => expect(api.botMark).toHaveBeenCalledWith({ botId: "bot-1" }));
  expect(item()).toBeUndefined();
});

it("trusts a marked bot again after the person confirms it is them, and reads the mark again", async () => {
  api.botMark.mockResolvedValue({ marked: true });
  api.trustBot.mockImplementation(async () => {
    api.botMark.mockResolvedValue({ marked: false });
    return { ok: true };
  });
  const onClose = vi.fn();
  await render(
    <>
      <DozoTrustBotHost />
      <DozoTrustBotItem rpc={rpc} botId="bot-1" onClose={onClose} />
    </>,
  );
  await vi.waitFor(() => expect(item()).toBeDefined());
  await act(async () => item()!.click());
  expect(onClose).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(api.trustBot).toHaveBeenCalledWith({ botId: "bot-1" }));
  expect(api.confirmed).toHaveBeenCalledOnce();
  // Done: the dialog's host lets go of it.
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="identity-dialog"]')).toBeNull(),
  );
  await vi.waitFor(() => expect(item()).toBeUndefined());
});

it("says so when trusting fails", async () => {
  api.botMark.mockResolvedValue({ marked: true });
  api.trustBot.mockRejectedValue(new Error("down"));
  await render(
    <>
      <DozoTrustBotHost />
      <DozoTrustBotItem rpc={rpc} botId="bot-1" onClose={() => undefined} />
    </>,
  );
  await vi.waitFor(() => expect(item()).toBeDefined());
  await act(async () => item()!.click());
  await vi.waitFor(() => expect(api.toastError).toHaveBeenCalledWith("Could not trust the bot"));
});

it("lets a second host take over when the first goes", async () => {
  api.botMark.mockResolvedValue({ marked: true });
  api.trustBot.mockResolvedValue({ ok: true });
  await render(
    <>
      <DozoTrustBotHost key="a" />
      <DozoTrustBotHost key="b" />
      <DozoTrustBotItem rpc={rpc} botId="bot-1" onClose={() => undefined} />
    </>,
  );
  await render(
    <>
      <DozoTrustBotHost key="b" />
      <DozoTrustBotItem rpc={rpc} botId="bot-1" onClose={() => undefined} />
    </>,
  );
  await vi.waitFor(() => expect(item()).toBeDefined());
  await act(async () => item()!.click());
  await vi.waitFor(() => expect(api.trustBot).toHaveBeenCalledOnce());
});

it("does nothing from the menu when no host is mounted", async () => {
  api.botMark.mockResolvedValue({ marked: true });
  const onClose = vi.fn();
  await render(<DozoTrustBotItem rpc={rpc} botId="bot-1" onClose={onClose} />);
  await vi.waitFor(() => expect(item()).toBeDefined());
  await act(async () => item()!.click());
  expect(onClose).toHaveBeenCalledOnce();
  expect(api.trustBot).not.toHaveBeenCalled();
});
