import { DOZO_NIGHT_NOTES_CRONS, DOZO_QUIET_DAYS } from "@rakazo/contracts";
import { nextRoutineRunDateAcross } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { dozoInQuietHours, dozoQuietHoursEnd } from "./dozo-quiet-hours.js";

const NIGHT = [{ startMinute: 22 * 60, endMinute: 7 * 60, days: DOZO_QUIET_DAYS.ALL }];

describe("the nightly memory note and quiet hours", () => {
  it("is due inside the usual night and is held until the quiet hours end, in the person's zone", () => {
    const zone = "Europe/Istanbul";
    const now = new Date("2026-11-20T12:00:00Z");
    const due = nextRoutineRunDateAcross(DOZO_NIGHT_NOTES_CRONS, now, now, zone)!;
    expect(due.toISOString()).toBe("2026-11-21T00:00:00.000Z");
    expect(dozoInQuietHours(NIGHT, due, zone)).toBe(true);
    expect(dozoQuietHoursEnd(NIGHT, due, zone).toISOString()).toBe("2026-11-21T04:00:00.000Z");
  });
});
