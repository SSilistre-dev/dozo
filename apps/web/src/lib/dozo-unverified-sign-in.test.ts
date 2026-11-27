import { expect, it } from "vitest";
import { isUnverifiedSignIn } from "./dozo-unverified-sign-in";

it("only a 403 with EMAIL_NOT_VERIFIED is an unverified sign-in", () => {
  expect(isUnverifiedSignIn({ status: 403, code: "EMAIL_NOT_VERIFIED" })).toBe(true);
  expect(isUnverifiedSignIn({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" })).toBe(false);
  expect(isUnverifiedSignIn({ status: 403, code: "OTHER" })).toBe(false);
  expect(isUnverifiedSignIn({ message: "plain" })).toBe(false);
  expect(isUnverifiedSignIn(null)).toBe(false);
});
