import type { TeachRecordingEvent } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  storedTeachTargets,
  TEACH_TARGETS_KEY,
  withoutSecretClickImages,
} from "./dozo-teaching-recordings.js";

const at = "2026-11-19T12:00:00.000Z";
const typing = (text: string): TeachRecordingEvent[] =>
  [...text].map((key) => ({ at, kind: "key", key }));

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
});

describe("withoutSecretClickImages", () => {
  const events: TeachRecordingEvent[] = [
    { at, kind: "pointer", x: 1, y: 1, type: "click" },
    ...typing("ali@example.test"),
    { at, kind: "pointer", x: 2, y: 2, type: "click" },
    { at, kind: "key", sensitive: true },
    { at, kind: "pointer", x: 3, y: 3, type: "click" },
  ];
  const clickAt = events.length - 1;
  const secretClick = 1 + "ali@example.test".length;

  it("drops the picture of a click before protected input and keeps its window", () => {
    const recording = {
      events,
      [TEACH_TARGETS_KEY]: [
        { eventIndex: 0, window: "A", image: "AAAA" },
        { eventIndex: secretClick, window: "B", image: "BBBB" },
        { eventIndex: clickAt, image: "CCCC" },
      ],
    };
    expect(withoutSecretClickImages("skill-1", recording)[TEACH_TARGETS_KEY]).toEqual([
      { eventIndex: 0, window: "A", image: "AAAA" },
      { eventIndex: secretClick, window: "B" },
      { eventIndex: clickAt, image: "CCCC" },
    ]);
  });

  it("leaves a recording without targets as it is, without the key", () => {
    expect(withoutSecretClickImages("skill-1", { events })).toEqual({ events });
    expect(
      withoutSecretClickImages("skill-1", { events, [TEACH_TARGETS_KEY]: "nonsense" }),
    ).toEqual({ events });
  });
});
