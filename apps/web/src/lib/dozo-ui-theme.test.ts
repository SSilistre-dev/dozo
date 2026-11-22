// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => ({
  set: vi.fn((preference: string) => (preference === "light" ? "light" : "dark")),
}));
vi.mock("./ui-appearance", () => ({
  getUiAppearancePreference: () => "dark",
  setUiAppearance: upstream.set,
}));

import {
  dozoBubblePreference,
  dozoThemePreference,
  getUiAppearancePreference,
  setDozoBubble,
  setDozoTheme,
  setUiAppearance,
  useDozoNeutralBubble,
} from "./dozo-ui-theme";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const root = document.documentElement;

beforeEach(() => {
  upstream.set.mockClear();
});

afterEach(() => {
  setUiAppearance("dark");
  setDozoBubble("bot");
  localStorage.clear();
});

describe("named theme", () => {
  it("is stored beside upstream's choice, which keeps its tone", () => {
    setDozoTheme({ id: "washi", tone: "light" });
    expect(localStorage.getItem("dozo.uiTheme")).toBe("washi");
    expect(root.dataset.skin).toBe("washi");
    expect(upstream.set).toHaveBeenCalledWith("light");
    expect(dozoThemePreference.get()).toBe("washi");
  });

  it("goes when System, Light or Dark is chosen, from settings or the command menu", () => {
    setDozoTheme({ id: "yoru", tone: "dark" });
    expect(setUiAppearance("system")).toBe("dark");
    expect(localStorage.getItem("dozo.uiTheme")).toBeNull();
    expect(root.dataset.skin).toBeUndefined();
    expect(upstream.set).toHaveBeenLastCalledWith("system");
    expect(getUiAppearancePreference()).toBe("dark");
  });
});

describe("message color", () => {
  it("is the bot's colour unless neutral was chosen, and an unknown value reads as the default", () => {
    expect(dozoBubblePreference.get()).toBe("bot");
    setDozoBubble("neutral");
    expect(localStorage.getItem("dozo.uiBubble")).toBe("neutral");
    expect(root.dataset.bubble).toBe("neutral");
    setDozoBubble("bot");
    expect(localStorage.getItem("dozo.uiBubble")).toBeNull();
    expect(root.dataset.bubble).toBeUndefined();
    localStorage.setItem("dozo.uiBubble", "pink");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "dozo.uiBubble", storageArea: localStorage }),
    );
    expect(dozoBubblePreference.get()).toBe("bot");
    localStorage.setItem("dozo.uiBubble", "neutral");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "dozo.uiBubble", storageArea: localStorage }),
    );
    expect(dozoBubblePreference.get()).toBe("neutral");
  });

  it("re-renders the chat when it changes", async () => {
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useDozoNeutralBubble());
      return null;
    }
    const host = document.createElement("div");
    const view = createRoot(host);
    await act(async () => view.render(createElement(Probe)));
    await act(async () => setDozoBubble("neutral"));
    expect(seen.at(0)).toBe(false);
    expect(seen.at(-1)).toBe(true);
    await act(async () => view.unmount());
  });
});
