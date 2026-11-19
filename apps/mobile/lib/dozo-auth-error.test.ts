import { i18n } from "@lingui/core";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dozoAuthErrorMessage } from "./dozo-auth-error";
import { authResponseErrorText } from "./user-error";

// The wiring tests run on the branded tree only: the brand rules route upstream's
// `authErrorText` here and add the Turkish copy to the catalog.

const copy = {
  fallback: "Could not continue",
  email: "Enter a valid email",
  password: "Enter a password",
};

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

it.each([
  ["INVALID_EMAIL_OR_PASSWORD", "Incorrect email or password"],
  ["INVALID_PASSWORD", "Incorrect password"],
  ["INVALID_EMAIL", "Enter a valid email"],
  ["PASSWORD_TOO_SHORT", "Password must be at least 8 characters"],
  ["PASSWORD_COMPROMISED", "This password appeared in a data breach. Choose another."],
  ["USER_ALREADY_EXISTS", "An account with this email already exists"],
  ["USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL", "An account with this email already exists"],
  ["EMAIL_NOT_VERIFIED", "Email verification required"],
  ["SESSION_EXPIRED", "Sign in again"],
  ["SESSION_NOT_FRESH", "Sign in again"],
  ["INVALID_TOKEN", "This link is invalid or expired"],
  ["TOKEN_EXPIRED", "This link is invalid or expired"],
  ["invalid_token", "This link is invalid or expired"],
  ["token_expired", "This link is invalid or expired"],
  ["TOO_MANY_REQUESTS", "Too many attempts. Try again in a few minutes."],
  ["SOCIAL_ACCOUNT_ALREADY_LINKED", "This account is already linked"],
  ["LINKED_ACCOUNT_ALREADY_EXISTS", "This account is already linked"],
  ["FAILED_TO_UNLINK_LAST_ACCOUNT", "Keep at least one way to sign in"],
  ["AUTH_CANCELLED", "Sign-in cancelled. Try again."],
])("says %s in its own words, never the server's", (code, text) => {
  expect(dozoAuthErrorMessage({ code, message: "Server words" }, copy)).toBe(text);
});

it("gives anything else the caller's copy, and a validation error its field", () => {
  expect(dozoAuthErrorMessage({ code: "FAILED_TO_CREATE_USER", message: "Failed" }, copy)).toBe(
    "Could not continue",
  );
  expect(console.warn).toHaveBeenCalledWith(
    "Auth error shown as generic copy:",
    "FAILED_TO_CREATE_USER",
    "Failed",
  );
  expect(dozoAuthErrorMessage(null, copy)).toBe("Could not continue");
  expect(
    dozoAuthErrorMessage({ code: "VALIDATION_ERROR", message: "[body.email] Invalid" }, copy),
  ).toBe("Enter a valid email");
  expect(dozoAuthErrorMessage({ status: 429 }, copy)).toBe(
    "Too many attempts. Try again in a few minutes.",
  );
});

it("is what the app's auth responses fall back on, in English and Turkish", () => {
  const body = { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" };
  expect(authResponseErrorText(401, body)).toBe("Incorrect email or password");
  expect(authResponseErrorText(400, { code: "SOMETHING_NEW", message: "Raw words" })).toBe(
    "Could not continue",
  );
  expect(authResponseErrorText(500, { message: "Internal" })).toBe(
    "The server had a problem. Try again in a moment.",
  );
  i18n.load("tr", tr);
  i18n.activate("tr");
  expect(authResponseErrorText(401, body)).toBe("E-posta ya da parola yanlış");
  expect(authResponseErrorText(400, { code: "PASSWORD_TOO_SHORT" })).toBe(
    "Parola en az 8 karakter olmalı",
  );
});
