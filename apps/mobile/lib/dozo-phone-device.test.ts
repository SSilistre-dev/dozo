import { deferred, flush } from "@rakazo/core/test-async";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneCalendarValue, PhonePermission } from "./dozo-phone-calendar";
import type { PhoneContactsValue } from "./dozo-phone-contacts";
import type { PhoneAccount, PhoneDeviceDeps, PhoneSocket } from "./dozo-phone-device";
import type { PhoneLocationValue } from "./dozo-phone-location";

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: vi.fn() },
  Platform: { OS: "ios" },
}));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("expo-secure-store", () => ({}));
vi.mock("expo-constants", () => ({ default: {} }));
vi.mock("./api", () => ({}));
vi.mock("./session", () => ({}));
vi.mock("./server-headers", () => ({}));
vi.mock("./monitoring", () => ({}));

const { createPhoneDevice, MAX_MESSAGE_BYTES, phoneStorageKey } = await import(
  "./dozo-phone-device"
);
const { PhoneReadError } = await import("./dozo-phone-calendar");

class FakeSocket implements PhoneSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data?: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  receive(message: unknown) {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
  }
  frames() {
    return this.sent.map((text) => JSON.parse(text) as unknown);
  }
}

const ORIGIN = "https://app.example.test";
const USER = "user-1";
const value: PhoneCalendarValue = {
  events: [
    {
      title: "Standup",
      start: "2026-11-23T09:00:00.000Z",
      end: "2026-11-23T09:15:00.000Z",
      allDay: false,
    },
  ],
  truncated: false,
};
const people: PhoneContactsValue = {
  contacts: [{ name: "Ada Lovelace", values: ["+1 555 0100"] }],
  truncated: false,
};
const place: PhoneLocationValue = {
  latitude: 41.01,
  longitude: 28.98,
  accuracyMeters: 1000,
  precise: false,
  at: "2026-11-23T09:00:00.000Z",
};
const contactsRequest = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "request",
  id,
  request: {
    method: "phoneContactsSearch",
    botId: "bot-1",
    runId: "run-1",
    query: "ada",
    field: "phone",
    limit: 10,
    ...extra,
  },
});
const locationRequest = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "request",
  id,
  request: { method: "phoneLocation", botId: "bot-1", runId: "run-1", ...extra },
});
const readRequest = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "request",
  id,
  request: {
    method: "phoneCalendarRead",
    botId: "bot-1",
    runId: "run-1",
    from: "2026-11-23T00:00:00.000Z",
    to: "2026-11-24T00:00:00.000Z",
    limit: 5,
    ...extra,
  },
});

function setup(stored?: Record<string, string>) {
  const store = new Map(Object.entries(stored ?? {}));
  const sockets: FakeSocket[] = [];
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  let watcher: (() => void) | null = null;
  const state = {
    foreground: true,
    account: { origin: ORIGIN, userId: USER } as PhoneAccount | null | Error,
    permission: "granted" as PhonePermission,
    available: true,
    contacts: { permission: "granted" as PhonePermission, available: true },
    location: { permission: "granted" as PhonePermission, available: true },
    now: 0,
  };
  const deps = {
    account: vi.fn(async () => {
      if (state.account instanceof Error) throw state.account;
      return state.account;
    }),
    load: vi.fn(async (key: string) => store.get(key) ?? null),
    save: vi.fn(async (key: string, text: string) => {
      store.set(key, text);
    }),
    remove: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    pair: vi.fn(async () => ({ deviceId: "device-1", userId: USER, token: "token-1" })),
    unpair: vi.fn(async () => {}),
    connect: vi.fn((url: string, headers: Record<string, string>) => {
      const socket = new FakeSocket(url, headers);
      sockets.push(socket);
      return socket;
    }),
    calendar: {
      available: () => state.available,
      permission: vi.fn(async () => state.permission),
      request: vi.fn(async () => state.permission),
      read: vi.fn(async () => value),
    },
    contacts: {
      available: () => state.contacts.available,
      permission: vi.fn(async () => state.contacts.permission),
      request: vi.fn(async () => state.contacts.permission),
      read: vi.fn(async () => people),
    },
    location: {
      available: () => state.location.available,
      permission: vi.fn(async () => state.location.permission),
      request: vi.fn(async () => state.location.permission),
      read: vi.fn(async () => place),
    },
    foreground: () => state.foreground,
    watch: (listener: () => void) => {
      watcher = listener;
      return () => {
        watcher = null;
      };
    },
    device: vi.fn(() => ({ name: "Test phone", platform: "ios" as const })),
    now: () => state.now,
    later: (run: () => void, ms: number) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    random: () => 0.5,
    report: vi.fn(),
  } satisfies PhoneDeviceDeps;
  const device = createPhoneDevice(deps);
  const pending = () => timers.filter((timer) => !timer.cancelled);
  return {
    device,
    deps,
    store,
    sockets,
    state,
    pending,
    last: () => sockets.at(-1)!,
    /** The app's state, server or session changed; resolves once the device has followed it. */
    change: async () => {
      watcher?.();
      await device.sync();
    },
    watching: () => watcher !== null,
  };
}

const key = phoneStorageKey({ origin: ORIGIN, userId: USER });
const pairedStore = () => ({
  [key]: JSON.stringify({ calendar: true, device: { deviceId: "device-1", token: "token-1" } }),
});

async function switchedOn() {
  const phone = setup();
  phone.device.start();
  expect(await phone.device.setSwitch("calendar", true)).toBe("done");
  return phone;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("pairing and the switch", () => {
  it("is off and unpaired until switched on, and opens nothing", async () => {
    const phone = setup();
    phone.device.start();
    await phone.device.sync();
    expect(phone.device.settings()).toEqual({
      ready: true,
      calendar: false,
      contacts: false,
      location: false,
    });
    expect(phone.deps.connect).not.toHaveBeenCalled();
    expect(phone.deps.pair).not.toHaveBeenCalled();
    expect(phone.deps.calendar.permission).not.toHaveBeenCalled();
  });

  it("pairs once as this phone and connects declaring calendar", async () => {
    const phone = await switchedOn();
    expect(phone.deps.pair).toHaveBeenCalledTimes(1);
    expect(phone.deps.pair).toHaveBeenCalledWith(ORIGIN, { name: "Test phone", platform: "ios" });
    expect(phone.device.settings()).toEqual({
      ready: true,
      calendar: true,
      contacts: false,
      location: false,
    });
    expect(JSON.parse(phone.store.get(key)!)).toEqual({
      calendar: true,
      contacts: false,
      location: false,
      device: { deviceId: "device-1", token: "token-1" },
    });
    expect(phone.sockets).toHaveLength(1);
    expect(phone.last().url).toBe("wss://app.example.test/api/devices/connect");
    expect(phone.last().headers).toEqual({
      authorization: "Bearer token-1",
      "x-dozo-device-capabilities": "calendar",
    });

    expect(await phone.device.setSwitch("calendar", true)).toBe("done");
    await phone.change();
    expect(phone.deps.pair).toHaveBeenCalledTimes(1);
    expect(phone.sockets).toHaveLength(1);
  });

  it("keeps the pairing across restarts", async () => {
    const phone = setup(pairedStore());
    phone.device.start();
    await phone.device.sync();
    expect(phone.deps.pair).not.toHaveBeenCalled();
    expect(phone.last().headers.authorization).toBe("Bearer token-1");
    expect(phone.device.settings().calendar).toBe(true);
  });

  it("declares nothing while the system permission is not granted, and reconnects when it changes", async () => {
    const phone = await switchedOn();
    phone.state.permission = "denied";
    await phone.change();
    expect(phone.sockets[0]!.closed).toBe(true);
    expect(phone.last().headers["x-dozo-device-capabilities"]).toBe("");
    phone.state.permission = "granted";
    await phone.change();
    expect(phone.sockets).toHaveLength(3);
    expect(phone.last().headers["x-dozo-device-capabilities"]).toBe("calendar");
  });

  it("declares nothing in a build without the calendar module", async () => {
    const phone = setup(pairedStore());
    phone.state.available = false;
    phone.device.start();
    await phone.device.sync();
    expect(phone.last().headers["x-dozo-device-capabilities"]).toBe("");
    expect(await phone.device.setSwitch("calendar", true)).toBe("unavailable");
  });

  it("stays off and unpaired when the system refuses", async () => {
    const phone = setup();
    phone.state.permission = "denied";
    phone.device.start();
    expect(await phone.device.setSwitch("calendar", true)).toBe("denied");
    expect(phone.deps.pair).not.toHaveBeenCalled();
    expect(phone.device.settings().calendar).toBe(false);
    expect(phone.deps.connect).not.toHaveBeenCalled();
    expect(phone.store.size).toBe(0);
  });

  it("switching off unpairs and forgets the token, so the next switch on pairs again", async () => {
    const phone = await switchedOn();
    expect(await phone.device.setSwitch("calendar", false)).toBe("done");
    expect(phone.deps.unpair).toHaveBeenCalledWith(ORIGIN, "token-1");
    expect(phone.store.size).toBe(0);
    expect(phone.sockets[0]!.closed).toBe(true);
    expect(phone.device.settings().calendar).toBe(false);
    expect(await phone.device.setSwitch("calendar", true)).toBe("done");
    expect(phone.deps.pair).toHaveBeenCalledTimes(2);
  });

  it("forgets the pairing even when the server cannot be told", async () => {
    const phone = await switchedOn();
    const failure = new Error("offline");
    phone.deps.unpair.mockRejectedValueOnce(failure);
    expect(await phone.device.setSwitch("calendar", false)).toBe("done");
    expect(phone.deps.report).toHaveBeenCalledWith(failure);
    expect(phone.store.size).toBe(0);
  });

  it("switching off before anything was paired only stores nothing", async () => {
    const phone = setup();
    phone.device.start();
    expect(await phone.device.setSwitch("calendar", false)).toBe("done");
    expect(phone.deps.unpair).not.toHaveBeenCalled();
    expect(phone.store.size).toBe(0);
  });

  it("refuses a pairing made for another account and undoes it", async () => {
    const phone = setup();
    phone.deps.pair.mockResolvedValueOnce({ deviceId: "d", userId: "someone-else", token: "t" });
    phone.device.start();
    await expect(phone.device.setSwitch("calendar", true)).rejects.toThrow("another account");
    expect(phone.deps.unpair).toHaveBeenCalledWith(ORIGIN, "t");
    expect(phone.store.size).toBe(0);
  });

  it("passes a failed pairing to the screen and stays off", async () => {
    const phone = setup();
    phone.deps.pair.mockRejectedValueOnce(new Error("Remove a computer before adding another"));
    phone.device.start();
    await expect(phone.device.setSwitch("calendar", true)).rejects.toThrow("Remove a computer");
    expect(phone.device.settings().calendar).toBe(false);
  });

  it("is unavailable where the phone cannot name itself", async () => {
    const phone = setup();
    phone.deps.device.mockReturnValueOnce(null as never);
    phone.device.start();
    expect(await phone.device.setSwitch("calendar", true)).toBe("unavailable");
  });

  it("keeps each account's pairing under its own server and user", () => {
    expect(phoneStorageKey({ origin: "https://a.example:8443", userId: "u/1" })).toBe(
      "dozo.phone.https_3a__2f__2f_a.example_3a_8443.u_2f_1",
    );
    expect(phoneStorageKey({ origin: ORIGIN, userId: "user-2" })).not.toBe(key);
  });

  it("reads a damaged saved pairing as off", async () => {
    for (const text of [
      "not json",
      "[]",
      JSON.stringify({ calendar: true, device: { token: 1 } }),
    ]) {
      const phone = setup({ [key]: text });
      phone.device.start();
      await phone.device.sync();
      expect(phone.device.settings().calendar).toBe(false);
      expect(phone.deps.connect).not.toHaveBeenCalled();
    }
  });
});

describe("where it connects", () => {
  it("never connects to a paired computer over the relay", async () => {
    const phone = setup(pairedStore());
    phone.state.account = {
      origin: `https://${"ab".repeat(16)}.computer.dozo.invalid`,
      userId: USER,
    };
    phone.device.start();
    await phone.device.sync();
    expect(phone.deps.connect).not.toHaveBeenCalled();
    expect(phone.device.settings().ready).toBe(false);
    expect(await phone.device.setSwitch("calendar", true)).toBe("unavailable");
    expect(phone.deps.pair).not.toHaveBeenCalled();
  });

  it("closes on background and reconnects on foreground", async () => {
    const phone = await switchedOn();
    phone.state.foreground = false;
    await phone.change();
    expect(phone.sockets[0]!.closed).toBe(true);
    expect(phone.pending()).toHaveLength(0);
    phone.state.foreground = true;
    await phone.change();
    expect(phone.sockets).toHaveLength(2);
    expect(phone.last().closed).toBe(false);
  });

  it("closes on sign-out", async () => {
    const phone = await switchedOn();
    phone.state.account = null;
    await phone.change();
    expect(phone.sockets[0]!.closed).toBe(true);
    expect(phone.device.settings()).toEqual({
      ready: false,
      calendar: false,
      contacts: false,
      location: false,
    });
  });

  it("tries again later when it cannot tell who is signed in", async () => {
    const phone = setup(pairedStore());
    phone.state.account = new Error("offline");
    phone.device.start();
    await phone.device.sync();
    expect(phone.deps.connect).not.toHaveBeenCalled();
    expect(phone.pending()).toHaveLength(1);
    phone.state.account = { origin: ORIGIN, userId: USER };
    phone.pending()[0]!.run();
    await phone.device.sync();
    expect(phone.deps.connect).toHaveBeenCalledTimes(1);
  });

  it("reconnects with growing, jittered waits, starting over after a lasting connection", async () => {
    const phone = await switchedOn();
    phone.last().onopen?.();
    phone.last().onclose?.();
    expect(phone.sockets[0]!.closed).toBe(true);
    expect(phone.pending().map((timer) => timer.ms)).toEqual([750]);
    phone.pending()[0]!.run();
    await phone.device.sync();
    expect(phone.sockets).toHaveLength(2);
    phone.last().onopen?.();
    phone.last().onerror?.();
    expect(phone.pending().at(-1)!.ms).toBe(1500);
    phone.pending().at(-1)!.run();
    await phone.device.sync();
    phone.last().onopen?.();
    phone.state.now = 30_000;
    phone.last().onclose?.();
    expect(phone.pending().at(-1)!.ms).toBe(750);
  });

  it("does not retry while in the background", async () => {
    const phone = await switchedOn();
    phone.last().onopen?.();
    phone.state.foreground = false;
    phone.last().onclose?.();
    expect(phone.pending()).toHaveLength(0);
  });

  it("keeps the pairing when connections fail before opening, and retries with growing waits", async () => {
    const phone = await switchedOn();
    const waits: number[] = [];
    for (let failure = 0; failure < 4; failure++) {
      phone.last().onerror?.();
      await flush();
      const timer = phone.pending().at(-1)!;
      waits.push(timer.ms);
      timer.run();
      await phone.device.sync();
    }
    expect(waits).toEqual([750, 1500, 3000, 6000]);
    expect(phone.sockets).toHaveLength(5);
    expect(phone.last().headers.authorization).toBe("Bearer token-1");
    expect(phone.store.size).toBe(1);
    expect(phone.device.settings().calendar).toBe(true);
  });

  it("ignores events from a connection it already replaced", async () => {
    const phone = await switchedOn();
    const old = phone.last();
    phone.state.permission = "denied";
    await phone.change();
    old.onopen?.();
    old.onclose?.();
    old.receive(readRequest("r1"));
    await flush();
    expect(old.sent).toEqual([]);
    expect(phone.pending()).toHaveLength(0);
  });

  it("stops following the app and closes when stopped", async () => {
    const phone = setup(pairedStore());
    const stop = phone.device.start();
    phone.device.start();
    await phone.device.sync();
    expect(phone.watching()).toBe(true);
    stop();
    await phone.device.sync();
    expect(phone.watching()).toBe(false);
    expect(phone.last().closed).toBe(true);
  });

  it("tells the screen when the switch changes", async () => {
    const phone = setup();
    const seen = vi.fn();
    const unsubscribe = phone.device.subscribe(seen);
    phone.device.start();
    await phone.device.setSwitch("calendar", true);
    expect(seen).toHaveBeenCalled();
    unsubscribe();
    seen.mockClear();
    await phone.device.setSwitch("calendar", false);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("requests", () => {
  it("answers a calendar read with its value, then done", async () => {
    const phone = await switchedOn();
    phone.last().onopen?.();
    phone.last().receive(readRequest("r1", { query: "stand" }));
    await vi.waitFor(() => expect(phone.last().sent).toHaveLength(2));
    expect(phone.deps.calendar.read).toHaveBeenCalledWith({
      from: "2026-11-23T00:00:00.000Z",
      to: "2026-11-24T00:00:00.000Z",
      query: "stand",
      limit: 5,
    });
    expect(phone.last().frames()).toEqual([
      { type: "frame", id: "r1", frame: { value } },
      { type: "frame", id: "r1", frame: { done: true } },
    ]);
  });

  it("reads up to 50 when the request names no limit", async () => {
    const phone = await switchedOn();
    phone.last().receive(readRequest("r1", { limit: undefined }));
    await vi.waitFor(() => expect(phone.last().sent).toHaveLength(2));
    expect(phone.deps.calendar.read).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it.each([
    ["calendar-permission", new PhoneReadError("calendar-permission")],
    ["calendar-unavailable", new PhoneReadError("calendar-unavailable")],
    ["calendar-unavailable", new Error("native read failed")],
  ])("answers %s when the read fails that way", async (code, failure) => {
    const phone = await switchedOn();
    phone.deps.calendar.read.mockRejectedValueOnce(failure);
    phone.last().receive(readRequest("r1"));
    await vi.waitFor(() => expect(phone.last().sent).toHaveLength(1));
    expect(phone.last().frames()).toEqual([{ type: "frame", id: "r1", frame: { error: code } }]);
  });

  it("answers calendar-unavailable without reading where the module is missing", async () => {
    const phone = await switchedOn();
    phone.state.available = false;
    phone.last().receive(readRequest("r1"));
    await vi.waitFor(() => expect(phone.last().sent).toHaveLength(1));
    expect(phone.last().frames()[0]).toEqual({
      type: "frame",
      id: "r1",
      frame: { error: "calendar-unavailable" },
    });
    expect(phone.deps.calendar.read).not.toHaveBeenCalled();
  });

  it("answers calendar-off once the switch is turning off", async () => {
    const phone = await switchedOn();
    const unpairing = deferred();
    phone.deps.unpair.mockReturnValueOnce(unpairing.promise);
    const off = phone.device.setSwitch("calendar", false);
    await vi.waitFor(() => expect(phone.deps.unpair).toHaveBeenCalled());
    phone.sockets[0]!.receive(readRequest("r1"));
    await vi.waitFor(() => expect(phone.sockets[0]!.sent).toHaveLength(1));
    expect(phone.sockets[0]!.frames()[0]).toEqual({
      type: "frame",
      id: "r1",
      frame: { error: "calendar-off" },
    });
    unpairing.resolve();
    expect(await off).toBe("done");
  });

  it("answers any other method as not supported", async () => {
    const phone = await switchedOn();
    phone.last().receive({ type: "request", id: "r2", request: { method: "exec", command: "ls" } });
    phone.last().receive({ type: "request", id: "r3", request: "phoneCalendarRead" });
    expect(phone.last().frames()).toEqual([
      { type: "frame", id: "r2", frame: { error: "Not supported on this phone" } },
      { type: "frame", id: "r3", frame: { error: "Not supported on this phone" } },
    ]);
    expect(phone.deps.calendar.read).not.toHaveBeenCalled();
  });

  it("sends nothing for a cancelled request", async () => {
    const phone = await switchedOn();
    const read = deferred<PhoneCalendarValue>();
    phone.deps.calendar.read.mockReturnValueOnce(read.promise);
    phone.last().receive(readRequest("r1"));
    phone.last().receive({ type: "cancel", id: "r1" });
    phone.last().receive({ type: "cancel", id: "unknown" });
    read.resolve(value);
    await flush();
    expect(phone.last().sent).toEqual([]);
  });

  it("sends nothing for a request the connection dropped under", async () => {
    const phone = await switchedOn();
    const read = deferred<PhoneCalendarValue>();
    phone.deps.calendar.read.mockReturnValueOnce(read.promise);
    const socket = phone.last();
    socket.onopen?.();
    socket.receive(readRequest("r1"));
    socket.onclose?.();
    read.resolve(value);
    await flush();
    expect(socket.sent).toEqual([]);
  });

  it("answers a repeated request id once", async () => {
    const phone = await switchedOn();
    const read = deferred<PhoneCalendarValue>();
    phone.deps.calendar.read.mockReturnValueOnce(read.promise);
    phone.last().receive(readRequest("r1"));
    phone.last().receive(readRequest("r1"));
    read.resolve(value);
    await vi.waitFor(() => expect(phone.last().sent).toHaveLength(2));
    expect(phone.deps.calendar.read).toHaveBeenCalledTimes(1);
  });

  it("forgets its token and shows off when the server revokes it, and does not reconnect", async () => {
    const phone = await switchedOn();
    phone.last().onopen?.();
    phone.last().receive({ type: "revoked", reason: "session-ended" });
    await phone.device.sync();
    expect(phone.store.size).toBe(0);
    expect(phone.device.settings().calendar).toBe(false);
    expect(phone.sockets[0]!.closed).toBe(true);
    expect(phone.pending()).toHaveLength(0);
    await phone.change();
    expect(phone.sockets).toHaveLength(1);
  });

  it("keeps a newer pairing when a revoke is handled after the phone paired again", async () => {
    const phone = await switchedOn();
    const socket = phone.last();
    const unpairing = deferred();
    phone.deps.unpair.mockReturnValueOnce(unpairing.promise);
    phone.deps.pair.mockResolvedValueOnce({ deviceId: "device-2", userId: USER, token: "token-2" });
    const off = phone.device.setSwitch("calendar", false);
    const on = phone.device.setSwitch("calendar", true);
    await vi.waitFor(() => expect(phone.deps.unpair).toHaveBeenCalled());
    socket.receive({ type: "revoked" });
    unpairing.resolve();
    await Promise.all([off, on]);
    await phone.device.sync();
    expect(phone.device.settings().calendar).toBe(true);
    expect(JSON.parse(phone.store.get(key)!).device.token).toBe("token-2");
    expect(phone.last().headers.authorization).toBe("Bearer token-2");
    expect(phone.last().closed).toBe(false);
  });

  it("drops messages over 1 MiB, whatever their characters", async () => {
    const phone = await switchedOn();
    const big = JSON.stringify(readRequest("r1", { query: "a".repeat(MAX_MESSAGE_BYTES) }));
    const wide = JSON.stringify(readRequest("r2", { query: "é".repeat(MAX_MESSAGE_BYTES / 2) }));
    const astral = JSON.stringify(readRequest("r3", { query: "😀".repeat(MAX_MESSAGE_BYTES / 4) }));
    for (const text of [big, wide, astral]) phone.last().receive(text);
    await flush();
    expect(phone.deps.calendar.read).not.toHaveBeenCalled();
    phone.last().receive(readRequest("r4", { query: "é😀" }));
    await vi.waitFor(() => expect(phone.last().sent).toHaveLength(2));
  });

  it("ignores what it cannot read", async () => {
    const phone = await switchedOn();
    const socket = phone.last();
    socket.onmessage?.({ data: new ArrayBuffer(4) });
    for (const text of ["{", "[]", '"text"']) socket.receive(text);
    for (const message of [
      { type: "request", id: "", request: { method: "phoneCalendarRead" } },
      { type: "request", id: "x".repeat(65), request: { method: "phoneCalendarRead" } },
      { type: "hello", id: "r1" },
    ]) {
      socket.receive(message);
    }
    await flush();
    expect(socket.sent).toEqual([]);
    expect(phone.deps.calendar.read).not.toHaveBeenCalled();
  });
});

describe("contacts and location", () => {
  const capabilities = (phone: ReturnType<typeof setup>) =>
    phone.last().headers["x-dozo-device-capabilities"];

  it("declares each kind only while its switch is on and the system allows it", async () => {
    const phone = await switchedOn();
    expect(capabilities(phone)).toBe("calendar");
    expect(await phone.device.setSwitch("contacts", true)).toBe("done");
    expect(capabilities(phone)).toBe("calendar,contacts");
    expect(await phone.device.setSwitch("location", true)).toBe("done");
    expect(capabilities(phone)).toBe("calendar,contacts,location");
    expect(phone.device.settings()).toEqual({
      ready: true,
      calendar: true,
      contacts: true,
      location: true,
    });
    phone.state.contacts.permission = "denied";
    await phone.change();
    expect(capabilities(phone)).toBe("calendar,location");
    phone.state.location.available = false;
    phone.state.permission = "unavailable";
    await phone.change();
    expect(capabilities(phone)).toBe("");
    expect(phone.deps.pair).toHaveBeenCalledTimes(1);
  });

  it("pairs once for whichever kind is switched on first", async () => {
    const phone = setup();
    phone.device.start();
    expect(await phone.device.setSwitch("location", true)).toBe("done");
    expect(phone.deps.location.request).toHaveBeenCalledTimes(1);
    expect(phone.deps.calendar.request).not.toHaveBeenCalled();
    expect(capabilities(phone)).toBe("location");
    expect(await phone.device.setSwitch("contacts", true)).toBe("done");
    expect(phone.deps.pair).toHaveBeenCalledTimes(1);
    expect(JSON.parse(phone.store.get(key)!)).toEqual({
      calendar: false,
      contacts: true,
      location: true,
      device: { deviceId: "device-1", token: "token-1" },
    });
  });

  it("turning one off stops declaring it and keeps the pairing", async () => {
    const phone = await switchedOn();
    await phone.device.setSwitch("contacts", true);
    expect(await phone.device.setSwitch("calendar", false)).toBe("done");
    expect(phone.deps.unpair).not.toHaveBeenCalled();
    expect(capabilities(phone)).toBe("contacts");
    expect(phone.last().closed).toBe(false);
    expect(phone.device.settings()).toEqual({
      ready: true,
      calendar: false,
      contacts: true,
      location: false,
    });
    expect(JSON.parse(phone.store.get(key)!).device.token).toBe("token-1");
  });

  it("turning off the last one unpairs, so every bot asks again", async () => {
    const phone = setup();
    phone.device.start();
    await phone.device.setSwitch("contacts", true);
    await phone.device.setSwitch("location", true);
    await phone.device.setSwitch("contacts", false);
    expect(phone.deps.unpair).not.toHaveBeenCalled();
    expect(await phone.device.setSwitch("location", false)).toBe("done");
    expect(phone.deps.unpair).toHaveBeenCalledWith(ORIGIN, "token-1");
    expect(phone.store.size).toBe(0);
    expect(phone.last().closed).toBe(true);
    expect(phone.device.settings()).toEqual({
      ready: true,
      calendar: false,
      contacts: false,
      location: false,
    });
  });

  it("leaves a switch off when the system refuses or the build lacks its module", async () => {
    const phone = await switchedOn();
    phone.state.contacts.permission = "denied";
    expect(await phone.device.setSwitch("contacts", true)).toBe("denied");
    phone.state.location.available = false;
    expect(await phone.device.setSwitch("location", true)).toBe("unavailable");
    expect(phone.deps.location.request).not.toHaveBeenCalled();
    expect(phone.device.settings()).toEqual({
      ready: true,
      calendar: true,
      contacts: false,
      location: false,
    });
    expect(capabilities(phone)).toBe("calendar");
  });

  it("keeps each switch across restarts", async () => {
    const phone = setup({
      [key]: JSON.stringify({
        contacts: true,
        location: true,
        device: { deviceId: "device-1", token: "token-1" },
      }),
    });
    phone.device.start();
    await phone.device.sync();
    expect(capabilities(phone)).toBe("contacts,location");
    expect(phone.device.settings()).toEqual({
      ready: true,
      calendar: false,
      contacts: true,
      location: true,
    });
  });

  it("forgets every switch when the server revokes the pairing", async () => {
    const phone = await switchedOn();
    await phone.device.setSwitch("location", true);
    phone.last().receive({ type: "revoked" });
    await phone.device.sync();
    expect(phone.device.settings()).toEqual({
      ready: true,
      calendar: false,
      contacts: false,
      location: false,
    });
    expect(phone.store.size).toBe(0);
  });
});

describe("contacts and location requests", () => {
  async function allOn() {
    const phone = await switchedOn();
    await phone.device.setSwitch("contacts", true);
    await phone.device.setSwitch("location", true);
    return phone;
  }
  const answered = async (phone: ReturnType<typeof setup>, count: number) => {
    await vi.waitFor(() => expect(phone.last().sent).toHaveLength(count));
    return phone.last().frames();
  };

  it("answers a contacts search with its value, then done", async () => {
    const phone = await allOn();
    phone.last().receive(contactsRequest("c1"));
    expect(await answered(phone, 2)).toEqual([
      { type: "frame", id: "c1", frame: { value: people } },
      { type: "frame", id: "c1", frame: { done: true } },
    ]);
    expect(phone.deps.contacts.read).toHaveBeenCalledWith({
      query: "ada",
      field: "phone",
      limit: 10,
    });
  });

  it("passes the asked field, and searches for at most 10 when no limit is named", async () => {
    const phone = await allOn();
    phone.last().receive(contactsRequest("c1", { field: "email", limit: undefined }));
    await answered(phone, 2);
    expect(phone.deps.contacts.read).toHaveBeenCalledWith({
      query: "ada",
      field: "email",
      limit: 10,
    });
  });

  it.each([
    ["an unknown field", { field: "address" }],
    ["no query", { query: undefined }],
  ])("answers contacts-query for %s without searching", async (_name, extra) => {
    const phone = await allOn();
    phone.last().receive(contactsRequest("c1", extra));
    expect(await answered(phone, 1)).toEqual([
      { type: "frame", id: "c1", frame: { error: "contacts-query" } },
    ]);
    expect(phone.deps.contacts.read).not.toHaveBeenCalled();
  });

  it.each([
    ["contacts-query", new PhoneReadError("contacts-query")],
    ["contacts-permission", new PhoneReadError("contacts-permission")],
    ["contacts-unavailable", new Error("native read failed")],
  ])("answers %s when the search fails that way", async (code, failure) => {
    const phone = await allOn();
    phone.deps.contacts.read.mockRejectedValueOnce(failure);
    phone.last().receive(contactsRequest("c1"));
    expect(await answered(phone, 1)).toEqual([{ type: "frame", id: "c1", frame: { error: code } }]);
  });

  it("answers a location read, approximate unless precise is asked", async () => {
    const phone = await allOn();
    phone.last().receive(locationRequest("l1"));
    expect(await answered(phone, 2)).toEqual([
      { type: "frame", id: "l1", frame: { value: place } },
      { type: "frame", id: "l1", frame: { done: true } },
    ]);
    expect(phone.deps.location.read).toHaveBeenLastCalledWith({ precision: "approximate" });
    phone.last().receive(locationRequest("l2", { precision: "precise" }));
    await answered(phone, 4);
    expect(phone.deps.location.read).toHaveBeenLastCalledWith({ precision: "precise" });
    phone.last().receive(locationRequest("l3", { precision: "exact" }));
    await answered(phone, 6);
    expect(phone.deps.location.read).toHaveBeenLastCalledWith({ precision: "approximate" });
  });

  it.each([
    ["location-permission", new PhoneReadError("location-permission")],
    ["location-unavailable", new PhoneReadError("location-unavailable")],
    ["location-unavailable", new Error("no fix")],
  ])("answers %s when the reading fails that way", async (code, failure) => {
    const phone = await allOn();
    phone.deps.location.read.mockRejectedValueOnce(failure);
    phone.last().receive(locationRequest("l1"));
    expect(await answered(phone, 1)).toEqual([{ type: "frame", id: "l1", frame: { error: code } }]);
  });

  it("answers off for a kind that is switched off, without reading", async () => {
    const phone = await switchedOn();
    phone.last().receive(contactsRequest("c1"));
    phone.last().receive(locationRequest("l1"));
    await answered(phone, 2);
    expect(phone.last().frames()).toEqual(
      expect.arrayContaining([
        { type: "frame", id: "c1", frame: { error: "contacts-off" } },
        { type: "frame", id: "l1", frame: { error: "location-off" } },
      ]),
    );
    expect(phone.deps.contacts.read).not.toHaveBeenCalled();
    expect(phone.deps.location.read).not.toHaveBeenCalled();
  });

  it("answers unavailable where the module is missing, without reading", async () => {
    const phone = await allOn();
    phone.state.contacts.available = false;
    phone.state.location.available = false;
    phone.last().receive(contactsRequest("c1"));
    phone.last().receive(locationRequest("l1"));
    await answered(phone, 2);
    expect(phone.last().frames()).toEqual(
      expect.arrayContaining([
        { type: "frame", id: "c1", frame: { error: "contacts-unavailable" } },
        { type: "frame", id: "l1", frame: { error: "location-unavailable" } },
      ]),
    );
    expect(phone.deps.contacts.read).not.toHaveBeenCalled();
    expect(phone.deps.location.read).not.toHaveBeenCalled();
  });
});
