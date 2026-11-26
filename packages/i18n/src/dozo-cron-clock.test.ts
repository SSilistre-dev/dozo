import { formatCron } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { cronLabels } from "./cron";

describe("cronLabels clock locale", () => {
  it("writes an English schedule on a 24-hour clock when the date locale says so", () => {
    const labels = cronLabels("en", "en-US-u-hc-h23");
    expect(formatCron("0 8 * * 1-5", labels)).toBe("Weekdays at 08:00");
    expect(formatCron("30 20 1 * *", labels)).toBe("Monthly on the 1st at 20:30");
  });
});
