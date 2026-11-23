import type { ToolStepCall } from "@rakazo/contracts";
import { isPhoneToolName, isPhoneWriteToolName } from "@rakazo/contracts";

/** What a later run is told of a phone read instead of its output. */
export const PHONE_READ_KEPT =
  "Read from the user's phone; not kept. Call the tool again to see it.";
/** What a later run is told of a write to the phone, instead of what it wrote. */
export const PHONE_WRITE_KEPT = "Written to the user's phone.";

/**
 * The calls a reply keeps for its later runs to replay. A read of the user's phone keeps its
 * arguments and no output: what it read stays in the run that read it (and in the reply the person
 * sees). A write to it keeps neither: its arguments are what it wrote there. An error holds no
 * content and is kept as it was (a write's without its arguments); every other tool's calls are
 * unchanged.
 */
export function keptToolCalls(tool: string, calls: ToolStepCall[]): ToolStepCall[] {
  if (!isPhoneToolName(tool)) return calls;
  const write = isPhoneWriteToolName(tool);
  return calls.map((call) => {
    if (call.failed) {
      if (!write) return call;
      const { arguments: _written, ...rest } = call;
      return rest;
    }
    if (write) return { result: PHONE_WRITE_KEPT };
    return {
      ...(call.arguments !== undefined ? { arguments: call.arguments } : {}),
      result: PHONE_READ_KEPT,
    };
  });
}
