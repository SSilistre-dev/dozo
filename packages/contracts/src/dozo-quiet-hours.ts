import { oc } from "@orpc/contract";
import * as z from "zod";

const Minute = z.number().int().min(0).max(1439);

/**
 * The account's quiet hours: one daily range of minutes past local midnight, in the account's
 * timezone, in which its routines start nothing. It ends at `endMinute` (not included) and crosses
 * midnight when that is the smaller one.
 */
export const DozoQuietHoursSchema = z
  .object({ startMinute: Minute, endMinute: Minute })
  .refine((hours) => hours.startMinute !== hours.endMinute, "Quiet hours need a start and an end");
export type DozoQuietHours = z.infer<typeof DozoQuietHoursSchema>;

const QuietHoursState = z.object({ hours: DozoQuietHoursSchema.nullable() });

export const dozoQuietHoursContract = {
  get: oc.output(QuietHoursState),
  /** Null turns quiet hours off. */
  set: oc.input(QuietHoursState).output(QuietHoursState),
};
