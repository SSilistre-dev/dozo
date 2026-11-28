import { describe, expect, it } from "vitest";
import { sanitizedError, scrubMonitoringText, stripMonitoringUrl } from "./monitoring.js";
import { redactSensitiveText } from "./redaction.js";

const token = "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9";

describe("share links", () => {
  it("keeps a link's token out of reported page and API URLs", () => {
    expect(stripMonitoringUrl(`https://app.example.com/s/${token}?x=1`)).toBe(
      "https://app.example.com/s/[Redacted]",
    );
    expect(stripMonitoringUrl(`/api/v1/dozo/shared/${token}`)).toBe(
      "/api/v1/dozo/shared/[Redacted]",
    );
  });

  it("keeps a link's token out of error text and logs, plain or percent-encoded", () => {
    const error = new Error(`Share link returned 500 for /api/v1/dozo/shared/${token}`);
    error.stack = `Error: at fetch (https://app.example.com/s/${token})`;
    expect(JSON.stringify(sanitizedError(error), ["message", "stack"])).not.toContain(token);
    expect(scrubMonitoringText(`GET /s/${token} failed`)).toBe("GET /s/[Redacted] failed");
    expect(redactSensitiveText(`next=%2Fs%2F${token}`)).not.toContain(token);
  });

  it("leaves paths that only contain an s segment deeper in alone", () => {
    expect(stripMonitoringUrl("https://app.example.com/app/s/settings")).toBe(
      "https://app.example.com/app/s/settings",
    );
  });
});

describe("replay frames", () => {
  it("keeps a link's token out of a frame's reported URL", () => {
    const url = stripMonitoringUrl(`https://app.example.com/api/v1/dozo/shared/${token}/frames/0`);
    expect(url).not.toContain(token);
    expect(scrubMonitoringText(`GET /api/v1/dozo/shared/${token}/frames/0 failed`)).not.toContain(
      token,
    );
  });
});
