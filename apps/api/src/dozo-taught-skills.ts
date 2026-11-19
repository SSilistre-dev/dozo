import { SandboxAllowanceUsedError } from "@rakazo/adapter-kit";
import { sandboxAllowanceUsedUp } from "@rakazo/adapters";
import type { Actor, TeachRecordingEvent } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { TaughtSkillsDeps } from "./taught-skills.js";
import { createTaughtSkillsService as createUpstreamTaughtSkillsService } from "./taught-skills.js";

/**
 * Forgets what was typed while teaching: the keys and text of the recording's key and clipboard
 * events, and the cached value suggestions. One statement on the row, so it cannot lose an update
 * made meanwhile. The protected-input marks and pointer steps stay.
 */
export async function scrubTeachRecording(prisma: PrismaClient, skillId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE taught_skills SET
      recording = jsonb_set(
        recording - 'dozoSuggestions',
        '{events}',
        (SELECT coalesce(jsonb_agg(
            CASE WHEN jsonb_typeof(e) = 'object' AND e->>'kind' IN ('key', 'clipboard')
              THEN e - 'key' - 'text' ELSE e END ORDER BY ord), '[]'::jsonb)
          FROM jsonb_array_elements(recording->'events') WITH ORDINALITY AS t(e, ord))
      ),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = ${skillId} AND jsonb_typeof(recording->'events') = 'array'`;
}

/**
 * Upstream's taught-skills service under the same name, with two changes: teaching on a plan with
 * no computer time left is refused before any of the person's runs is cancelled, and every save
 * forgets what was typed (the playbook holds placeholders, never the text).
 */
export function createTaughtSkillsService(deps: TaughtSkillsDeps) {
  const upstream = createUpstreamTaughtSkillsService(deps);
  return {
    ...upstream,

    async start(actor: Actor, botId: string, goal: string) {
      const bot = await deps.prisma.bot.findFirst({
        where: { id: botId, spaceId: actor.spaceId },
        include: { computer: true },
      });
      const computer = bot?.computer;
      // Only a computer teaching would start; a running one costs nothing new.
      if (computer && (computer.state !== "running" || !computer.providerRef)) {
        const kind = (await deps.sandbox.provisionKind?.(computer.homeKey)) ?? computer.kind;
        if (await sandboxAllowanceUsedUp(deps, { spaceId: computer.spaceId, kind })) {
          throw new SandboxAllowanceUsedError();
        }
      }
      return upstream.start(actor, botId, goal);
    },

    async save(actor: Actor, skillId: string, name?: string) {
      const saved = await upstream.save(actor, skillId, name);
      await scrubTeachRecording(deps.prisma, skillId);
      return {
        ...saved,
        recording: { ...saved.recording, events: scrubbedEvents(saved.recording.events) },
      };
    },
  };
}

/** The events as the scrub leaves them, for the answer read before it. */
function scrubbedEvents(events: TeachRecordingEvent[]): TeachRecordingEvent[] {
  return events.map((event) => {
    if (event.kind !== "key" && event.kind !== "clipboard") return event;
    const { key: _key, text: _text, ...rest } = event;
    return rest;
  });
}
