// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs on the branded tree: the command rule procedures exist once the brand rules apply.

const ui = vi.hoisted(() => ({ rpc: vi.fn(), alert: vi.fn() }));

vi.mock("react-native", () => ({ Alert: { alert: ui.alert } }));
vi.mock("./api/user-error", () => ({
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
vi.mock("../components/native/native-switch", () => ({
  NativeSwitch: ({
    accessibilityLabel,
    value,
    disabled,
    onValueChange,
  }: {
    accessibilityLabel: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <input
      type="checkbox"
      aria-label={accessibilityLabel}
      checked={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.checked)}
    />
  ),
}));
vi.mock("../components/settings/settings-group", () => ({
  SettingsRow: ({
    title,
    leading,
    trailing,
    dimmed,
  }: {
    title: string;
    leading?: ReactNode;
    trailing?: ReactNode;
    dimmed?: boolean;
  }) => (
    <li data-dimmed={dimmed ? "yes" : undefined}>
      {leading}
      {title}
      {trailing}
    </li>
  ),
}));

import { DozoHostedAsksRow } from "../components/dozo-hosted-asks-row";
import { queryClient } from "./query/query";

let answers: Record<string, unknown>;
let root: Root;
let container: HTMLDivElement;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
  await act(() => flush());
}
const settle = (check: () => void) => act(() => vi.waitFor(check));
const toggle = () => container.querySelector("input");
const calls = (path: string) => ui.rpc.mock.calls.filter(([called]) => called === path);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  queryClient.clear();
  answers = {};
  ui.rpc.mockReset().mockImplementation(async (path: string, input: unknown) => {
    const value = answers[path];
    if (value instanceof Error) throw value;
    return typeof value === "function" ? value(input) : value;
  });
  ui.alert.mockReset();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("asking before commands on bot computers, on mobile", () => {
  it("shows the switch with its icon, and turns it off", async () => {
    answers["dozoCommandRules/getHostedAsks"] = { hostedAsks: true };
    await render(<DozoHostedAsksRow leading={<i data-testid="icon" />} />);
    await settle(() => expect(toggle()?.checked).toBe(true));
    expect(container.textContent).toBe("Ask before commands on bot computers");
    expect(toggle()?.getAttribute("aria-label")).toBe("Ask before commands on bot computers");
    expect(container.querySelector("[data-testid=icon]")).not.toBeNull();

    answers["dozoCommandRules/setHostedAsks"] = ({ hostedAsks }: { hostedAsks: boolean }) => ({
      hostedAsks,
    });
    answers["dozoCommandRules/getHostedAsks"] = { hostedAsks: false };
    await act(async () => toggle()!.click());
    await settle(() => expect(toggle()?.checked).toBe(false));
    expect(calls("dozoCommandRules/setHostedAsks")[0]![1]).toEqual({ hostedAsks: false });
  });

  it("shows nothing where the Space has no bot computer, or the read fails", async () => {
    answers["dozoCommandRules/getHostedAsks"] = { hostedAsks: null };
    await render(<DozoHostedAsksRow />);
    await settle(() => expect(calls("dozoCommandRules/getHostedAsks")).toHaveLength(1));
    await act(() => flush());
    expect(container.textContent).toBe("");

    queryClient.clear();
    answers["dozoCommandRules/getHostedAsks"] = new Error("Offline");
    await render(<DozoHostedAsksRow key="again" />);
    await settle(() => expect(calls("dozoCommandRules/getHostedAsks")).toHaveLength(2));
    await act(() => flush());
    expect(toggle()).toBeNull();
  });

  it("shows the new value and holds the switch while a save is in flight", async () => {
    answers["dozoCommandRules/getHostedAsks"] = { hostedAsks: false };
    await render(<DozoHostedAsksRow />);
    await settle(() => expect(toggle()?.disabled).toBe(false));
    const saving = deferred<{ hostedAsks: boolean }>();
    answers["dozoCommandRules/setHostedAsks"] = () => saving.promise;
    await act(async () => toggle()!.click());
    expect(toggle()?.checked).toBe(true);
    expect(toggle()?.disabled).toBe(true);
    expect(container.querySelector("[data-dimmed]")).not.toBeNull();
    answers["dozoCommandRules/getHostedAsks"] = { hostedAsks: true };
    await act(async () => saving.resolve({ hostedAsks: true }));
    await settle(() => expect(toggle()?.disabled).toBe(false));
    expect(toggle()?.checked).toBe(true);
  });

  it("says when a save fails and goes back to the saved value", async () => {
    answers["dozoCommandRules/getHostedAsks"] = { hostedAsks: true };
    await render(<DozoHostedAsksRow />);
    await settle(() => expect(toggle()?.disabled).toBe(false));
    answers["dozoCommandRules/setHostedAsks"] = new Error("Try later");
    await act(async () => toggle()!.click());
    await settle(() =>
      expect(ui.alert).toHaveBeenCalledWith("Couldn't update this setting", "Try later"),
    );
    await settle(() => expect(toggle()?.checked).toBe(true));
  });
});
