import type { DozoTeachStoredTarget } from "@rakazo/contracts";
import { DozoTeachStoredTargetSchema } from "@rakazo/contracts";
import * as z from "zod";
import { JsonColumnMismatchError, readJsonColumn, reportJsonColumnOnce } from "./json-column.js";

/**
 * Where a teaching recording keeps what each recorded click hit, beside its events: its window,
 * and while it records a small picture, which drafting moves to the teacher's short-lived store.
 */
export const TEACH_TARGETS_KEY = "dozoTargets";

const StoredTargets = z.object({
  [TEACH_TARGETS_KEY]: z.array(DozoTeachStoredTargetSchema).optional(),
});

/**
 * The targets a skill's recording holds. Targets in another shape are reported and read as none:
 * losing them only leaves their steps with the coordinate, and nothing is guessed about them.
 */
export function storedTeachTargets(skillId: string, recording: unknown): DozoTeachStoredTarget[] {
  const row = { table: "taught_skills", column: "recording", id: skillId };
  try {
    return readJsonColumn(StoredTargets, recording, row, "reject")[TEACH_TARGETS_KEY] ?? [];
  } catch (error) {
    if (!(error instanceof JsonColumnMismatchError)) throw error;
    reportJsonColumnOnce("Stored teach targets do not match their schema; dropping them", row);
    return [];
  }
}
