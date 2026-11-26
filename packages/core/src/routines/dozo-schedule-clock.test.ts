import { afterEach, describe, expect, it, vi } from "vitest";
import { localizedClock } from "./schedule.js";

const RealDate = Date;
const originalZone = process.env.TZ;
const hermesNow = RealDate.UTC(2026, 6, 1, 12);

function offsetMinutesAt(zone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(instant);
  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = RealDate.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
  );
  return (asUtc - Math.floor(instant / 60000) * 60000) / 60000;
}

/** Hermes reads `new Date(y, m, d, h, mi)` with the zone's offset now, not the one at that date. */
function useHermesDate(zone: string) {
  process.env.TZ = zone;
  const offsetMs = offsetMinutesAt(zone, hermesNow) * 60000;
  class HermesDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length >= 2) {
        const [year, month, day = 1, hour = 0, minute = 0] = args as [number, number, ...number[]];
        super(RealDate.UTC(year, month, day, hour, minute) - offsetMs);
      } else {
        super(...(args as [number]));
      }
    }
  }
  vi.stubGlobal("Date", HermesDate);
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;
});

describe("localizedClock on a runtime that reads local dates with the current offset", () => {
  it("shows 08:00 in a zone with no daylight saving that shifted since 2000 (Europe/Istanbul)", () => {
    useHermesDate("Europe/Istanbul");
    expect(localizedClock("8:00 AM", "tr")).toMatch(/^0?8:00$/);
    expect(localizedClock("9:30 PM", "tr")).toBe("21:30");
  });

  it("shows 08:00 in a zone whose offset differs between July and January (America/New_York)", () => {
    useHermesDate("America/New_York");
    expect(localizedClock("8:00 AM", "tr")).toMatch(/^0?8:00$/);
    expect(localizedClock("12:15 AM", "tr")).toMatch(/^0?0:15$/);
  });
});
