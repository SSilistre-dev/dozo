import { oc } from "@orpc/contract";
import * as z from "zod";

/** Sends each bot may make in a day without asking, until the account picks another number. */
export const DOZO_DEFAULT_DAILY_SENDS = 50;
/** The numbers Settings offers. Any whole number from 1 to 1000 is accepted. */
export const DOZO_DAILY_SEND_CHOICES = [10, 25, 50, 100, 250] as const;

/**
 * How many sends (an email, a message to someone else's agent, an app action that changes
 * something) each of the account's bots may make in a day of the account's timezone without
 * asking. Past it, each send asks.
 */
export const DozoDailySendsSchema = z.number().int().min(1).max(1000);

const SendLimitState = z.object({ dailySends: DozoDailySendsSchema });

export const dozoSendLimitContract = {
  get: oc.output(SendLimitState),
  set: oc.input(SendLimitState).output(SendLimitState),
};
