import { expect, it } from "vitest";
import { DOZO_TOKEN_NONCE_PREFIX, dozoTokenNonce, isDozoTokenNonce } from "./dozo-token-source.js";

it("marks a message sent with a token, and tells it from every other nonce", () => {
  expect(dozoTokenNonce("abc")).toBe(`${DOZO_TOKEN_NONCE_PREFIX}abc`);
  expect(isDozoTokenNonce(dozoTokenNonce("abc"))).toBe(true);
  for (const other of [null, undefined, "", "call:1:marker", "send:m-1", "abc", "API:x"])
    expect(isDozoTokenNonce(other)).toBe(false);
});
