import { describe, expect, it } from "vitest";
import {
  DOZO_DAILY_SEND_CHOICES,
  DOZO_DEFAULT_DAILY_SENDS,
  DozoDailySendsSchema,
  dozoSendLimitContract,
} from "./dozo-send-limit.js";

describe("dozoSendLimitContract", () => {
  it("takes a whole number of daily sends from 1 to 1000", () => {
    expect(DozoDailySendsSchema.parse(1)).toBe(1);
    expect(DozoDailySendsSchema.parse(1000)).toBe(1000);
    for (const bad of [0, -1, 1001, 2.5, "50", null])
      expect(DozoDailySendsSchema.safeParse(bad).success).toBe(false);
    expect(Object.keys(dozoSendLimitContract)).toEqual(["get", "set"]);
  });

  it("offers the default among its choices, each one valid", () => {
    expect(DOZO_DAILY_SEND_CHOICES).toContain(DOZO_DEFAULT_DAILY_SENDS);
    for (const choice of DOZO_DAILY_SEND_CHOICES)
      expect(DozoDailySendsSchema.safeParse(choice).success).toBe(true);
  });
});
