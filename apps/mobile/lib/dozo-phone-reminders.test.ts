import { beforeEach, describe, expect, it, vi } from "vitest";

type NativeReminder = Record<string, unknown>;

const native = vi.hoisted(() => {
  const list = (id: string, title: string | null) => ({
    id,
    title,
    listReminders: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  });
  const lists = { work: list("work", "Work"), home: list("home", "Home") };
  return {
    module: {} as object | null,
    platform: { OS: "ios" },
    list,
    lists,
    calendar: {
      getRemindersPermissions: vi.fn(async () => ({ granted: true })),
      requestRemindersPermissions: vi.fn(async () => ({ granted: true })),
      getCalendars: vi.fn(
        async (): Promise<Array<ReturnType<typeof list>>> => [lists.work, lists.home],
      ),
      EntityTypes: { EVENT: "event", REMINDER: "reminder" },
    },
  };
});

vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: (name: string) => (name === "CalendarNext" ? native.module : null),
}));
vi.mock("react-native", () => ({ Platform: native.platform }));
vi.mock("./dozo-phone-read-permission", () => ({ readPermission: null }));

type RemindersFile = typeof import("./dozo-phone-reminders");
let reminders: RemindersFile;

const reminder = (extra: NativeReminder): NativeReminder => ({
  title: "Reminder",
  dueDate: "2026-11-23T09:00:00.000Z",
  completed: false,
  ...extra,
});
const request = { includeDone: false, limit: 50 };

beforeEach(async () => {
  vi.resetModules();
  native.module = {};
  native.platform.OS = "ios";
  vi.doMock("expo-calendar", () => native.calendar);
  native.calendar.getRemindersPermissions.mockClear().mockResolvedValue({ granted: true });
  native.calendar.requestRemindersPermissions.mockClear().mockResolvedValue({ granted: true });
  native.calendar.getCalendars.mockClear();
  native.lists.work.listReminders.mockReset().mockResolvedValue([]);
  native.lists.home.listReminders.mockReset().mockResolvedValue([]);
  reminders = await import("./dozo-phone-reminders");
});

describe("the reminders' value", () => {
  const entry = (extra: NativeReminder, list: string | null = "Work") => ({
    reminder: reminder(extra),
    list,
  });

  it("sends only the contract's fields, even when the system returns more", () => {
    const value = reminders.remindersValue(
      [
        entry({
          title: "Pay rent",
          notes: "account 123",
          url: "https://bank.example.test",
          id: "r-1",
          location: "Home",
          priority: 1,
          alarms: [{ relativeOffset: -15 }],
          calendarId: "work",
        }),
      ],
      request,
      null,
    );
    expect(value).toEqual({
      reminders: [
        { title: "Pay rent", due: "2026-11-23T09:00:00.000Z", done: false, list: "Work" },
      ],
      truncated: false,
    });
  });

  it("leaves done ones out unless asked, sorts by due with undated last, and keeps the first `limit`", () => {
    const native = [
      entry({ title: "Undated", dueDate: null }),
      entry({ title: "Late", dueDate: "2026-11-25T09:00:00.000Z" }),
      entry({ title: "Done", completed: true, dueDate: "2026-11-22T09:00:00.000Z" }),
      entry({ title: "Early", dueDate: new Date("2026-11-23T08:00:00.000Z") }),
    ];
    expect(reminders.remindersValue(native, request, null).reminders.map((r) => r.title)).toEqual([
      "Early",
      "Late",
      "Undated",
    ]);
    const all = reminders.remindersValue(native, { includeDone: true, limit: 2 }, null);
    expect(all.reminders).toEqual([
      { title: "Done", due: "2026-11-22T09:00:00.000Z", done: true, list: "Work" },
      { title: "Early", due: "2026-11-23T08:00:00.000Z", done: false, list: "Work" },
    ]);
    expect(all.truncated).toBe(true);
  });

  it("keeps only reminders due inside the window when one is asked", () => {
    const window = {
      from: new Date("2026-11-23T00:00:00.000Z"),
      to: new Date("2026-11-24T00:00:00.000Z"),
    };
    const value = reminders.remindersValue(
      [
        entry({ title: "In" }),
        entry({ title: "Undated", dueDate: null }),
        entry({ title: "Before", dueDate: "2026-11-22T23:59:00.000Z" }),
        entry({ title: "At the end", dueDate: "2026-11-24T00:00:00.000Z" }),
      ],
      request,
      window,
    );
    expect(value.reminders.map((r) => r.title)).toEqual(["In"]);
  });

  it("caps each text and the number, takes links out, and leaves out what is empty", () => {
    const many = Array.from({ length: 60 }, () =>
      entry({ title: "t".repeat(300) }, "l".repeat(150)),
    );
    const value = reminders.remindersValue(
      [
        ...many,
        entry({ title: "Call https://x.example/j/1?pwd=abc", dueDate: "nope" }, null),
        entry({ title: null }, ""),
      ],
      { includeDone: false, limit: 500 },
      null,
    );
    expect(value.reminders).toHaveLength(50);
    expect(value.truncated).toBe(true);
    expect(value.reminders[0]!.title).toHaveLength(200);
    expect(value.reminders[0]!.list).toHaveLength(100);
    const small = reminders.remindersValue(
      [
        entry({ title: "Call https://x.example/j/1?pwd=abc", dueDate: "nope" }, null),
        entry({ title: null, dueDate: undefined }, ""),
      ],
      request,
      null,
    );
    expect(small.reminders).toEqual([
      { title: "Call", done: false },
      { title: "", done: false },
    ]);
  });
});

describe("reading the phone's reminders", () => {
  it("reads every list, done ones too, and names each reminder's list", async () => {
    native.lists.work.listReminders.mockResolvedValueOnce([reminder({ title: "A" })]);
    native.lists.home.listReminders.mockResolvedValueOnce([
      reminder({ title: "B", dueDate: "2026-11-23T08:00:00.000Z" }),
      reminder({ title: "C", completed: true }),
    ]);
    const value = await reminders.readReminders({ includeDone: true, limit: 50 });
    expect(native.calendar.getCalendars).toHaveBeenCalledWith("reminder");
    expect(native.lists.work.listReminders).toHaveBeenCalledWith(null, null, null);
    expect(value.reminders).toEqual([
      { title: "B", due: "2026-11-23T08:00:00.000Z", done: false, list: "Home" },
      { title: "A", due: "2026-11-23T09:00:00.000Z", done: false, list: "Work" },
      { title: "C", due: "2026-11-23T09:00:00.000Z", done: true, list: "Home" },
    ]);
  });

  it("reads only the named list, whatever its case and spacing", async () => {
    await reminders.readReminders({ ...request, list: "  home\n" });
    expect(native.lists.home.listReminders).toHaveBeenCalled();
    expect(native.lists.work.listReminders).not.toHaveBeenCalled();
    expect(await reminders.readReminders({ ...request, list: "Groceries" })).toEqual({
      reminders: [],
      truncated: false,
    });
  });

  it("reads at most 31 days of due dates", async () => {
    native.lists.work.listReminders.mockResolvedValueOnce([
      reminder({ title: "Inside", dueDate: "2026-12-20T00:00:00.000Z" }),
      reminder({ title: "Past 31 days", dueDate: "2026-12-25T00:00:00.000Z" }),
    ]);
    const value = await reminders.readReminders({
      ...request,
      due: { from: "2026-11-23T00:00:00.000Z", to: "2027-06-01T00:00:00.000Z" },
    });
    expect(value.reminders.map((r) => r.title)).toEqual(["Inside"]);
  });

  it("refuses without the system's permission", async () => {
    native.calendar.getRemindersPermissions.mockResolvedValueOnce({ granted: false });
    await expect(reminders.readReminders(request)).rejects.toMatchObject({
      code: "reminders-permission",
    });
    expect(native.calendar.getCalendars).not.toHaveBeenCalled();
  });

  const badWindow = { ...request, due: { from: "nope", to: "2026-11-24T00:00:00.000Z" } };
  it.each([
    ["Android", request, () => (native.platform.OS = "android")],
    ["a build without the module", request, () => (native.module = null)],
    [
      "a module that fails to load",
      request,
      () =>
        vi.doMock("expo-calendar", () => {
          throw new Error("Cannot find native module 'CalendarNext'");
        }),
    ],
    [
      "a failed read",
      request,
      () => native.lists.work.listReminders.mockRejectedValueOnce(new Error("boom")),
    ],
    ["a due window it cannot read", badWindow, () => undefined],
  ])("is unavailable on %s", async (_name, asked, arrange) => {
    arrange();
    await expect(reminders.readReminders(asked)).rejects.toMatchObject({
      code: "reminders-unavailable",
    });
  });
});

describe("the system permission", () => {
  it("is iOS only and asks for reminders on its own", async () => {
    expect(reminders.remindersAvailable()).toBe(true);
    expect(await reminders.requestRemindersPermission()).toBe("granted");
    expect(native.calendar.requestRemindersPermissions).toHaveBeenCalledTimes(1);
    native.calendar.requestRemindersPermissions.mockResolvedValueOnce({ granted: false });
    expect(await reminders.requestRemindersPermission()).toBe("denied");
    native.calendar.getRemindersPermissions.mockResolvedValueOnce({ granted: false });
    expect(await reminders.remindersPermission()).toBe("denied");
    native.platform.OS = "android";
    expect(reminders.remindersAvailable()).toBe(false);
    expect(await reminders.remindersPermission()).toBe("unavailable");
    expect(await reminders.requestRemindersPermission()).toBe("unavailable");
    expect(native.calendar.requestRemindersPermissions).toHaveBeenCalledTimes(2);
  });

  it("reads a failing permission call as unavailable", async () => {
    native.calendar.getRemindersPermissions.mockRejectedValueOnce(new Error("boom"));
    expect(await reminders.remindersPermission()).toBe("unavailable");
    native.calendar.requestRemindersPermissions.mockRejectedValueOnce(new Error("boom"));
    expect(await reminders.requestRemindersPermission()).toBe("unavailable");
  });

  it("loads the module once a failed load is over", async () => {
    vi.doMock("expo-calendar", () => {
      throw new Error("Cannot find native module 'CalendarNext'");
    });
    vi.resetModules();
    reminders = await import("./dozo-phone-reminders");
    expect(await reminders.remindersPermission()).toBe("unavailable");
    vi.doMock("expo-calendar", () => native.calendar);
    expect(await reminders.remindersPermission()).toBe("granted");
  });
});
