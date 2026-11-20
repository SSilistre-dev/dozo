import type { RelayWebSocket } from "@rakazo/core";
import { RelayHttpError } from "@rakazo/core";
import { getRandomBytes } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type {
  RelayConnection,
  RelayDeps,
  RelayPairing,
  RelayPairingStore,
} from "./dozo-relay-connection";
import { isRelayOrigin, pairedConnection, RelayUnreachableError } from "./dozo-relay-connection";
import { nobleRelayCrypto } from "./dozo-relay-crypto";
import { relayWebTypes } from "./dozo-relay-web";

/**
 * Routes the app's requests to a paired computer through the relay. The app reaches a computer as
 * a server address of its own (`relayOrigin`); `fetch` for that origin goes through the computer's
 * relay connection, every other request is untouched. Imported once, first, by the root layout,
 * so each caller's `fetch`, read when it runs, is this one.
 */

const PAIRING_KEY = "dozo.relay_pairing";

export const relayPairingStore: RelayPairingStore = {
  async load() {
    const stored = await SecureStore.getItemAsync(PAIRING_KEY);
    if (!stored) return null;
    try {
      return JSON.parse(stored) as RelayPairing;
    } catch {
      return null;
    }
  },
  save: (pairing) => SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(pairing)),
  clear: () => SecureStore.deleteItemAsync(PAIRING_KEY),
};

type NativeWebSocket = new (
  url: string,
  protocols: string[] | undefined,
  options: { headers: Record<string, string> },
) => RelayWebSocket & {
  onopen: (() => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
};

/**
 * The status of a refused upgrade, from the message React Native's socket gives: iOS says "bad
 * response code from server: 404", Android "Expected HTTP 101 response but was '404 Not Found'".
 */
export function upgradeStatus(message = "") {
  const match = /(?:response code from server:?|but was ')\s*(\d{3})/i.exec(message);
  return match ? Number(match[1]) : null;
}

/** Opens a relay socket with the token in the upgrade's header, as React Native's socket can. */
export function connectNativeRelaySocket(
  url: string,
  token: string,
  signal: AbortSignal,
): Promise<RelayWebSocket> {
  const Socket = globalThis.WebSocket as unknown as NativeWebSocket;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const socket = new Socket(url, undefined, { headers: { Authorization: `Bearer ${token}` } });
    socket.binaryType = "arraybuffer";
    const settle = () => {
      socket.onopen = socket.onerror = socket.onclose = null;
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      settle();
      socket.close();
      reject(error);
    };
    const onAbort = () => fail(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    socket.onopen = () => {
      settle();
      resolve(socket);
    };
    socket.onerror = (event) => {
      const status = upgradeStatus(event.message);
      fail(
        status
          ? new RelayHttpError(status)
          : new RelayUnreachableError(event.message ?? "socket error"),
      );
    };
    socket.onclose = (event) => fail(new RelayUnreachableError(event.reason || "socket closed"));
  });
}

export const relayDeps: RelayDeps = {
  crypto: nobleRelayCrypto((length) => getRandomBytes(length)),
  connect: connectNativeRelaySocket,
  web: relayWebTypes,
};

const connections = new Map<string, RelayConnection>();
let restored: Promise<void> | null = null;

/** The stored pairing's connection, made on the first request for it. */
function restore(store: RelayPairingStore, deps: RelayDeps) {
  restored ??= store.load().then(
    (pairing) => {
      if (!pairing) return;
      const connection = pairedConnection(deps, pairing);
      if (!connections.has(connection.origin)) adoptRelayConnection(connection, store);
    },
    () => undefined,
  );
  return restored;
}

/** Serves a connection's origin; when the computer removes this phone, the pairing is forgotten. */
export function adoptRelayConnection(
  connection: RelayConnection,
  store: RelayPairingStore = relayPairingStore,
) {
  connection.onGone = () => {
    connections.delete(connection.origin);
    connection.close();
    void store.clear();
  };
  connections.set(connection.origin, connection);
}

/** Closes every connection but the one for `origin`, once the app has switched to it. */
export function keepOnlyRelayConnection(origin: string) {
  for (const [key, connection] of connections) {
    if (key === origin) continue;
    connections.delete(key);
    connection.close();
  }
}

function originOf(input: RequestInfo | URL) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Puts the relay in front of `target.fetch` for paired computers' origins. */
export function installRelayFetch(
  target: { fetch: typeof fetch },
  store: RelayPairingStore = relayPairingStore,
  deps: RelayDeps = relayDeps,
) {
  const base = target.fetch;
  target.fetch = async (input, init) => {
    const origin = originOf(input);
    if (!origin || !isRelayOrigin(origin)) return base(input, init);
    await restore(store, deps);
    const connection = connections.get(origin);
    if (!connection) throw new RelayUnreachableError("this computer is not paired");
    return connection.fetch(input, init);
  };
}

/** For tests: forget every connection and the restored pairing. */
export function resetRelayConnections() {
  for (const connection of connections.values()) connection.close();
  connections.clear();
  restored = null;
}
