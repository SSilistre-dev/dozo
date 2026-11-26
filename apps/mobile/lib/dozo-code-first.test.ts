import { expect, it, vi } from "vitest";
import { isUnverifiedSignIn, passwordShown, signInNeedsCode, usesCode } from "./dozo-code-first";

const failure = (status: number, code: string) =>
  Object.assign(new Error("refused"), { status, code });

it("sign-in asks for a code until a password is chosen, and sign-up never for a password", () => {
  expect(usesCode(true, "in", false, false)).toBe(true);
  expect(usesCode(true, "in", false, true)).toBe(false);
  expect(usesCode(true, "up", false, true)).toBe(true);
  expect(usesCode(true, "in", true, true)).toBe(true);
});

it("a server without codes keeps the password form, and the reset form has none", () => {
  expect(usesCode(false, "up", false, false)).toBe(false);
  expect(passwordShown("up", false)).toBe(true);
  expect(passwordShown("in", true)).toBe(false);
  expect(passwordShown("forgot", false)).toBe(false);
});

it("only a 403 with EMAIL_NOT_VERIFIED is an unverified sign-in", () => {
  expect(isUnverifiedSignIn(failure(403, "EMAIL_NOT_VERIFIED"))).toBe(true);
  expect(isUnverifiedSignIn(failure(401, "INVALID_EMAIL_OR_PASSWORD"))).toBe(false);
  expect(isUnverifiedSignIn(failure(403, "OTHER"))).toBe(false);
  expect(isUnverifiedSignIn(new Error("plain"))).toBe(false);
});

it("asks for a code on an unverified refusal and passes every other error on", async () => {
  expect(await signInNeedsCode(true, async () => undefined)).toBe(false);
  expect(
    await signInNeedsCode(true, vi.fn().mockRejectedValue(failure(403, "EMAIL_NOT_VERIFIED"))),
  ).toBe(true);
  const wrong = failure(401, "INVALID_EMAIL_OR_PASSWORD");
  await expect(signInNeedsCode(true, vi.fn().mockRejectedValue(wrong))).rejects.toBe(wrong);
  const unverified = failure(403, "EMAIL_NOT_VERIFIED");
  await expect(signInNeedsCode(false, vi.fn().mockRejectedValue(unverified))).rejects.toBe(
    unverified,
  );
});
