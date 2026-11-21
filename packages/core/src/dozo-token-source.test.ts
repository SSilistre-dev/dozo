import { expect, it } from "vitest";
import {
  DOZO_TOKEN_NONCE_PREFIX,
  dozoTokenNonce,
  dozoViaTokenField,
  isDozoTokenNonce,
} from "./dozo-token-source.js";

it("marks a message sent with a token, and tells it from every other nonce", () => {
  expect(dozoTokenNonce("abc")).toBe(`${DOZO_TOKEN_NONCE_PREFIX}abc`);
  expect(isDozoTokenNonce(dozoTokenNonce("abc"))).toBe(true);
  expect(dozoViaTokenField(dozoTokenNonce("abc"))).toEqual({ dozoViaToken: true });
  for (const other of [null, undefined, "", "call:1:marker", "send:m-1", "abc", "API:x"]) {
    expect(isDozoTokenNonce(other)).toBe(false);
    expect(dozoViaTokenField(other)).toEqual({});
  }
});

it("matches the literal the token gate's SQL uses for its index", () => {
  expect(DOZO_TOKEN_NONCE_PREFIX).toBe("api:");
});
