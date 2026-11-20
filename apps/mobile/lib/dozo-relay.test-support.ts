import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  RelayConnect,
  RelayDuplex,
  RelayHostChannel,
  RelayHostEvent,
  RelayHostStore,
  RelayKeyPair,
  RelayReceiver,
} from "@rakazo/core";
import { pairRelayHost, runRelayHost, webRelayCrypto } from "@rakazo/core";
import type { RelayDeps } from "./dozo-relay-connection";
import { nobleRelayCrypto } from "./dozo-relay-crypto";
import { relayWebTypes } from "./dozo-relay-web";

type DevRelay = { url: string; port: number; state: unknown; close(): Promise<void> };
type Adapters = {
  startDevRelay(options?: { port?: number; state?: unknown }): Promise<DevRelay>;
  connectRelaySocket: RelayConnect;
};

/**
 * The reference relay and the computer's socket come from `@rakazo/adapters`, which the app does
 * not depend on. Loaded by path at run time, so the app's type check stays inside the app.
 */
async function adapters(): Promise<Adapters> {
  const base = "../../../packages/adapters/src/";
  const [relay, agent] = await Promise.all([
    import(/* @vite-ignore */ `${base}dozo-relay-dev-relay`),
    import(/* @vite-ignore */ `${base}dozo-relay-agent`),
  ]);
  return { startDevRelay: relay.startDevRelay, connectRelaySocket: agent.connectRelaySocket };
}

/** Two connected duplexes, as two ends of a relay socket would be; both attach at once. */
export function duplexPair(): { app: RelayDuplex; host: RelayDuplex } {
  const receivers: RelayReceiver[] = [];
  const end = (self: number): RelayDuplex => ({
    send: (data) => queueMicrotask(() => receivers[1 - self]?.receive(data)),
    close: () => undefined,
    attach: (receiver) => {
      receivers[self] = receiver;
    },
  });
  return { app: end(0), host: end(1) };
}

/**
 * The whole path in one process: the reference relay in memory, the computer's end (WebCrypto)
 * forwarding to a loopback server, and the phone's dependencies (`@noble`, the phone's own
 * `Request` and `Response`, Node's socket where the phone has React Native's).
 */

/** The user's server on loopback: health, an echo, a JSON answer, a slow answer and live events. */
export async function loopbackServer() {
  const events = new Set<(line: string) => void>();
  let healthy = true;
  const server = createServer((request, response) => {
    const url = new URL(String(request.url), "http://localhost");
    if (url.pathname === "/rpc/health") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ json: { ok: healthy } }));
      return;
    }
    if (url.pathname === "/echo") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.setHeader("x-method", String(request.method));
        response.setHeader("x-type", String(request.headers["content-type"]));
        response.end(Buffer.concat(chunks));
      });
      return;
    }
    if (url.pathname === "/big") {
      response.end(Buffer.alloc(Number(url.searchParams.get("n")), 7));
      return;
    }
    if (url.pathname === "/hang") return;
    if (url.pathname === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      const send = (line: string) => response.write(`data: ${line}\n\n`);
      events.add(send);
      request.on("close", () => events.delete(send));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    /** Listeners on the live event stream right now. */
    listeners: () => events.size,
    emit: (line: string) => {
      for (const send of events) send(line);
    },
    setHealthy: (value: boolean) => {
      healthy = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function memoryHostStore(): RelayHostStore & { channels: Map<string, RelayHostChannel> } {
  const channels = new Map<string, RelayHostChannel>();
  // One promise, so the computer and an offer made while it starts never make two keys.
  let key: Promise<RelayKeyPair> | null = null;
  const listeners = new Set<() => void>();
  return {
    channels,
    hostKey(create) {
      key ??= create();
      return key;
    },
    list: async () => [...channels.values()].map((entry) => structuredClone(entry)),
    async put(entry) {
      channels.set(entry.channel, structuredClone(entry));
      for (const listener of listeners) listener();
    },
    async remove(channel) {
      channels.delete(channel);
      for (const listener of listeners) listener();
    },
    watch(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
}

export async function relayWorld() {
  const { startDevRelay, connectRelaySocket } = await adapters();
  const local = await loopbackServer();
  let relay = await startDevRelay();
  const relayState = relay.state;
  const store = memoryHostStore();
  const crypto = webRelayCrypto();
  const events: RelayHostEvent[] = [];
  let host: { stop(): Promise<void> } | null = null;

  const world = {
    local,
    store,
    events,
    get relayUrl() {
      return relay.url;
    },
    /** A pairing offer from the computer, as the QR code's link. */
    async offer(now?: () => number) {
      const made = await pairRelayHost({ store, crypto, relay: relay.url, now });
      return `rakazo://dozo-pair#${made.offer}`;
    },
    startHost() {
      const controller = new AbortController();
      const done = runRelayHost({
        store,
        crypto,
        origin: local.origin,
        connect: connectRelaySocket,
        random: () => 0,
        onEvent: (event) => events.push(event),
        signal: controller.signal,
      });
      host = {
        stop: async () => {
          controller.abort();
          await done;
        },
      };
      return host;
    },
    async stopHost() {
      await host?.stop();
      host = null;
    },
    /** Restarts the relay on the same port and state: every socket drops. */
    async restartRelay() {
      const port = relay.port;
      await relay.close();
      relay = await startDevRelay({ port, state: relayState });
    },
    deps(overrides: Partial<RelayDeps> = {}): RelayDeps {
      return {
        crypto: nobleRelayCrypto((length) => new Uint8Array(randomBytes(length))),
        connect: connectRelaySocket,
        web: relayWebTypes,
        ...overrides,
      };
    },
    async close() {
      await world.stopHost();
      await relay.close();
      await local.close();
    },
  };
  return world;
}
