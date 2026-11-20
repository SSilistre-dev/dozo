import { RelayAppPairingSchema } from "@rakazo/contracts";
import type { RelayWebSocket } from "@rakazo/core";
import { decodeRelayBytes, RelayHttpError, relayApprovalCode } from "@rakazo/core";
import { getRandomValues } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type {
  RelayConnection,
  RelayDeps,
  RelayPairing,
  RelayPairingStore,
} from "./dozo-relay-connection";
import {
  isRelayOrigin,
  pairedConnection,
  RELAY_HOST_SUFFIX,
  RelayUnreachableError,
} from "./dozo-relay-connection";
import { nobleRelayCrypto } from "./dozo-relay-crypto";
import { relayWebTypes } from "./dozo-relay-web";

/**
 * Routes the app's requests to a paired computer through the relay. The app reaches a computer as
 * a server address of its own (`relayOrigin`); `fetch` for that origin goes through the computer's
 * relay connection, every other request is untouched. Imported once, first, by the root layout,
 * so each caller's `fetch`, read when it runs, is this one.
 */

const PAIRING_KEY = "dozo.relay_pairing";

/**
 * The relay this build pairs through without naming it to the user. An offer that names any
 * other relay is still accepted, but the question before pairing says which.
 */
export const DEFAULT_RELAY = process.env.EXPO_PUBLIC_DOZO_RELAY_URL ?? "https://relay.dozo.bot";

/** A stored value that is not a whole pairing counts as none: nothing is guessed from it. */
function storedPairing(stored: string | null): RelayPairing | null {
  if (!stored) return null;
  let json: unknown;
  try {
    json = JSON.parse(stored);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = RelayAppPairingSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export const relayPairingStore: RelayPairingStore = {
  load: async () => storedPairing(await SecureStore.getItemAsync(PAIRING_KEY)),
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
  // The system's source every time: expo-crypto's getRandomBytes falls back to Math.random under a
  // development debugger, getRandomValues never does.
  crypto: nobleRelayCrypto((length) => getRandomValues(new Uint8Array(length))),
  connect: connectNativeRelaySocket,
  web: relayWebTypes,
};

const connections = new Map<string, RelayConnection>();
let restored: Promise<void> | null = null;
/** Computers that removed this phone, until it pairs again. */
const gone = new Set<string>();
const goneListeners = new Set<() => void>();

export function isRelayGone(origin: string) {
  return gone.has(origin);
}

export function subscribeRelayGone(listener: () => void) {
  goneListeners.add(listener);
  return () => {
    goneListeners.delete(listener);
  };
}

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

/**
 * Serves a connection's origin. When the computer removes this phone, the connection ends and the
 * stored pairing goes too, but only if it is this computer's: a newer pairing stays.
 */
export function adoptRelayConnection(
  connection: RelayConnection,
  store: RelayPairingStore = relayPairingStore,
) {
  connection.onGone = () => {
    forgetRelayConnection(connection.origin);
    gone.add(connection.origin);
    for (const listener of [...goneListeners]) listener();
    void store.load().then((stored) => {
      if (stored?.channel === connection.channel) return store.clear();
    });
  };
  gone.delete(connection.origin);
  connections.set(connection.origin, connection);
}

/** Ends a connection the app no longer uses, such as one whose server switch failed. */
export function forgetRelayConnection(origin: string) {
  connections.get(origin)?.close();
  connections.delete(origin);
}

/** Closes every connection but the one for `origin`, once the app has switched to it. */
export function keepOnlyRelayConnection(origin: string) {
  for (const [key, connection] of connections) {
    if (key === origin) continue;
    connections.delete(key);
    connection.close();
  }
}

/**
 * The computer address a request is for, or null for any other address. A computer's name with a
 * port, a user or plain http is no address the app uses: it fails here rather than reach DNS.
 */
function computerOrigin(input: RequestInfo | URL) {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let url: URL;
  try {
    url = new URL(href);
  } catch (error) {
    // Not an absolute address: the platform's fetch answers it as it always has.
    if (error instanceof TypeError) return null;
    throw error;
  }
  if (!url.hostname.endsWith(RELAY_HOST_SUFFIX)) return null;
  const origin = `https://${url.hostname}`;
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !isRelayOrigin(origin)
  ) {
    throw new RelayUnreachableError("not a computer's address");
  }
  return origin;
}

/** The six digits the computer shows while the user approves this phone, or null if unpaired. */
export async function relayApprovalCodeOf(
  origin: string,
  store: RelayPairingStore = relayPairingStore,
  deps: RelayDeps = relayDeps,
) {
  await restore(store, deps);
  const pairing = connections.get(origin)?.pairing();
  return pairing ? relayApprovalCode(deps.crypto, decodeRelayBytes(pairing.pairingKey)) : null;
}

/** Puts the relay in front of `target.fetch` for paired computers' origins. */
export function installRelayFetch(
  target: { fetch: typeof fetch },
  store: RelayPairingStore = relayPairingStore,
  deps: RelayDeps = relayDeps,
) {
  const base = target.fetch;
  target.fetch = async (input, init) => {
    const origin = computerOrigin(input);
    if (!origin) return base(input, init);
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
  gone.clear();
  restored = null;
}
