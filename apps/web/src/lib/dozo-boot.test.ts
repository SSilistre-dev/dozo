// @vitest-environment jsdom

import { flush } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listen, fetchAuthCapabilities } = vi.hoisted(() => ({
  listen: vi.fn((_signal: string, listener: () => void) => listener()),
  fetchAuthCapabilities: vi.fn(() => Promise.resolve({})),
}));
vi.mock("./auth", () => ({ authClient: { $store: { listen } } }));
vi.mock("./auth-capabilities", () => ({ fetchAuthCapabilities }));
vi.mock("../pages/SettingsOverlay", () => ({ screen: "settings" }));
vi.mock("../components/bot-templates/bot-templates-dialog", () => ({ screen: "new bot" }));
vi.mock("../pages/BotContextMenu", () => ({ screen: "bot menu" }));

import {
  appHasPainted,
  boot,
  loadCommonScreens,
  releaseBootShell,
  startBootReads,
  whenIdle,
} from "./dozo-boot";

function page(rootHtml: string) {
  document.body.innerHTML = `<div id="root">${rootHtml}</div><div id="dozo-boot"><div></div></div>`;
  return document.getElementById("root")!;
}

const loader =
  '<div data-rakazo-app-state="ready"><div class="grid place-items-center"><span><svg data-slot="spinner"></svg></span></div></div>';

describe("appHasPainted", () => {
  it("waits through an empty root, pending language or session, and a whole-page spinner", () => {
    expect(appHasPainted(page(""))).toBe(false);
    expect(appHasPainted(page('<div data-rakazo-app-state="i18n-pending"></div>'))).toBe(false);
    expect(appHasPainted(page('<div data-rakazo-app-state="session-pending"></div>'))).toBe(false);
    expect(appHasPainted(page(loader))).toBe(false);
  });

  it("is done once a screen, an error or a spinner inside a screen shows", () => {
    expect(appHasPainted(page('<div data-rakazo-app-state="ready"><main></main></div>'))).toBe(
      true,
    );
    expect(appHasPainted(page('<div data-rakazo-app-state="failed"></div>'))).toBe(true);
    expect(
      appHasPainted(
        page(
          '<div data-rakazo-app-state="ready"><main><svg data-slot="spinner"></svg></main></div>',
        ),
      ),
    ).toBe(true);
  });
});

describe("releaseBootShell", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the shell while the app loads and removes it when the app paints", async () => {
    const root = page("");
    const released = vi.fn();
    releaseBootShell(document, 10_000, released);
    root.innerHTML = '<div data-rakazo-app-state="session-pending"></div>';
    await vi.advanceTimersByTimeAsync(0);
    root.innerHTML = loader;
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("dozo-boot")).not.toBeNull();
    expect(released).not.toHaveBeenCalled();
    root.innerHTML = '<div data-rakazo-app-state="ready"><main></main></div>';
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById("dozo-boot")).toBeNull();
    expect(released).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("gives up after the limit so a stuck load is not hidden", () => {
    page("");
    const released = vi.fn();
    releaseBootShell(document, 10_000, released);
    vi.advanceTimersByTime(9_999);
    expect(document.getElementById("dozo-boot")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(document.getElementById("dozo-boot")).toBeNull();
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("releases at once when there is no shell or the app already painted", () => {
    document.body.innerHTML = '<div id="root"></div>';
    const withoutShell = vi.fn();
    releaseBootShell(document, 10_000, withoutShell);
    expect(withoutShell).toHaveBeenCalledTimes(1);

    page('<div data-rakazo-app-state="ready"><main></main></div>');
    releaseBootShell(document, 10_000);
    expect(document.getElementById("dozo-boot")).toBeNull();
  });
});

describe("startBootReads", () => {
  beforeEach(() => {
    listen.mockClear();
    fetchAuthCapabilities.mockClear();
  });

  it("starts the session and capability reads on a chat route", () => {
    expect(startBootReads("/app/bot_1", false)).toBe(true);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(fetchAuthCapabilities).toHaveBeenCalledTimes(1);
  });

  it("leaves other pages to load as before", () => {
    expect(startBootReads("/sign-in", false)).toBe(false);
    expect(startBootReads("/", false)).toBe(false);
    expect(listen).not.toHaveBeenCalled();
    expect(fetchAuthCapabilities).not.toHaveBeenCalled();
  });

  it("does not leave a failed capability read unhandled", async () => {
    fetchAuthCapabilities.mockReturnValueOnce(Promise.reject(new Error("offline")));
    expect(startBootReads("/", true)).toBe(true);
    await flush();
  });
});

describe("whenIdle", () => {
  it("loads when the browser is idle, ignoring a chunk that fails", async () => {
    const idle: Array<() => void> = [];
    const view = {
      location,
      setTimeout: vi.fn(),
      requestIdleCallback: vi.fn((callback: () => void) => idle.push(callback)),
    };
    const failing = vi.fn(() => Promise.reject(new Error("stale chunk")));
    whenIdle(view as never, failing);
    expect(failing).not.toHaveBeenCalled();
    idle[0]!();
    await flush();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(view.setTimeout).not.toHaveBeenCalled();
  });

  it("falls back to a short timer where idle callbacks do not exist", () => {
    const timers: Array<() => void> = [];
    const view = { location, setTimeout: vi.fn((callback: () => void) => timers.push(callback)) };
    const load = vi.fn(() => Promise.resolve());
    whenIdle(view as never, load);
    expect(view.setTimeout).toHaveBeenCalledWith(expect.any(Function), 2_000);
    timers[0]!();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("boot", () => {
  it("loads the common screens after a chat route paints", async () => {
    await expect(loadCommonScreens()).resolves.toEqual([
      expect.objectContaining({ screen: "settings" }),
      expect.objectContaining({ screen: "new bot" }),
      expect.objectContaining({ screen: "bot menu" }),
    ]);
    const idle: Array<() => void> = [];
    const chat = {
      location: { pathname: "/app" },
      setTimeout: vi.fn(),
      requestIdleCallback: vi.fn((callback: () => void) => idle.push(callback)),
    };
    const root = page("");
    boot(chat as never, document);
    expect(chat.requestIdleCallback).not.toHaveBeenCalled();
    root.innerHTML = '<div data-rakazo-app-state="ready"><main></main></div>';
    await flush();
    expect(chat.requestIdleCallback).toHaveBeenCalledTimes(1);
  });

  it("preloads nothing on other pages", () => {
    const other = { location: { pathname: "/sign-in" }, setTimeout: vi.fn() };
    page('<div data-rakazo-app-state="ready"><main></main></div>');
    boot(other as never, document);
    expect(other.setTimeout).not.toHaveBeenCalled();
  });
});
