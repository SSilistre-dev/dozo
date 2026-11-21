import { createExecutionContext, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { relayVerifier } from "@dozo/relay-core/dozo-relay-channel";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { settings } from "../src/env.js";
import { createRelay } from "../src/index.js";
import type { Registry, RegistryLimits } from "../src/registry.js";
import { sourceOf } from "../src/registry.js";
import {
  call,
  channelStub,
  confirmPairing,
  connect,
  newAddress,
  peer,
  register,
  registryStub,
  relayCrypto,
  token,
  upgrade,
  waitForText,
} from "./support.js";

const DAY = 24 * 60 * 60 * 1000;
const ADMIN = "a".repeat(40);

/** A registry of its own, so counts in one test never depend on another. */
function freshRegistry() {
  return env.REGISTRY.get(env.REGISTRY.idFromName(`test-${crypto.randomUUID()}`));
}

const limits = (overrides: Partial<RegistryLimits> = {}): RegistryLimits => ({
  maxChannels: 0,
  pendingPerSource: 0,
  channelsPerSourceDaily: 0,
  ...overrides,
});

function relayWith(overrides: Partial<Env>) {
  const relay = createRelay(() => true);
  const limited = { ...env, ...overrides };
  return async (request: Request) =>
    relay.fetch!(
      request as Request<unknown, IncomingRequestCfProperties>,
      limited,
      createExecutionContext(),
    );
}

async function registerBody() {
  return JSON.stringify({
    hostVerifier: await relayVerifier(relayCrypto, token()),
    pairVerifier: await relayVerifier(relayCrypto, token()),
    pairExpiresAt: Date.now() + 10 * 60 * 1000,
  });
}

async function stats() {
  return runInDurableObject(registryStub(), (registry: Registry) => registry.stats());
}

describe("sources", () => {
  it("takes an IPv4 address whole and an IPv6 address by its /64", () => {
    expect(sourceOf("198.51.100.7")).toBe("198.51.100.7");
    expect(sourceOf("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(sourceOf("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(sourceOf("2001:0DB8:0001:0002:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(sourceOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(sourceOf("2001:db8:1:3::1")).not.toBe(sourceOf("2001:db8:1:2::1"));
    expect(sourceOf("unknown")).toBe("unknown");
  });
});

describe("registry", () => {
  it("limits the unpaired channels one source holds at once, and frees a slot on pairing", async () => {
    const registry = freshRegistry();
    const only = limits({ pendingPerSource: 2 });
    expect(await registry.reserve("c1", "192.0.2.1", only)).toBe("reserved");
    expect(await registry.reserve("c2", "192.0.2.1", only)).toBe("reserved");
    expect(await registry.reserve("c3", "192.0.2.1", only)).toBe("refused");
    // Same /64: the same source.
    expect(await registry.reserve("v1", "2001:db8::1", only)).toBe("reserved");
    expect(await registry.reserve("v2", "2001:db8::2", only)).toBe("reserved");
    expect(await registry.reserve("v3", "2001:db8::3", only)).toBe("refused");
    expect(await registry.reserve("o1", "192.0.2.2", only)).toBe("reserved");
    expect(await registry.paired("c1")).toBe(true);
    expect(await registry.reserve("c3", "192.0.2.1", only)).toBe("reserved");
  });

  it("limits the channels one source registered in the last day, paired or not", async () => {
    const registry = freshRegistry();
    const only = limits({ channelsPerSourceDaily: 2 });
    const start = Date.now();
    expect(await registry.reserve("c1", "192.0.2.1", only, start)).toBe("reserved");
    expect(await registry.paired("c1", start)).toBe(true);
    expect(await registry.reserve("c2", "192.0.2.1", only, start)).toBe("reserved");
    expect(await registry.paired("c2", start)).toBe(true);
    expect(await registry.reserve("c3", "192.0.2.1", only, start + 1000)).toBe("refused");
    // A deleted channel no longer counts.
    await registry.release("c2");
    expect(await registry.reserve("c3", "192.0.2.1", only, start + 2000)).toBe("reserved");
    expect(await registry.reserve("c4", "192.0.2.1", only, start + 3000)).toBe("refused");
    // A day later the source is forgotten: the channels stay, the limit starts again.
    expect(await registry.reserve("c4", "192.0.2.1", only, start + DAY + 3000)).toBe("reserved");
    expect(await registry.count()).toBe(3);
  });

  it("forgets which source registered a channel after a day", async () => {
    const registry = freshRegistry();
    const start = Date.now();
    await registry.reserve("c1", "192.0.2.1", limits(), start);
    await registry.reserve("c2", "192.0.2.2", limits(), start + DAY + 1);
    const sources = await runInDurableObject(registry, (_: Registry, state) =>
      state.storage.sql
        .exec<{ id: string; source: string | null }>("SELECT id, source FROM channels ORDER BY id")
        .toArray(),
    );
    expect(sources[0]).toEqual({ id: "c1", source: null });
    // Kept only as a keyed hash, never the address.
    expect(sources[1]?.source).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(sources)).not.toContain("192.0.2");
  });

  it("makes room at the ceiling by pushing out the oldest unpaired channel, never a paired one", async () => {
    const registry = freshRegistry();
    const ceiling = limits({ maxChannels: 3 });
    const start = Date.now();
    await registry.reserve("paired", "192.0.2.1", ceiling, start);
    await registry.paired("paired", start);
    await registry.reserve("old", "192.0.2.2", ceiling, start + 1);
    await registry.reserve("new", "192.0.2.3", ceiling, start + 2);
    expect(await registry.reserve("next", "192.0.2.4", ceiling, start + 3)).toBe("reserved");
    expect(await registry.count()).toBe(3);
    // The pushed-out channel can no longer pair; the others can.
    expect(await registry.paired("old")).toBe(false);
    expect(await registry.paired("new")).toBe(true);
    expect(await registry.paired("next")).toBe(true);
    expect(await registry.paired("paired")).toBe(true);
    // Every channel paired: the ceiling holds.
    expect(await registry.reserve("more", "192.0.2.5", ceiling, start + 4)).toBe("refused");
    await registry.release("new");
    await registry.release("new");
    expect(await registry.count()).toBe(2);
    expect(await registry.reserve("more", "192.0.2.5", ceiling, start + 5)).toBe("reserved");
  });

  it("counts what happened each day, without saying who", async () => {
    const registry = freshRegistry();
    const ceiling = limits({ maxChannels: 1, pendingPerSource: 1 });
    await registry.reserve("c1", "192.0.2.1", ceiling);
    await registry.reserve("c2", "192.0.2.1", ceiling);
    await registry.reserve("c3", "192.0.2.2", ceiling);
    await registry.paired("c3");
    await registry.reserve("c4", "192.0.2.3", ceiling);
    const result = await registry.stats();
    expect(result.channels).toBe(1);
    expect(result.pending).toBe(0);
    expect(result.days).toEqual([
      {
        day: new Date().toISOString().slice(0, 10),
        registered: 2,
        paired: 1,
        evicted: 1,
        refusedPending: 1,
        refusedDaily: 0,
        refusedCeiling: 1,
      },
    ]);
  });

  it("keeps counting the channels of a registry from before sources existed", async () => {
    const name = `test-${crypto.randomUUID()}`;
    const id = env.REGISTRY.idFromName(name);
    // The first release's schema, with one live channel in it.
    await runInDurableObject(env.REGISTRY.get(id), (_: Registry, state) => {
      const { sql } = state.storage;
      sql.exec("DROP TABLE channels");
      sql.exec("DROP TABLE total");
      sql.exec("CREATE TABLE channels (id TEXT PRIMARY KEY)");
      sql.exec(
        "CREATE TABLE total (one INTEGER PRIMARY KEY CHECK (one = 1), count INTEGER NOT NULL)",
      );
      sql.exec("INSERT INTO channels (id) VALUES ('legacy')");
      sql.exec("INSERT INTO total (one, count) VALUES (1, 1)");
    });
    await evictDurableObject(env.REGISTRY.get(id));
    const registry = env.REGISTRY.get(id);
    const ceiling = limits({ maxChannels: 1 });
    // Counted as paired: never pushed out.
    expect(await registry.reserve("c1", "192.0.2.1", ceiling)).toBe("refused");
    expect(await registry.paired("legacy")).toBe(true);
    await registry.release("legacy");
    expect(await registry.count()).toBe(0);
  });
});

describe("registration flood", { timeout: 60_000 }, () => {
  it("never drops a paired channel and never fills the ceiling with unpaired ones", async () => {
    const pairedOne = await register();
    const appToken = await confirmPairing(pairedOne);
    const host = await connect(pairedOne.channel, "host", pairedOne.hostToken);
    const app = await connect(pairedOne.channel, "app", appToken);
    await waitForText(host, peer(true));
    const waiting = await register();

    const before = await stats();
    const ceiling = before.channels;
    // More than every unpaired channel there is, so the one waiting above is pushed out too.
    const flood = before.pending + 5;
    const post = relayWith({ MAX_CHANNELS: String(ceiling) });
    const statuses: number[] = [];
    for (let i = 0; i < flood; i += 1) {
      const response = await post(
        new Request("https://relay.test/v1/channels", {
          method: "POST",
          headers: { "CF-Connecting-IP": newAddress() },
          body: await registerBody(),
        }),
      );
      statuses.push(response.status);
    }
    // Every flood registration got in by pushing out an older unpaired one.
    expect(statuses.every((status) => status === 201)).toBe(true);
    const after = await stats();
    expect(after.channels).toBe(ceiling);
    expect(after.pending).toBeLessThanOrEqual(flood);
    expect(after.days[0]?.evicted).toBeGreaterThanOrEqual(flood);

    // The paired channel kept its sockets and still takes new ones.
    app.ws.send(new Uint8Array([7]));
    await vi.waitFor(() => expect(host.binaries).toEqual([new Uint8Array([7])]));
    expect(app.closed).toBeNull();
    expect((await upgrade(pairedOne.channel, "app", appToken)).status).toBe(101);

    // The unpaired channel registered before the flood was pushed out: it cannot pair, and goes.
    const refused = await call(`/v1/channels/${waiting.channel}/app`, {
      method: "PUT",
      token: waiting.hostToken,
      body: JSON.stringify({ appVerifier: await relayVerifier(relayCrypto, token()) }),
    });
    expect(refused.status).toBe(404);
    const record = await runInDurableObject(channelStub(waiting.channel), (_, state) =>
      state.storage.get("record"),
    );
    expect(record).toBeUndefined();
  });

  it("refuses the eleventh unpaired channel from one address, and one in the same /64", async () => {
    const address = newAddress();
    for (let i = 0; i < settings(env).pendingPerSource; i += 1) await register({ address });
    const refused = await call("/v1/channels", {
      method: "POST",
      address,
      body: await registerBody(),
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    await register();

    const prefix = `2001:db8:${(Date.now() % 0xffff).toString(16)}:1`;
    for (let i = 0; i < settings(env).pendingPerSource; i += 1) {
      await register({ address: `${prefix}::${i + 1}` });
    }
    const sameNetwork = await call("/v1/channels", {
      method: "POST",
      address: `${prefix}:ffff::1`,
      body: await registerBody(),
    });
    expect(sameNetwork.status).toBe(429);
  });
});

describe("counters", () => {
  const get = (fetch: (request: Request) => Promise<Response>, bearer?: string) =>
    fetch(
      new Request("https://relay.test/admin/stats", {
        headers: {
          "CF-Connecting-IP": newAddress(),
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
      }),
    );

  it("answers 404 when no admin token is set, or one too short to trust", async () => {
    expect((await call("/admin/stats")).status).toBe(404);
    expect((await call("/admin/stats", { token: ADMIN })).status).toBe(404);
    const short = relayWith({ ADMIN_TOKEN: "short" });
    expect((await get(short, "short")).status).toBe(404);
  });

  it("answers the operator only, with counts and no address", async () => {
    const address = newAddress();
    await register({ address });
    const relay = relayWith({ ADMIN_TOKEN: ADMIN });
    expect((await get(relay)).status).toBe(404);
    expect((await get(relay, `${ADMIN}x`)).status).toBe(404);
    expect((await get(relay, "b".repeat(40))).status).toBe(404);
    const response = await get(relay, ADMIN);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain(address);
    const body = JSON.parse(text) as { channels: number; pending: number; days: unknown[] };
    expect(body.channels).toBeGreaterThan(0);
    expect(body.pending).toBeGreaterThan(0);
    expect(Object.keys(body.days[0] as object).sort()).toEqual(
      [
        "day",
        "evicted",
        "paired",
        "refusedCeiling",
        "refusedDaily",
        "refusedPending",
        "registered",
      ].sort(),
    );
  });
});
