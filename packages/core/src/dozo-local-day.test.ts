import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dozoLocalDay } from "./dozo-local-day.js";

describe("the local day", () => {
  const zone = process.env.TZ;
  beforeEach(() => {
    process.env.TZ = "Europe/Istanbul";
  });
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  it("is the person's own date, not the UTC one", () => {
    // Half past midnight on 21 November in Istanbul is still 20 November in UTC.
    expect(dozoLocalDay(new Date("2026-11-20T21:30:00Z"))).toBe("2026-11-21");
    expect(dozoLocalDay(new Date("2026-01-05T20:59:00Z"))).toBe("2026-01-05");
  });
});
