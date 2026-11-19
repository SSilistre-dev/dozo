import { describe, expect, it, vi } from "vitest";
import type * as JsonColumn from "./json-column.js";

const column = vi.hoisted(() => ({ broken: false }));
vi.mock("./json-column.js", async (importOriginal) => {
  const actual = await importOriginal<typeof JsonColumn>();
  return {
    ...actual,
    readJsonColumn: ((...args: Parameters<typeof actual.readJsonColumn>) => {
      if (column.broken) throw new Error("database gone");
      return actual.readJsonColumn(...args);
    }) as typeof actual.readJsonColumn,
  };
});

const { storedTeachTargets, TEACH_TARGETS_KEY } = await import("./dozo-teaching-recordings.js");

describe("storedTeachTargets", () => {
  it("reads the targets, none when there are none", () => {
    const targets = [{ eventIndex: 1, window: "Form", image: "AAAA" }];
    expect(storedTeachTargets("skill-1", { [TEACH_TARGETS_KEY]: targets })).toEqual(targets);
    expect(storedTeachTargets("skill-1", { events: [] })).toEqual([]);
    expect(storedTeachTargets("skill-1", null)).toEqual([]);
  });

  it("reads targets in another shape as none and reports them", () => {
    expect(storedTeachTargets("skill-bad", { [TEACH_TARGETS_KEY]: [{ eventIndex: "x" }] })).toEqual(
      [],
    );
  });

  it("lets any other failure through", () => {
    column.broken = true;
    try {
      expect(() => storedTeachTargets("skill-1", {})).toThrow("database gone");
    } finally {
      column.broken = false;
    }
  });
});
