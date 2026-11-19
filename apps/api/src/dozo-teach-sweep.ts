import type { TeachingSessionDeps } from "@rakazo/adapters";
import { expireTaughtSkillTeaching } from "@rakazo/adapters";
import { expireAllTeachValues, runAsSystem } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { FORGET_PAGE, forgetOldTeachTyping } from "./dozo-taught-skills.js";

/** A recording this long past its time lost its expiry job; the job is the main path. */
const LATE_RECORDING_SECONDS = 10 * 60;
/** One pass forgets at most this many pages of old skills; the next pass, the rest. */
const FORGET_PAGES_PER_PASS = 50;

/**
 * The slow safety net behind teaching's queue jobs, run by the API at start and hourly (every
 * instance may: each step is safe to repeat). It forgets the values of every draft whose review
 * time is up (also where no queue runs), drafts recordings whose expiry job was lost, which
 * moves what was typed in them out of the recording, and forgets what is typed in skills the
 * previous release drafted or saved.
 */
export function dozoTeachSweep(deps: TeachingSessionDeps) {
  return (signal: AbortSignal) =>
    runAsSystem("sweep what teaching left behind", async () => {
      await expireAllTeachValues(deps.prisma);
      const late = await deps.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM taught_skills
        WHERE status = 'recording'
          AND "expiresAt" < CURRENT_TIMESTAMP - make_interval(secs => ${LATE_RECORDING_SECONDS})`;
      for (const { id } of late) {
        if (signal.aborted) return;
        await bestEffort(
          "draft a teaching recording past its time",
          expireTaughtSkillTeaching(deps, id),
        );
      }
      // In id order, on past the last skill looked at, so one that cannot be forgotten is passed.
      let after: string | undefined;
      for (let page = 0; page < FORGET_PAGES_PER_PASS && !signal.aborted; page += 1) {
        const { looked, last } = await forgetOldTeachTyping(deps.prisma, { after });
        if (looked < FORGET_PAGE || !last) return;
        after = last;
      }
    });
}
