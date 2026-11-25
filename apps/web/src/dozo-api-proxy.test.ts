import { describe, expect, it } from "vitest";
import { forwardsToApi } from "../server/api-proxy.js";

describe("what the web server forwards to the API (MCP metadata)", () => {
  it("forwards the MCP endpoint's OAuth metadata, as the API serves it", () => {
    expect(forwardsToApi("/.well-known/oauth-protected-resource/api/v1/dozo/mcp")).toBe(true);
    expect(forwardsToApi("/api/v1/dozo/mcp")).toBe(true);
  });

  it("keeps every other /.well-known/ path where it was", () => {
    expect(forwardsToApi("/.well-known/assetlinks.json")).toBe(true);
    expect(forwardsToApi("/.well-known/apple-app-site-association")).toBe(true);
    for (const path of ["/.well-known/security.txt", "/.well-known/openid-configuration"])
      expect(forwardsToApi(path)).toBe(false);
  });

  it("forwards no upgrade there", () => {
    expect(forwardsToApi("/.well-known/oauth-protected-resource/api/v1/dozo/mcp", true)).toBe(
      false,
    );
  });
});
