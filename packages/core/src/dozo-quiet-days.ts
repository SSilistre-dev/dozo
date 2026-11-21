import type { DozoQuietRange } from "@rakazo/contracts";
import { DOZO_DEFAULT_QUIET_HOURS, DOZO_QUIET_DAYS, dozoQuietDayBit } from "@rakazo/contracts";

/** What turning quiet hours on, or adding a range, starts with: the night, every day. */
export const DOZO_DEFAULT_QUIET_RANGE: DozoQuietRange = {
  ...DOZO_DEFAULT_QUIET_HOURS,
  days: DOZO_QUIET_DAYS.ALL,
};

/** The day sets a person picks by name, in the order they are offered. */
export const DOZO_QUIET_DAY_PRESETS = ["ALL", "WEEKDAYS", "WEEKEND"] as const;
export type DozoQuietDayPreset = (typeof DOZO_QUIET_DAY_PRESETS)[number];

/** The named set `days` is, or null for any other choice of days. */
export function dozoQuietDayPreset(days: number): DozoQuietDayPreset | null {
  return DOZO_QUIET_DAY_PRESETS.find((preset) => DOZO_QUIET_DAYS[preset] === days) ?? null;
}

/** The weekdays Monday to Sunday, numbered as {@link dozoQuietDayBit} takes them. */
export const DOZO_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** Whether `days` holds the weekday, Monday 0 to Sunday 6. */
export function dozoQuietHasDay(days: number, weekday: number): boolean {
  return (days & dozoQuietDayBit(weekday)) !== 0;
}

/**
 * `days` with the weekday added or taken out. Taking out the only day left keeps it: a range is
 * always on at least one day.
 */
export function dozoQuietToggleDay(days: number, weekday: number): number {
  const next = days ^ dozoQuietDayBit(weekday);
  return next === 0 ? days : next;
}

/** A weekday's name in the locale, Monday 0 to Sunday 6. */
export function dozoWeekdayName(
  weekday: number,
  locale: string,
  width: "narrow" | "short" | "long",
): string {
  // 1 January 2024 was a Monday.
  return new Intl.DateTimeFormat(locale, { weekday: width, timeZone: "UTC" }).format(
    new Date(Date.UTC(2024, 0, 1 + weekday)),
  );
}

/**
 * A choice of days that has no name, as its short weekday names: "Mon, Wed, Fri". Joined by hand,
 * as the mobile app's engine has no `Intl.ListFormat`.
 */
export function dozoQuietDayList(days: number, locale: string): string {
  return DOZO_WEEKDAYS.filter((weekday) => dozoQuietHasDay(days, weekday))
    .map((weekday) => dozoWeekdayName(weekday, locale, "short"))
    .join(", ");
}
