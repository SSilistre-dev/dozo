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

/** What says where a run's input came from, and what it read that no result marks. */
export type LastingWriteRun = {
  trigger: string;
  /** isOwnerStartedRun for the run; false for a message sent with an access token. */
  ownerStartedRun: boolean;
  /** A connected chat's run that someone other than the owner may have written. */
  nonOwnerChatRun: boolean;
  /** A routine a change trigger started: its prompt ends with what the watch read. */
  watchFired: boolean;
  /**
   * The run acts for the bot's owner (its user is the bot's). Every member and guest of a Space
   * can message any of its bots, on the web, mobile, a bot's extra chats and the Bot API alike.
   */
  botOwnerRun: boolean;
  /** The run called read_history or search_history. */
  readHistory: boolean;
};

/** What the rule reads only when it needs it. */
export type LastingWriteChecks = {
  /** For a routine's run: whether the routine's last writer counts as its owner (routineWriterIsOwner). */
  routineFromOwner: () => Promise<boolean>;
  /** Whether the run read outside content. */
  readOutside: () => Promise<boolean>;
};

/**
 * Who last created or changed a routine: the bot's owner through the app or the API ("owner"),
 * the owner's own run that read nothing from outside and took no input from outside ("owner_run"),
 * another member through the app or the API ("member"), and any other run ("outside_run"),
 * including one whose write a person approved on its card.
 */
export const ROUTINE_WRITERS = ["owner", "owner_run", "member", "outside_run"] as const;

/** Whether a routine's prompt counts as its owner's words. No record, or an unknown one, does not. */
export function routineWriterIsOwner(writer: string | undefined): boolean {
  return writer === "owner" || writer === "owner_run";
}

/**
 * Whether the input that started a run came from someone other than the bot's owner. The owner's
 * words are isOwnerStartedRun's (their message, a follow-up they wrote, the close of their call) and
 * their own connected chat app, in a run that acts for the bot's owner; and a routine's prompt (a routine run
 * is owner-started upstream, whoever wrote it, so only this decides it) when
 * the owner last wrote it (routineWriterIsOwner) and no change trigger appended what its watch read.
 * Every other trigger (another bot, a webhook or email, a spawned bot, a ticket, a helper's result,
 * a provider's callback), a new one included, is outside.
 */
export async function runStartedFromOutside(
  run: LastingWriteRun,
  routineFromOwner: LastingWriteChecks["routineFromOwner"],
): Promise<boolean> {
  if (run.nonOwnerChatRun || !run.botOwnerRun) return true;
  // Upstream counts a routine's run as the owner's (isOwnerStartedRun), so it is read before that:
  // its prompt is the owner's words only when the owner last wrote it.
  if (run.trigger === "routine") return run.watchFired || !(await routineFromOwner());
  if (run.ownerStartedRun || run.trigger === "messaging") return false;
  return true;
}

/**
 * A lasting write in a run started from outside, once the run read outside content, or once it
 * read its history (a page read earlier, or in another chat, comes back without a mark) could plant
 * (or remove) a lasting prompt. It needs a person in every mode: no allow rule or approval model
 * passes it, and Never ask refuses it. The checks run only for a lasting write, in order.
 */
export async function lastingWriteNeedsApproval(
  toolName: string,
  run: LastingWriteRun,
  checks: LastingWriteChecks,
): Promise<boolean> {
  if (!LASTING_WRITE_TOOLS.has(toolName)) return false;
  return run.readHistory || (await lastingWriteHoldReason(toolName, run, checks)) !== undefined;
}

/**
 * Why lastingWriteNeedsApproval holds a lasting write: "outside" when the run was started from
 * outside or read outside content, otherwise "history" when only its history read holds it; undefined
 * when it is not held.
 */
export async function lastingWriteHoldReason(
  toolName: string,
  run: LastingWriteRun,
  checks: LastingWriteChecks,
): Promise<"outside" | "history" | undefined> {
  if (!LASTING_WRITE_TOOLS.has(toolName)) return undefined;
  if ((await runStartedFromOutside(run, checks.routineFromOwner)) || (await checks.readOutside()))
    return "outside";
  return run.readHistory ? "history" : undefined;
}

/** Whether a lasting write's card shows its whole text, as the child instruction card does. */
export function lastingWriteShowsWholeText(toolName: string): boolean {
  return LASTING_TEXT_TOOLS.has(toolName);
}
