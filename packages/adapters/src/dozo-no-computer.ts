import { bestEffort } from "@rakazo/logging";
import { noComputerFilesInstruction } from "./dozo-no-computer.prompt.js";
import type { ExecutorDeps } from "./executor-deps.js";
import { modelCreditBillingEnabled } from "./run-model.js";
import { sandboxAllowance, sandboxHourlyCostMicros } from "./sandbox-allowance.js";
import { restoreTurnCheckpoint } from "./turn-checkpoint.js";

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

/** Why a run has no computer: no hours left, or a subscription whose payment is overdue. */
export type NoComputerReason = "hours" | "payment";

type AllowanceDeps = Pick<ExecutorDeps, "prisma" | "sandbox" | "billingEnabled">;

/** Computers a run was assembled without, so its tools can tell (see filesWithoutComputer). */
const withheldComputers = new WeakSet<object>();

/**
 * Why the organization of this Space has no computer hours left, or null when it has some or the
 * server does not bill. The same allowance the computer's start checks, plus the billing status
 * read beside it, to tell an overdue payment (which closes the allowance) from spent hours.
 */
async function hoursMissing(
  deps: AllowanceDeps,
  spaceId: string,
): Promise<NoComputerReason | null> {
  if (!(await modelCreditBillingEnabled(deps))) return null;
  const space = await deps.prisma.space.findUnique({
    where: { id: spaceId },
    select: { organizationId: true },
  });
  if (!space) return null;
  const [allowance, organization] = await Promise.all([
    sandboxAllowance(deps, space.organizationId),
    deps.prisma.organization.findUnique({
      where: { id: space.organizationId },
      select: { billing: { select: { status: true } } },
    }),
  ]);
  if (allowance === null || allowance.usedMicros < allowance.limitMicros) return null;
  return organization?.billing?.status === "past_due" ? "payment" : "hours";
}

/** Whether a paused turn already called a computer tool: it then resumes with them. */
function checkpointUsedComputer(
  checkpoint: string | undefined,
  model: { provider: string; id: string },
): boolean {
  if (!checkpoint) return false;
  let messages: ReturnType<typeof restoreTurnCheckpoint>["messages"];
  try {
    messages = restoreTurnCheckpoint(checkpoint, model).messages;
  } catch {
    // A checkpoint this model cannot restore is dropped by the run itself.
    return false;
  }
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.content.some(
        (part) => part.type === "toolCall" && CLOUD_COMPUTER_TOOL_NAMES.has(part.name),
      ),
  );
}

/** The run's turned-off built-ins, with the computer's when it has none. */
export function withoutCloudComputerTools(
  disabled: Set<string>,
  withheld: NoComputerReason | false | undefined,
): Set<string> {
  return withheld ? new Set([...disabled, ...CLOUD_COMPUTER_TOOL_NAMES]) : disabled;
}

/**
 * Prepares the run's computer and decides whether the run has it: not when the server bills and
 * the organization has no computer hours left (Free has none, a paid plan can spend them, and an
 * overdue payment closes them). It is the check that refuses the computer's start, read once,
 * alongside the preparation, so the bot is never offered a computer that would be refused. A
 * computer on the user's own machine never counts. If the read fails the run keeps its computer,
 * whose start checks again.
 *
 * Without it the run is not graphical (no desktop, page browser or computer-mode model), and
 * attachments are named without the paths they would have been copied to, and are not files the
 * turn can open. A paused turn that was in computer mode, held for a takeover or already called
 * a computer tool resumes with its computer (whose start is still refused); any other paused turn
 * is decided again, so one that started without the computer resumes without it.
 */
export async function gateRunComputer<
  T extends {
    storedComputer: object;
    computerKind: string;
    graphical: boolean;
    attachedFilesPrompt: string;
    currentTurnFiles: readonly { name: string }[];
  },
>(
  hold: {
    deps: AllowanceDeps;
    run: { modelProvider?: string | null; modelId?: string | null };
    takeover: { heldForTakeover: boolean };
  },
  saved: { pinnedComputerModels?: unknown; turnCheckpoint?: string },
  stored: { spaceId: string } | null,
  prepare: () => Promise<T>,
): Promise<T & { cloudComputerWithheld: NoComputerReason | false }> {
  const resumedWithComputer =
    Boolean(saved.pinnedComputerModels) ||
    hold.takeover.heldForTakeover ||
    checkpointUsedComputer(saved.turnCheckpoint, {
      provider: hold.run.modelProvider ?? "",
      id: hold.run.modelId ?? "",
    });
  const [computer, missing] = await Promise.all([
    prepare(),
    stored && !resumedWithComputer
      ? bestEffort("computer hours at run start", hoursMissing(hold.deps, stored.spaceId))
      : null,
  ]);
  const withheld =
    missing && sandboxHourlyCostMicros(hold.deps.sandbox, { kind: computer.computerKind }) > 0
      ? missing
      : false;
  if (!withheld) return { ...computer, cloudComputerWithheld: false };
  withheldComputers.add(computer.storedComputer);
  return {
    ...computer,
    graphical: false,
    attachedFilesPrompt: noComputerFilesInstruction(
      computer.currentTurnFiles.map((file) => file.name),
    ),
    // Nothing is copied anywhere, so an image the model cannot see is not a file it can open.
    currentTurnFiles: [],
    cloudComputerWithheld: withheld,
  };
}

/**
 * The refusal for files a bot asks to send from a computer this run does not have; undefined when
 * it has one. Checked before anything reaches for the computer, which would fail less clearly.
 */
export function filesWithoutComputer(storedComputer: object): { error: string } | undefined {
  return withheldComputers.has(storedComputer)
    ? {
        error:
          "you have no computer in this run, so there are no files to send; send the message without files. Nothing was sent.",
      }
    : undefined;
}
