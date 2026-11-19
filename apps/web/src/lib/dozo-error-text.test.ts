import { i18n } from "@lingui/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@rakazo/ui-web", () => ({ toast }));

import { errorText, toastError } from "./dozo-error-text";

const answered = (message: string, status = 400) => Object.assign(new Error(message), { status });

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  toast.error.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it("hides the words of a server's answer behind the caller's copy", () => {
  expect(errorText(answered("User 42 not found"), "Could not grant access")).toBe(
    "Could not grant access",
  );
  expect(console.warn).toHaveBeenCalledWith(
    "Server error shown as generic copy:",
    "User 42 not found",
  );
  expect(errorText(answered("  Space limit reached "))).toBe("Something went wrong. Try again.");
});

it("keeps the copy the client wrote and what upstream already translates", () => {
  expect(errorText(new Error("Add a voice provider key and pick a voice in Voice settings."))).toBe(
    "Add a voice provider key and pick a voice in Voice settings.",
  );
  expect(errorText(Object.assign(answered("raw", 402), { code: "VOICE_OUT_OF_CREDIT" }))).toBe(
    "Your voice provider is out of credit.",
  );
  expect(errorText(new TypeError("Failed to fetch"), "x")).toBe("Could not reach the server");
  expect(errorText(answered(""), "Could not save")).toBe("Could not save");
  expect(console.warn).not.toHaveBeenCalled();
});

it("is the one way an error becomes a toast", () => {
  toastError("Could not save");
  expect(toast.error).toHaveBeenLastCalledWith("Could not save");
  toastError("Could not revoke grant", answered("Grant g_1 is gone", 404));
  expect(toast.error).toHaveBeenLastCalledWith("Could not revoke grant");
  toastError("Could not play that clip.", undefined, { id: "read-aloud-error" });
  expect(toast.error).toHaveBeenLastCalledWith("Could not play that clip.", {
    id: "read-aloud-error",
  });
});
