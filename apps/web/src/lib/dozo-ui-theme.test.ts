// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => ({
  set: vi.fn((preference: string) => (preference === "light" ? "light" : "dark")),
  apply: vi.fn(() => "dark"),
}));
vi.mock("./preferences/ui-appearance", () => ({
  getUiAppearancePreference: () => "dark",
  setUiAppearance: upstream.set,
  applyUiAppearance: upstream.apply,
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
  upstream.apply.mockClear();
});

/** What another tab's choice looks like here: the storage write, then its event. */
function fromAnotherTab(key: string, value: string | null) {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
  window.dispatchEvent(new StorageEvent("storage", { key, storageArea: localStorage }));
}

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

describe("another tab", () => {
  it("brings its theme here: the page's mark and upstream's stored tone", () => {
    fromAnotherTab("dozo.uiTheme", "sumi");
    expect(root.dataset.skin).toBe("sumi");
    expect(upstream.apply).toHaveBeenCalled();
    fromAnotherTab("dozo.uiTheme", null);
    expect(root.dataset.skin).toBeUndefined();
  });

  it("brings its message color here: the bubble and the page's mark agree", () => {
    fromAnotherTab("dozo.uiBubble", "neutral");
    expect(dozoBubblePreference.get()).toBe("neutral");
    expect(root.dataset.bubble).toBe("neutral");
    fromAnotherTab("dozo.uiBubble", null);
    expect(root.dataset.bubble).toBeUndefined();
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
