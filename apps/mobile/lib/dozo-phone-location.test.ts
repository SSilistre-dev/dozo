import { deferred } from "@rakazo/core/test-async";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Grant = {
  granted: boolean;
  ios?: { scope?: string; accuracy?: "full" | "reduced" };
  android?: { accuracy?: "fine" | "coarse" | "none" };
};
type Reading = {
  coords: { latitude: number; longitude: number; accuracy: number | null };
  timestamp: number;
};

const AT = Date.parse("2026-11-23T09:00:00.000Z");
const reading = (extra: Partial<Reading["coords"]> = {}, timestamp = AT): Reading => ({
  coords: { latitude: 41.008_712, longitude: 28.978_359, accuracy: 12.4, ...extra },
  timestamp,
});

const native = vi.hoisted(() => ({
  module: {} as object | null,
  platform: { OS: "ios" },
  location: {
    getForegroundPermissionsAsync: vi.fn(async (): Promise<Grant> => ({ granted: true })),
    requestForegroundPermissionsAsync: vi.fn(async (): Promise<Grant> => ({ granted: true })),
    getCurrentPositionAsync: vi.fn(
      async (_options: { accuracy: number }): Promise<unknown> => null,
    ),
    getBackgroundPermissionsAsync: vi.fn(),
    requestBackgroundPermissionsAsync: vi.fn(),
    watchPositionAsync: vi.fn(),
    getLastKnownPositionAsync: vi.fn(),
    startLocationUpdatesAsync: vi.fn(),
    Accuracy: { Lowest: 1, Low: 2, Balanced: 3, High: 4, Highest: 5 },
  },
}));

vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: (name: string) => (name === "ExpoLocation" ? native.module : null),
}));
vi.mock("react-native", () => ({ Platform: native.platform }));

async function withoutNativeModule() {
  vi.doMock("expo-location", () => {
    throw new Error("Cannot find native module 'ExpoLocation'");
  });
  vi.resetModules();
  location = await import("./dozo-phone-location");
}

type LocationFile = typeof import("./dozo-phone-location");
let location: LocationFile;

/** A timer the test runs by hand; the reading never waits on a real one. */
const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
const later = (run: () => void, ms: number) => {
  const timer = { run, ms, cancelled: false };
  timers.push(timer);
  return () => {
    timer.cancelled = true;
  };
};

const fullIos: Grant = { granted: true, ios: { scope: "whenInUse", accuracy: "full" } };
const reducedIos: Grant = { granted: true, ios: { scope: "whenInUse", accuracy: "reduced" } };

beforeEach(async () => {
  vi.resetModules();
  timers.length = 0;
  native.module = {};
  native.platform.OS = "ios";
  vi.doMock("expo-location", () => native.location);
  for (const spy of Object.values(native.location)) {
    if (typeof spy === "function" && "mockClear" in spy) spy.mockClear();
  }
  native.location.getForegroundPermissionsAsync.mockResolvedValue(fullIos);
  native.location.requestForegroundPermissionsAsync.mockResolvedValue(fullIos);
  native.location.getCurrentPositionAsync.mockResolvedValue(reading());
  location = await import("./dozo-phone-location");
});

function neverInBackground() {
  expect(native.location.getBackgroundPermissionsAsync).not.toHaveBeenCalled();
  expect(native.location.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
  expect(native.location.watchPositionAsync).not.toHaveBeenCalled();
  expect(native.location.getLastKnownPositionAsync).not.toHaveBeenCalled();
  expect(native.location.startLocationUpdatesAsync).not.toHaveBeenCalled();
}

describe("reading the phone's location", () => {
  it("answers approximate with a low-accuracy reading, rounded to about a kilometre", async () => {
    const value = await location.readLocation({ precision: "approximate" }, later);
    expect(native.location.getCurrentPositionAsync).toHaveBeenCalledTimes(1);
    expect(native.location.getCurrentPositionAsync).toHaveBeenCalledWith({ accuracy: 2 });
    expect(value).toEqual({
      latitude: 41.01,
      longitude: 28.98,
      accuracyMeters: 1000,
      precise: false,
      at: "2026-11-23T09:00:00.000Z",
    });
    neverInBackground();
  });

  it("keeps a coarser accuracy than a kilometre, and rounds negative coordinates", async () => {
    native.location.getCurrentPositionAsync.mockResolvedValueOnce(
      reading({ latitude: -33.868_82, longitude: -151.209_29, accuracy: 3_210.6 }),
    );
    expect(await location.readLocation({ precision: "approximate" }, later)).toMatchObject({
      latitude: -33.87,
      longitude: -151.21,
      accuracyMeters: 3211,
    });
  });

  it("answers precise with a high-accuracy reading when the system granted precise", async () => {
    const value = await location.readLocation({ precision: "precise" }, later);
    expect(native.location.getCurrentPositionAsync).toHaveBeenCalledWith({ accuracy: 4 });
    expect(value).toEqual({
      latitude: 41.008_712,
      longitude: 28.978_359,
      accuracyMeters: 13,
      precise: true,
      at: "2026-11-23T09:00:00.000Z",
    });
    native.location.getForegroundPermissionsAsync.mockResolvedValueOnce({
      granted: true,
      android: { accuracy: "fine" },
    });
    expect((await location.readLocation({ precision: "precise" }, later)).precise).toBe(true);
    neverInBackground();
  });

  it.each([
    ["iOS reduced accuracy", reducedIos],
    ["Android coarse", { granted: true, android: { accuracy: "coarse" } } as Grant],
    ["no accuracy detail", { granted: true } as Grant],
  ])("answers precise as approximate under %s", async (_name, grant) => {
    native.location.getForegroundPermissionsAsync.mockResolvedValueOnce(grant);
    const value = await location.readLocation({ precision: "precise" }, later);
    expect(native.location.getCurrentPositionAsync).toHaveBeenCalledWith({ accuracy: 2 });
    expect(value).toMatchObject({
      latitude: 41.01,
      longitude: 28.98,
      accuracyMeters: 1000,
      precise: false,
    });
  });

  it("answers a precise reading without a known accuracy as approximate", async () => {
    native.location.getCurrentPositionAsync.mockResolvedValueOnce(reading({ accuracy: null }));
    expect(await location.readLocation({ precision: "precise" }, later)).toMatchObject({
      latitude: 41.01,
      accuracyMeters: 1000,
      precise: false,
    });
  });

  it("refuses without the system's permission, and never asks for it", async () => {
    native.location.getForegroundPermissionsAsync.mockResolvedValueOnce({ granted: false });
    await expect(location.readLocation({ precision: "approximate" }, later)).rejects.toMatchObject({
      code: "location-permission",
    });
    expect(native.location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(native.location.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it("gives up after 10 seconds without a fix, and stops waiting once it has one", async () => {
    const fix = deferred<Reading>();
    native.location.getCurrentPositionAsync.mockReturnValueOnce(fix.promise);
    const read = location.readLocation({ precision: "approximate" }, later);
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(timers[0]!.ms).toBe(10_000);
    timers[0]!.run();
    await expect(read).rejects.toMatchObject({ code: "location-unavailable" });
    fix.resolve(reading());

    await location.readLocation({ precision: "approximate" }, later);
    expect(timers[1]!.cancelled).toBe(true);
  });

  it.each([
    ["a build without the module", () => (native.module = null)],
    ["a module that fails to load", withoutNativeModule],
    [
      "no fix",
      () => native.location.getCurrentPositionAsync.mockRejectedValueOnce(new Error("no fix")),
    ],
    [
      "a reading without coordinates",
      () =>
        native.location.getCurrentPositionAsync.mockResolvedValueOnce(
          reading({ latitude: Number.NaN }),
        ),
    ],
    [
      "a reading without a time",
      () =>
        native.location.getCurrentPositionAsync.mockResolvedValueOnce(
          reading({}, Number.POSITIVE_INFINITY),
        ),
    ],
    [
      "a failing permission call",
      () => native.location.getForegroundPermissionsAsync.mockRejectedValueOnce(new Error("boom")),
    ],
  ])("is unavailable with %s", async (_name, arrange) => {
    await arrange();
    await expect(location.readLocation({ precision: "approximate" }, later)).rejects.toMatchObject({
      code: "location-unavailable",
    });
  });

  it("loads the module once a failed load is over", async () => {
    await withoutNativeModule();
    expect(await location.locationPermission()).toBe("unavailable");
    vi.doMock("expo-location", () => native.location);
    expect(await location.locationPermission()).toBe("granted");
  });
});

describe("the location permission", () => {
  it("is unavailable in a build without the module, and never asked there", async () => {
    native.module = null;
    expect(location.locationAvailable()).toBe(false);
    expect(await location.locationPermission()).toBe("unavailable");
    expect(await location.requestLocationPermission()).toBe("unavailable");
    expect(native.location.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it("asks only while the app is in use, never in the background", async () => {
    expect(location.locationAvailable()).toBe(true);
    expect(await location.requestLocationPermission()).toBe("granted");
    native.location.requestForegroundPermissionsAsync.mockResolvedValueOnce({ granted: false });
    expect(await location.requestLocationPermission()).toBe("denied");
    native.location.getForegroundPermissionsAsync.mockResolvedValueOnce({ granted: false });
    expect(await location.locationPermission()).toBe("denied");
    neverInBackground();
  });

  it("reads a failing permission call as unavailable", async () => {
    native.location.getForegroundPermissionsAsync.mockRejectedValueOnce(new Error("boom"));
    expect(await location.locationPermission()).toBe("unavailable");
    native.location.requestForegroundPermissionsAsync.mockRejectedValueOnce(new Error("boom"));
    expect(await location.requestLocationPermission()).toBe("unavailable");
  });

  it("is not offered on the web", () => {
    native.platform.OS = "web";
    expect(location.locationAvailable()).toBe(false);
  });
});
