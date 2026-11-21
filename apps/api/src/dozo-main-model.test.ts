import { describe, expect, it } from "vitest";
import { dozoBecomesMain } from "./dozo-main-model.js";

const mine = { id: "mine", provider: "provider-a" };
const other = { provider: "provider-a", credentialId: "other" };

describe("the main model on a saved connection", () => {
  it("moves only when asked to", () => {
    expect(dozoBecomesMain({ makeDefault: true }, other, mine)).toBe(true);
    expect(dozoBecomesMain({ makeDefault: false }, null, mine)).toBe(false);
  });

  it("is the first connection's when nothing is said, and stays put after that", () => {
    expect(dozoBecomesMain({}, null, mine)).toBe(true);
    expect(dozoBecomesMain({}, other, mine)).toBe(false);
    expect(dozoBecomesMain({}, { provider: "provider-b" }, mine)).toBe(false);
  });

  it("stays on the connection that runs it when its own form is saved", () => {
    expect(dozoBecomesMain({}, { provider: "provider-a", credentialId: "mine" }, mine)).toBe(true);
    expect(dozoBecomesMain({}, { provider: "provider-a", credentialId: null }, mine)).toBe(true);
  });

  it("keeps an existing one when the caller says so", () => {
    const keep = { makeDefault: true, keepExistingDefault: true };
    expect(dozoBecomesMain(keep, other, mine)).toBe(false);
    expect(dozoBecomesMain(keep, null, mine)).toBe(true);
  });
});
