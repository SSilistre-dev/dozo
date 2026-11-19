import { describe, expect, it } from "vitest";
import { DOZO_FEATURED_MODEL_OPTIONS, dozoModelKeyPage } from "./dozo-model-providers.js";

describe("DOZO_FEATURED_MODEL_OPTIONS", () => {
  it("lists a few distinct ways, each a provider id with an optional way to connect", () => {
    expect(new Set(DOZO_FEATURED_MODEL_OPTIONS).size).toBe(DOZO_FEATURED_MODEL_OPTIONS.length);
    expect(DOZO_FEATURED_MODEL_OPTIONS.length).toBeLessThanOrEqual(8);
    for (const value of DOZO_FEATURED_MODEL_OPTIONS)
      expect(value).toMatch(/^[a-z0-9-]+(:(sign-in|key))?$/);
  });
});

describe("dozoModelKeyPage", () => {
  it("gives an https page for a provider with a checked one", () => {
    const page = dozoModelKeyPage("openrouter");
    expect(page).toBeDefined();
    expect(new URL(page ?? "").protocol).toBe("https:");
  });

  it("gives nothing for an unknown provider or an inherited name", () => {
    expect(dozoModelKeyPage("no-such-provider")).toBeUndefined();
    expect(dozoModelKeyPage("constructor")).toBeUndefined();
    expect(dozoModelKeyPage("")).toBeUndefined();
  });
});
