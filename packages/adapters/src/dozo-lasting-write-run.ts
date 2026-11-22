import { recordRoutineWriter } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { lastingWriteHeld } from "./dozo-lasting-write-card.js";
import { markRunReadHistory } from "./dozo-read-outside.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall, ToolHandler } from "./run-tool-gate.js";

/** The tools that write a routine, each answering `{ ok: true, routineId }` once it is saved. */
const ROUTINE_WRITE_TOOLS = new Set(["schedule_create", "schedule_update", "create_child_routine"]);

/**
 * Runs a tool call the gate let through, noting what the lasting-write rule reads later: that the
 * run called a history tool, and who wrote a routine (dozo_routine_writers). A routine written
 * where lastingWriteHeld holds the call (whether a person approved it or not) is recorded as an
 * outside run's before the write as well, and that one must be saved for the write to go ahead, so
 * a record lost after the write commits never leaves an owner's record on text from outside; the
 * one after the write does not fail the call. The owner's clean run records itself only when it
 * writes the prompt: pausing or moving a routine does not make someone else's text the owner's.
 */
export async function runToolNoted(
  ctx: RunContext,
  call: ToolCall,
  handler: ToolHandler,
): Promise<unknown> {
  markRunReadHistory(ctx.state, call.name);
  if (!ROUTINE_WRITE_TOOLS.has(call.name)) return handler(ctx, call);
  const held = await lastingWriteHeld(ctx, call.name);
  const record = (routineId: string) =>
    recordRoutineWriter(
      ctx.deps.prisma,
      { routineId, spaceId: ctx.run.spaceId },
      held ? "outside_run" : "owner_run",
    );
  const { routineId, prompt } = call.args;
  if (held && call.name === "schedule_update" && typeof routineId === "string")
    await record(routineId);
  const result = await handler(ctx, call);
  const written = writtenRoutineId(result);
  const writesPrompt =
    call.name !== "schedule_update" || (typeof prompt === "string" && prompt.trim());
  if (written && (held || writesPrompt))
    await bestEffort("record a routine's writer", record(written));
  return result;
}

function writtenRoutineId(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const { ok, routineId } = result as { ok?: unknown; routineId?: unknown };
  return ok === true && typeof routineId === "string" ? routineId : undefined;
}
