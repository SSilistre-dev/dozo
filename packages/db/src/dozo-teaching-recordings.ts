import type { DozoTeachStoredTarget } from "@rakazo/contracts";
import { DozoTeachStoredTargetSchema } from "@rakazo/contracts";
import type { TeachRecordingEvent } from "@rakazo/core";
import { clicksBeforeSecrets } from "@rakazo/core";
import * as z from "zod";
import { JsonColumnMismatchError, readJsonColumn, reportJsonColumnOnce } from "./json-column.js";

/**
 * Where a teaching recording keeps what each recorded click hit (its window and a small picture),
 * beside its events, until the skill is saved.
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

/**
 * The recording as it is drafted: a click whose next typed value is secret keeps its window but
 * loses its picture, so no picture of a password field reaches the review. Stop, expiry and the
 * end of the control all draft through here.
 */
export function withoutSecretClickImages<R extends { events: TeachRecordingEvent[] }>(
  skillId: string,
  recording: R,
): R {
  const targets = storedTeachTargets(skillId, recording);
  const secret = clicksBeforeSecrets(recording.events);
  const kept = targets.map(({ image, ...target }) =>
    image && !secret.has(target.eventIndex) ? { ...target, image } : target,
  );
  const { [TEACH_TARGETS_KEY]: _stored, ...rest } = recording as R & Record<string, unknown>;
  return (kept.length ? { ...rest, [TEACH_TARGETS_KEY]: kept } : rest) as R;
}
