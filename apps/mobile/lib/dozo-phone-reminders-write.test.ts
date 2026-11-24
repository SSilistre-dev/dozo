import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  module: {} as object | null,
  platform: { OS: "ios" },
  next: {
    getRemindersPermissions: vi.fn(async () => ({ granted: true })),
    requestRemindersPermissions: vi.fn(async () => ({ granted: true })),
    getCalendars: vi.fn(async (): Promise<unknown[]> => []),
    EntityTypes: { EVENT: "event", REMINDER: "reminder" },
  },
  legacy: {
    getCalendarsAsync: vi.fn(
      async (): Promise<Array<{ id: string; title: string | null }>> => [
        { id: "work", title: "Work" },
        { id: "shop", title: "Shopping" },
        { id: "inbox", title: "Reminders" },
      ],
    ),
    createReminderAsync: vi.fn(async () => "created-1"),
    getReminderAsync: vi.fn(async () => ({
      id: "created-1",
      calendarId: "inbox",
      title: "read back",
      notes: "read back",
    })),
    EntityTypes: { EVENT: "event", REMINDER: "reminder" },
  },
}));

vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: (name: string) => (name === "CalendarNext" ? native.module : null),
}));
vi.mock("react-native", () => ({ Platform: native.platform }));
vi.mock("./dozo-phone-read-permission", () => ({ readPermission: null }));

type WriteFile = typeof import("./dozo-phone-reminders-write");
let write: WriteFile;

beforeEach(async () => {
  vi.resetModules();
  native.module = {};
  native.platform.OS = "ios";
  vi.doMock("expo-calendar", () => native.next);
  vi.doMock("expo-calendar/legacy", () => native.legacy);
  native.next.getRemindersPermissions.mockClear().mockResolvedValue({ granted: true });
  native.legacy.getCalendarsAsync.mockClear();
  native.legacy.createReminderAsync.mockClear();
  native.legacy.getReminderAsync.mockClear();
  write = await import("./dozo-phone-reminders-write");
});

/**
 * The same write samples, row for row, in the server's tests (packages/adapters/src/
 * dozo-phone-write.test.ts) and here: each side runs them through its own path, so the phone and
 * the server accept and refuse the same items. Items are as the wire carries them, at NOW.
 */
const REMINDER_SAMPLES: Array<[string, Record<string, unknown>, boolean]> = [
  ["a reminder", { title: "Buy milk" }, true],
  ["one due at a time", { title: "Buy milk", due: "2026-11-24T09:00:00+00:00" }, true],
  ["one due without an offset", { title: "Buy milk", due: "2026-11-24T09:00:00" }, false],
  ["one due on a date", { title: "Buy milk", due: "2026-11-24" }, false],
  ["no title", { title: "" }, false],
  ["a list of 100", { title: "Buy milk", list: "l".repeat(100) }, true],
  ["a list of 101", { title: "Buy milk", list: "l".repeat(101) }, false],
  ["notes of 1001", { title: "Buy milk", notes: "n".repeat(1001) }, false],
  ["an id", { title: "Buy milk", id: "r-1" }, false],
  ["alarms", { title: "Buy milk", alarms: [1] }, false],
];

describe("checking a reminder before it is written", () => {
  it.each(REMINDER_SAMPLES)("%s: accepted %s", async (_name, item, ok) => {
    // An accepted item may still name a list the phone does not have: only "invalid" is the check's.
    const code = await write.createReminder(item).then(
      () => undefined,
      (error: { code: string }) => error.code,
    );
    expect(code === "reminders-write-invalid").toBe(!ok);
  });

  it("refuses what is not a reminder", () => {
    expect(write.reminderInput(undefined)).toBeNull();
  });
});

describe("adding a reminder", () => {
  it("adds it to the named list and answers that list's name", async () => {
    expect(
      await write.createReminder({
        title: "Buy milk",
        due: "2026-11-24T09:00:00.000Z",
        notes: "Oat",
        list: " shopping ",
      }),
    ).toEqual({ created: true, list: "Shopping" });
    expect(native.legacy.getCalendarsAsync).toHaveBeenCalledWith("reminder");
    expect(native.legacy.createReminderAsync).toHaveBeenCalledWith("shop", {
      title: "Buy milk",
      dueDate: new Date("2026-11-24T09:00:00.000Z"),
      notes: "Oat",
    });
    expect(native.legacy.getReminderAsync).not.toHaveBeenCalled();
  });

  it("writes nothing when the named list is not there, and says so", async () => {
    await expect(
      write.createReminder({ title: "Call Ada", list: "Errands" }),
    ).rejects.toMatchObject({ code: "reminders-write-list" });
    expect(native.legacy.createReminderAsync).not.toHaveBeenCalled();
  });

  it("adds it to the default list when no list is named, and names that list", async () => {
    expect(await write.createReminder({ title: "Call Ada" })).toEqual({
      created: true,
      list: "Reminders",
    });
    expect(native.legacy.createReminderAsync).toHaveBeenCalledWith(null, { title: "Call Ada" });
    expect(native.legacy.getReminderAsync).toHaveBeenCalledWith("created-1");
  });

  it("refuses a reminder it cannot check, before anything else", async () => {
    await expect(write.createReminder({ title: "" })).rejects.toMatchObject({
      code: "reminders-write-invalid",
    });
    expect(native.next.getRemindersPermissions).not.toHaveBeenCalled();
    expect(native.legacy.createReminderAsync).not.toHaveBeenCalled();
  });

  it("refuses without the system's permission", async () => {
    native.next.getRemindersPermissions.mockResolvedValueOnce({ granted: false });
    await expect(write.createReminder({ title: "A" })).rejects.toMatchObject({
      code: "reminders-write-permission",
    });
    expect(native.legacy.createReminderAsync).not.toHaveBeenCalled();
  });

  it.each([
    ["Android", () => (native.platform.OS = "android")],
    ["a build without the module", () => (native.module = null)],
    [
      "a module that fails to load",
      () =>
        vi.doMock("expo-calendar/legacy", () => {
          throw new Error("Cannot find native module 'ExpoCalendar'");
        }),
    ],
    [
      "a failed write",
      () => native.legacy.createReminderAsync.mockRejectedValueOnce(new Error("boom")),
    ],
  ])("is unavailable on %s", async (_name, arrange) => {
    arrange();
    await expect(write.createReminder({ title: "A" })).rejects.toMatchObject({
      code: "reminders-write-unavailable",
    });
  });

  it("still answers created when the default list's name cannot be found", async () => {
    native.legacy.getReminderAsync.mockRejectedValueOnce(new Error("gone"));
    expect(await write.createReminder({ title: "A" })).toEqual({ created: true, list: "" });
  });
});
