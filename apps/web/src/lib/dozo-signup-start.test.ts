// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { markSignupStarted, takeSignupStarted } from "./dozo-signup-start";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

it("takes nothing from a value it did not write", () => {
  window.sessionStorage.setItem("dozo:signup-started", "yesterday");
  expect(takeSignupStarted()).toBeNull();
  expect(window.sessionStorage.getItem("dozo:signup-started")).toBeNull();
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
  vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
    throw new Error("off");
  });
  markSignupStarted();
  expect(takeSignupStarted()).toBeNull();
});
