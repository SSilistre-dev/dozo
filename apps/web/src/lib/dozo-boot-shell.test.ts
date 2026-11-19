// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// public/dozo-boot.js runs as a plain script before first paint; this runs the same file.
import script from "../../public/dozo-boot.js?raw";
import {
  BOTS_SIDEBAR_MINI_WIDTH,
  clampBotsSidebarWidth,
  readBotsSidebarWidth,
} from "./bots-sidebar-pref";

function runAt(path: string, viewport = 1280, saved: Record<string, string> = {}) {
  window.history.replaceState(null, "", path);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport });
  for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
  new Function(script)();
  // Only the sidebar is under test here: the load watch has its own tests below.
  (window as { dozoBootStarted?: () => void }).dozoBootStarted?.();
  const root = document.documentElement;
  const side = root.style.getPropertyValue("--dozo-boot-side");
  return { chat: root.dataset.dozoBoot, side: side ? Number.parseInt(side, 10) : null };
}

/** The width the app's sidebar opens at for the one user this browser saved, or for a new one. */
function appWidth(viewport: number, userId: string | null) {
  return clampBotsSidebarWidth(readBotsSidebarWidth(userId), viewport);
}

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.dozoBoot;
  document.documentElement.style.removeProperty("--dozo-boot-side");
  delete (window as { rakazoDesktop?: unknown }).rakazoDesktop;
});

describe("boot shell script", () => {
  it("draws no sidebar outside the chat routes", () => {
    expect(runAt("/sign-in")).toEqual({ chat: undefined, side: null });
    expect(runAt("/")).toEqual({ chat: undefined, side: null });
  });

  it("draws on a chat route, and on the desktop app's start page", () => {
    expect(runAt("/app").chat).toBe("chat");
    (window as { rakazoDesktop?: unknown }).rakazoDesktop = {};
    expect(runAt("/").chat).toBe("chat");
  });

  it.each([1920, 1280, 900, 700, 560])(
    "matches the app's sidebar width with nothing saved, at a %ipx viewport",
    (viewport) => {
      expect(runAt("/app", viewport).side).toBe(appWidth(viewport, null));
    },
  );

  it.each([
    ["300", 1280],
    ["900", 1280],
    ["12", 1280],
    ["450", 700],
    ["not a number", 1280],
  ])("matches the app's width for a saved %s at a %ipx viewport", (width, viewport) => {
    const saved = { "rakazo:bots-sidebar-width:u1": width };
    expect(runAt("/app/bot_1", viewport, saved).side).toBe(appWidth(viewport, "u1"));
  });

  it("draws the narrow sidebar when it was collapsed", () => {
    const saved = {
      "rakazo:bots-sidebar-width:u1": "300",
      "rakazo:bots-sidebar-collapsed:u1": "1",
    };
    expect(runAt("/app", 1280, saved).side).toBe(BOTS_SIDEBAR_MINI_WIDTH);
  });

  it("uses the new user's width when several people used this browser", () => {
    const saved = {
      "rakazo:bots-sidebar-width:u1": "300",
      "rakazo:bots-sidebar-width:u2": "400",
    };
    expect(runAt("/app", 1280, saved).side).toBe(appWidth(1280, null));
  });
});

describe("boot shell watch", () => {
  const reload = vi.fn();
  type Watched = Window & { dozoBootStarted?: () => void };

  function start(online = true) {
    // A page has one watch: the one of the page before stops.
    (window as Watched).dozoBootStarted?.();
    document.body.innerHTML =
      '<div id="root"></div><div id="dozo-boot" aria-hidden="true"><div></div></div>';
    const nav = { language: "tr-TR", onLine: online };
    new Function("location", "navigator", script)({ pathname: "/app", reload }, nav);
  }
  /** The entry script failed to load, as the browser reports it. */
  function entryFails() {
    const entry = document.createElement("script");
    entry.type = "module";
    document.head.append(entry);
    entry.dispatchEvent(new Event("error"));
    entry.remove();
  }
  const shell = () => document.getElementById("dozo-boot")!;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    (window as Watched).dozoBootStarted?.();
    delete (window as Watched).dozoBootStarted;
    vi.useRealTimers();
    reload.mockReset();
    sessionStorage.clear();
  });

  it("reloads once when the app's code fails to load, then offers a retry", () => {
    start();
    entryFails();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(shell().dataset.state).toBeUndefined();
    // The reloaded page fails again within 30 seconds: no loop, the shell says so.
    start();
    entryFails();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(shell().dataset.state).toBe("unreachable");
    expect(shell().getAttribute("aria-hidden")).toBeNull();
    expect(shell().textContent).toContain("Sunucuya ulaşılamıyor.");
    shell().querySelector("button")!.click();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("offers a retry without reloading while the browser is offline", () => {
    start(false);
    entryFails();
    expect(reload).not.toHaveBeenCalled();
    expect(shell().dataset.state).toBe("unreachable");
  });

  it("offers a retry when the app's code hangs, and stays quiet once it runs", () => {
    start();
    vi.advanceTimersByTime(14_999);
    expect(shell().dataset.state).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(shell().dataset.state).toBe("unreachable");

    start();
    (window as Watched).dozoBootStarted?.();
    vi.advanceTimersByTime(60_000);
    entryFails();
    expect(shell().dataset.state).toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
  });
});
