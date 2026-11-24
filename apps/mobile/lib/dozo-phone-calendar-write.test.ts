import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");

const native = vi.hoisted(() => {
  const target = (title: string | null, extra: Record<string, unknown> = {}) => ({
    id: `id-${title}`,
    title,
    allowsModifications: true,
    createEvent: vi.fn(async () => ({ id: "created", title: "read back" })),
    ...extra,
  });
  return {
    module: {} as object | null,
    platform: { OS: "ios" },
    target,
    write: null as null | { check: () => Promise<boolean>; request: () => Promise<boolean> },
    androidCheck: vi.fn(async () => true),
    androidRequest: vi.fn(async () => true),
    defaultCalendar: target("Home"),
    calendar: {
      getCalendarPermissions: vi.fn(async () => ({ granted: true })),
      requestCalendarPermissions: vi.fn(async () => ({ granted: true })),
      getDefaultCalendarSync: vi.fn((): unknown => undefined),
      getCalendars: vi.fn(async (): Promise<unknown[]> => []),
      EntityTypes: { EVENT: "event", REMINDER: "reminder" },
    },
  };
});

vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: (name: string) => (name === "CalendarNext" ? native.module : null),
}));
vi.mock("react-native", () => ({ Platform: native.platform }));
vi.mock("./dozo-phone-read-permission", () => ({ readPermission: null }));
vi.mock("./dozo-phone-write-permission", () => ({
  get writePermission() {
    return native.write;
  },
}));

type WriteFile = typeof import("./dozo-phone-calendar-write");
let write: WriteFile;

const event = {
  title: "Dentist",
  start: "2026-11-24T09:00:00.000Z",
  end: "2026-11-24T10:00:00.000Z",
  allDay: false,
};

beforeEach(async () => {
  vi.resetModules();
  native.module = {};
  native.platform.OS = "ios";
  native.write = null;
  native.defaultCalendar = native.target("Home");
  vi.doMock("expo-calendar", () => native.calendar);
  native.calendar.getCalendarPermissions.mockClear().mockResolvedValue({ granted: true });
  native.calendar.requestCalendarPermissions.mockClear().mockResolvedValue({ granted: true });
  native.calendar.getDefaultCalendarSync
    .mockReset()
    .mockImplementation(() => native.defaultCalendar);
  native.calendar.getCalendars.mockReset().mockResolvedValue([]);
  native.androidCheck.mockClear().mockResolvedValue(true);
  native.androidRequest.mockClear().mockResolvedValue(true);
  write = await import("./dozo-phone-calendar-write");
});

/**
 * The same write samples, row for row, in the server's tests (packages/adapters/src/
 * dozo-phone-write.test.ts) and here: each side runs them through its own path, so the phone and
 * the server accept and refuse the same items. Items are as the wire carries them, at NOW.
 */
const TIMED = {
  title: "Dentist",
  start: "2026-11-24T09:00:00+00:00",
  end: "2026-11-24T10:00:00+00:00",
  allDay: false,
};
const EVENT_SAMPLES: Array<[string, Record<string, unknown>, boolean]> = [
  ["a timed event", TIMED, true],
  ["an all-day day", { title: "Trip", start: "2026-12-01", end: "2026-12-02", allDay: true }, true],
  ["an all-day event given times", { ...TIMED, allDay: true }, false],
  ["a timed event given dates", { ...TIMED, start: "2026-12-01", end: "2026-12-02" }, false],
  [
    "a time without an offset",
    { ...TIMED, start: "2026-11-24T09:00:00", end: "2026-11-24T10:00:00" },
    false,
  ],
  [
    "a date that does not exist",
    { title: "Trip", start: "2026-02-30", end: "2026-03-01", allDay: true },
    false,
  ],
  ["a title of 200", { ...TIMED, title: "t".repeat(200) }, true],
  ["a title of 201", { ...TIMED, title: "t".repeat(201) }, false],
  ["a location of 201", { ...TIMED, location: "l".repeat(201) }, false],
  ["notes of 1000", { ...TIMED, notes: "n".repeat(1000) }, true],
  ["notes of 1001", { ...TIMED, notes: "n".repeat(1001) }, false],
  ["31 days", { ...TIMED, end: "2026-12-25T09:00:00+00:00" }, true],
  ["over 31 days", { ...TIMED, end: "2026-12-25T09:00:01+00:00" }, false],
  ["an end at the start", { ...TIMED, end: TIMED.start }, false],
  [
    "a start a day ago",
    { ...TIMED, start: "2026-11-22T12:00:00+00:00", end: "2026-11-22T13:00:00+00:00" },
    true,
  ],
  [
    "a start over a day ago",
    { ...TIMED, start: "2026-11-22T11:59:00+00:00", end: "2026-11-22T13:00:00+00:00" },
    false,
  ],
  [
    "a start 730 days ahead",
    { ...TIMED, start: "2028-11-22T12:00:00+00:00", end: "2028-11-22T13:00:00+00:00" },
    true,
  ],
  [
    "a start past 730 days",
    { ...TIMED, start: "2028-11-22T12:00:01+00:00", end: "2028-11-22T13:00:00+00:00" },
    false,
  ],
  [
    "a repeat by count",
    { ...TIMED, recurrence: { frequency: "weekly", interval: 2, count: 10 } },
    true,
  ],
  [
    "a repeat until a time",
    {
      ...TIMED,
      recurrence: { frequency: "daily", interval: 1, until: "2026-12-24T09:00:00+00:00" },
    },
    true,
  ],
  [
    "an all-day repeat until a date",
    {
      title: "Gym",
      start: "2026-12-01",
      end: "2026-12-02",
      allDay: true,
      recurrence: { frequency: "weekly", interval: 1, until: "2027-01-01" },
    },
    true,
  ],
  [
    "a repeat by count and until",
    {
      ...TIMED,
      recurrence: { frequency: "daily", interval: 1, count: 3, until: "2026-12-24T09:00:00+00:00" },
    },
    false,
  ],
  [
    "a repeat that never ends",
    { ...TIMED, recurrence: { frequency: "daily", interval: 1 } },
    false,
  ],
  [
    "an interval of 31",
    { ...TIMED, recurrence: { frequency: "daily", interval: 31, count: 2 } },
    false,
  ],
  [
    "a count of 366",
    { ...TIMED, recurrence: { frequency: "daily", interval: 1, count: 366 } },
    false,
  ],
  [
    "an until before the start",
    {
      ...TIMED,
      recurrence: { frequency: "daily", interval: 1, until: "2026-11-23T00:00:00+00:00" },
    },
    false,
  ],
  [
    "a repeat by weekday",
    { ...TIMED, recurrence: { frequency: "weekly", interval: 1, count: 2, byDay: ["MO"] } },
    false,
  ],
  ["attendees", { ...TIMED, attendees: ["ada@example.test"] }, false],
  ["an id", { ...TIMED, id: "event-1" }, false],
  ["an eventId", { ...TIMED, eventId: "event-1" }, false],
  ["a link", { ...TIMED, url: "https://example.test" }, false],
];

describe("checking an event before it is written", () => {
  it.each(EVENT_SAMPLES)("%s: accepted %s", async (_name, item, ok) => {
    const written = write.createCalendarEvent(item, NOW);
    if (ok) await expect(written).resolves.toEqual({ created: true, calendar: "Home" });
    else await expect(written).rejects.toMatchObject({ code: "calendar-write-invalid" });
  });

  it("refuses what is not an event", () => {
    expect(write.eventInput(null, NOW)).toBeNull();
    expect(write.eventInput({ ...event, allDay: "yes" }, NOW)).toBeNull();
  });
});

describe("an all-day event", () => {
  const holiday = { title: "Holiday", start: "2026-03-01", end: "2026-03-02", allDay: true };
  const MARCH = Date.parse("2026-02-27T12:00:00.000Z");
  const zone = process.env.TZ;
  afterEach(() => {
    process.env.TZ = zone;
  });

  it.each(["America/Los_Angeles", "Asia/Tokyo", "UTC"])(
    "lands on its date in %s, on iOS at the phone's own midnight",
    async (where) => {
      process.env.TZ = where;
      await write.createCalendarEvent(holiday, MARCH);
      const calls = native.defaultCalendar.createEvent.mock.calls as unknown as Array<
        [{ startDate: Date; endDate: Date; allDay: boolean }]
      >;
      const { startDate, endDate, allDay } = calls[0]![0];
      expect(allDay).toBe(true);
      const day = (date: Date) => [date.getFullYear(), date.getMonth() + 1, date.getDate()];
      expect(day(startDate)).toEqual([2026, 3, 1]);
      expect([startDate.getHours(), startDate.getMinutes()]).toEqual([0, 0]);
      // EventKit's all-day end is the last day itself.
      expect(day(endDate)).toEqual([2026, 3, 1]);
    },
  );

  it.each(["America/Los_Angeles", "Asia/Tokyo"])(
    "lands on its date in %s, on Android at midnight UTC with the end the day after",
    async (where) => {
      process.env.TZ = where;
      native.platform.OS = "android";
      native.write = { check: native.androidCheck, request: native.androidRequest };
      const primary = native.target("Personal", { isPrimary: true });
      native.calendar.getCalendars.mockResolvedValue([primary]);
      await write.createCalendarEvent(holiday, MARCH);
      expect(primary.createEvent).toHaveBeenCalledWith({
        title: "Holiday",
        startDate: new Date("2026-03-01T00:00:00.000Z"),
        endDate: new Date("2026-03-02T00:00:00.000Z"),
        allDay: true,
        timeZone: "UTC",
      });
    },
  );
});

describe("an all-day event that repeats until a day", () => {
  const daily = {
    title: "Holiday",
    start: "2026-03-01",
    end: "2026-03-02",
    allDay: true,
    recurrence: { frequency: "daily", interval: 1, until: "2026-03-01" },
  };
  const MARCH = Date.parse("2026-02-27T12:00:00.000Z");
  const zone = process.env.TZ;
  afterEach(() => {
    process.env.TZ = zone;
  });
  const rule = (calls: unknown) =>
    (calls as Array<[{ recurrenceRule: { endDate: Date } }]>)[0]![0].recurrenceRule.endDate;

  it.each(["Europe/Istanbul", "Asia/Tokyo", "America/Los_Angeles"])(
    "ends on Android on the day its start is on, at midnight UTC, in %s",
    async (where) => {
      process.env.TZ = where;
      native.platform.OS = "android";
      native.write = { check: native.androidCheck, request: native.androidRequest };
      const primary = native.target("Personal", { isPrimary: true });
      native.calendar.getCalendars.mockResolvedValue([primary]);
      await write.createCalendarEvent(daily, MARCH);
      expect(rule(primary.createEvent.mock.calls)).toEqual(new Date("2026-03-01T00:00:00.000Z"));
    },
  );

  it.each(["Europe/Istanbul", "Asia/Tokyo", "America/Los_Angeles"])(
    "ends on iOS at the phone's own midnight of that day in %s",
    async (where) => {
      process.env.TZ = where;
      await write.createCalendarEvent(daily, MARCH);
      const end = rule(native.defaultCalendar.createEvent.mock.calls);
      expect([end.getFullYear(), end.getMonth() + 1, end.getDate(), end.getHours()]).toEqual([
        2026, 3, 1, 0,
      ]);
    },
  );
});

describe("adding an event to the phone's calendar", () => {
  it("creates it in the default calendar with only the given fields, and answers its name", async () => {
    const value = await write.createCalendarEvent(
      {
        ...event,
        location: "Main St 1",
        notes: "Bring the card",
        recurrence: { frequency: "weekly", interval: 2, until: "2027-01-01T00:00:00.000Z" },
      },
      NOW,
    );
    expect(value).toEqual({ created: true, calendar: "Home" });
    expect(native.defaultCalendar.createEvent).toHaveBeenCalledTimes(1);
    expect(native.defaultCalendar.createEvent).toHaveBeenCalledWith({
      title: "Dentist",
      startDate: new Date(event.start),
      endDate: new Date(event.end),
      allDay: false,
      location: "Main St 1",
      notes: "Bring the card",
      recurrenceRule: {
        frequency: "weekly",
        interval: 2,
        endDate: new Date("2027-01-01T00:00:00.000Z"),
      },
    });
    expect(native.calendar.getCalendars).not.toHaveBeenCalled();
  });

  it("always ends a repeat, by count when no date is given", async () => {
    await write.createCalendarEvent(
      { ...event, recurrence: { frequency: "daily", interval: 1, count: 3 } },
      NOW,
    );
    expect(native.defaultCalendar.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        recurrenceRule: { frequency: "daily", interval: 1, occurrence: 3 },
      }),
    );
  });

  it("names the calendar without its links", async () => {
    native.defaultCalendar = native.target("Team meet.google.com");
    expect(await write.createCalendarEvent(event, NOW)).toEqual({
      created: true,
      calendar: "Team",
    });
  });

  it("uses Android's primary writable calendar, or the first writable one", async () => {
    native.platform.OS = "android";
    native.write = { check: native.androidCheck, request: native.androidRequest };
    const readOnly = native.target("Holidays", { allowsModifications: false, isPrimary: true });
    const other = native.target("Other");
    const primary = native.target("Personal", { isPrimary: true });
    native.calendar.getCalendars.mockResolvedValue([readOnly, other, primary]);
    expect(await write.createCalendarEvent(event, NOW)).toEqual({
      created: true,
      calendar: "Personal",
    });
    expect(native.calendar.getCalendars).toHaveBeenCalledWith("event");
    expect(native.calendar.getDefaultCalendarSync).not.toHaveBeenCalled();
    expect(primary.createEvent).toHaveBeenCalledTimes(1);
    native.calendar.getCalendars.mockResolvedValue([readOnly, other]);
    expect(await write.createCalendarEvent(event, NOW)).toEqual({
      created: true,
      calendar: "Other",
    });
    native.calendar.getCalendars.mockResolvedValue([readOnly]);
    await expect(write.createCalendarEvent(event, NOW)).rejects.toMatchObject({
      code: "calendar-write-unavailable",
    });
    expect(readOnly.createEvent).not.toHaveBeenCalled();
  });

  it("refuses an event it cannot check, before anything else", async () => {
    await expect(write.createCalendarEvent({ ...event, title: "" }, NOW)).rejects.toMatchObject({
      code: "calendar-write-invalid",
    });
    expect(native.calendar.getCalendarPermissions).not.toHaveBeenCalled();
    expect(native.defaultCalendar.createEvent).not.toHaveBeenCalled();
  });

  it("refuses without the system's permission", async () => {
    native.calendar.getCalendarPermissions.mockResolvedValueOnce({ granted: false });
    await expect(write.createCalendarEvent(event, NOW)).rejects.toMatchObject({
      code: "calendar-write-permission",
    });
    expect(native.defaultCalendar.createEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["a build without the module", () => (native.module = null)],
    [
      "a module that fails to load",
      () =>
        vi.doMock("expo-calendar", () => {
          throw new Error("Cannot find native module 'CalendarNext'");
        }),
    ],
    [
      "no default calendar",
      () =>
        native.calendar.getDefaultCalendarSync.mockImplementationOnce(() => {
          throw new Error("no default");
        }),
    ],
    [
      "a failed write",
      () => native.defaultCalendar.createEvent.mockRejectedValueOnce(new Error("boom")),
    ],
  ])("is unavailable on %s", async (_name, arrange) => {
    arrange();
    await expect(write.createCalendarEvent(event, NOW)).rejects.toMatchObject({
      code: "calendar-write-unavailable",
    });
  });
});

describe("the system permission to add events", () => {
  it("is the calendar's full access where the system asks for both at once", async () => {
    expect(await write.calendarWritePermission()).toBe("granted");
    expect(await write.requestCalendarWritePermission()).toBe("granted");
    expect(native.calendar.requestCalendarPermissions).toHaveBeenCalledTimes(1);
    native.calendar.requestCalendarPermissions.mockResolvedValueOnce({ granted: false });
    expect(await write.requestCalendarWritePermission()).toBe("denied");
  });

  it("asks Android for writing only from this switch", async () => {
    native.write = { check: native.androidCheck, request: native.androidRequest };
    expect(await write.calendarWritePermission()).toBe("granted");
    expect(await write.requestCalendarWritePermission()).toBe("granted");
    native.androidRequest.mockResolvedValueOnce(false);
    expect(await write.requestCalendarWritePermission()).toBe("denied");
    native.androidCheck.mockRejectedValueOnce(new Error("boom"));
    expect(await write.calendarWritePermission()).toBe("unavailable");
    expect(native.calendar.requestCalendarPermissions).not.toHaveBeenCalled();
    native.module = null;
    expect(await write.requestCalendarWritePermission()).toBe("unavailable");
  });
});
