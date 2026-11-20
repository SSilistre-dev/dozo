import { describe, expect, it } from "vitest";
import {
  POOL_COOLDOWN_DEFAULT_MS,
  POOL_COOLDOWN_MAX_MS,
  poolCooldownUntil,
  poolOrder,
} from "./dozo-model-pool.js";

const now = Date.UTC(2026, 10, 20, 12);
const minutes = (count: number) => count * 60_000;

describe("poolOrder", () => {
  it("stays on the chosen connection while it is open, even when another was added first", () => {
    expect(
      poolOrder({ members: [{ id: "a" }, { id: "b" }, { id: "c" }], preferred: "b", now }),
    ).toEqual({ order: ["b", "a", "c"] });
  });

  it("keeps the order connections were added in when nothing is known about their resets", () => {
    expect(
      poolOrder({ members: [{ id: "c" }, { id: "a" }, { id: "b" }], preferred: "x", now }),
    ).toEqual({ order: ["c", "a", "b"] });
  });

  it("leaves out a resting connection, the chosen one included", () => {
    expect(
      poolOrder({
        members: [{ id: "a", resetsAt: now + minutes(30) }, { id: "b" }, { id: "c" }],
        preferred: "a",
        now,
      }),
    ).toEqual({ order: ["b", "c"] });
  });

  it("takes a connection back once its reset has passed", () => {
    expect(
      poolOrder({
        members: [
          { id: "a", resetsAt: now },
          { id: "b", resetsAt: now - minutes(5) },
        ],
        preferred: "a",
        now,
      }),
    ).toEqual({ order: ["a", "b"] });
  });

  it("orders every resting connection by the earliest reset and says when the first opens", () => {
    expect(
      poolOrder({
        members: [
          { id: "a", resetsAt: now + minutes(90) },
          { id: "b", resetsAt: now + minutes(10) },
          { id: "c", resetsAt: now + minutes(45) },
        ],
        preferred: "a",
        now,
      }),
    ).toEqual({ order: ["b", "c", "a"], opensAt: now + minutes(10) });
  });

  it("returns nothing for an empty pool", () => {
    expect(poolOrder({ members: [], preferred: "a", now })).toEqual({
      order: [],
      opensAt: undefined,
    });
  });
});

describe("poolCooldownUntil", () => {
  it("rests until the provider's reset", () => {
    expect(poolCooldownUntil(now, now + minutes(300))).toBe(now + minutes(300));
  });

  it("rests for the default time without a reset, or with one already past", () => {
    expect(poolCooldownUntil(now)).toBe(now + POOL_COOLDOWN_DEFAULT_MS);
    expect(poolCooldownUntil(now, now - 1)).toBe(now + POOL_COOLDOWN_DEFAULT_MS);
  });

  it("holds a far reset to the longest rest", () => {
    expect(poolCooldownUntil(now, now + 30 * POOL_COOLDOWN_MAX_MS)).toBe(
      now + POOL_COOLDOWN_MAX_MS,
    );
  });
});
