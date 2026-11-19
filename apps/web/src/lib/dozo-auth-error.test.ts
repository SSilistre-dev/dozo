import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dozoAuthErrorMessage } from "./dozo-auth-error";
import { authErrorText } from "./user-error";

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
  expect(console.warn).not.toHaveBeenCalled();
});

it("gives an unknown code the caller's copy and keeps the server's words in the console", () => {
  expect(
    dozoAuthErrorMessage({ code: "FAILED_TO_CREATE_USER", message: "Failed to create user" }, copy),
  ).toBe("Could not continue");
  expect(console.warn).toHaveBeenCalledWith(
    "Auth error shown as generic copy:",
    "FAILED_TO_CREATE_USER",
    "Failed to create user",
  );
  expect(dozoAuthErrorMessage({ message: "Human words from a server" }, copy)).toBe(
    "Could not continue",
  );
  expect(dozoAuthErrorMessage(undefined, copy)).toBe("Could not continue");
  expect(dozoAuthErrorMessage("text", copy)).toBe("Could not continue");
  expect(console.warn).toHaveBeenCalledTimes(2);
});

it("names the rejected field of a validation error, and a rate limit without a code", () => {
  const body = (message: string) => ({ code: "VALIDATION_ERROR", message });
  expect(dozoAuthErrorMessage(body("[body.email] Invalid email address"), copy)).toBe(
    "Enter a valid email",
  );
  expect(dozoAuthErrorMessage(body("[body.password] Required"), copy)).toBe("Enter a password");
  expect(dozoAuthErrorMessage(body("[body.name] Required"), copy)).toBe("Could not continue");
  expect(dozoAuthErrorMessage({ status: 429, message: "Too many requests" }, copy)).toBe(
    "Too many attempts. Try again in a few minutes.",
  );
});

it("is what upstream's authErrorText falls back on", () => {
  expect(
    authErrorText({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, "x"),
  ).toBe("Incorrect email or password");
  expect(
    authErrorText({ code: "USER_NOT_FOUND", message: "User not found" }, "Could not sign in"),
  ).toBe("Could not sign in");
  // Codes upstream already translates keep its copy.
  expect(authErrorText({ code: "INVALID_OTP", message: "Invalid OTP" }, "x")).toBe("Invalid code");
});

it("speaks Turkish with the catalog the build ships", () => {
  i18n.load("tr", tr as Messages);
  i18n.activate("tr");
  expect(authErrorText({ code: "INVALID_EMAIL_OR_PASSWORD" }, "x")).toBe(
    "E-posta ya da parola yanlış",
  );
  expect(authErrorText({ code: "PASSWORD_TOO_SHORT" }, "x")).toBe("Parola en az 8 karakter olmalı");
  expect(authErrorText({ code: "INVALID_EMAIL" }, "x")).toBe("Geçerli bir e-posta girin");
  for (const code of [
    "INVALID_PASSWORD",
    "PASSWORD_COMPROMISED",
    "USER_ALREADY_EXISTS",
    "INVALID_TOKEN",
    "SOCIAL_ACCOUNT_ALREADY_LINKED",
    "FAILED_TO_UNLINK_LAST_ACCOUNT",
  ]) {
    i18n.activate("en");
    const english = dozoAuthErrorMessage({ code }, copy);
    i18n.activate("tr");
    expect(dozoAuthErrorMessage({ code }, copy)).not.toBe(english);
  }
});
