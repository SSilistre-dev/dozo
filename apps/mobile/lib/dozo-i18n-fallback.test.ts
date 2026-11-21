import { setupI18n } from "@lingui/core";
import { describe, expect, it, vi } from "vitest";
import { compileMissingMessages } from "./dozo-i18n-fallback";

// A release build: Lingui registers no compiler of its own in production.
function releaseI18n() {
  vi.stubEnv("NODE_ENV", "production");
  try {
    const i18n = setupI18n({ locale: "en", messages: { en: { listed: ["Listed ", ["0"]] } } });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    return i18n;
  } finally {
    vi.unstubAllEnvs();
  }
}

describe("compileMissingMessages", () => {
  it("fills the placeholders of a string the catalog does not list", () => {
    const i18n = releaseI18n();
    const missing = {
      id: "missing",
      message: "Uses the relay at {0}.",
      values: { 0: "relay.test" },
    };
    expect(i18n._(missing)).toBe("Uses the relay at {0}.");
    compileMissingMessages(i18n);
    expect(i18n._(missing)).toBe("Uses the relay at relay.test.");
  });

  it("leaves a listed, compiled string as the catalog has it", () => {
    const i18n = releaseI18n();
    compileMissingMessages(i18n);
    expect(i18n._({ id: "listed", values: { 0: "here" } })).toBe("Listed here");
  });
});
