const SKILL_WRITE_TOOLS = new Set(["skill_create", "skill_update"]);

/**
 * A skill's text enters the catalog of every bot in the space, so a skill written after outside
 * content entered the run, or in a run someone else started, could plant a lasting prompt. It
 * needs a person in every mode: no allow rule or approval model passes it, and Never ask refuses
 * it. The predicate is only checked for a skill write.
 */
export async function skillWriteNeedsApproval(
  toolName: string,
  actionTainted: () => Promise<boolean>,
): Promise<boolean> {
  return SKILL_WRITE_TOOLS.has(toolName) && (await actionTainted());
}
