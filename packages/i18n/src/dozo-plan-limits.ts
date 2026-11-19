import { i18n } from "@lingui/core";

/**
 * The catalog's line for an English sentence that is also its id, or the English itself where no
 * language is active yet (some tests, early boot).
 */
function say(message: string, values: Record<string, string> = {}): string {
  if (i18n.locale) return i18n._({ id: message, message, values });
  return message.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
}

/**
 * The plan-limit table's copy (`PlanLimitCopy` in `@rakazo/contracts`) in the UI's language, from
 * the translation catalog. Static descriptors with the English text as their id, so the catalog
 * finds them and the build checks each one has its Turkish line. Built on each call: it follows
 * the language in force.
 */
export function planLimitCopy() {
  return {
    computerNotInPlan: say("Your plan doesn't include a computer."),
    computerNotInPlanAskOwner: say(
      "Your plan doesn't include a computer. Ask the owner to upgrade.",
    ),
    computerHoursUsed: say("This month's computer hours are used up."),
    noComputerHours: say("No computer hours left."),
    sharedSpaceFull: say("Shared space is full. Delete files or change the plan."),
    sharedSpaceFullUpgrade: say("Shared space is full. Delete files or upgrade."),
    sharedSpaceFullAskOwner: say("Shared space is full. Delete files or ask the owner to upgrade."),
    sharedSpaceFullTop: say("Shared space is full. Delete files to make room."),
    computersBusy: say("All computers are busy. Try again shortly."),
    computerLimit: say("Computer limit reached. Archive a bot to free one."),
    spaceLimit: say("Space limit reached. Delete a Space to add another."),
    planNotOffered: say("This plan is free. Choose a paid plan to upgrade."),
    upgrade: say("Upgrade"),
    upgradeTo: (plan: string) => say("Upgrade to {plan}", { plan }),
    retry: say("Try again"),
  };
}
