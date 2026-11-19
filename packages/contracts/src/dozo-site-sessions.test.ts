import { describe, expect, it } from "vitest";
import { DozoSignInUrl, DozoSiteSessionListSchema } from "./dozo-site-sessions.js";

describe("the signed-in sites a client receives", () => {
  it("carry a site name and two times, and drop anything else a server might add", () => {
    const parsed = DozoSiteSessionListSchema.parse({
      sites: [
        {
          site: "example.com",
          since: "2026-11-19T10:00:00.000Z",
          lastUsedAt: "2026-11-19T11:00:00.000Z",
          value: "session-secret",
          cookies: [{ name: "sid", value: "session-secret" }],
        },
      ],
    });
    expect(parsed.sites[0]).toEqual({
      site: "example.com",
      since: "2026-11-19T10:00:00.000Z",
      lastUsedAt: "2026-11-19T11:00:00.000Z",
    });
    expect(JSON.stringify(parsed)).not.toContain("session-secret");
  });
});

describe("the address to sign in to", () => {
  it("takes a bare site as https", () => {
    expect(DozoSignInUrl.parse(" example.com/login ")).toBe("https://example.com/login");
    expect(DozoSignInUrl.parse("http://intranet.example.com")).toBe("http://intranet.example.com");
  });

  it("refuses what is not a web page, or carries a user name or password", () => {
    for (const value of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "chrome://settings",
      "ftp://example.com",
      "https://user:pass@example.com",
      "https://",
      "",
    ]) {
      expect(DozoSignInUrl.safeParse(value).success, value).toBe(false);
    }
  });
});
