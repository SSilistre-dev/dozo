import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
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
import { pairRelayHost, revokeRelayChannel, runRelayHost, webRelayCrypto } from "@rakazo/core";
import type { RelayDeps } from "./dozo-relay-connection";
import { nobleRelayCrypto } from "./dozo-relay-crypto";
import { relayWebTypes } from "./dozo-relay-web";

type DevRelay = {
  url: string;
  port: number;
  state: unknown;
  seen: Uint8Array[];
  close(): Promise<void>;
};
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

/** The session a phone signed in with; the stand-in chat answers no other. */
export const CHAT_SESSION = "session-token-the-relay-must-not-see";

type ChatMessage = { id: number; text: string; attachments: { name: string; sha256: string }[] };

/**
 * The chat's core requests as the stand-in serves them: read the chats, send a message with its
 * attachments inside the JSON body, and a live stream that signals once on every (re)connect and
 * then on each change, without content, as `notifications.subscribe` does.
 */
function chatRoutes() {
  const messages: ChatMessage[] = [];
  const signals = new Set<() => void>();
  const changed = () => {
    for (const signal of signals) signal();
  };
  const json = (response: ServerResponse, value: unknown) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ json: value }));
  };
  const add = (text: string, attachments: ChatMessage["attachments"]) => {
    const message = { id: messages.length + 1, text, attachments };
    messages.push(message);
    changed();
    return message;
  };
  return {
    messages,
    /** A message the computer adds on its own, as a bot's answer. */
    reply: (text: string) => add(text, []),
    listeners: () => signals.size,
    handle(path: string, request: IncomingMessage, response: ServerResponse) {
      if (request.headers.authorization !== `Bearer ${CHAT_SESSION}`) {
        response.statusCode = 401;
        return response.end();
      }
      if (path === "subscribe") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const signal = () => response.write('data: {"type":"chats"}\n\n');
        signals.add(signal);
        request.on("close", () => signals.delete(signal));
        return signal();
      }
      if (path === "list") return json(response, { messages });
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const { json: body } = JSON.parse(Buffer.concat(chunks).toString()) as {
          json: { text: string; attachments: { name: string; contentBase64: string }[] };
        };
        const attachments = body.attachments.map((file) => ({
          name: file.name,
          sha256: createHash("sha256")
            .update(Buffer.from(file.contentBase64, "base64"))
            .digest("hex"),
        }));
        json(response, add(body.text, attachments));
      });
    },
  };
}

/** The user's server on loopback: health, an echo, a JSON answer, a slow answer and live events. */
export async function loopbackServer() {
  const events = new Set<(line: string) => void>();
  const chat = chatRoutes();
  let healthy = true;
  const server = createServer((request, response) => {
    const url = new URL(String(request.url), "http://localhost");
    if (url.pathname.startsWith("/rpc/chat/")) {
      return chat.handle(url.pathname.slice("/rpc/chat/".length), request, response);
    }
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
    if (url.pathname === "/moved" || url.pathname === "/loop") {
      // `to` is where it points (`/loop` points at itself); `status` overrides the 302.
      const to = url.pathname === "/loop" ? "/loop" : url.searchParams.get("to");
      response.writeHead(Number(url.searchParams.get("status") ?? 302), to ? { location: to } : {});
      response.end("moved");
      return;
    }
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
    chat,
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
  const approvals = new Map<string, number>();
  // One promise, so the computer and an offer made while it starts never make two keys.
  let key: Promise<RelayKeyPair> | null = null;
  const listeners = new Set<() => void>();
  return {
    channels,
    hostKey(create) {
      key ??= create();
      return key;
    },
    // An approval kept apart from the channel, as the file store keeps it.
    list: async () =>
      [...channels.values()].map((entry) => {
        const copy = structuredClone(entry);
        if (copy.app && !copy.app.approvedAt) {
          copy.app.approvedAt = approvals.get(copy.channel) ?? copy.app.approvedAt;
        }
        return copy;
      }),
    async put(entry) {
      channels.set(entry.channel, structuredClone(entry));
      for (const listener of listeners) listener();
    },
    async approve(channel, approvedAt) {
      approvals.set(channel, approvedAt);
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
  const earlier: Uint8Array[] = [];

  const world = {
    local,
    store,
    events,
    get relayUrl() {
      return relay.url;
    },
    /** Every binary message the relay forwarded, across its restarts. */
    wire: () => Buffer.concat([...earlier, ...relay.seen]),
    /** What the relay keeps about its channels. */
    relayState: relayState as Map<string, Record<string, unknown>>,
    /** Removes a phone as the computer's Connect Phone window does. */
    revoke: (channel: string) => revokeRelayChannel({ store, crypto, channel }),
    /** A pairing offer from the computer, as the QR code's link. */
    async offer(now?: () => number) {
      const made = await pairRelayHost({ store, crypto, relay: relay.url, now });
      return `dozo://pair#${made.offer}`;
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
      earlier.push(...relay.seen);
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
