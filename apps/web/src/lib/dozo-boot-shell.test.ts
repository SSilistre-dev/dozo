// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
// public/dozo-boot.js runs as a plain script before first paint; this runs the same file.
import script from "../../public/dozo-boot.js?raw";

function runAt(path: string, saved: Record<string, string> = {}) {
  window.history.replaceState(null, "", path);
  for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
  new Function(script)();
  const root = document.documentElement;
  return { chat: root.dataset.dozoBoot, side: root.style.getPropertyValue("--dozo-boot-side") };
}

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.dozoBoot;
  document.documentElement.style.removeProperty("--dozo-boot-side");
  delete (window as { rakazoDesktop?: unknown }).rakazoDesktop;
});

describe("boot shell script", () => {
  it("draws no sidebar outside the chat routes", () => {
    expect(runAt("/sign-in")).toEqual({ chat: undefined, side: "" });
    expect(runAt("/")).toEqual({ chat: undefined, side: "" });
  });

  it("draws the default sidebar on a chat route, and on the desktop app's start page", () => {
    expect(runAt("/app")).toEqual({ chat: "chat", side: "240px" });
    (window as { rakazoDesktop?: unknown }).rakazoDesktop = {};
    expect(runAt("/")).toEqual({ chat: "chat", side: "240px" });
  });

  it("uses the width this browser saved, within the sidebar's limits", () => {
    expect(runAt("/app/bot_1", { "rakazo:bots-sidebar-width:u1": "300" }).side).toBe("300px");
    localStorage.clear();
    expect(runAt("/app", { "rakazo:bots-sidebar-width:u1": "900" }).side).toBe("480px");
    localStorage.clear();
    expect(runAt("/app", { "rakazo:bots-sidebar-width:u1": "12" }).side).toBe("240px");
  });

  it("draws the narrow sidebar when it was collapsed", () => {
    expect(
      runAt("/app", {
        "rakazo:bots-sidebar-width:u1": "300",
        "rakazo:bots-sidebar-collapsed:u1": "1",
      }).side,
    ).toBe("72px");
  });

  it("keeps the default when several people used this browser", () => {
    expect(
      runAt("/app", {
        "rakazo:bots-sidebar-width:u1": "300",
        "rakazo:bots-sidebar-width:u2": "400",
      }).side,
    ).toBe("240px");
  });
});
