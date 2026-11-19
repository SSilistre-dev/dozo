// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
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
