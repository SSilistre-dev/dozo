import { approvalCuts } from "./dozo-approval-cut.js";
import { buildApprovalAskBlock } from "./dozo-user-computer-gate.js";
import type { RunContext } from "./runs/assembly/run-context.js";
import { auditToolCall } from "./runs/tools/run-tool-audit.js";
import { refusal } from "./runs/turn/tool-refusal.js";

/** Why a call that needs approval is refused when its card would not show all of it. */
export const WHOLE_APPROVAL_ERROR =
  "This request is too long to show the user for approval. Split it into smaller steps, each short enough to read in full.";

/**
 * Whether the approval card for this call would hide part of what Allow approves: any cut made
 * while the card is built, after secrets are redacted, with the limits the card really has. The
 * card is built and dropped before anything is asked or stored.
 */
export function approvalCardCut(
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  options?: Parameters<typeof buildApprovalAskBlock>[4],
): boolean {
  const before = approvalCuts();
  buildApprovalAskBlock("", toolName, args, secrets, options);
  return approvalCuts() !== before;
}

/**
 * The refusal for a call that needs approval whose card would be cut, or undefined when the card
 * shows all of it. Nothing is asked: the recorded effect is marked denied, so no approval stays
 * pending, and the model reads that it must split the request.
 */
export async function wholeApprovalRefusal(
  ctx: RunContext,
  call: { name: string; args: Record<string, unknown>; applied?: { effect: { id: string } } },
  card: Parameters<typeof buildApprovalAskBlock>[4],
): Promise<{ error: string } | undefined> {
  if (!approvalCardCut(call.name, call.args, ctx.secrets, card)) return undefined;
  if (call.applied)
    await ctx.deps.prisma.externalEffect.updateMany({
      where: { id: call.applied.effect.id, status: "intended" },
      data: { status: "denied", result: { refused: "approval_too_long" } },
    });
  await auditToolCall(ctx, call.name, "denied", { reason: "approval_too_long" });
  return refusal("approval_too_long", WHOLE_APPROVAL_ERROR);
}
