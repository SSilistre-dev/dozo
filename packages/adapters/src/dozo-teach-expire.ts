import { expireTeachValues } from "@rakazo/db";
import type { TeachingSessionDeps } from "./teaching-session.js";
import { expireTaughtSkillTeaching as expireUpstream } from "./teaching-session.js";

/**
 * Upstream's teaching timer under the same name: it also forgets the values typed while teaching
 * once the teacher's time to review them is up (the draft queues this job for that time).
 */
export async function expireTaughtSkillTeaching(deps: TeachingSessionDeps, skillId: string) {
  const skill = await expireUpstream(deps, skillId);
  await expireTeachValues(deps.prisma, skillId);
  return skill;
}
