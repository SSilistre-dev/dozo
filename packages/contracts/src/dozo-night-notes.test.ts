import { describe, expect, it } from "vitest";
import {
  DOZO_NIGHT_NOTES_ROUTINE_PROMPT,
  dozoNightNotesChange,
  findDozoNightNotes,
} from "./dozo-night-notes.js";
import { CreateRoutineInput } from "./routines/routine.js";

const tidy = { id: "r1", prompt: DOZO_NIGHT_NOTES_ROUTINE_PROMPT };

describe("the nightly memory note switch", () => {
  it("switching on with no routine creates a valid running daily routine in the given zone", () => {
    const change = dozoNightNotesChange(
      [{ id: "x", prompt: "Water the plants", active: true }],
      "bot-1",
      "Europe/Istanbul",
      true,
    );
    expect(change).toMatchObject({
      create: { botId: "bot-1", timezone: "Europe/Istanbul", active: true, crons: ["0 3 * * *"] },
    });
    const create = (change as { create: unknown }).create;
    expect(CreateRoutineInput.parse(create)).toMatchObject({ active: true, inChat: false });
  });

  it("turns the routine it made on and off, and sends nothing when it already is", () => {
    const paused = [{ ...tidy, active: false }];
    const running = [{ ...tidy, active: true }];
    expect(dozoNightNotesChange(paused, "b", "UTC", true)).toEqual({
      update: { routineId: "r1", active: true },
    });
    expect(dozoNightNotesChange(running, "b", "UTC", false)).toEqual({
      update: { routineId: "r1", active: false },
    });
    expect(dozoNightNotesChange(running, "b", "UTC", true)).toBeNull();
    expect(dozoNightNotesChange([], "b", "UTC", false)).toBeNull();
  });

  it("finds the routine by its prompt, so a renamed one is still found", () => {
    expect(findDozoNightNotes([{ id: "a", prompt: "other" }, tidy])).toBe(tidy);
  });

  it("tells the bot to send no message when memory did not change", () => {
    expect(DOZO_NIGHT_NOTES_ROUTINE_PROMPT).toContain("did not change, send no message at all");
  });
});
