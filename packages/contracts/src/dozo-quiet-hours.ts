import { oc } from "@orpc/contract";
import * as z from "zod";

const Minute = z.number().int().min(0).max(1439);

/**
 * One daily range of minutes past local midnight, in the account's timezone. It ends at
 * `endMinute` (not included) and crosses midnight when that is the smaller one.
 */
export const DozoQuietHoursSchema = z
  .object({ startMinute: Minute, endMinute: Minute })
  .refine((hours) => hours.startMinute !== hours.endMinute, "Quiet hours need a start and an end");
export type DozoQuietHours = z.infer<typeof DozoQuietHoursSchema>;

/** What turning quiet hours on starts with: the night. */
export const DOZO_DEFAULT_QUIET_HOURS: DozoQuietHours = { startMinute: 22 * 60, endMinute: 7 * 60 };

/**
 * Days as a 7-bit mask, Monday bit 0 to Sunday bit 6. A range belongs to the day it starts on:
 * Friday 22:00-07:00 also covers Saturday morning.
 */
export const DOZO_QUIET_DAYS = { WEEKDAYS: 0b0011111, WEEKEND: 0b1100000, ALL: 0b1111111 } as const;

/** How many ranges an account can have. */
export const DOZO_MAX_QUIET_RANGES = 4;

/** The bit of a weekday in {@link DOZO_QUIET_DAYS}, Monday 0 to Sunday 6. */
export function dozoQuietDayBit(weekday: number): number {
  return 1 << weekday;
}

/**
 * The account's quiet hours are the union of up to four ranges, each on its own days, in which
 * its routines start nothing. Ranges may overlap or touch.
 */
export const DozoQuietRangeSchema = z
  .object({
    startMinute: Minute,
    endMinute: Minute,
    days: z.number().int().min(1).max(DOZO_QUIET_DAYS.ALL),
  })
  .refine((range) => range.startMinute !== range.endMinute, "Quiet hours need a start and an end");
export type DozoQuietRange = z.infer<typeof DozoQuietRangeSchema>;

const Ranges = z.array(DozoQuietRangeSchema).max(DOZO_MAX_QUIET_RANGES);

/**
 * The single range a client that knows only `hours` sees: the first range's times. Exact when that
 * is the only range and it is on every day, close enough otherwise.
 */
export function dozoQuietHoursOf(ranges: readonly DozoQuietRange[]): DozoQuietHours | null {
  const [first] = ranges;
  return first ? { startMinute: first.startMinute, endMinute: first.endMinute } : null;
}

const QuietHoursState = z.object({ hours: DozoQuietHoursSchema.nullable(), ranges: Ranges });

export const dozoQuietHoursContract = {
  get: oc.output(QuietHoursState),
  /**
   * `ranges` wins when given; otherwise `hours` becomes one range on every day. An empty list,
   * or null for both, turns quiet hours off.
   */
  set: oc
    .input(
      z.object({
        hours: DozoQuietHoursSchema.nullable().optional(),
        ranges: Ranges.nullable().optional(),
      }),
    )
    .output(QuietHoursState),
  /** Ranges fitted to when the caller writes, or null when there is too little or no clear pattern. */
  suggest: oc.output(z.object({ ranges: Ranges.nullable() })),
};
