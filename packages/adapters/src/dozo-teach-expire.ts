import { expireTeachValues } from "@rakazo/db";
import type { TeachingSessionDeps } from "./teaching-session.js";
import { expireTaughtSkillTeaching as expireUpstream } from "./teaching-session.js";

/**
 * Upstream's teaching timer under the same name: it also forgets the values typed while teaching
 * once the teacher's time to review them is up (the draft queues this job for that time). The
 * values go first, so a failure in upstream's part never keeps them.
 */
export async function expireTaughtSkillTeaching(deps: TeachingSessionDeps, skillId: string) {
  await expireTeachValues(deps.prisma, skillId);
  return expireUpstream(deps, skillId);
}
