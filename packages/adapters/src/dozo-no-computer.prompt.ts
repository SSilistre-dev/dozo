import type { UserComputerState } from "./run-tools-user-computer.js";

/**
 * In place of the computer guidance when the run has no computer of its own (the plan has no
 * computer hours left). The bot works without one and, when a task truly needs one, says how to
 * get it: the user's own computer, connected through the desktop app, or a plan with hours.
 */
export function noCloudComputerInstruction(options: {
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
  if (options.userComputer === "connected")
    return `You have no computer of your own in this run: the plan has no computer hours left. For work that needs a computer, use the user's computer.${web}`;
  return `You have no computer in this run: the plan has no computer hours left. Work without one: answer directly and use connected tools.${web} Never offer to run commands, open a browser, or save files. If a task truly needs a computer, say so in one short sentence: the user can connect their own computer from the desktop app, or upgrade the plan.`;
}

/** Attachments are named, but without a computer there is nowhere to open them. */
export function noComputerFilesInstruction(names: readonly string[]): string {
  if (!names.length) return "";
  return `Attached: ${names.map((name) => JSON.stringify(name)).join(", ")}. Without a computer you can read only what is visible in your input, such as an image.`;
}
