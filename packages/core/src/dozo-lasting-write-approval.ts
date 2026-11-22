/**
 * Writes whose text outlives the run as an instruction: a skill enters the catalog of every bot in
 * the space, and a routine's prompt (also one set on another bot) is what its later runs take as
 * the owner's words.
 */
const LASTING_WRITE_TOOLS = new Set([
  "skill_create",
  "skill_update",
  "skill_delete",
  "schedule_create",
  "schedule_update",
  "create_child_routine",
]);

/**
 * The lasting writes that carry text and have no card of their own, whose approval card shows all
 * of it. create_child_routine's fleet card already shows its whole request or refuses it.
 */
const LASTING_TEXT_TOOLS = new Set([
  "skill_create",
  "skill_update",
  "schedule_create",
  "schedule_update",
]);

/** What says where a run's input came from. */
export type LastingWriteRun = {
  trigger: string;
  /** isOwnerStartedRun for the run; false for a message sent with an access token. */
  ownerStartedRun: boolean;
  /** A connected chat's run that someone other than the owner may have written. */
  nonOwnerChatRun: boolean;
  /** A routine a change trigger started: its prompt ends with what the watch read. */
  watchFired: boolean;
};

/**
 * Whether the input that started a run came from someone other than the owner. The owner's words
 * are isOwnerStartedRun's (their message, a follow-up they wrote, the close of their call), their
 * own connected chat app, and a routine's prompt, which counts as the owner's words when it runs
 * (as the gate's routine site check reads it) unless a change trigger appended what its watch read.
 * Every other trigger (another bot, a webhook or email, a spawned bot, a ticket, a helper's result,
 * a provider's callback), a new one included, is outside.
 */
export function runStartedFromOutside(run: LastingWriteRun): boolean {
  if (run.nonOwnerChatRun) return true;
  if (run.ownerStartedRun || run.trigger === "messaging") return false;
  if (run.trigger === "routine") return run.watchFired;
  return true;
}

/**
 * A lasting write in a run started from outside, or once the run read outside content, could plant
 * (or remove) a lasting prompt. It needs a person in every mode: no allow rule or approval model
 * passes it, and Never ask refuses it. `readOutside` is only checked for a lasting write in a run
 * the owner's words started.
 */
export async function lastingWriteNeedsApproval(
  toolName: string,
  run: LastingWriteRun,
  readOutside: () => Promise<boolean>,
): Promise<boolean> {
  if (!LASTING_WRITE_TOOLS.has(toolName)) return false;
  return runStartedFromOutside(run) || (await readOutside());
}

/** Whether a lasting write's card shows its whole text, as the child instruction card does. */
export function lastingWriteShowsWholeText(toolName: string): boolean {
  return LASTING_TEXT_TOOLS.has(toolName);
}
