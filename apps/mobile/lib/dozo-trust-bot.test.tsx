// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs on the branded tree: the access token procedures exist once the brand rules apply.

type AlertButton = { text: string; style?: string; onPress?: () => void };

const ui = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  confirmed: vi.fn(),
  mounted: vi.fn(),
}));

vi.mock("react-native", () => ({ Alert: { alert: ui.alert } }));
vi.mock("./user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("./api/api-server", () => ({}));
vi.mock("./auth/api-auth", () => ({}));
vi.mock("./api/api-live", () => ({}));
vi.mock("./api/api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space",
  captureApiRequestContext: async (spaceId: string | null = "space") => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
  rpc: ui.rpc,
}));
vi.mock("./api/session", () => ({ currentSessionGeneration: () => 1 }));
// The identity check is loaded with the dialog only: this stub counts when it is first used.
vi.mock("../components/vault/confirm-identity", () => ({
  useIdentityConfirmation: () => {
    ui.mounted();
    return {
      withIdentityConfirmation: <T,>(action: () => Promise<T>) => {
        ui.confirmed();
        return action();
      },
      identityDialog: <i data-identity="" />,
    };
  },
}));

import { DozoTrustBotHost, useDozoTrustActions } from "./dozo-trust-bot";
import { queryClient } from "./query/query";

let answers: Record<string, unknown>;
let root: Root;
let container: HTMLDivElement;
let actions: ReturnType<typeof useDozoTrustActions> = [];

function Menu({ botId }: { botId: string }) {
  actions = useDozoTrustActions(botId);
  return null;
}

async function render(node: ReactNode) {
  await act(async () => root.render(node));
  await act(() => flush());
}
const settle = (check: () => void) => act(() => vi.waitFor(check));
const calls = (path: string) => ui.rpc.mock.calls.filter(([called]) => called === path);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  queryClient.clear();
  answers = {};
  actions = [];
  ui.rpc.mockReset().mockImplementation(async (path: string, input: unknown) => {
    const value = answers[path];
    if (value instanceof Error) throw value;
    return typeof value === "function" ? value(input) : value;
  });
  for (const mock of [ui.alert, ui.confirmed, ui.mounted]) mock.mockReset();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("trusting a bot again on mobile", () => {
  it("offers nothing for a bot that is not marked, nor before the bot is known", async () => {
    answers["dozoAccessTokens/botMark"] = { marked: false };
    await render(<Menu botId="bot-1" />);
    await settle(() => expect(calls("dozoAccessTokens/botMark")).toHaveLength(1));
    expect(actions).toEqual([]);

    await render(<Menu botId="" />);
    expect(actions).toEqual([]);
    expect(calls("dozoAccessTokens/botMark")).toHaveLength(1);
  });

  it("offers one item for a marked bot, asks first, then trusts after the identity check", async () => {
    answers["dozoAccessTokens/botMark"] = { marked: true };
    await render(
      <>
        <Menu botId="bot-1" />
        <DozoTrustBotHost />
      </>,
    );
    await settle(() =>
      expect(actions.map((action) => action.text)).toEqual(["Trust this bot again"]),
    );
    // The check is not loaded until someone asks.
    expect(ui.mounted).not.toHaveBeenCalled();

    answers["dozoAccessTokens/trustBot"] = () => {
      answers["dozoAccessTokens/botMark"] = { marked: false };
      return { ok: true };
    };
    act(() => actions[0]!.onPress());
    const [title, message, buttons] = ui.alert.mock.lastCall as [string, unknown, AlertButton[]];
    expect(title).toBe("Trust this bot again");
    expect(message).toBeUndefined();
    expect(buttons.map((entry) => entry.text)).toEqual(["Cancel", "Continue"]);
    expect(calls("dozoAccessTokens/trustBot")).toHaveLength(0);
    expect(ui.mounted).not.toHaveBeenCalled();

    await act(async () => buttons[1]!.onPress!());
    await settle(() => expect(calls("dozoAccessTokens/trustBot")).toHaveLength(1));
    expect(calls("dozoAccessTokens/trustBot")[0]![1]).toEqual({ botId: "bot-1" });
    expect(ui.confirmed).toHaveBeenCalledOnce();
    // Done: the host lets go of the dialog, and the mark is read again, so the item goes.
    await settle(() => expect(container.querySelector("[data-identity]")).toBeNull());
    await settle(() => expect(actions).toEqual([]));
  });

  it("does nothing when the person backs out of the question", async () => {
    answers["dozoAccessTokens/botMark"] = { marked: true };
    await render(
      <>
        <Menu botId="bot-1" />
        <DozoTrustBotHost />
      </>,
    );
    await settle(() => expect(actions).toHaveLength(1));
    act(() => actions[0]!.onPress());
    const buttons = ui.alert.mock.lastCall![2] as AlertButton[];
    act(() => buttons[0]!.onPress?.());
    expect(calls("dozoAccessTokens/trustBot")).toHaveLength(0);
    expect(ui.mounted).not.toHaveBeenCalled();
  });

  it("says so when trusting fails, and lets go of the dialog", async () => {
    answers["dozoAccessTokens/botMark"] = { marked: true };
    answers["dozoAccessTokens/trustBot"] = new Error("Not you");
    await render(
      <>
        <Menu botId="bot-1" />
        <DozoTrustBotHost />
      </>,
    );
    await settle(() => expect(actions).toHaveLength(1));
    act(() => actions[0]!.onPress());
    await act(async () => (ui.alert.mock.lastCall![2] as AlertButton[])[1]!.onPress!());
    await settle(() => expect(ui.alert).toHaveBeenCalledWith("Could not trust the bot", "Not you"));
    await settle(() => expect(container.querySelector("[data-identity]")).toBeNull());
    expect(actions).toHaveLength(1);
  });

  it("without a mounted host, the question goes nowhere", async () => {
    answers["dozoAccessTokens/botMark"] = { marked: true };
    await render(<Menu botId="bot-1" />);
    await settle(() => expect(actions).toHaveLength(1));
    act(() => actions[0]!.onPress());
    await act(async () => (ui.alert.mock.lastCall![2] as AlertButton[])[1]!.onPress!());
    expect(calls("dozoAccessTokens/trustBot")).toHaveLength(0);
  });

  it("a host that goes away no longer receives the request", async () => {
    answers["dozoAccessTokens/botMark"] = { marked: true };
    await render(
      <>
        <Menu botId="bot-1" />
        <DozoTrustBotHost key="a" />
      </>,
    );
    await settle(() => expect(actions).toHaveLength(1));
    await render(<Menu botId="bot-1" />);
    act(() => actions[0]!.onPress());
    await act(async () => (ui.alert.mock.lastCall![2] as AlertButton[])[1]!.onPress!());
    expect(ui.mounted).not.toHaveBeenCalled();
  });

  it("hands the request to the newest host when an older one goes away", async () => {
    answers["dozoAccessTokens/botMark"] = { marked: true };
    answers["dozoAccessTokens/trustBot"] = { ok: true };
    const both = (first: boolean) => (
      <>
        <Menu botId="bot-1" />
        {first ? <DozoTrustBotHost key="a" /> : null}
        <DozoTrustBotHost key="b" />
      </>
    );
    await render(both(true));
    await settle(() => expect(actions).toHaveLength(1));
    await render(both(false));
    act(() => actions[0]!.onPress());
    await act(async () => (ui.alert.mock.lastCall![2] as AlertButton[])[1]!.onPress!());
    await settle(() => expect(calls("dozoAccessTokens/trustBot")).toHaveLength(1));
  });
});
