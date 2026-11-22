import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  module: {} as object | null,
  platform: { OS: "ios" },
  read: null as null | { check: () => Promise<boolean>; request: () => Promise<boolean> },
  androidCheck: vi.fn(async () => true),
  androidRequest: vi.fn(async () => true),
  calendar: {
    getCalendarPermissions: vi.fn(async () => ({ granted: true })),
    requestCalendarPermissions: vi.fn(async () => ({ granted: true })),
    getCalendars: vi.fn(
      async (): Promise<Array<{ id: string; title?: string | null }>> => [
        { id: "work", title: "Work" },
        { id: "home", title: null },
      ],
    ),
    listEvents: vi.fn(async (): Promise<unknown[]> => []),
    EntityTypes: { EVENT: "event" },
  },
}));

vi.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: (name: string) => (name === "CalendarNext" ? native.module : null),
}));
vi.mock("react-native", () => ({ Platform: native.platform }));
vi.mock("./dozo-phone-read-permission", () => ({
  get readPermission() {
    return native.read;
  },
}));
vi.mock("expo-calendar", () => native.calendar);

async function withoutNativeModule() {
  vi.doMock("expo-calendar", () => {
    throw new Error("Cannot find native module 'CalendarNext'");
  });
  vi.resetModules();
  calendar = await import("./dozo-phone-calendar");
}

type CalendarFile = typeof import("./dozo-phone-calendar");
let calendar: CalendarFile;

const request = { from: "2026-11-23T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z", limit: 50 };
const event = (extra: Record<string, unknown>) => ({
  title: "Event",
  location: null,
  startDate: "2026-11-23T09:00:00.000Z",
  endDate: "2026-11-23T10:00:00.000Z",
  allDay: false,
  calendarId: "work",
  ...extra,
});

beforeEach(async () => {
  vi.resetModules();
  native.module = {};
  native.platform.OS = "ios";
  native.read = null;
  vi.doMock("expo-calendar", () => native.calendar);
  native.calendar.getCalendarPermissions.mockClear().mockResolvedValue({ granted: true });
  native.calendar.requestCalendarPermissions.mockClear().mockResolvedValue({ granted: true });
  native.calendar.listEvents.mockClear().mockResolvedValue([]);
  native.calendar.getCalendars.mockClear();
  native.androidCheck.mockClear().mockResolvedValue(true);
  native.androidRequest.mockClear().mockResolvedValue(true);
  calendar = await import("./dozo-phone-calendar");
});

describe("the calendar's value", () => {
  it("sends only the contract's fields, even when the system returns more", () => {
    const names = new Map([["work", "Work"]]);
    const value = calendar.calendarValue(
      [
        {
          ...event({ title: "Dentist", location: "Main St 1" }),
          notes: "bring the card",
          attendees: [{ email: "someone@example.test" }],
          url: "https://example.test/meeting",
          id: "event-1",
          alarms: [{ relativeOffset: -15 }],
          recurrenceRule: { frequency: "weekly" },
          organizer: { email: "boss@example.test" },
        } as never,
      ],
      names,
      request,
    );
    expect(value).toEqual({
      events: [
        {
          title: "Dentist",
          start: "2026-11-23T09:00:00.000Z",
          end: "2026-11-23T10:00:00.000Z",
          allDay: false,
          location: "Main St 1",
          calendar: "Work",
        },
      ],
      truncated: false,
    });
  });

  it("filters by title or location, sorts by start and keeps the first `limit`", () => {
    const value = calendar.calendarValue(
      [
        event({ title: "Late lunch", startDate: "2026-11-23T15:00:00.000Z" }),
        event({ title: "Gym", location: "Lunch Hall", startDate: "2026-11-23T12:00:00.000Z" }),
        event({ title: "LUNCH", startDate: new Date("2026-11-23T11:00:00.000Z") }),
        event({ title: "Standup", startDate: "2026-11-23T08:00:00.000Z" }),
      ],
      new Map(),
      { ...request, query: "lunch", limit: 2 },
    );
    expect(value.events.map((entry) => entry.title)).toEqual(["LUNCH", "Gym"]);
    expect(value.truncated).toBe(true);
  });

  it("caps each text and the number of events, and skips events without times", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      event({ title: `${"t".repeat(300)}${index}`, location: "l".repeat(300) }),
    );
    const value = calendar.calendarValue(
      [...many, event({ startDate: "not a date" }), event({ endDate: null })],
      new Map([["work", "c".repeat(150)]]),
      { ...request, limit: 500 },
    );
    expect(value.events).toHaveLength(50);
    expect(value.truncated).toBe(true);
    expect(value.events[0]!.title).toHaveLength(200);
    expect(value.events[0]!.location).toHaveLength(200);
    expect(value.events[0]!.calendar).toHaveLength(100);
  });

  it("leaves out a location that holds a link, so a meeting link or passcode stays on the phone", () => {
    const linked = [
      "https://zoom.us/j/123?pwd=secret",
      "Join at www.example.test/meet",
      "meet.example.test/abc-defg-hij",
      "Teams: zoom.us/j/987 passcode 4242",
      "zoommtg://zoom.us/join?confno=1",
    ];
    const kept = ["Room 4.2", "Main St. 12/3, Berlin", "Cafe", "e.g. the lobby"];
    const value = calendar.calendarValue(
      [...linked, ...kept].map((location, index) => event({ title: `E${index}`, location })),
      new Map(),
      request,
    );
    expect(value.events.map((entry) => entry.location)).toEqual([
      ...linked.map(() => undefined),
      ...kept,
    ]);
    // Nor can a search find out what the link says.
    const probe = { ...request, query: "pwd=secret" };
    expect(
      calendar.calendarValue([event({ location: linked[0] })], new Map(), probe).events,
    ).toEqual([]);
  });

  it("leaves out an empty location and an unknown calendar, and reads all-day as given", () => {
    const value = calendar.calendarValue(
      [event({ title: null, allDay: true, calendarId: "gone" }), event({ calendarId: null })],
      new Map(),
      { ...request, limit: 1 },
    );
    expect(value).toEqual({
      events: [
        {
          title: "",
          start: "2026-11-23T09:00:00.000Z",
          end: "2026-11-23T10:00:00.000Z",
          allDay: true,
        },
      ],
      truncated: true,
    });
  });
});

describe("reading the phone's calendar", () => {
  it("reads every calendar in the requested window", async () => {
    native.calendar.listEvents.mockResolvedValueOnce([
      event({ title: "B", startDate: "2026-11-23T10:00:00.000Z", calendarId: "home" }),
      event({ title: "A" }),
    ]);
    const value = await calendar.readCalendar(request);
    expect(native.calendar.getCalendars).toHaveBeenCalledWith("event");
    expect(native.calendar.listEvents).toHaveBeenCalledWith(
      ["work", "home"],
      new Date(request.from),
      new Date(request.to),
    );
    expect(value.events.map((entry) => [entry.title, entry.calendar])).toEqual([
      ["A", "Work"],
      ["B", undefined],
    ]);
  });

  it("reads at most 31 days", async () => {
    await calendar.readCalendar({ ...request, to: "2027-06-01T00:00:00.000Z" });
    expect(native.calendar.listEvents).toHaveBeenCalledWith(
      ["work", "home"],
      new Date(request.from),
      new Date("2026-12-24T00:00:00.000Z"),
    );
  });

  it("answers nothing without calendars", async () => {
    native.calendar.getCalendars.mockResolvedValueOnce([]);
    expect(await calendar.readCalendar(request)).toEqual({ events: [], truncated: false });
    expect(native.calendar.listEvents).not.toHaveBeenCalled();
  });

  it("refuses without the system's permission", async () => {
    native.calendar.getCalendarPermissions.mockResolvedValueOnce({ granted: false });
    await expect(calendar.readCalendar(request)).rejects.toMatchObject({
      code: "calendar-permission",
    });
    expect(native.calendar.listEvents).not.toHaveBeenCalled();
  });

  it.each([
    ["a build without the module", () => (native.module = null)],
    ["a module that fails to load", withoutNativeModule],
    ["a failed read", () => native.calendar.listEvents.mockRejectedValueOnce(new Error("boom"))],
  ])("is unavailable in %s", async (_name, arrange) => {
    await arrange();
    await expect(calendar.readCalendar(request)).rejects.toMatchObject({
      code: "calendar-unavailable",
    });
  });

  it.each([
    { ...request, from: "nope" },
    { ...request, to: request.from },
  ])("is unavailable for a window it cannot read", async (window) => {
    await expect(calendar.readCalendar(window)).rejects.toBeInstanceOf(calendar.PhoneCalendarError);
    expect(native.calendar.listEvents).not.toHaveBeenCalled();
  });

  it("loads the module once a failed load is over", async () => {
    await withoutNativeModule();
    expect(await calendar.calendarPermission()).toBe("unavailable");
    vi.doMock("expo-calendar", () => native.calendar);
    expect(await calendar.calendarPermission()).toBe("granted");
  });
});

describe("the system permission", () => {
  it("is unavailable in a build without the module, and never asked there", async () => {
    native.module = null;
    expect(calendar.calendarAvailable()).toBe(false);
    expect(await calendar.calendarPermission()).toBe("unavailable");
    expect(await calendar.requestCalendarPermission()).toBe("unavailable");
    expect(native.calendar.requestCalendarPermissions).not.toHaveBeenCalled();
  });

  it("asks iOS for full access through the calendar module", async () => {
    expect(calendar.calendarAvailable()).toBe(true);
    expect(await calendar.requestCalendarPermission()).toBe("granted");
    expect(native.calendar.requestCalendarPermissions).toHaveBeenCalledWith();
    native.calendar.requestCalendarPermissions.mockResolvedValueOnce({ granted: false });
    expect(await calendar.requestCalendarPermission()).toBe("denied");
    native.calendar.getCalendarPermissions.mockResolvedValueOnce({ granted: false });
    expect(await calendar.calendarPermission()).toBe("denied");
  });

  it("asks for reading alone where the system asks for it apart from writing", async () => {
    native.read = { check: native.androidCheck, request: native.androidRequest };
    expect(await calendar.calendarPermission()).toBe("granted");
    expect(await calendar.requestCalendarPermission()).toBe("granted");
    native.androidRequest.mockResolvedValueOnce(false);
    expect(await calendar.requestCalendarPermission()).toBe("denied");
    expect(native.androidCheck).toHaveBeenCalledTimes(1);
    expect(native.calendar.requestCalendarPermissions).not.toHaveBeenCalled();
    expect(native.calendar.getCalendarPermissions).not.toHaveBeenCalled();
  });

  it("reads a failing permission call as unavailable", async () => {
    native.calendar.getCalendarPermissions.mockRejectedValueOnce(new Error("boom"));
    expect(await calendar.calendarPermission()).toBe("unavailable");
    native.calendar.requestCalendarPermissions.mockRejectedValueOnce(new Error("boom"));
    expect(await calendar.requestCalendarPermission()).toBe("unavailable");
  });

  it("is not offered on the web", () => {
    native.platform.OS = "web";
    expect(calendar.calendarAvailable()).toBe(false);
  });
});
