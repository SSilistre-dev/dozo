/**
 * Writes whose text outlives the run as an instruction: a skill enters the catalog of every bot in
 * the space, and a routine's prompt is what its later runs take as the owner's words.
 */
const LASTING_WRITE_TOOLS = new Set([
  "skill_create",
  "skill_update",
  "skill_delete",
  "schedule_create",
  "schedule_update",
]);

/** The lasting writes that carry text, whose approval card shows all of it. */
const LASTING_TEXT_TOOLS = new Set([
  "skill_create",
  "skill_update",
  "schedule_create",
  "schedule_update",
]);

/**
 * A lasting write after outside content entered the run, or in a run someone else started, could
 * plant (or remove) a lasting prompt. It needs a person in every mode: no allow rule or approval
 * model passes it, and Never ask refuses it. The predicate is only checked for a lasting write.
 */
export async function lastingWriteNeedsApproval(
  toolName: string,
  actionTainted: () => Promise<boolean>,
): Promise<boolean> {
  return LASTING_WRITE_TOOLS.has(toolName) && (await actionTainted());
}

/** Whether a lasting write's card shows its whole text, as the child instruction card does. */
export function lastingWriteShowsWholeText(toolName: string): boolean {
  return LASTING_TEXT_TOOLS.has(toolName);
}
