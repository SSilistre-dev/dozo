import { noComputerFilesInstruction } from "./dozo-no-computer.prompt.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { modelCreditBillingEnabled } from "./run-model.js";
import { sandboxAllowanceUsedUp } from "./sandbox-allowance.js";

/**
 * The built-ins that work only on the bot's own computer: every one of them starts it. The user's
 * own connected computer has its own tools (`user_computer_*`), which stay.
 */
export const CLOUD_COMPUTER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "computer_observe",
  "computer_act",
  "shell",
  "open_path",
  "launch_app",
  "list_files",
  "read_file",
  "write_file",
  "attach_file",
  // Writes the chart's PNG to the computer before it attaches it.
  "render_plot",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "request_takeover",
]);

/**
 * Whether a run starts without its computer: the server bills and the organization has no computer
 * hours left (Free has none). It is the same check that refuses the computer's start, made once at
 * the start of the run, so the bot is never offered a computer that would be refused. A computer
 * on the user's own machine never counts, and a server that does not bill never withholds one.
 * A paused turn resumes with the tools it started with: its computer's start is still refused.
 */
export async function cloudComputerWithheld(
  deps: Pick<ExecutorDeps, "prisma" | "sandbox" | "billingEnabled">,
  computer: { spaceId: string; kind: string },
  resumed: boolean,
): Promise<boolean> {
  if (resumed || !(await modelCreditBillingEnabled(deps))) return false;
  return sandboxAllowanceUsedUp(deps, computer);
}

/** The run's turned-off built-ins, with the computer's when it has none. */
export function withoutCloudComputerTools(
  disabled: Set<string>,
  withheld: boolean | undefined,
): Set<string> {
  return withheld ? new Set([...disabled, ...CLOUD_COMPUTER_TOOL_NAMES]) : disabled;
}

/**
 * The prepared computer as the rest of the run sees it. Without hours it is not graphical (no
 * desktop, page browser or computer-mode model), and attachments are named without the paths
 * they would have been copied to.
 */
export async function gateRunComputer<
  T extends {
    storedComputer: { spaceId: string };
    computerKind: string;
    graphical: boolean;
    attachedFilesPrompt: string;
    currentTurnFiles: readonly { name: string }[];
  },
>(
  hold: {
    deps: Pick<ExecutorDeps, "prisma" | "sandbox" | "billingEnabled">;
    takeover: { heldForTakeover: boolean };
  },
  saved: { storedTurnCheckpoint: boolean; checkpointLoadError?: Error },
  computer: T,
): Promise<T & { cloudComputerWithheld: boolean }> {
  const withheld = await cloudComputerWithheld(
    hold.deps,
    { spaceId: computer.storedComputer.spaceId, kind: computer.computerKind },
    saved.storedTurnCheckpoint ||
      Boolean(saved.checkpointLoadError) ||
      hold.takeover.heldForTakeover,
  );
  if (!withheld) return { ...computer, cloudComputerWithheld: false };
  return {
    ...computer,
    graphical: false,
    attachedFilesPrompt: noComputerFilesInstruction(
      computer.currentTurnFiles.map((file) => file.name),
    ),
    cloudComputerWithheld: true,
  };
}
