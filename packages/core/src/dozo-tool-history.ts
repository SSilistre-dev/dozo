import type { ToolStepCall } from "@rakazo/contracts";
import { isPhoneToolName } from "@rakazo/contracts";

/** What a later run is told of a phone read instead of its output. */
export const PHONE_READ_KEPT =
  "Read from the user's phone; not kept. Call the tool again to see it.";

/**
 * The calls a reply keeps for its later runs to replay. A read of the user's phone keeps its
 * arguments and no output: what it read stays in the run that read it (and in the reply the person
 * sees). An error holds no content and is kept as it was; every other tool's calls are unchanged.
 */
export function keptToolCalls(tool: string, calls: ToolStepCall[]): ToolStepCall[] {
  if (!isPhoneToolName(tool)) return calls;
  return calls.map((call) =>
    call.failed
      ? call
      : {
          ...(call.arguments !== undefined ? { arguments: call.arguments } : {}),
          result: PHONE_READ_KEPT,
        },
  );
}
