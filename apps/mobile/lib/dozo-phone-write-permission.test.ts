import { beforeEach, expect, it, vi } from "vitest";

const READ = "android.permission.READ_CALENDAR";
const WRITE = "android.permission.WRITE_CALENDAR";

const android = vi.hoisted(() => ({
  granted: new Set<string>(),
  check: vi.fn(async (name: string) => android.granted.has(name)),
  requestMultiple: vi.fn(async (names: string[]) =>
    Object.fromEntries(names.map((name) => [name, android.answer(name)])),
  ),
  answer: (_name: string): string => "granted",
}));

vi.mock("react-native", () => ({
  PermissionsAndroid: {
    PERMISSIONS: { READ_CALENDAR: READ, WRITE_CALENDAR: WRITE },
    RESULTS: { GRANTED: "granted" },
    check: android.check,
    requestMultiple: android.requestMultiple,
  },
}));

beforeEach(() => {
  android.granted = new Set([READ, WRITE]);
  android.answer = () => "granted";
  android.check.mockClear();
  android.requestMultiple.mockClear();
});

it("leaves the asking to the calendar module outside Android", async () => {
  const { writePermission } = await import("./dozo-phone-write-permission");
  expect(writePermission).toBeNull();
});

it("checks and asks Android for writing the calendar with the reading it needs", async () => {
  const { writePermission } = await import("./dozo-phone-write-permission.android");
  expect(await writePermission?.check()).toBe(true);
  android.granted.delete(WRITE);
  expect(await writePermission?.check()).toBe(false);
  expect(await writePermission?.request()).toBe(true);
  expect(android.requestMultiple).toHaveBeenCalledWith([READ, WRITE]);
  android.answer = (name) => (name === WRITE ? "never_ask_again" : "granted");
  expect(await writePermission?.request()).toBe(false);
});
