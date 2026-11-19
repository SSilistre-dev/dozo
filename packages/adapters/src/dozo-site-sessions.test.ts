import type {
  AdapterContext,
  ComputerRef,
  ProcessEvent,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { browserProfilePathForScreen } from "@rakazo/core/node/desktop-runtime";
import { describe, expect, it } from "vitest";
import type { BrowserSites } from "./dozo-site-sessions.js";
import {
  cookieSite,
  endSiteSessions,
  groupSiteSessions,
  hasSiteSessions,
  listSiteSessions,
  openSiteInBrowser,
  readBrowserSites,
  SiteSessionError,
  storageKeySite,
} from "./dozo-site-sessions.js";
import { SITE_SESSIONS_SCRIPT } from "./dozo-site-sessions.script.js";

const computer = { kind: "docker", providerRef: "ref" } as ComputerRef;
const context = { botId: "bot-1" } as AdapterContext;

/** A computer that answers the session script with `replies` in turn and keeps what it was asked. */
function sandbox(...replies: { stdout: string; code?: number }[]) {
  const requests: { request: Record<string, unknown>; argv: string[]; botId?: string }[] = [];
  const provider = {
    async *execute(
      _computer: ComputerRef,
      command: { argv: string[] },
      ctx: AdapterContext,
    ): AsyncIterable<ProcessEvent> {
      requests.push({
        request: JSON.parse(command.argv.at(-1)!),
        argv: command.argv,
        botId: ctx.botId,
      });
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)]!;
      yield { type: "stdout", data: reply.stdout };
      yield { type: "exit", code: reply.code ?? 0 };
    },
  } as unknown as SandboxProvider;
  return { provider, requests };
}
const json = (value: unknown) => ({ stdout: JSON.stringify(value) });

const at = (iso: string) => new Date(iso).getTime();
const browser = (over: Partial<BrowserSites>): BrowserSites => ({
  hosts: [],
  visited: [],
  storageKeys: [],
  ...over,
});

describe("sites from what the browser holds", () => {
  it("groups subdomains under their registrable domain, private suffixes as their own sites", () => {
    expect(cookieSite(".example.com")).toBe("example.com");
    expect(cookieSite("a.b.example.co.uk")).toBe("example.co.uk");
    expect(cookieSite("alice.github.io")).toBe("alice.github.io");
    expect(storageKeySite("https://a.example.com/^0https://top.example")).toBe("example.com");
    expect(storageKeySite("not a key")).toBeUndefined();
    const sites = groupSiteSessions(
      browser({
        hosts: [
          { host: "example.com", created: at("2026-11-01"), lastUsed: at("2026-11-10") },
          { host: "a.example.com", created: at("2026-10-01"), lastUsed: at("2026-11-18") },
          { host: "notexample.com", created: at("2026-11-02"), lastUsed: at("2026-11-02") },
          { host: "example.com.evil.org", created: at("2026-11-03"), lastUsed: at("2026-11-03") },
          { host: "alice.github.io", created: at("2026-11-04"), lastUsed: at("2026-11-04") },
          { host: "bob.github.io", created: at("2026-11-05"), lastUsed: at("2026-11-05") },
        ],
        visited: [
          "www.example.com",
          "notexample.com",
          "example.com.evil.org",
          "alice.github.io",
          "bob.github.io",
        ],
        storageKeys: [
          "https://example.com/",
          "https://a.example.com/^0https://top.example",
          "https://notexample.com/",
          "https://carol.github.io/",
        ],
      }),
    );
    expect(sites.map(({ site, hosts, storageKeys }) => [site, hosts, storageKeys])).toEqual([
      [
        "example.com",
        ["example.com", "a.example.com"],
        ["https://example.com/", "https://a.example.com/^0https://top.example"],
      ],
      ["bob.github.io", ["bob.github.io"], []],
      ["alice.github.io", ["alice.github.io"], []],
      ["evil.org", ["example.com.evil.org"], []],
      ["notexample.com", ["notexample.com"], ["https://notexample.com/"]],
    ]);
    expect(sites[0]!.since).toBe(at("2026-10-01"));
    expect(sites[0]!.lastUsedAt).toBe(at("2026-11-18"));
  });

  it("leaves out a site only ever loaded inside other sites' pages", () => {
    const sites = groupSiteSessions(
      browser({
        hosts: [
          { host: "tracker.example", created: 1, lastUsed: 2 },
          { host: "cdn.example", created: 1, lastUsed: 2 },
          { host: "news.example", created: 1, lastUsed: 2 },
        ],
        visited: ["news.example"],
      }),
    );
    expect(sites.map(({ site }) => site)).toEqual(["news.example"]);
  });

  it("keeps a host the browser has not saved yet, with no time, after the ones it has", () => {
    const sites = groupSiteSessions(
      browser({
        hosts: [
          { host: "fresh.example", created: null, lastUsed: null },
          { host: "www.old.example", created: null, lastUsed: null },
          { host: "old.example", created: 5, lastUsed: 9 },
          { host: "", created: 1, lastUsed: 1 },
        ],
        visited: ["fresh.example", "old.example", ""],
      }),
    );
    expect(sites).toEqual([
      {
        site: "old.example",
        since: 5,
        lastUsedAt: 9,
        hosts: ["www.old.example", "old.example"],
        storageKeys: [],
      },
      {
        site: "fresh.example",
        since: null,
        lastUsedAt: null,
        hosts: ["fresh.example"],
        storageKeys: [],
      },
    ]);
  });
});

describe("the session script", () => {
  it("is the computer's Python, given this bot's own profile and nothing it read back", async () => {
    const { provider, requests } = sandbox(
      json({
        ok: true,
        hosts: [
          { host: "example.com", created: 1, lastUsed: 2, value: "session-secret" },
          { host: 7, created: 1, lastUsed: 2 },
          { host: "live.example", created: null, lastUsed: null },
          "junk",
          null,
        ],
        visited: ["example.com", 3],
        storageKeys: ["https://example.com/", null],
      }),
    );
    const read = await readBrowserSites(provider, computer, "bot-1", context, 42);
    expect(read).toEqual({
      hosts: [
        { host: "example.com", created: 1, lastUsed: 2 },
        { host: "live.example", created: null, lastUsed: null },
      ],
      visited: ["example.com"],
      storageKeys: ["https://example.com/"],
    });
    expect(requests[0]!.argv.slice(0, 4)).toEqual(["python3", "-I", "-c", SITE_SESSIONS_SCRIPT]);
    expect(requests[0]!.request).toEqual({
      op: "list",
      since: 42,
      profile: browserProfilePathForScreen("bot-1"),
    });
    expect(requests[0]!.botId).toBe("bot-1");
    const sites = await listSiteSessions(provider, computer, "bot-1", context);
    expect(JSON.stringify(sites)).not.toContain("session-secret");
    expect(requests[1]!.request).toEqual({
      op: "list",
      profile: browserProfilePathForScreen("bot-1"),
    });
  });

  it("reads nothing from a reply without lists", async () => {
    const { provider } = sandbox(json({ ok: true }));
    expect(await readBrowserSites(provider, computer, "bot-1", context)).toEqual({
      hosts: [],
      visited: [],
      storageKeys: [],
    });
  });

  it("ends exactly the hosts and keys listed for that site, plus its bare and www names", async () => {
    const { provider, requests } = sandbox(json({ ok: true, remaining: 0 }));
    const [example] = groupSiteSessions(
      browser({
        hosts: [{ host: "a.example.com", created: 1, lastUsed: 1 }],
        visited: ["example.com"],
        storageKeys: ["https://a.example.com/^0https://top.example"],
      }),
    );
    await endSiteSessions(provider, computer, "bot-1", [example!], context);
    expect(requests[0]!.request).toEqual({
      op: "delete",
      hosts: ["a.example.com", "example.com", "www.example.com"],
      storageKeys: ["https://a.example.com/^0https://top.example"],
      profile: browserProfilePathForScreen("bot-1"),
    });
  });

  it("never sends a www name for an address, which the browser cannot read", async () => {
    const { provider, requests } = sandbox(json({ ok: true, remaining: 0 }));
    const sites = groupSiteSessions(
      browser({
        hosts: [
          { host: "10.0.0.5", created: 1, lastUsed: 1 },
          { host: "[::1]", created: 1, lastUsed: 1 },
        ],
        visited: ["10.0.0.5", "[::1]"],
      }),
    );
    await endSiteSessions(provider, computer, "bot-1", sites, context);
    expect(requests[0]!.request.hosts).toEqual(["10.0.0.5", "[::1]"]);
  });

  it("splits many sites into requests that each fit one argument", async () => {
    const { provider, requests } = sandbox(json({ ok: true, remaining: 0 }));
    const hosts = Array.from({ length: 3000 }, (_, i) => ({
      host: `site-${i}-with-a-longer-name.example${i % 7}.com`,
      created: 1,
      lastUsed: 1,
    }));
    const sites = groupSiteSessions(browser({ hosts, visited: hosts.map(({ host }) => host) }));
    await endSiteSessions(provider, computer, "bot-1", sites, context);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every(({ argv }) => argv.at(-1)!.length < 100_000)).toBe(true);
    expect(requests.flatMap(({ request }) => request.hosts as string[])).toHaveLength(3000 + 7 * 2);
  });

  it("refuses a site too large for one argument", async () => {
    const { provider, requests } = sandbox(json({ ok: true, remaining: 0 }));
    const hosts = Array.from({ length: 6000 }, (_, i) => ({
      host: `host-number-${i}.big.example`,
      created: 1,
      lastUsed: 1,
    }));
    const sites = groupSiteSessions(browser({ hosts, visited: ["big.example"] }));
    await expect(
      endSiteSessions(provider, computer, "bot-1", sites, context),
    ).rejects.toBeInstanceOf(SiteSessionError);
    expect(requests).toEqual([]);
  });

  it("asks nothing for no sites, and fails unless nothing was left", async () => {
    const quiet = sandbox(json({ ok: true, remaining: 0 }));
    await endSiteSessions(quiet.provider, computer, "bot-1", [], context);
    expect(quiet.requests).toEqual([]);
    const [site] = groupSiteSessions(
      browser({
        hosts: [{ host: "example.com", created: 1, lastUsed: 1 }],
        visited: ["example.com"],
      }),
    );
    for (const remaining of [1, null]) {
      const stuck = sandbox(json({ ok: true, remaining }));
      await expect(
        endSiteSessions(stuck.provider, computer, "bot-1", [site!], context),
      ).rejects.toBeInstanceOf(SiteSessionError);
    }
  });

  it("opens an address in the bot's browser", async () => {
    const { provider, requests } = sandbox(json({ ok: true }));
    await openSiteInBrowser(provider, computer, "bot-1", "https://example.com/login", context);
    expect(requests[0]!.request).toMatchObject({ op: "open", url: "https://example.com/login" });
  });

  it("turns a refusal, a broken or an oversized reply into a conflict the person can retry", async () => {
    const busy = "The bot's browser is busy. Try again in a moment.";
    const failed = "The bot's computer could not do that.";
    for (const [reply, message] of [
      [json({ ok: false, error: "busy" }), busy],
      [json({ ok: false, error: "no_browser" }), busy],
      [json({ ok: false, error: "profile" }), failed],
      [{ stdout: "Traceback", code: 1 }, failed],
      [{ stdout: '{"ok": tru' }, failed],
      [{ stdout: "x".repeat(5 * 1024 * 1024) }, failed],
    ] as const) {
      const { provider } = sandbox(reply);
      await expect(readBrowserSites(provider, computer, "bot-1", context)).rejects.toMatchObject({
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
