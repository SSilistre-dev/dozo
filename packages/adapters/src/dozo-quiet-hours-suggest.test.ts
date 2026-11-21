import { DOZO_QUIET_DAYS } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { currentDbContext } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { DozoHourActivity } from "./dozo-quiet-hours-suggest.js";
import {
  DOZO_QUIET_SUGGEST_DAYS,
  dozoSuggestQuietHours,
  suggestDozoQuietHours,
} from "./dozo-quiet-hours-suggest.js";

const range = (from: number, to: number) =>
  Array.from({ length: (to - from + 24) % 24 || 24 }, (_, index) => (from + index) % 24);

/**
 * Four weeks of local hours written in, from Monday 26 October 2026: `hours` picks the hours of
 * each day (index 0 is that Monday), one message in each.
 */
function weeks(hours: (day: number, weekday: number) => readonly number[], days = 28) {
  const activity: DozoHourActivity[] = [];
  for (let day = 0; day < days; day += 1) {
    const date = new Date(Date.UTC(2026, 9, 26 + day)).toISOString().slice(0, 10);
    const weekday = day % 7;
    for (const hour of hours(day, weekday))
      activity.push({ day: date, weekday, hour, messages: 1 });
  }
  return activity;
}

const isWeekend = (weekday: number) => weekday >= 5;

describe("suggested quiet hours", () => {
  it("are the night for someone awake from eight to eleven", () => {
    expect(dozoSuggestQuietHours(weeks(() => range(8, 23)))).toEqual([
      { startMinute: 23 * 60, endMinute: 8 * 60, days: DOZO_QUIET_DAYS.ALL },
    ]);
  });

  it("ignore a rare message in the night", () => {
    const activity = weeks((day) => (day === 3 ? [...range(8, 23), 3] : range(8, 23)));
    expect(dozoSuggestQuietHours(activity)).toEqual([
      { startMinute: 23 * 60, endMinute: 8 * 60, days: DOZO_QUIET_DAYS.ALL },
    ]);
  });

  it("are the day for someone who works at night", () => {
    // Writes from 21:00 to 06:00: the quiet stretch is 15 hours, cut to the 12 before 21:00.
    expect(dozoSuggestQuietHours(weeks(() => range(21, 6)))).toEqual([
      { startMinute: 9 * 60, endMinute: 21 * 60, days: DOZO_QUIET_DAYS.ALL },
    ]);
  });

  it("keep the quietest twelve hours of a longer stretch", () => {
    // A rare message at 18:00 on a Thursday and a Saturday leaves 06:00-18:00 the quietest.
    const activity = weeks((day) =>
      day === 3 || day === 5 ? [...range(21, 6), 18] : range(21, 6),
    );
    expect(dozoSuggestQuietHours(activity)).toEqual([
      { startMinute: 6 * 60, endMinute: 18 * 60, days: DOZO_QUIET_DAYS.ALL },
    ]);
  });

  it("take the less written-in of two equally long stretches", () => {
    // Busy 02:00-08:00 and 14:00-20:00: quiet 08:00-14:00 and 20:00-02:00, six hours each.
    const busy = [...range(2, 8), ...range(14, 20)];
    const noisy = (hour: number) => (day: number) =>
      day === 3 || day === 5 ? [...busy, hour] : busy;
    expect(dozoSuggestQuietHours(weeks(noisy(10)))).toEqual([
      { startMinute: 20 * 60, endMinute: 2 * 60, days: DOZO_QUIET_DAYS.ALL },
    ]);
    expect(dozoSuggestQuietHours(weeks(noisy(23)))).toEqual([
      { startMinute: 8 * 60, endMinute: 14 * 60, days: DOZO_QUIET_DAYS.ALL },
    ]);
  });

  it("split weekdays from the weekend when their nights differ", () => {
    const activity = weeks((_, weekday) => (isWeekend(weekday) ? range(10, 2) : range(7, 23)));
    expect(dozoSuggestQuietHours(activity)).toEqual([
      { startMinute: 23 * 60, endMinute: 7 * 60, days: DOZO_QUIET_DAYS.WEEKDAYS },
      { startMinute: 2 * 60, endMinute: 10 * 60, days: DOZO_QUIET_DAYS.WEEKEND },
    ]);
  });

  it("join weekdays and the weekend when their nights are within an hour", () => {
    const activity = weeks((_, weekday) => (isWeekend(weekday) ? range(8, 0) : range(7, 23)));
    expect(dozoSuggestQuietHours(activity)).toEqual([
      { startMinute: 23 * 60 + 30, endMinute: 7 * 60 + 30, days: DOZO_QUIET_DAYS.ALL },
    ]);
  });

  it("cover weekdays only when the weekend has too few days to read", () => {
    const activity = weeks((day, weekday) =>
      isWeekend(weekday) && day > 7 ? [] : isWeekend(weekday) ? [12] : range(8, 23),
    );
    expect(dozoSuggestQuietHours(activity)).toEqual([
      { startMinute: 23 * 60, endMinute: 8 * 60, days: DOZO_QUIET_DAYS.WEEKDAYS },
    ]);
  });

  it("cover the weekend only when weekdays have too few days to read", () => {
    const activity = weeks((_, weekday) => (isWeekend(weekday) ? range(9, 1) : []));
    expect(dozoSuggestQuietHours(activity)).toEqual([
      { startMinute: 1 * 60, endMinute: 9 * 60, days: DOZO_QUIET_DAYS.WEEKEND },
    ]);
  });

  it("are not suggested from too few messages", () => {
    // 19 messages on 19 days.
    expect(dozoSuggestQuietHours(weeks(() => [12], 19))).toBeNull();
    expect(dozoSuggestQuietHours([])).toBeNull();
  });

  it("are not suggested from too few days", () => {
    // Plenty of messages, on six days.
    expect(dozoSuggestQuietHours(weeks(() => range(8, 23), 6))).toBeNull();
  });

  it("are not suggested when no hour stands out", () => {
    // One message a day at a different hour each time.
    expect(dozoSuggestQuietHours(weeks((day) => [(day * 7) % 24]))).toBeNull();
  });

  it("are not suggested when every hour is busy", () => {
    expect(dozoSuggestQuietHours(weeks(() => range(0, 0)))).toBeNull();
  });

  it("are not suggested when the quiet stretch is shorter than three hours", () => {
    expect(dozoSuggestQuietHours(weeks(() => range(5, 3)))).toBeNull();
  });

  it("count a day once in an hour, however much was written in it", () => {
    const activity = weeks(() => range(8, 23)).map((entry) =>
      entry.hour === 12 ? { ...entry, messages: 40 } : entry,
    );
    expect(dozoSuggestQuietHours(activity)).toEqual([
      { startMinute: 23 * 60, endMinute: 8 * 60, days: DOZO_QUIET_DAYS.ALL },
    ]);
  });
});

describe("suggesting quiet hours for an account", () => {
  it("counts only that account's own messages of the last four weeks", async () => {
    const queryRaw = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      expect(currentDbContext()).toMatchObject({ kind: "system" });
      expect(strings.join("?")).toContain(`m."authorUserId" = ? AND m.role = 'user'`);
      return weeks(() => range(8, 23));
    });
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient;
    expect(await suggestDozoQuietHours(prisma, "user-1")).toEqual([
      { startMinute: 23 * 60, endMinute: 8 * 60, days: DOZO_QUIET_DAYS.ALL },
    ]);
    expect(queryRaw.mock.calls[0]?.slice(1)).toEqual(["user-1", "user-1", DOZO_QUIET_SUGGEST_DAYS]);
  });
});
