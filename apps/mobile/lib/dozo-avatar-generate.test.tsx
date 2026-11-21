// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs on the branded tree: the avatar procedures exist once the brand rules apply.

const ui = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("react-native", () => ({
  Text: ({ children }: { children?: ReactNode }) => <p role="alert">{children}</p>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./user-error", () => ({
  errorText: (_error: unknown, fallback = "Something went wrong. Try again.") => fallback,
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space",
  captureApiRequestContext: async (spaceId: string | null = "space") => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
  rpc: ui.rpc,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./native", () => ({ useMobileTokens: () => ({ destructive: "red" }) }));
vi.mock("../components/bot-avatar", () => ({
  BotAvatar: ({ color }: { color: string }) => <img alt="" src={color} />,
}));
vi.mock("../components/growing-text-input", () => ({
  GrowingTextInput: ({
    label,
    value,
    editable,
    onChangeText,
  }: {
    label: string;
    value: string;
    editable?: boolean;
    onChangeText: (value: string) => void;
  }) => (
    <textarea
      aria-label={label}
      value={value}
      disabled={editable === false}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
    busy,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
    busy?: boolean;
  }) => (
    <button type="button" disabled={disabled || busy} onClick={onPress}>
      {label}
    </button>
  ),
}));

import { DozoAvatarGenerate } from "../components/dozo-avatar-generate";
import { queryClient } from "./query";

const IMAGE = "data:image/webp;base64,AAAA";
const used = vi.fn<(image: string) => void>();
let answers: Record<string, unknown>;
let root: Root;
let container: HTMLDivElement;

async function render() {
  await act(async () => root.render(<DozoAvatarGenerate onUse={used} />));
  await act(() => flush());
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);
async function press(label: string) {
  await act(async () => button(label)?.click());
  await act(() => flush());
}
async function describeAs(text: string) {
  const field = container.querySelector("textarea");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
    field?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const calls = (path: string) => ui.rpc.mock.calls.filter(([called]) => called === path);
const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  queryClient.clear();
  answers = { "dozoAvatarGenerate/status": { available: true, reason: null } };
  used.mockClear();
  ui.rpc.mockReset().mockImplementation(async (path: string, input: unknown) => {
    const value = answers[path];
    if (value instanceof Error) throw value;
    return typeof value === "function" ? value(input) : value;
  });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("drawing an avatar from a description on mobile", () => {
  it.each(["unavailable", "plan", "limit"])(
    "offers nothing when the reason is %s",
    async (reason) => {
      answers["dozoAvatarGenerate/status"] = { available: false, reason };
      await render();
      expect(container.textContent).toBe("");
    },
  );

  it("starts with the description and Generate, which waits for words", async () => {
    await render();
    expect(container.querySelectorAll("textarea")).toHaveLength(1);
    expect(button("Generate")?.disabled).toBe(true);
    expect(button("Use")).toBeUndefined();
  });

  it("shows the failure and offers nothing to use", async () => {
    answers["dozoAvatarGenerate/generate"] = Object.assign(new Error("down"), {
      code: "avatar_generate_failed",
    });
    await render();
    await describeAs("a fox");
    await press("Generate");
    expect(alertText()).toBe("Something went wrong. Try again.");
    expect(button("Use")).toBeUndefined();
    expect(used).not.toHaveBeenCalled();
  });

  it("goes back to waiting, silently, when one is already being drawn", async () => {
    answers["dozoAvatarGenerate/generate"] = Object.assign(new Error("busy"), {
      code: "avatar_generate_busy",
    });
    await render();
    await describeAs("a fox");
    await press("Generate");
    expect(alertText()).toBeNull();
    expect(button("Generate")?.disabled).toBe(false);
  });

  it("sends one request for two taps", async () => {
    const answer = deferred<{ image: string }>();
    answers["dozoAvatarGenerate/generate"] = () => answer.promise;
    await render();
    await describeAs("a fox");
    await act(async () => {
      button("Generate")?.click();
      button("Generate")?.click();
    });
    await act(() => flush());
    expect(calls("dozoAvatarGenerate/generate")).toHaveLength(1);
    expect(calls("dozoAvatarGenerate/generate")[0]?.[1]).toEqual({ prompt: "a fox" });
    await act(async () => answer.resolve({ image: IMAGE }));
    await act(() => flush());
    expect(button("Use")).toBeDefined();
  });

  it("ignores an answer that arrives after the sheet is gone", async () => {
    const answer = deferred<{ image: string }>();
    answers["dozoAvatarGenerate/generate"] = () => answer.promise;
    await render();
    await describeAs("a fox");
    await press("Generate");
    act(() => root.unmount());
    await act(async () => answer.resolve({ image: IMAGE }));
    await act(() => flush());
    expect(used).not.toHaveBeenCalled();
    root = createRoot(container);
  });

  it("uses the picture exactly once, and draws again from the same description", async () => {
    answers["dozoAvatarGenerate/generate"] = () => ({ image: IMAGE });
    await render();
    await describeAs("a fox");
    await press("Generate");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(IMAGE);

    const second = "data:image/webp;base64,BBBB";
    answers["dozoAvatarGenerate/generate"] = () => ({ image: second });
    await press("Try again");
    expect(calls("dozoAvatarGenerate/generate")).toHaveLength(2);
    expect(calls("dozoAvatarGenerate/generate")[1]?.[1]).toEqual({ prompt: "a fox" });
    expect(used).not.toHaveBeenCalled();

    await press("Use");
    expect(used).toHaveBeenCalledTimes(1);
    expect(used).toHaveBeenCalledWith(second);
  });
});
