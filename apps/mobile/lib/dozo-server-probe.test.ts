import { i18n } from "@lingui/core";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeDozoServer, SERVER_PROBE_TIMEOUT_MS, wwwAlternative } from "./dozo-server-probe";

const CAPABILITIES = { sso: null, passwordAuth: true, passwordReset: false, resetUrl: null };

type Answer = Response | Error | "hang";

/** A fetch that answers each URL from the table, and records what was asked. */
function server(answers: Record<string, Answer>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const answer = answers[url];
    if (answer === undefined) throw new TypeError("Network request failed");
    if (answer === "hang")
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    if (answer instanceof Error) throw answer;
    return answer.clone();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const healthy = (origin: string) => ({
  [`${origin}/api/auth/capabilities`]: json(CAPABILITIES),
  [`${origin}/rpc/health`]: json({ json: { ok: true } }),
});

beforeEach(() => {
  i18n.load("en", {});
  i18n.activate("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("probeDozoServer", () => {
  it("accepts a server whose capabilities and health answer, as the mobile app asks them", async () => {
    const { fetchImpl, calls } = server(healthy("https://dozo.example"));
    expect(await probeDozoServer(" dozo.example/ ", fetchImpl)).toEqual({
      ok: true,
      url: "https://dozo.example",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://dozo.example/api/auth/capabilities",
      "https://dozo.example/rpc/health",
    ]);
    expect(calls[0]?.init?.headers).toMatchObject({ origin: "rakazo://" });
    expect(calls[0]?.init?.redirect).toBeUndefined();
  });

  it("asks with the platform's fetch when given none", async () => {
    vi.stubGlobal("fetch", server(healthy("https://dozo.example")).fetchImpl);
    expect(await probeDozoServer("dozo.example")).toEqual({
      ok: true,
      url: "https://dozo.example",
    });
  });

  it("sends the server's own headers and refuses a redirect with them", async () => {
    const { fetchImpl, calls } = server(healthy("https://dozo.example"));
    await probeDozoServer("dozo.example", fetchImpl, { "x-gate": "1" });
    expect(calls[0]?.init).toMatchObject({ redirect: "error", headers: { "x-gate": "1" } });
  });

  it("uses the address with www. when only that one answers, and without it the other way", async () => {
    const withWww = server(healthy("https://www.dozo.example"));
    expect(await probeDozoServer("dozo.example", withWww.fetchImpl)).toEqual({
      ok: true,
      url: "https://www.dozo.example",
    });
    const without = server({
      ...healthy("https://dozo.example"),
      "https://www.dozo.example/api/auth/capabilities": new Response("<html>", { status: 200 }),
    });
    expect(await probeDozoServer("www.dozo.example", without.fetchImpl)).toEqual({
      ok: true,
      url: "https://dozo.example",
    });
  });

  it("says no address answered when neither form does", async () => {
    const { fetchImpl, calls } = server({});
    expect(await probeDozoServer("dozo.example", fetchImpl)).toEqual({
      ok: false,
      error: "Could not reach this address. Check it and your connection.",
    });
    expect(calls).toHaveLength(2);
  });

  it("says an answering site is not a Dozo server: an error status, other JSON or not JSON", async () => {
    for (const answer of [
      new Response("nope", { status: 404 }),
      json({ hello: "world" }),
      new Response("<html></html>", { status: 200 }),
    ]) {
      const { fetchImpl } = server({ "https://site.example/api/auth/capabilities": answer });
      expect(await probeDozoServer("site.example", fetchImpl)).toEqual({
        ok: false,
        error: "This address is not a Dozo server.",
      });
    }
  });

  it("says the server did not answer in time, without trying another address", async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = server({ "https://slow.example/api/auth/capabilities": "hang" });
    const result = probeDozoServer("slow.example", fetchImpl);
    await vi.advanceTimersByTimeAsync(SERVER_PROBE_TIMEOUT_MS);
    expect(await result).toEqual({
      ok: false,
      error: "The server did not answer in time. Try again.",
    });
    expect(calls).toHaveLength(1);
  });

  it("keeps the health check's verdict after the capabilities pass", async () => {
    const { fetchImpl } = server({
      "https://dozo.example/api/auth/capabilities": json(CAPABILITIES),
      "https://dozo.example/rpc/health": json({ json: { ok: false } }),
    });
    expect(await probeDozoServer("dozo.example", fetchImpl)).toMatchObject({ ok: false });
  });

  it("says what is wrong with the address before asking anything, in Turkish too", async () => {
    const { fetchImpl, calls } = server({});
    expect(await probeDozoServer("", fetchImpl)).toMatchObject({ ok: false });
    expect(await probeDozoServer("http://dozo.example", fetchImpl)).toEqual({
      ok: false,
      error: "Public servers need https://",
    });
    expect(calls).toHaveLength(0);
    i18n.load("tr", tr);
    i18n.activate("tr");
    expect(await probeDozoServer("http://dozo.example", fetchImpl)).toEqual({
      ok: false,
      error: "Herkese açık sunucular için https:// gerekir",
    });
    expect(await probeDozoServer("dozo.example", fetchImpl)).toEqual({
      ok: false,
      error: "Bu adrese ulaşılamadı. Adresi ve bağlantınızı kontrol edin.",
    });
  });
});

describe("wwwAlternative", () => {
  it("adds or removes www. for a public name only", () => {
    expect(wwwAlternative("https://dozo.example")).toBe("https://www.dozo.example");
    expect(wwwAlternative("https://www.dozo.example")).toBe("https://dozo.example");
    expect(wwwAlternative("https://www.example")).toBeNull();
    expect(wwwAlternative("https://dozo.example:8443")).toBeNull();
    expect(wwwAlternative("http://192.168.1.20")).toBeNull();
    expect(wwwAlternative("https://203.0.113.5")).toBeNull();
    expect(wwwAlternative("http://localhost")).toBeNull();
  });
});
