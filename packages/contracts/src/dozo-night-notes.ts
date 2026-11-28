import {
  DOZO_NIGHT_NOTES_ROUTINE_NAME,
  DOZO_NIGHT_NOTES_ROUTINE_PROMPT,
} from "./dozo-night-notes.prompt.js";

export { DOZO_NIGHT_NOTES_ROUTINE_NAME, DOZO_NIGHT_NOTES_ROUTINE_PROMPT };

/** Every night at three, in the routine's own zone. Quiet hours hold the run until they end. */
export const DOZO_NIGHT_NOTES_CRONS = ["0 3 * * *"];

/**
 * The bot's nightly tidy-up among its routines. A routine row carries no origin or key, so it is
 * the one with the fork's prompt or the fork's name, which survives editing either but not both.
 * With several, the one running wins, so a switch never makes a second.
 */
export function findDozoNightNotes<Row extends { name: string; prompt: string; active?: boolean }>(
  routines: readonly Row[],
): Row | undefined {
  const ours = routines.filter(
    (routine) =>
      routine.prompt === DOZO_NIGHT_NOTES_ROUTINE_PROMPT ||
      routine.name === DOZO_NIGHT_NOTES_ROUTINE_NAME,
  );
  return ours.find((routine) => routine.active) ?? ours[0];
}

/** The routine switching the tidy-up on creates: running, in the zone the person's app uses. */
export function dozoNightNotesRoutine(botId: string, timezone: string) {
  return {
    botId,
    name: DOZO_NIGHT_NOTES_ROUTINE_NAME,
    prompt: DOZO_NIGHT_NOTES_ROUTINE_PROMPT,
    crons: DOZO_NIGHT_NOTES_CRONS,
    timezone,
    active: true,
  };
}

/** What switching it on or off sends for the bot's routines as they are now. */
export function dozoNightNotesChange(
  routines: readonly { id: string; name: string; prompt: string; active: boolean }[],
  botId: string,
  timezone: string,
  on: boolean,
):
  | { create: ReturnType<typeof dozoNightNotesRoutine> }
  | { update: { routineId: string; active: boolean } }
  | null {
  const existing = findDozoNightNotes(routines);
  if (!existing) return on ? { create: dozoNightNotesRoutine(botId, timezone) } : null;
  return existing.active === on ? null : { update: { routineId: existing.id, active: on } };
}
