import type { NoComputerReason } from "./dozo-no-computer.js";
import { CONNECT_OWN_COMPUTER } from "./dozo-own-computer.prompt.js";
import type { UserComputerState } from "./run-tools-user-computer.js";

/**
 * In place of the computer guidance when the run has no computer of its own: the plan has no
 * computer hours left, its payment is overdue, or it includes no cloud computer at all (Free, which
 * works on the user's own computer by design). The bot works without one and, when a task truly
 * needs one, says how to get it: the user's own computer, connected through the desktop app, or
 * for spent hours more of them, or for an overdue payment the payment fixed. A plan without a
 * cloud computer is never told to upgrade.
 */
export function noCloudComputerInstruction(options: {
  /** Absent reads as no hours left. */
  reason?: NoComputerReason | false;
  userComputer: UserComputerState;
  /** The tools this run was offered. */
  offered: ReadonlySet<string>;
}): string {
  const search = options.offered.has("web_search");
  const fetch = options.offered.has("web_fetch");
  const web =
    search && fetch
      ? " Look things up with web_search and read pages with web_fetch."
      : search
        ? " Look things up with web_search."
        : fetch
          ? " Read pages with web_fetch."
          : "";
  const why =
    options.reason === "payment"
      ? "the plan's payment is overdue, and its computer hours return once it is paid"
      : options.reason === "plan"
        ? "the plan includes no cloud computer, so you work on the user's own computer"
        : "the plan has no computer hours left";
  if (options.userComputer === "connected")
    return `You have no computer of your own in this run: ${why}. For work that needs a computer, use the user's computer.${web}`;
  const fix =
    options.reason === "payment"
      ? "whoever manages billing can update the payment"
      : options.reason === "plan"
        ? `the user can connect their own computer: ${CONNECT_OWN_COMPUTER}`
        : `the user can connect their own computer (${CONNECT_OWN_COMPUTER}), or get more computer hours`;
  return `You have no computer in this run: ${why}. Work without one: answer directly and use connected tools.${web} Never offer to run commands, open a browser, or save files. If a task truly needs a computer, say so in one short sentence: ${fix}.`;
}

/** Attachments are named, but without a computer there is nowhere to open them. */
export function noComputerFilesInstruction(names: readonly string[]): string {
  if (!names.length) return "";
  return `Attached: ${names.map((name) => JSON.stringify(name)).join(", ")}. Without a computer you can read only what is visible in your input, such as an image.`;
}
