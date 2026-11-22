import { beforeEach, describe, expect, it, vi } from "vitest";

// The device module wired to the app: the server, the session, secure storage and the socket.

const app = vi.hoisted(() => ({
  apiBase: "https://app.example.test",
  generation: 1,
  token: "session-token",
  platform: { OS: "ios" },
  constants: { deviceName: "Ada's iPhone" as string | undefined },
  appState: { currentState: "active" },
  rpc: vi.fn(async () => ({ userId: "user-1" })),
  fetchMobileJson: vi.fn(),
  report: vi.fn(),
  secure: new Map<string, string>(),
  listeners: { app: vi.fn(), server: vi.fn(), session: vi.fn() },
  removed: { app: vi.fn(), server: vi.fn(), session: vi.fn() },
}));

vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return app.appState.currentState;
    },
    addEventListener: (_type: string, listener: () => void) => {
      app.listeners.app(listener);
      return { remove: app.removed.app };
    },
  },
  Platform: app.platform,
}));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("expo-constants", () => ({ default: app.constants }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => app.secure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    app.secure.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    app.secure.delete(key);
  },
}));
vi.mock("./api", () => ({
  currentApiBase: () => app.apiBase,
  captureApiRequestContext: async () => ({
    apiBase: app.apiBase,
    headers: { authorization: "Bearer session-token", "x-rakazo-client": "mobile" },
    sessionGeneration: app.generation,
  }),
  fetchMobileJson: app.fetchMobileJson,
  rpc: app.rpc,
  subscribeApiBase: (listener: () => void) => {
    app.listeners.server(listener);
    return app.removed.server;
  },
}));
vi.mock("./session", () => ({
  currentSessionGeneration: () => app.generation,
  loadSessionToken: async () => app.token,
  subscribeSessionGeneration: (listener: () => void) => {
    app.listeners.session(listener);
    return app.removed.session;
  },
}));
vi.mock("./server-headers", () => ({
  serverHeaders: () => ({ "cf-access-client-id": "placeholder" }),
}));
vi.mock("./monitoring", () => ({ reportMobileError: app.report }));

const device = await import("./dozo-phone-device");

const answer = (status: number, body: unknown = null) => ({
  response: { ok: status >= 200 && status < 300, status },
  body,
});

beforeEach(() => {
  app.apiBase = "https://app.example.test";
  app.generation += 1;
  app.token = "session-token";
  app.platform.OS = "ios";
  app.constants.deviceName = "Ada's iPhone";
  app.appState.currentState = "active";
  app.rpc.mockClear();
  app.fetchMobileJson.mockReset();
  app.secure.clear();
  vi.unstubAllGlobals();
});

describe("the app's phone device", () => {
  it("finds the signed-in account once per server and session", async () => {
    const deps = device.appPhoneDeviceDeps();
    expect(await deps.account()).toEqual({ origin: "https://app.example.test", userId: "user-1" });
    expect(await deps.account()).toEqual({ origin: "https://app.example.test", userId: "user-1" });
    expect(app.rpc).toHaveBeenCalledTimes(1);
    expect(app.rpc).toHaveBeenCalledWith("me");
    app.generation += 1;
    await deps.account();
    expect(app.rpc).toHaveBeenCalledTimes(2);
  });

  it("has no account when signed out, and none to ask about over the relay", async () => {
    const deps = device.appPhoneDeviceDeps();
    app.token = "";
    expect(await deps.account()).toBeNull();
    app.token = "session-token";
    app.apiBase = `https://${"ab".repeat(16)}.computer.dozo.invalid`;
    expect((await deps.account())?.userId).toBe("");
    expect(app.rpc).not.toHaveBeenCalled();
  });

  it("pairs with the session as this phone", async () => {
    app.fetchMobileJson.mockResolvedValueOnce(
      answer(201, { deviceId: "device-1", userId: "user-1", token: "device-token" }),
    );
    const paired = await device
      .appPhoneDeviceDeps()
      .pair("https://app.example.test", { name: "Ada's iPhone", platform: "ios" });
    expect(paired).toEqual({ deviceId: "device-1", userId: "user-1", token: "device-token" });
    const [url, init, fallback, apiBase] = app.fetchMobileJson.mock.calls[0]!;
    expect(url).toBe("https://app.example.test/api/devices/pair");
    expect(init).toEqual({
      method: "POST",
      headers: {
        origin: "rakazo://",
        "content-type": "application/json",
        authorization: "Bearer session-token",
        "x-rakazo-client": "mobile",
      },
      body: JSON.stringify({ name: "Ada's iPhone", platform: "ios" }),
    });
    expect([fallback, apiBase]).toEqual([null, "https://app.example.test"]);
  });

  it("passes on the server's reason when pairing is refused", async () => {
    const deps = device.appPhoneDeviceDeps();
    const phone = { name: "p", platform: "ios" as const };
    app.fetchMobileJson.mockResolvedValueOnce(answer(409, { error: "Remove a computer first" }));
    await expect(deps.pair("https://app.example.test", phone)).rejects.toThrow(
      "Remove a computer first",
    );
    app.fetchMobileJson.mockResolvedValueOnce(answer(201, { deviceId: "d" }));
    await expect(deps.pair("https://app.example.test", phone)).rejects.toThrow(
      "Request failed (201)",
    );
    await expect(deps.pair("https://other.example.test", phone)).rejects.toThrow(
      "The server changed",
    );
  });

  it("unpairs and checks a pairing with the device token", async () => {
    const deps = device.appPhoneDeviceDeps();
    app.fetchMobileJson.mockResolvedValue(answer(204));
    await deps.unpair("https://app.example.test", "device-token");
    expect(app.fetchMobileJson).toHaveBeenLastCalledWith(
      "https://app.example.test/api/devices/self",
      {
        method: "DELETE",
        headers: { origin: "rakazo://", authorization: "Bearer device-token" },
      },
      null,
      "https://app.example.test",
    );
    expect(await deps.verify("https://app.example.test", "device-token")).toBe(true);
    expect(app.fetchMobileJson).toHaveBeenLastCalledWith(
      "https://app.example.test/api/devices/self/session",
      expect.objectContaining({ method: "POST" }),
      null,
      "https://app.example.test",
    );
    app.fetchMobileJson.mockResolvedValue(answer(401));
    await deps.unpair("https://old.example.test", "device-token");
    expect(app.fetchMobileJson.mock.calls.at(-1)?.[3]).toBe("https://old.example.test");
    expect(await deps.verify("https://app.example.test", "device-token")).toBe(false);
    app.fetchMobileJson.mockResolvedValue(answer(403));
    expect(await deps.verify("https://app.example.test", "device-token")).toBe(true);
    app.fetchMobileJson.mockResolvedValue(answer(503));
    expect(await deps.verify("https://app.example.test", "device-token")).toBeNull();
    await expect(deps.unpair("https://app.example.test", "device-token")).rejects.toThrow(
      "Request failed (503)",
    );
  });

  it("opens the socket with the server's own headers and the device's", () => {
    const opened: unknown[][] = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor(...args: unknown[]) {
          opened.push(args);
        }
      },
    );
    device.appPhoneDeviceDeps().connect("wss://app.example.test/api/devices/connect", {
      authorization: "Bearer device-token",
      "x-dozo-device-capabilities": "calendar",
    });
    expect(opened).toEqual([
      [
        "wss://app.example.test/api/devices/connect",
        undefined,
        {
          headers: {
            "cf-access-client-id": "placeholder",
            authorization: "Bearer device-token",
            "x-dozo-device-capabilities": "calendar",
          },
        },
      ],
    ]);
  });

  it("keeps its pairing in secure storage", async () => {
    const deps = device.appPhoneDeviceDeps();
    await deps.save("dozo.phone.k", "v");
    expect(await deps.load("dozo.phone.k")).toBe("v");
    await deps.remove("dozo.phone.k");
    expect(await deps.load("dozo.phone.k")).toBeNull();
  });

  it("follows the app's state, server and session, and stops following", () => {
    const deps = device.appPhoneDeviceDeps();
    const listener = vi.fn();
    const stop = deps.watch(listener);
    expect(app.listeners.app).toHaveBeenCalledWith(listener);
    expect(app.listeners.server).toHaveBeenCalledWith(listener);
    expect(app.listeners.session).toHaveBeenCalledWith(listener);
    stop();
    expect(app.removed.app).toHaveBeenCalled();
    expect(app.removed.server).toHaveBeenCalled();
    expect(app.removed.session).toHaveBeenCalled();
    expect(deps.foreground()).toBe(true);
    app.appState.currentState = "background";
    expect(deps.foreground()).toBe(false);
  });

  it("names the phone, falling back to its kind", () => {
    const deps = device.appPhoneDeviceDeps();
    expect(deps.device()).toEqual({ name: "Ada's iPhone", platform: "ios" });
    app.constants.deviceName = undefined;
    expect(deps.device()).toEqual({ name: "iPhone", platform: "ios" });
    app.platform.OS = "android";
    app.constants.deviceName = ` ${"x".repeat(200)} `;
    expect(deps.device()).toEqual({ name: "x".repeat(128), platform: "android" });
    app.constants.deviceName = "  ";
    expect(deps.device()?.name).toBe("Android");
    app.platform.OS = "web";
    expect(deps.device()).toBeNull();
  });

  it("waits on a timer it can cancel, and reports a failed unpairing as transport", async () => {
    const deps = device.appPhoneDeviceDeps();
    const run = vi.fn();
    const cancel = deps.later(run, 10_000);
    cancel();
    deps.later(run, 0);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(typeof deps.now()).toBe("number");
    expect(deps.random()).toBeLessThan(1);
    const error = new Error("offline");
    deps.report(error);
    expect(app.report).toHaveBeenCalledWith(error, "rpc.transport", { source: "phone-device" });
  });

  it("is one device for the whole app, started by the layout", async () => {
    expect(device.phoneDevice()).toBe(device.phoneDevice());
    app.token = "";
    const stop = device.startPhoneDevice();
    await device.phoneDevice().sync();
    expect(device.phoneDevice().settings()).toEqual({ ready: false, calendar: false });
    stop();
  });
});
