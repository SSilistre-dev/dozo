import type { AdapterContext, SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { TeachRecordingEvent } from "@rakazo/core";
import { computerInputForDomKey, sanitizeTeachRecordingEvent } from "@rakazo/core";
import { toComputerRef } from "./computer-support.js";
import { expireTaughtSkillTeaching } from "./dozo-teach-expire.js";
import { withTeachClickTarget } from "./dozo-teach-targets.js";
import type { TeachingSessionDeps } from "./teaching-session.js";
import { getActiveTeachingSession, parseRecording } from "./teaching-session.js";

/** The most actions the computer takes in one call. */
const ACTIONS_PER_CALL = 24;

/**
 * Sends keys to the computer in order, as one request per key would type them, but as a few
 * action calls: one input request starts a process on the computer for each key (about 0.2 s
 * each, measured), while an action call runs its keys in the computer's own control process.
 */
export async function sendTeachKeys(
  sandbox: Pick<SandboxProvider, "act">,
  computer: { homeKey: string; kind: string; providerRef: string | null },
  keys: string[],
  context: AdapterContext,
): Promise<void> {
  if (!computer.providerRef) return;
  const actions = keys.map((key) => computerInputForDomKey(key));
  for (let at = 0; at < actions.length; at += ACTIONS_PER_CALL) {
    await sandbox.act(
      toComputerRef(computer),
      { actions: actions.slice(at, at + ACTIONS_PER_CALL), observe: false },
      context,
    );
  }
}

export function teachKeysContext(actor: Actor, botId: string): AdapterContext {
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
 * would record them, but with one check of the recording before and one write after: the keys
 * reach the computer in order (`sendTeachKeys`). Plain keys only; protected input keeps its own
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
  const at = new Date().toISOString();
  const events: TeachRecordingEvent[] = keys.map((key) =>
    sanitizeTeachRecordingEvent({ at, kind: "key", key }),
  );
  if (prepared.computer) {
    await sendTeachKeys(deps.sandbox, prepared.computer, keys, teachKeysContext(actor, botId));
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
