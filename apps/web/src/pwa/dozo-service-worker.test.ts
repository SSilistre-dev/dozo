import { deferred } from "@rakazo/core/test-async";
import { describe, expect, it, vi } from "vitest";
import { installServiceWorker, NETWORK_WAIT_MS } from "./dozo-service-worker";
import type { ServiceWorkerScope } from "./service-worker.js";
import { SKIP_WAITING } from "./service-worker.js";

const ORIGIN = "https://app.example.com";
const CACHE = "rakazo-shell-current";

class FakeCache {
  readonly entries = new Map<string, Response>();
  async match(request: RequestInfo) {
    return this.entries
      .get(new URL(typeof request === "string" ? request : request.url, ORIGIN).href)
      ?.clone();
  }
  async put(request: RequestInfo, response: Response) {
    this.entries.set(
      new URL(typeof request === "string" ? request : request.url, ORIGIN).href,
      response,
    );
  }
  async addAll(requests: Request[]) {
    for (const request of requests) await this.put(request, await network(request));
  }
}

let network: (request: Request) => Promise<Response>;
const offline = async (): Promise<Response> => {
  throw new TypeError("offline");
};

function setup(precache = ["/", "/assets/index-abc.js"]) {
  const stores = new Map<string, FakeCache>();
  const listeners = new Map<string, (event: unknown) => void>();
  const scope = {
    location: { origin: ORIGIN },
    caches: {
      open: async (name: string) => {
        if (!stores.has(name)) stores.set(name, new FakeCache());
        return stores.get(name)!;
      },
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      match: async (request: Request) => {
        for (const store of stores.values()) {
          const found = await store.match(request);
          if (found) return found;
        }
        return undefined;
      },
    } as unknown as CacheStorage,
    clients: { matchAll: async () => [{}] },
    registration: { waiting: null },
    skipWaiting: vi.fn(async () => undefined),
    fetch: vi.fn((request: Request) => network(request)),
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
  };
  installServiceWorker(scope as unknown as ServiceWorkerScope, precache, CACHE);

  async function dispatch(type: string, extra: object) {
    const pending: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    listeners.get(type)!({
      ...extra,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      respondWith: (value: Promise<Response>) => {
        response = value;
      },
    });
    const result = await response;
    await Promise.all(pending);
    return result;
  }
  const fetch = async (
    path: string,
    ids: { clientId?: string; resultingClientId?: string } = {},
    mode: RequestMode = "cors",
    method = "GET",
  ) => {
    // Request() refuses "navigate" as a mode, so pin it the way the browser would.
    const request = Object.defineProperty(new Request(new URL(path, ORIGIN), { method }), "mode", {
      value: mode,
    });
    return (await dispatch("fetch", { request, ...ids }))?.text();
  };
  return { scope, dispatch, fetch };
}

describe("dozo service worker", () => {
  it("takes hashed assets from the network, never the worker's cache, on an online page", async () => {
    network = async (request) => new Response(`v1 ${new URL(request.url).pathname}`);
    const sw = setup();
    await sw.dispatch("install", {});
    network = async (request) => new Response(`network ${new URL(request.url).pathname}`);
    expect(await sw.fetch("/t/1", { resultingClientId: "page" }, "navigate")).toBe("network /t/1");
    expect(await sw.fetch("/assets/index-abc.js", { clientId: "page" })).toBe(
      "network /assets/index-abc.js",
    );
    expect(await sw.fetch("/assets/lazy-1.js", { clientId: "page" })).toBe(
      "network /assets/lazy-1.js",
    );
  });

  it("falls back to the worker's cache when an asset's network request fails", async () => {
    network = async (request) => new Response(`v1 ${new URL(request.url).pathname}`);
    const sw = setup();
    await sw.dispatch("install", {});
    network = offline;
    // A worker restarted since the page opened, or a browser without client ids, knows no
    // offline page: the precached copy still answers, an uncached chunk fails as the network did.
    expect(await sw.fetch("/assets/index-abc.js", { clientId: "page" })).toBe(
      "v1 /assets/index-abc.js",
    );
    expect(await sw.fetch("/assets/index-abc.js")).toBe("v1 /assets/index-abc.js");
    await expect(sw.fetch("/assets/lazy-1.js", { clientId: "page" })).rejects.toThrow("offline");
  });

  it("opens offline from the cached shell and its precached assets", async () => {
    network = async (request) => new Response(`v1 ${new URL(request.url).pathname}`);
    const sw = setup();
    await sw.dispatch("install", {});
    network = offline;
    expect(await sw.fetch("/t/1", { resultingClientId: "page" }, "navigate")).toBe("v1 /");
    expect(await sw.fetch("/assets/index-abc.js", { clientId: "page" })).toBe(
      "v1 /assets/index-abc.js",
    );
    // A lazy chunk the worker never cached still goes to the browser's network stack.
    await expect(sw.fetch("/assets/lazy-1.js", { clientId: "page" })).rejects.toThrow("offline");
    // Another page tries the network first and gets the cached copy when it fails.
    expect(await sw.fetch("/assets/index-abc.js", { clientId: "other" })).toBe(
      "v1 /assets/index-abc.js",
    );
  });

  it("keeps upstream's handling of the theme, other requests and updates", async () => {
    network = async (request) => new Response(`v1 ${new URL(request.url).pathname}`);
    const sw = setup();
    await sw.dispatch("install", {});
    expect(await sw.fetch("/instance-theme.css")).toBe("v1 /instance-theme.css");
    expect(await sw.fetch("/assets/index-abc.js", {}, "cors", "POST")).toBeUndefined();
    expect(await sw.fetch("https://cdn.example.com/assets/x.js")).toBeUndefined();
    await sw.dispatch("message", { data: SKIP_WAITING });
    expect(sw.scope.skipWaiting).toHaveBeenCalled();
    await sw.dispatch("activate", {});
    // Without a resulting client id the shell still opens, and so do its assets.
    network = offline;
    expect(await sw.fetch("/t/1", {}, "navigate")).toBe("v1 /");
    expect(await sw.fetch("/assets/index-abc.js")).toBe("v1 /assets/index-abc.js");
  });

  it("answers from the cache when the network hangs, and waits for it when nothing is cached", async () => {
    vi.useFakeTimers();
    try {
      network = async (request) => new Response(`v1 ${new URL(request.url).pathname}`);
      const sw = setup();
      await sw.dispatch("install", {});
      const late = deferred<Response>();
      // No answer and no error: what a stalled connection looks like to the worker.
      network = (request) =>
        new URL(request.url).pathname === "/assets/lazy-1.js"
          ? late.promise
          : deferred<Response>().promise;
      const precached = sw.fetch("/assets/index-abc.js", { clientId: "page" });
      const uncached = sw.fetch("/assets/lazy-1.js", { clientId: "page" });
      const page = sw.fetch("/t/1", { resultingClientId: "page" }, "navigate");
      await vi.advanceTimersByTimeAsync(NETWORK_WAIT_MS);
      expect(await precached).toBe("v1 /assets/index-abc.js");
      expect(await page).toBe("v1 /");
      let settled = false;
      void uncached.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(NETWORK_WAIT_MS * 5);
      expect(settled).toBe(false);
      late.resolve(new Response("slow /assets/lazy-1.js"));
      expect(await uncached).toBe("slow /assets/lazy-1.js");
    } finally {
      vi.useRealTimers();
    }
  });
});
