import type { AdapterContext } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { TeachRecordingEvent } from "@rakazo/core";
import { sanitizeTeachRecordingEvent } from "@rakazo/core";
import { expireTaughtSkillTeaching } from "./dozo-teach-expire.js";
import { withTeachClickTarget } from "./dozo-teach-targets.js";
import type { TeachingSessionDeps } from "./teaching-session.js";
import {
  applyTeachingDesktopInput,
  getActiveTeachingSession,
  parseRecording,
} from "./teaching-session.js";

/** The most keys one request carries; the page sends what is queued, in order. */
export const TEACH_KEYS_MAX = 200;

function context(actor: Actor, botId: string): AdapterContext {
  return {
    operationId: "input",
    traceId: "input",
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  };
}

/**
 * Keys typed in a row while teaching, recorded as one event each exactly as one request per key
 * would record them, but with one check of the recording before and one write after: each key
 * still reaches the computer in order, one by one. Plain keys only; protected input keeps its own
 * request. "idle" when nothing records for this person (the caller then just sends the keys),
 * "stale" when the recording ended meanwhile.
 */
export async function recordTeachingKeys(
  deps: TeachingSessionDeps,
  actor: Actor,
  botId: string,
  keys: string[],
): Promise<"recorded" | "idle" | "stale"> {
  const skill = await getActiveTeachingSession(deps.prisma, actor.spaceId, botId, actor.userId);
  if (!skill) return "idle";
  const live = (current: { status: string; expiresAt: Date | null }) =>
    current.status !== "recording"
      ? ("stale" as const)
      : current.expiresAt && current.expiresAt.getTime() <= Date.now()
        ? ("expired" as const)
        : ("live" as const);
  const prepared = await deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM taught_skills WHERE id = ${skill.id} FOR UPDATE`;
    const current = await tx.taughtSkill.findUniqueOrThrow({ where: { id: skill.id } });
    const state = live(current);
    if (state !== "live") return { state, computer: null };
    const bot = await tx.bot.findUnique({ where: { id: botId }, include: { computer: true } });
    return { state, computer: bot?.computer ?? null };
  });
  if (prepared.state === "expired") {
    await expireTaughtSkillTeaching(deps, skill.id);
    return "stale";
  }
  if (prepared.state === "stale") return "stale";
  const events: TeachRecordingEvent[] = [];
  for (const key of keys) {
    if (prepared.computer?.providerRef) {
      await applyTeachingDesktopInput(
        deps.sandbox,
        prepared.computer,
        { kind: "key", key, sensitive: false },
        context(actor, botId),
      );
    }
    events.push(sanitizeTeachRecordingEvent({ at: new Date().toISOString(), kind: "key", key }));
  }
  const recorded = await deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM taught_skills WHERE id = ${skill.id} FOR UPDATE`;
    const current = await tx.taughtSkill.findUniqueOrThrow({ where: { id: skill.id } });
    const state = live(current);
    if (state !== "live") return state;
    // The clicks' targets recorded so far stay with the recording.
    const recording = withTeachClickTarget(
      skill.id,
      current.recording,
      parseRecording(current.recording),
    );
    recording.events.push(...events);
    await tx.taughtSkill.update({
      where: { id: skill.id },
      data: { recording: recording as never },
    });
    return "recorded" as const;
  });
  if (recorded === "expired") {
    await expireTaughtSkillTeaching(deps, skill.id);
    return "stale";
  }
  return recorded;
}
