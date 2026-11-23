import { describe, expect, it } from "vitest";
import {
  checkPhoneEvent,
  checkPhoneReminder,
  dateOnly,
  isoWithOffset,
  PHONE_WRITE_LIMITS,
} from "./dozo-phone-write.js";

const NOW = Date.parse("2026-11-23T12:00:00.000Z");
const TIMED = {
  title: "Dentist",
  start: "2026-11-24T09:00:00+00:00",
  end: "2026-11-24T10:00:00+00:00",
  allDay: false,
};
const error = (value: unknown) => (value as { error?: string }).error;

describe("an event a write may create", () => {
  it("is kept field for field, optional ones only when given", () => {
    const full = {
      ...TIMED,
      location: "Clinic",
      notes: "Bring the card",
      recurrence: { frequency: "weekly", interval: 2, count: 3 },
    };
    expect(checkPhoneEvent(full, NOW)).toEqual({ value: full });
    expect(checkPhoneEvent({ ...TIMED, location: "", notes: "" }, NOW)).toEqual({ value: TIMED });
  });

  it("says why it is refused", () => {
    expect(error(checkPhoneEvent("event", NOW))).toBe("The event must be an object.");
    expect(error(checkPhoneEvent({ ...TIMED, attendees: [] }, NOW))).toBe(
      '"attendees" is not accepted.',
    );
    expect(error(checkPhoneEvent({ ...TIMED, title: 5 }, NOW))).toBe("title is required.");
    expect(error(checkPhoneEvent({ ...TIMED, title: "" }, NOW))).toBe("title is required.");
    expect(error(checkPhoneEvent({ ...TIMED, allDay: 1 }, NOW))).toBe(
      "allDay must be true or false.",
    );
    expect(error(checkPhoneEvent({ ...TIMED, location: 5 }, NOW))).toBe("location must be text.");
    expect(error(checkPhoneEvent({ ...TIMED, start: 5 }, NOW))).toContain("ISO 8601");
    expect(error(checkPhoneEvent({ ...TIMED, allDay: true }, NOW))).toContain("2026-03-01");
    expect(error(checkPhoneEvent({ ...TIMED, notes: "n".repeat(1001) }, NOW))).toBe(
      "notes can be at most 1000 characters.",
    );
    expect(error(checkPhoneEvent({ ...TIMED, recurrence: [] }, NOW))).toContain("an object");
    expect(
      error(
        checkPhoneEvent({ ...TIMED, recurrence: { frequency: "daily", interval: 1, x: 1 } }, NOW),
      ),
    ).toBe('"x" is not accepted in recurrence.');
    expect(
      error(checkPhoneEvent({ ...TIMED, recurrence: { frequency: "daily", count: 2 } }, NOW)),
    ).toContain("interval");
    expect(
      error(
        checkPhoneEvent(
          { ...TIMED, recurrence: { frequency: "daily", interval: 1, until: 5 } },
          NOW,
        ),
      ),
    ).toContain("until");
  });

  it("places an all-day event by its dates, with a day's room either side for the zones", () => {
    const day = { title: "Trip", start: "2026-11-22", end: "2026-11-23", allDay: true };
    expect(checkPhoneEvent(day, NOW)).toEqual({ value: day });
    expect(error(checkPhoneEvent({ ...day, start: "2026-11-21" }, NOW))).toContain("start must be");
    const last = new Date(NOW + PHONE_WRITE_LIMITS.startDaysAhead * 86_400_000 + 86_400_000);
    const date = last.toISOString().slice(0, 10);
    const next = new Date(last.getTime() + 86_400_000).toISOString().slice(0, 10);
    expect(checkPhoneEvent({ ...day, start: date, end: next }, NOW)).toHaveProperty("value");
  });
});

describe("a reminder a write may create", () => {
  it("is kept field for field, and says why it is refused", () => {
    const full = { title: "Buy milk", due: TIMED.start, notes: "Oat", list: "Shopping" };
    expect(checkPhoneReminder(full)).toEqual({ value: full });
    expect(checkPhoneReminder({ title: "Buy milk", notes: "", list: "" })).toEqual({
      value: { title: "Buy milk" },
    });
    expect(error(checkPhoneReminder(null))).toBe("The reminder must be an object.");
    expect(error(checkPhoneReminder({ title: "A", list: 3 }))).toBe("list must be text.");
    expect(error(checkPhoneReminder({ title: "A", notes: 3 }))).toBe("notes must be text.");
    expect(error(checkPhoneReminder({ title: "A", due: "soon" }))).toContain("ISO 8601");
  });
});

describe("times and dates", () => {
  it("are ISO 8601 with an offset, and real calendar days", () => {
    expect(isoWithOffset("2026-03-01T09:00+01:00")).toBe("2026-03-01T09:00+01:00");
    expect(isoWithOffset("2026-03-01T09:00")).toBeUndefined();
    expect(isoWithOffset(5)).toBeUndefined();
    expect(dateOnly("2028-02-29")).toBe("2028-02-29");
    expect(dateOnly("2026-02-29")).toBeUndefined();
    expect(dateOnly("2026-13-01")).toBeUndefined();
    expect(dateOnly(20260301)).toBeUndefined();
  });
});
