import { describe, expect, it } from "vitest";
import { verificationCallbackUrl } from "./dozo-email-link.js";

describe("verificationCallbackUrl", () => {
  it("lands on the web app's result page with the address", () => {
    expect(verificationCallbackUrl("https://app.example.com", "ada+x@example.com")).toBe(
      "https://app.example.com/verify-email?email=ada%2Bx%40example.com",
    );
  });

  it("ignores a path on the origin", () => {
    expect(verificationCallbackUrl("https://app.example.com/app", "a@example.com")).toBe(
      "https://app.example.com/verify-email?email=a%40example.com",
    );
  });
});
