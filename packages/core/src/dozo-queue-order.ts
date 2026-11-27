import { PERSON_RUN_TRIGGERS } from "./runs/run-state.js";

/**
 * The order work waiting for a bot starts in: a person's run before background work (a routine),
 * then the oldest first, the id breaking a tie. The first rule is the starter's two reads, a
 * person's run asked for first (`PERSON_RUN_TRIGGERS`); the keys below order within each. The run that
 * starts when a bot's computer is released and the line people are shown both read it here, so
 * the place shown is the place that comes up.
 */
export function queueStartOrder(): Array<{ createdAt: "asc" } | { id: "asc" }> {
  return [{ createdAt: "asc" }, { id: "asc" }];
}

/** `queueStartOrder`, person's run first, as a comparison of two runs already read. */
export function compareQueueStart(
  a: { createdAt: Date; id: string; trigger: string },
  b: { createdAt: Date; id: string; trigger: string },
): number {
  const people: readonly string[] = PERSON_RUN_TRIGGERS;
  return (
    Number(people.includes(b.trigger)) - Number(people.includes(a.trigger)) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    a.id.localeCompare(b.id)
  );
}
