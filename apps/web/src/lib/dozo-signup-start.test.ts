// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { KEPT_FOR_MS } from "./dozo-kept-for-an-hour";
import { markSignupStarted, takeSignupStarted } from "./dozo-signup-start";

/** A value as the store holds it, kept for the next half hour. */
const store = (value: unknown) =>
  window.localStorage.setItem(
    "dozo:signup-started",
    JSON.stringify({ value, expiresAt: Date.now() + KEPT_FOR_MS / 2 }),
  );

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

it("keeps when the form was first opened, until it is taken once", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T10:00:00.000Z"));
  markSignupStarted();
  vi.setSystemTime(new Date("2026-11-19T10:05:00.000Z"));
  markSignupStarted();
  expect(takeSignupStarted()).toBe("2026-11-19T10:00:00.000Z");
  expect(takeSignupStarted()).toBeNull();
});

it("keeps the start for another tab of the same browser", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T10:00:00.000Z"));
  markSignupStarted();
  // A new tab starts with its own empty session storage; the start is not kept there.
  window.sessionStorage.clear();
  vi.setSystemTime(new Date("2026-11-19T10:20:00.000Z"));
  expect(takeSignupStarted()).toBe("2026-11-19T10:00:00.000Z");
});

it("forgets a start after an hour, and a new form open starts again", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T10:00:00.000Z"));
  markSignupStarted();
  vi.setSystemTime(new Date(Date.parse("2026-11-19T10:00:00.000Z") + KEPT_FOR_MS));
  markSignupStarted();
  expect(takeSignupStarted()).toBe("2026-11-19T10:00:00.000Z");

  markSignupStarted();
  vi.setSystemTime(new Date("2026-11-19T12:00:00.001Z"));
  expect(takeSignupStarted()).toBeNull();
  expect(window.localStorage.getItem("dozo:signup-started")).toBeNull();

  vi.setSystemTime(new Date("2026-11-19T13:00:00.000Z"));
  markSignupStarted();
  expect(takeSignupStarted()).toBe("2026-11-19T13:00:00.000Z");
});

it.each(["yesterday", '"2026-11-19T10:00:00.000Z"'])(
  "takes nothing from %j, a value it did not write, and removes it",
  (raw) => {
    window.localStorage.setItem("dozo:signup-started", raw);
    expect(takeSignupStarted()).toBeNull();
    expect(window.localStorage.getItem("dozo:signup-started")).toBeNull();
  },
);

it.each([7, "yesterday", "2026-11-19", "2999-01-01T00:00:00.000Z"])(
  "takes nothing from a kept %j, and removes it",
  (value) => {
    store(value);
    expect(takeSignupStarted()).toBeNull();
    expect(window.localStorage.getItem("dozo:signup-started")).toBeNull();
  },
);

it("replaces a value it did not write when the form opens", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T10:00:00.000Z"));
  store("yesterday");
  markSignupStarted();
  expect(takeSignupStarted()).toBe("2026-11-19T10:00:00.000Z");
});

it("keeps nothing, and takes nothing, when storage refuses", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("full");
  });
  markSignupStarted();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("refused");
  });
  expect(takeSignupStarted()).toBeNull();
  vi.restoreAllMocks();
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new Error("off");
  });
  markSignupStarted();
  expect(takeSignupStarted()).toBeNull();
});
