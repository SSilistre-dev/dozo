import { beforeEach, expect, it, vi } from "vitest";

const android = vi.hoisted(() => ({
  check: vi.fn(async () => true),
  request: vi.fn(async () => "granted"),
}));

vi.mock("react-native", () => ({
  PermissionsAndroid: {
    PERMISSIONS: { READ_CALENDAR: "android.permission.READ_CALENDAR" },
    RESULTS: { GRANTED: "granted" },
    check: android.check,
    request: android.request,
  },
}));

beforeEach(() => {
  android.check.mockClear();
  android.request.mockClear();
});

it("leaves the asking to the calendar module outside Android", async () => {
  const { readPermission } = await import("./dozo-phone-read-permission");
  expect(readPermission).toBeNull();
});

it("checks and asks Android for reading the calendar alone", async () => {
  const { readPermission } = await import("./dozo-phone-read-permission.android");
  expect(await readPermission?.check()).toBe(true);
  expect(android.check).toHaveBeenCalledWith("android.permission.READ_CALENDAR");
  expect(await readPermission?.request()).toBe(true);
  expect(android.request).toHaveBeenCalledWith("android.permission.READ_CALENDAR");
  android.request.mockResolvedValueOnce("never_ask_again");
  expect(await readPermission?.request()).toBe(false);
});
