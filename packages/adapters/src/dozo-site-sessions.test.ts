import type {
  AdapterContext,
  ComputerRef,
  ProcessEvent,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { browserProfilePathForScreen } from "@rakazo/core/node/desktop-runtime";
import { describe, expect, it } from "vitest";
import {
  cookieSite,
  endSiteSessions,
  groupSiteSessions,
  hasSiteSessions,
  listSiteSessions,
  openSiteInBrowser,
  readCookieHosts,
  SiteSessionError,
} from "./dozo-site-sessions.js";

const computer = { kind: "docker", providerRef: "ref" } as ComputerRef;
const context = { botId: "bot-1" } as AdapterContext;

/** A computer that answers the session script with `reply` and keeps what it was asked. */
function sandbox(reply: unknown, code = 0) {
  const requests: { request: Record<string, unknown>; botId: string | undefined }[] = [];
  const provider = {
    async *execute(
      _computer: ComputerRef,
      command: { argv: string[] },
      ctx: AdapterContext,
    ): AsyncIterable<ProcessEvent> {
      requests.push({ request: JSON.parse(command.argv.at(-1)!), botId: ctx.botId });
      yield { type: "stdout", data: typeof reply === "string" ? reply : JSON.stringify(reply) };
      yield { type: "exit", code };
    },
  } as unknown as SandboxProvider;
  return { provider, requests };
}

const at = (iso: string) => new Date(iso).getTime();

describe("sites from cookie hosts", () => {
  it("groups subdomains under their registrable domain, private suffixes as their own sites", () => {
    expect(cookieSite(".example.com")).toBe("example.com");
    expect(cookieSite("a.b.example.co.uk")).toBe("example.co.uk");
    expect(cookieSite("alice.github.io")).toBe("alice.github.io");
    const sites = groupSiteSessions([
      { host: "example.com", created: at("2026-11-01"), lastUsed: at("2026-11-10") },
      { host: "a.example.com", created: at("2026-10-01"), lastUsed: at("2026-11-18") },
      { host: "notexample.com", created: at("2026-11-02"), lastUsed: at("2026-11-02") },
      { host: "example.com.evil.org", created: at("2026-11-03"), lastUsed: at("2026-11-03") },
      { host: "alice.github.io", created: at("2026-11-04"), lastUsed: at("2026-11-04") },
      { host: "bob.github.io", created: at("2026-11-05"), lastUsed: at("2026-11-05") },
    ]);
    expect(sites.map(({ site, hosts }) => [site, hosts])).toEqual([
      ["example.com", ["example.com", "a.example.com"]],
      ["bob.github.io", ["bob.github.io"]],
      ["alice.github.io", ["alice.github.io"]],
      ["evil.org", ["example.com.evil.org"]],
      ["notexample.com", ["notexample.com"]],
    ]);
    expect(sites[0]!.since).toEqual(new Date("2026-10-01"));
    expect(sites[0]!.lastUsedAt).toEqual(new Date("2026-11-18"));
  });
});

describe("the session script", () => {
  it("reads host names and times of this bot's own profile, never a value", async () => {
    const { provider, requests } = sandbox({
      ok: true,
      hosts: [
        { host: "example.com", created: 1, lastUsed: 2, value: "session-secret" },
        { host: 7, created: 1, lastUsed: 2 },
        "junk",
      ],
    });
    const hosts = await readCookieHosts(provider, computer, "bot-1", context);
    expect(hosts).toEqual([{ host: "example.com", created: 1, lastUsed: 2 }]);
    expect(requests).toEqual([
      { request: { op: "list", profile: browserProfilePathForScreen("bot-1") }, botId: "bot-1" },
    ]);
    const sites = await listSiteSessions(provider, computer, "bot-1", context);
    expect(JSON.stringify(sites)).not.toContain("session-secret");
  });

  it("ends exactly the hosts the browser listed for that site, and its bare and www names", async () => {
    const { provider, requests } = sandbox({ ok: true, remaining: 0 });
    const [example] = groupSiteSessions([
      { host: "a.example.com", created: 1, lastUsed: 1 },
      { host: "notexample.com", created: 1, lastUsed: 1 },
    ]).filter(({ site }) => site === "example.com");
    await endSiteSessions(provider, computer, "bot-1", [example!], context);
    expect(requests[0]!.request).toEqual({
      op: "delete",
      hosts: ["a.example.com", "example.com", "www.example.com"],
      profile: browserProfilePathForScreen("bot-1"),
    });
  });

  it("asks nothing for no sites, and fails when a cookie survived", async () => {
    const quiet = sandbox({ ok: true, remaining: 0 });
    await endSiteSessions(quiet.provider, computer, "bot-1", [], context);
    expect(quiet.requests).toEqual([]);
    const stuck = sandbox({ ok: true, remaining: 1 });
    const [site] = groupSiteSessions([{ host: "example.com", created: 1, lastUsed: 1 }]);
    await expect(
      endSiteSessions(stuck.provider, computer, "bot-1", [site!], context),
    ).rejects.toBeInstanceOf(SiteSessionError);
  });

  it("opens an address in the bot's browser", async () => {
    const { provider, requests } = sandbox({ ok: true });
    await openSiteInBrowser(provider, computer, "bot-1", "https://example.com/login", context);
    expect(requests[0]!.request).toMatchObject({ op: "open", url: "https://example.com/login" });
  });

  it("turns a refusal or a broken reply into a conflict the person can retry", async () => {
    for (const [reply, code, message] of [
      [{ ok: false, error: "busy" }, 0, "The bot's browser is busy. Try again in a moment."],
      [{ ok: false, error: "no_browser" }, 0, "The bot's browser is busy. Try again in a moment."],
      [{ ok: false, error: "profile" }, 0, "The bot's computer could not do that."],
      ["Traceback", 1, "The bot's computer could not do that."],
    ] as const) {
      const { provider } = sandbox(reply, code);
      await expect(readCookieHosts(provider, computer, "bot-1", context)).rejects.toMatchObject({
        kind: "CONFLICT",
        message,
      });
    }
  });
});

describe("the capability", () => {
  it("is declared by the provider, and absent for one that does not", () => {
    expect(hasSiteSessions("docker")).toBe(true);
    expect(hasSiteSessions("desktop")).toBe(false);
    expect(hasSiteSessions(null)).toBe(false);
  });
});
