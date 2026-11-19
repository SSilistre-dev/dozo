import { i18n } from "@lingui/core";

/**
 * The plan-limit table's copy (`PlanLimitCopy` in `@rakazo/contracts`) in the UI's language, from
 * the translation catalog. Static descriptors with the English text as their id, so the catalog
 * finds them and the build checks each one has its Turkish line. Built on each call: it follows
 * the language in force.
 */
export function planLimitCopy() {
  return {
    computerNotInPlan: i18n._({
      id: "Your plan doesn't include a computer.",
      message: "Your plan doesn't include a computer.",
    }),
    computerNotInPlanAskOwner: i18n._({
      id: "Your plan doesn't include a computer. Ask the owner to upgrade.",
      message: "Your plan doesn't include a computer. Ask the owner to upgrade.",
    }),
    computerHoursUsed: i18n._({
      id: "This month's computer hours are used up.",
      message: "This month's computer hours are used up.",
    }),
    noComputerHours: i18n._({
      id: "No computer hours left.",
      message: "No computer hours left.",
    }),
    sharedSpaceFull: i18n._({
      id: "Shared space is full. Delete files or change the plan.",
      message: "Shared space is full. Delete files or change the plan.",
    }),
    sharedSpaceFullUpgrade: i18n._({
      id: "Shared space is full. Delete files or upgrade.",
      message: "Shared space is full. Delete files or upgrade.",
    }),
    sharedSpaceFullAskOwner: i18n._({
      id: "Shared space is full. Delete files or ask the owner to upgrade.",
      message: "Shared space is full. Delete files or ask the owner to upgrade.",
    }),
    sharedSpaceFullTop: i18n._({
      id: "Shared space is full. Delete files to make room.",
      message: "Shared space is full. Delete files to make room.",
    }),
    computersBusy: i18n._({
      id: "All computers are busy. Try again shortly.",
      message: "All computers are busy. Try again shortly.",
    }),
    computerLimit: i18n._({
      id: "Computer limit reached. Archive a bot to free one.",
      message: "Computer limit reached. Archive a bot to free one.",
    }),
    spaceLimit: i18n._({
      id: "Space limit reached. Delete a Space to add another.",
      message: "Space limit reached. Delete a Space to add another.",
    }),
    planNotOffered: i18n._({
      id: "This plan is free. Choose a paid plan to upgrade.",
      message: "This plan is free. Choose a paid plan to upgrade.",
    }),
    upgrade: i18n._({ id: "Upgrade", message: "Upgrade" }),
    upgradeTo: (plan: string) =>
      i18n._({ id: "Upgrade to {plan}", message: "Upgrade to {plan}", values: { plan } }),
    retry: i18n._({ id: "Try again", message: "Try again" }),
  };
}
