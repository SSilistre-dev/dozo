// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs on the branded tree: the daily send procedures exist once the brand rules apply.

const ui = vi.hoisted(() => ({ rpc: vi.fn(), alert: vi.fn() }));

vi.mock("react-native", () => ({
  Alert: { alert: ui.alert },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
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
vi.mock("../components/ui/menu-picker", () => ({
  MenuPickerMenu: ({
    label,
    choices,
    value,
    onChange,
    disabled,
    children,
  }: {
    label: string;
    choices: { key: string; label: string }[];
    value: string;
    onChange: (key: string) => void;
    disabled?: boolean;
    children?: ReactNode;
  }) => (
    <fieldset aria-label={label} data-value={value} disabled={disabled}>
      {choices.map((choice) => (
        <button type="button" key={choice.key} onClick={() => onChange(choice.key)}>
          {choice.label}
        </button>
      ))}
      {children}
    </fieldset>
  ),
}));
vi.mock("../components/native/native-symbol", () => ({ NativeSymbol: () => <i /> }));
vi.mock("./native/native", () => ({ native: { tertiaryLabel: "tertiary" } }));
vi.mock("../components/settings/settings-group", () => ({
  SettingsRow: ({ title, value, dimmed }: { title: string; value?: string; dimmed?: boolean }) => (
    <li data-dimmed={dimmed ? "yes" : undefined}>
      {title}
      {value ? <b>{value}</b> : null}
    </li>
  ),
}));

import { DozoSendLimitRow } from "../components/dozo-send-limit-row";
import { queryClient } from "./query/query";

let answers: Record<string, unknown>;
let root: Root;
let container: HTMLDivElement;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
  await act(() => flush());
}
const settle = (check: () => void) => act(() => vi.waitFor(check));
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);
const calls = (path: string) => ui.rpc.mock.calls.filter(([called]) => called === path);
const picker = () => container.querySelector("fieldset")!;

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

describe("daily sends per bot on mobile", () => {
  it("offers the account's choices with its number checked, and saves another", async () => {
    answers["dozoSendLimit/get"] = { dailySends: 50 };
    await render(<DozoSendLimitRow />);
    await settle(() => expect(picker().getAttribute("data-value")).toBe("50"));
    expect(text()).toContain("Daily sends per bot");
    expect([...container.querySelectorAll("button")].map((entry) => entry.textContent)).toEqual([
      "10",
      "25",
      "50",
      "100",
      "250",
    ]);
    expect(container.querySelector("b")!.textContent).toBe("50");

    answers["dozoSendLimit/set"] = ({ dailySends }: { dailySends: number }) => ({ dailySends });
    answers["dozoSendLimit/get"] = { dailySends: 100 };
    await act(async () => button("100")!.click());
    await settle(() => expect(picker().getAttribute("data-value")).toBe("100"));
    expect(calls("dozoSendLimit/set")[0]![1]).toEqual({ dailySends: 100 });
  });

  it("keeps a number set elsewhere among the choices, in order", async () => {
    answers["dozoSendLimit/get"] = { dailySends: 75 };
    await render(<DozoSendLimitRow />);
    await settle(() => expect(picker().getAttribute("data-value")).toBe("75"));
    expect([...container.querySelectorAll("button")].map((entry) => entry.textContent)).toEqual([
      "10",
      "25",
      "50",
      "75",
      "100",
      "250",
    ]);
  });

  it("shows nothing until the number is known, and holds the row while a save is in flight", async () => {
    const known = deferred<{ dailySends: number }>();
    answers["dozoSendLimit/get"] = () => known.promise;
    await render(<DozoSendLimitRow />);
    expect(container.querySelector("fieldset")).toBeNull();
    known.resolve({ dailySends: 50 });
    await settle(() => expect(picker().disabled).toBe(false));

    const saving = deferred<{ dailySends: number }>();
    answers["dozoSendLimit/set"] = () => saving.promise;
    await act(async () => button("25")!.click());
    expect(picker().disabled).toBe(true);
    expect(picker().getAttribute("data-value")).toBe("25");
    expect(container.querySelector("[data-dimmed]")).not.toBeNull();
    answers["dozoSendLimit/get"] = { dailySends: 25 };
    await act(async () => saving.resolve({ dailySends: 25 }));
    await settle(() => expect(picker().disabled).toBe(false));
    expect(picker().getAttribute("data-value")).toBe("25");
  });

  it("says when a save fails and goes back to the saved number", async () => {
    answers["dozoSendLimit/get"] = { dailySends: 50 };
    await render(<DozoSendLimitRow />);
    await settle(() => expect(picker().disabled).toBe(false));
    answers["dozoSendLimit/set"] = new Error("Try later");
    await act(async () => button("25")!.click());
    await settle(() =>
      expect(ui.alert).toHaveBeenCalledWith("Couldn't update daily sends", "Try later"),
    );
    await settle(() => expect(picker().getAttribute("data-value")).toBe("50"));
  });

  it("leaves the row out when the number cannot be read", async () => {
    answers["dozoSendLimit/get"] = new Error("Offline");
    await render(<DozoSendLimitRow />);
    expect(container.querySelector("fieldset")).toBeNull();
  });
});
