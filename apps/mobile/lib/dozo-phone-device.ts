import {
  USER_DEVICE_CONNECT_PATH,
  USER_DEVICE_PAIR_PATH,
  USER_DEVICE_PATH,
} from "@rakazo/contracts";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { AppState, Platform } from "react-native";
import {
  captureApiRequestContext,
  currentApiBase,
  fetchMobileJson,
  rpc,
  subscribeApiBase,
} from "./api";
import { isForegroundState } from "./app-foreground";
import type {
  PhoneCalendarRequest,
  PhoneCalendarValue,
  PhonePermission,
} from "./dozo-phone-calendar";
import {
  calendarAvailable,
  calendarPermission,
  PhoneReadError,
  readCalendar,
  requestCalendarPermission,
} from "./dozo-phone-calendar";
import type { PhoneContactsRequest, PhoneContactsValue } from "./dozo-phone-contacts";
import {
  contactsAvailable,
  contactsPermission,
  requestContactsPermission,
  searchContacts,
} from "./dozo-phone-contacts";
import type { Later, PhoneLocationRequest, PhoneLocationValue } from "./dozo-phone-location";
import {
  locationAvailable,
  locationPermission,
  readLocation,
  requestLocationPermission,
} from "./dozo-phone-location";
import { isRelayOrigin } from "./dozo-relay-connection";
import { reportMobileError } from "./monitoring";
import { serverHeaders } from "./server-headers";
import { currentSessionGeneration, loadSessionToken, subscribeSessionGeneration } from "./session";

/**
 * The phone as a paired device of its account (wire contract: the paired-computer connection,
 * with phone requests). It pairs once a kind of data is switched on, keeps one WebSocket open
 * while the app is in the foreground and signed in to a direct server, and answers the server's
 * requests from the phone's own data. It never connects to a paired computer over the relay, which
 * carries no WebSocket. What each kind declares is sent on connecting, so the server offers only
 * what is switched on and allowed by the system.
 */

export const PHONE_CAPABILITIES_HEADER = "x-dozo-device-capabilities";
export const MAX_MESSAGE_BYTES = 1024 * 1024;
const UNSUPPORTED = "Not supported on this phone";
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;
/** A connection that lasted this long starts the backoff over when it drops. */
const STABLE_MS = 30_000;

/** The kinds of the phone's data a bot may read, in the order the phone declares them. */
const PHONE_KINDS = ["calendar", "contacts", "location"] as const;
export type PhoneKind = (typeof PHONE_KINDS)[number];
type Switches = Record<PhoneKind, boolean>;
const ALL_OFF: Switches = { calendar: false, contacts: false, location: false };

type Paired = { deviceId: string; token: string };
/** What the phone keeps per server and account; each kind is off until switched on here. */
type Saved = Switches & { device?: Paired };
export type PhoneAccount = { origin: string; userId: string };
export type PhonePlatform = "ios" | "android";
type Frame = { value: unknown } | { done: true } | { error: string };

export type PhoneSocket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data?: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
};

export type PhoneDeviceDeps = {
  /** The signed-in account on the current server; null when signed out. Throws when it cannot tell. */
  account(): Promise<PhoneAccount | null>;
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  pair(
    origin: string,
    device: { name: string; platform: PhonePlatform },
  ): Promise<{ deviceId: string; userId: string; token: string }>;
  unpair(origin: string, token: string): Promise<void>;
  connect(url: string, headers: Record<string, string>): PhoneSocket;
  calendar: PhoneReader<PhoneCalendarRequest, PhoneCalendarValue>;
  contacts: PhoneReader<PhoneContactsRequest, PhoneContactsValue>;
  location: PhoneReader<PhoneLocationRequest, PhoneLocationValue>;
  foreground(): boolean;
  /** Calls back when the app's state, server or session changes. */
  watch(listener: () => void): () => void;
  device(): { name: string; platform: PhonePlatform } | null;
  now(): number;
  later(run: () => void, ms: number): () => void;
  random(): number;
  report(error: unknown): void;
};

/** One kind of the phone's data: its native module, the system's permission and its read. */
export type PhoneReader<Request, Value> = {
  available(): boolean;
  permission(): Promise<PhonePermission>;
  request(): Promise<PhonePermission>;
  read(request: Request): Promise<Value>;
};

export type PhoneSettings = { ready: boolean } & Switches;
export type PhoneSwitchResult = "done" | "denied" | "unavailable";

/** A SecureStore key: letters, digits, `.`, `-` and `_` only, so the rest is written as `_hex_`. */
export function phoneStorageKey(account: PhoneAccount): string {
  const safe = (text: string) =>
    text.replace(/[^A-Za-z0-9.-]/g, (char) => `_${char.charCodeAt(0).toString(16)}_`);
  return `dozo.phone.${safe(account.origin)}.${safe(account.userId)}`;
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code < 0xdc00 ? 4 : 3;
    if (code >= 0xd800 && code < 0xdc00) index++;
  }
  return bytes;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && id.length <= 64;

const anyOn = (switches: Switches) => PHONE_KINDS.some((kind) => switches[kind]);

function readSaved(text: string | null): Saved {
  if (!text) return { ...ALL_OFF };
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return { ...ALL_OFF };
    const device = value.device;
    const paired =
      isRecord(device) && typeof device.deviceId === "string" && typeof device.token === "string"
        ? { deviceId: device.deviceId, token: device.token }
        : undefined;
    const saved: Saved = { ...ALL_OFF, ...(paired ? { device: paired } : {}) };
    for (const kind of PHONE_KINDS) saved[kind] = value[kind] === true && Boolean(paired);
    return saved;
  } catch {
    return { ...ALL_OFF };
  }
}

function socketUrl(origin: string): string {
  const url = new URL(USER_DEVICE_CONNECT_PATH, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

type Method = { kind: PhoneKind; read(request: Record<string, unknown>): Promise<unknown> };

type Connection = {
  socket: PhoneSocket;
  key: string;
  token: string;
  capabilities: string;
  origin: string;
  openedAt: number | null;
};

export function createPhoneDevice(deps: PhoneDeviceDeps) {
  let started = false;
  let account: PhoneAccount | null = null;
  let saved: { key: string; value: Saved } | null = null;
  let connection: Connection | null = null;
  let cancelRetry: (() => void) | null = null;
  let attempt = 0;
  const calls = new Map<string, { cancelled: boolean }>();
  const listeners = new Set<() => void>();
  let settings: PhoneSettings = { ready: false, ...ALL_OFF };
  let queue: Promise<unknown> = Promise.resolve();

  function publish() {
    const next: PhoneSettings = { ready: Boolean(account && saved), ...ALL_OFF };
    for (const kind of PHONE_KINDS) next[kind] = Boolean(saved?.value[kind]);
    if ((["ready", ...PHONE_KINDS] as const).every((name) => next[name] === settings[name])) return;
    settings = next;
    for (const listener of [...listeners]) listener();
  }

  /** One change at a time, so a switch and a reconnect never interleave their reads and writes. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  function stopRetry() {
    cancelRetry?.();
    cancelRetry = null;
  }

  function cancelCalls() {
    for (const call of calls.values()) call.cancelled = true;
    calls.clear();
  }

  function close() {
    stopRetry();
    const open = connection;
    connection = null;
    cancelCalls();
    open?.socket.close();
  }

  function retry() {
    if (!started || cancelRetry || !deps.foreground()) return;
    const ceiling = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(attempt, 16));
    attempt += 1;
    // Full jitter keeps many phones from reconnecting in step after a server restart.
    const delay = ceiling / 2 + (ceiling / 2) * deps.random();
    cancelRetry = deps.later(() => {
      cancelRetry = null;
      void sync();
    }, delay);
  }

  /** Forgets a pairing the server ended, unless the phone has paired again since. */
  async function forget(key: string, token: string) {
    if (saved?.key === key && saved.value.device && saved.value.device.token !== token) return;
    if (connection?.token === token) close();
    if (saved?.key === key) saved = { key, value: { ...ALL_OFF } };
    publish();
    await deps.remove(key);
  }

  function lost(entry: Connection) {
    if (connection !== entry) return;
    connection = null;
    cancelCalls();
    entry.socket.close();
    if (entry.openedAt !== null && deps.now() - entry.openedAt >= STABLE_MS) attempt = 0;
    // A connection that never opened (a proxy, a deploy, the network) keeps its pairing and tries
    // again later: only a `revoked` message or the switch turned off forgets the token.
    retry();
  }

  type Call = { cancelled: boolean };

  function reply(entry: Connection, id: string, call: Call, frame: Frame) {
    if (call.cancelled || connection !== entry) return;
    entry.socket.send(JSON.stringify({ type: "frame", id, frame }));
  }

  function finish(id: string, call: Call) {
    if (calls.get(id) === call) calls.delete(id);
  }

  /** Each request method: its kind, and its read; a request it cannot read throws its code. */
  const METHODS = new Map<string, Method>([
    [
      "phoneCalendarRead",
      {
        kind: "calendar",
        read: (request) =>
          deps.calendar.read({
            from: String(request.from),
            to: String(request.to),
            ...(typeof request.query === "string" ? { query: request.query } : {}),
            limit: typeof request.limit === "number" ? request.limit : 50,
          }),
      },
    ],
    [
      "phoneContactsSearch",
      {
        kind: "contacts",
        read: ({ query, field, limit }) => {
          if (typeof query !== "string" || (field !== "phone" && field !== "email")) {
            throw new PhoneReadError("contacts-query");
          }
          return deps.contacts.read({
            query,
            field,
            limit: typeof limit === "number" ? limit : 10,
          });
        },
      },
    ],
    [
      "phoneLocation",
      {
        kind: "location",
        read: ({ precision }) =>
          deps.location.read({ precision: precision === "precise" ? "precise" : "approximate" }),
      },
    ],
  ]);

  async function answer(
    entry: Connection,
    { kind, read }: Method,
    request: Record<string, unknown>,
  ): Promise<Frame[]> {
    if (saved?.key !== entry.key || !saved.value[kind]) return [{ error: `${kind}-off` }];
    if (!deps[kind].available()) return [{ error: `${kind}-unavailable` }];
    try {
      return [{ value: await read(request) }, { done: true }];
    } catch (error) {
      return [{ error: error instanceof PhoneReadError ? error.code : `${kind}-unavailable` }];
    }
  }

  function receive(entry: Connection, data: unknown) {
    if (typeof data !== "string") return;
    if (data.length > MAX_MESSAGE_BYTES || utf8Bytes(data) > MAX_MESSAGE_BYTES) return;
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (message.type === "revoked") {
      void serial(() => forget(entry.key, entry.token));
      return;
    }
    const id = message.id;
    if (!validId(id)) return;
    if (message.type === "cancel") {
      const call = calls.get(id);
      if (call) call.cancelled = true;
      calls.delete(id);
      return;
    }
    if (message.type !== "request" || calls.has(id)) return;
    const call: Call = { cancelled: false };
    calls.set(id, call);
    const request = message.request;
    const method = isRecord(request) ? METHODS.get(String(request.method)) : undefined;
    if (!isRecord(request) || !method) {
      reply(entry, id, call, { error: UNSUPPORTED });
      finish(id, call);
      return;
    }
    void answer(entry, method, request).then((frames) => {
      for (const frame of frames) reply(entry, id, call, frame);
      finish(id, call);
    });
  }

  function open(target: Omit<Connection, "socket" | "openedAt">) {
    close();
    const socket = deps.connect(socketUrl(target.origin), {
      authorization: `Bearer ${target.token}`,
      [PHONE_CAPABILITIES_HEADER]: target.capabilities,
    });
    const entry: Connection = { ...target, socket, openedAt: null };
    connection = entry;
    socket.onopen = () => {
      if (connection === entry) entry.openedAt = deps.now();
    };
    socket.onmessage = (event) => {
      if (connection === entry) receive(entry, event.data);
    };
    socket.onclose = () => lost(entry);
    socket.onerror = () => lost(entry);
  }

  /** The kinds switched on, in this build, and allowed by the system, as the header lists them. */
  async function declared(value: Saved): Promise<string> {
    const kinds: PhoneKind[] = [];
    for (const kind of PHONE_KINDS) {
      if (!value[kind] || !deps[kind].available()) continue;
      if ((await deps[kind].permission()) === "granted") kinds.push(kind);
    }
    return kinds.join(",");
  }

  async function syncNow() {
    if (!started) {
      close();
      return;
    }
    let who: PhoneAccount | null;
    try {
      who = await deps.account();
    } catch {
      // Offline or the server did not answer: try again later, as after a dropped connection.
      close();
      retry();
      return;
    }
    if (!who || isRelayOrigin(who.origin)) {
      account = null;
      saved = null;
      close();
      publish();
      return;
    }
    const key = phoneStorageKey(who);
    if (saved?.key !== key) saved = { key, value: readSaved(await deps.load(key)) };
    account = who;
    publish();
    const { value } = saved;
    if (!value.device || !anyOn(value) || !deps.foreground()) {
      close();
      return;
    }
    const capabilities = await declared(value);
    const current = connection;
    if (
      current &&
      current.key === key &&
      current.token === value.device.token &&
      current.capabilities === capabilities
    ) {
      return;
    }
    stopRetry();
    open({ key, token: value.device.token, capabilities, origin: who.origin });
  }

  function sync() {
    return serial(syncNow);
  }

  async function switchKind(kind: PhoneKind, on: boolean): Promise<PhoneSwitchResult> {
    await syncNow();
    const who = account;
    const current = saved;
    if (!who || !current) return "unavailable";
    if (on) {
      if (!deps[kind].available()) return "unavailable";
      const permission = await deps[kind].request();
      if (permission !== "granted") return permission;
      let device = current.value.device;
      if (!device) {
        const phone = deps.device();
        if (!phone) return "unavailable";
        const paired = await deps.pair(who.origin, phone);
        if (paired.userId !== who.userId) {
          await deps.unpair(who.origin, paired.token).catch(deps.report);
          throw new Error("The server paired another account");
        }
        device = { deviceId: paired.deviceId, token: paired.token };
      }
      const value: Saved = { ...current.value, [kind]: true, device };
      await deps.save(current.key, JSON.stringify(value));
      saved = { key: current.key, value };
      attempt = 0;
    } else if (current.value.device && anyOn({ ...current.value, [kind]: false })) {
      // Another kind is still on: the pairing stays, and this kind is no longer declared.
      const value: Saved = { ...current.value, [kind]: false };
      saved = { key: current.key, value };
      publish();
      await deps.save(current.key, JSON.stringify(value));
    } else {
      // Switching the last kind off unpairs: every bot asks again the next time one is on.
      // Requests that arrive meanwhile are answered as switched off.
      const { device } = current.value;
      saved = { key: current.key, value: { ...ALL_OFF, ...(device ? { device } : {}) } };
      publish();
      if (device) await deps.unpair(who.origin, device.token).catch(deps.report);
      await forget(current.key, device?.token ?? "");
    }
    publish();
    await syncNow();
    return "done";
  }

  let unwatch: (() => void) | null = null;
  return {
    /** Starts following the app; the returned function stops and closes the connection. */
    start(): () => void {
      if (!started) {
        started = true;
        unwatch = deps.watch(() => void sync());
      }
      void sync();
      return () => {
        started = false;
        unwatch?.();
        unwatch = null;
        void sync();
      };
    },
    sync,
    settings: () => settings,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Switches one kind; "denied" when the system refused, with the switch left off. */
    setSwitch: (kind: PhoneKind, on: boolean) => serial(() => switchKind(kind, on)),
  };
}

export type PhoneDevice = ReturnType<typeof createPhoneDevice>;

const originOf = (url: string) => new URL(url).origin;

let cachedAccount: { apiBase: string; generation: number; userId: string } | null = null;

async function signedInAccount(): Promise<PhoneAccount | null> {
  const apiBase = currentApiBase();
  const generation = currentSessionGeneration();
  if (!(await loadSessionToken())) return null;
  const origin = originOf(apiBase);
  if (isRelayOrigin(origin)) return { origin, userId: "" };
  if (cachedAccount?.apiBase !== apiBase || cachedAccount.generation !== generation) {
    const me = await rpc("me");
    cachedAccount = { apiBase, generation, userId: me.userId };
  }
  return { origin, userId: cachedAccount.userId };
}

function serverError(status: number, body: unknown): Error {
  const message = isRecord(body) && typeof body.error === "string" ? body.error : "";
  return new Error(message || `Request failed (${status})`);
}

async function pairPhone(origin: string, device: { name: string; platform: PhonePlatform }) {
  const context = await captureApiRequestContext(null);
  if (originOf(context.apiBase) !== origin) throw new Error("The server changed");
  const { response, body } = await fetchMobileJson<unknown>(
    `${context.apiBase}${USER_DEVICE_PAIR_PATH}`,
    {
      method: "POST",
      headers: {
        origin: "rakazo://",
        "content-type": "application/json",
        ...context.headers,
      },
      body: JSON.stringify(device),
    },
    null,
    context.apiBase,
  );
  if (
    !response.ok ||
    !isRecord(body) ||
    typeof body.deviceId !== "string" ||
    typeof body.userId !== "string" ||
    typeof body.token !== "string"
  ) {
    throw serverError(response.status, body);
  }
  return { deviceId: body.deviceId, userId: body.userId, token: body.token };
}

async function deviceRequest(origin: string, token: string, path: string, method: string) {
  const apiBase = currentApiBase();
  const { response } = await fetchMobileJson<unknown>(
    `${origin}${path}`,
    { method, headers: { origin: "rakazo://", authorization: `Bearer ${token}` } },
    null,
    originOf(apiBase) === origin ? apiBase : origin,
  );
  return response;
}

function phoneName(): { name: string; platform: PhonePlatform } | null {
  if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
  const fallback = Platform.OS === "ios" ? "iPhone" : "Android";
  const name = (Constants.deviceName ?? "").trim().slice(0, 128) || fallback;
  return { name, platform: Platform.OS };
}

type RnWebSocket = new (
  url: string,
  protocols: string[] | undefined,
  options: { headers: Record<string, string> },
) => PhoneSocket;

const later: Later = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export function appPhoneDeviceDeps(): PhoneDeviceDeps {
  return {
    account: signedInAccount,
    load: (key) => SecureStore.getItemAsync(key),
    save: (key, value) => SecureStore.setItemAsync(key, value),
    remove: (key) => SecureStore.deleteItemAsync(key),
    pair: pairPhone,
    async unpair(origin, token) {
      const response = await deviceRequest(origin, token, `${USER_DEVICE_PATH}/self`, "DELETE");
      if (!response.ok && response.status !== 401) throw serverError(response.status, null);
    },
    connect(url, headers) {
      const Socket = WebSocket as unknown as RnWebSocket;
      return new Socket(url, undefined, {
        headers: { ...serverHeaders(currentApiBase()), ...headers },
      });
    },
    calendar: {
      available: calendarAvailable,
      permission: calendarPermission,
      request: requestCalendarPermission,
      read: readCalendar,
    },
    contacts: {
      available: contactsAvailable,
      permission: contactsPermission,
      request: requestContactsPermission,
      read: searchContacts,
    },
    location: {
      available: locationAvailable,
      permission: locationPermission,
      request: requestLocationPermission,
      read: (request) => readLocation(request, later),
    },
    foreground: () => isForegroundState(AppState.currentState),
    watch(listener) {
      const appState = AppState.addEventListener("change", listener);
      const server = subscribeApiBase(listener);
      const session = subscribeSessionGeneration(listener);
      return () => {
        appState.remove();
        server();
        session();
      };
    },
    device: phoneName,
    now: () => Date.now(),
    later,
    random: Math.random,
    report: (error) => reportMobileError(error, "rpc.transport", { source: "phone-device" }),
  };
}

let shared: PhoneDevice | null = null;

/** The app's one phone device, created on first use. */
export function phoneDevice(): PhoneDevice {
  shared ??= createPhoneDevice(appPhoneDeviceDeps());
  return shared;
}

/** Started by the root layout once the saved server is restored; returns the stop. */
export function startPhoneDevice(): () => void {
  return phoneDevice().start();
}
