import { DOZO_QUIET_DAYS } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  DOZO_DEFAULT_QUIET_RANGE,
  dozoQuietDayList,
  dozoQuietDayPreset,
  dozoQuietHasDay,
  dozoQuietToggleDay,
  dozoWeekdayName,
} from "./dozo-quiet-days.js";

describe("quiet days", () => {
  it("starts with the night on every day", () => {
    expect(DOZO_DEFAULT_QUIET_RANGE).toEqual({
      startMinute: 1320,
      endMinute: 420,
      days: 0b1111111,
    });
  });

  it("names the presets and nothing else", () => {
    expect(dozoQuietDayPreset(DOZO_QUIET_DAYS.ALL)).toBe("ALL");
    expect(dozoQuietDayPreset(DOZO_QUIET_DAYS.WEEKDAYS)).toBe("WEEKDAYS");
    expect(dozoQuietDayPreset(DOZO_QUIET_DAYS.WEEKEND)).toBe("WEEKEND");
    expect(dozoQuietDayPreset(0b0000101)).toBeNull();
  });

  it("adds and takes out a day, but never the last one", () => {
    expect(dozoQuietToggleDay(DOZO_QUIET_DAYS.WEEKEND, 0)).toBe(0b1100001);
    expect(dozoQuietToggleDay(DOZO_QUIET_DAYS.WEEKEND, 6)).toBe(0b0100000);
    expect(dozoQuietToggleDay(0b0100000, 5)).toBe(0b0100000);
    expect(dozoQuietHasDay(0b0100000, 5)).toBe(true);
    expect(dozoQuietHasDay(0b0100000, 6)).toBe(false);
  });

  it("names days Monday first in the locale", () => {
    expect(dozoWeekdayName(0, "en-US", "long")).toBe("Monday");
    expect(dozoWeekdayName(6, "en-US", "narrow")).toBe("S");
    expect(dozoWeekdayName(0, "tr-TR", "long")).toBe("Pazartesi");
    expect(dozoQuietDayList(0b0010101, "en-US")).toBe("Mon, Wed, Fri");
  });
});
