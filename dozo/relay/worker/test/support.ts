import { env, exports } from "cloudflare:workers";
import {
  encodeRelayBytes,
  relayVerifier,
  webRelayCrypto,
} from "@dozo/relay-core/dozo-relay-channel";
import { vi } from "vitest";

export const relayCrypto = webRelayCrypto();
const BASE = "https://relay.test";

let addresses = 0;
/** A fresh client address per test, so the per-address limits of one test never meet another. */
export function newAddress() {
  addresses += 1;
  return `192.0.2.${addresses}`;
}

export function token() {
  return encodeRelayBytes(relayCrypto.randomBytes(32));
}

export function call(path: string, init: RequestInit & { token?: string; address?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", init.address ?? newAddress());
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

export type Registered = {
  channel: string;
  hostToken: string;
  pairToken: string;
  pairExpiresAt: number;
  address: string;
};

export async function register(
  options: { address?: string; pairExpiresAt?: number; pairToken?: string } = {},
): Promise<Registered> {
  const hostToken = token();
  const pairToken = options.pairToken ?? token();
  const pairExpiresAt = options.pairExpiresAt ?? Date.now() + 10 * 60 * 1000;
  const address = options.address ?? newAddress();
  const response = await call("/v1/channels", {
    method: "POST",
    address,
    body: JSON.stringify({
      hostVerifier: await relayVerifier(relayCrypto, hostToken),
      pairVerifier: await relayVerifier(relayCrypto, pairToken),
      pairExpiresAt,
    }),
  });
  if (response.status !== 201) throw new Error(`register answered ${response.status}`);
  const { channel } = (await response.json()) as { channel: string };
  return { channel, hostToken, pairToken, pairExpiresAt, address };
}

/** Sets the phone's verifier as the host does once pairing completed; returns the app token. */
export async function confirmPairing(registered: Registered) {
  const appToken = token();
  const response = await call(`/v1/channels/${registered.channel}/app`, {
    method: "PUT",
    token: registered.hostToken,
    body: JSON.stringify({ appVerifier: await relayVerifier(relayCrypto, appToken) }),
  });
  if (response.status !== 204) throw new Error(`pairing answered ${response.status}`);
  return appToken;
}

export function upgrade(channel: string, role: "host" | "app", bearer: string, address?: string) {
  return call(`/v1/channels/${channel}/${role}`, {
    token: bearer,
    address,
    headers: { Upgrade: "websocket" },
  });
}

/** A client socket with everything it received, in order. */
export type Socket = {
  ws: WebSocket;
  texts: string[];
  binaries: Uint8Array[];
  closed: { code: number; reason: string } | null;
};

export async function connect(
  channel: string,
  role: "host" | "app",
  bearer: string,
  address?: string,
): Promise<Socket> {
  const response = await upgrade(channel, role, bearer, address);
  const ws = response.webSocket;
  if (response.status !== 101 || !ws) throw new Error(`connect answered ${response.status}`);
  const socket: Socket = { ws, texts: [], binaries: [], closed: null };
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") socket.texts.push(event.data);
    else socket.binaries.push(new Uint8Array((event.data as ArrayBuffer).slice(0)));
  });
  ws.addEventListener("close", (event) => {
    socket.closed = { code: event.code, reason: event.reason };
  });
  // Binary arrives as ArrayBuffer, as the ends ask for; the runtime default is Blob.
  ws.binaryType = "arraybuffer";
  ws.accept();
  return socket;
}

export const peer = (present: boolean) => JSON.stringify({ type: "peer", present });

export async function waitForText(socket: Socket, text: string, count = 1) {
  await vi.waitFor(() => {
    if (socket.texts.filter((t) => t === text).length < count) {
      throw new Error(`waiting for ${count} x ${text}, got ${JSON.stringify(socket.texts)}`);
    }
  });
}

export async function waitForClose(socket: Socket) {
  await vi.waitFor(() => {
    if (!socket.closed) throw new Error("socket still open");
  });
  return socket.closed!;
}

export function channelStub(channel: string) {
  return env.CHANNELS.get(env.CHANNELS.idFromName(channel));
}

export function registryStub() {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}
