import { describe, expect, it } from "vitest";
import { serverHearsCaller } from "./dozo-server-hears";

describe("whether the speech server hears the caller", () => {
  it("is so when the check said it can and the provider transcribes or has not said", () => {
    expect(serverHearsCaller(true, true)).toBe(true);
    expect(serverHearsCaller(undefined, true)).toBe(true);
  });

  it("is not so without the check's word, or when the provider cannot transcribe", () => {
    expect(serverHearsCaller(true, undefined)).toBe(false);
    expect(serverHearsCaller(true, false)).toBe(false);
    expect(serverHearsCaller(false, true)).toBe(false);
  });
});
