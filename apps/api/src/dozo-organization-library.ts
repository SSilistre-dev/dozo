import { BUILTIN_AGENT_SKILLS } from "@rakazo/adapters";
import type { Actor, AgentSkill } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  hideLibrarySkill,
  libraryReaderSpaces,
  readOrganizationLibrary,
  recordAuditEvent,
  runAsSystem,
  shareSkillWithOrganization,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { RouterDeps } from "./router.js";
import type { RouterContext } from "./routes/context.js";

/** The built-in skill names, which no one else's library skill may stand in for. */
export const BUILTIN_SKILL_NAMES: readonly string[] = BUILTIN_AGENT_SKILLS.map(
  (skill) => skill.name,
);

/**
 * A skill as the person reading it sees it. A skill of the organization library that is someone
 * else's is read only for them, and where its owner keeps it is not theirs to know.
 */
export function dozoSkillView(actor: Pick<Actor, "userId">) {
  return <T extends { userId: string }>(row: T, skill: AgentSkill): AgentSkill =>
    row.userId === actor.userId ? skill : { ...skill, readOnly: true, availability: undefined };
}

/**
 * Runs an owner's change to one of their skills, then, when the skill is in a library, signals
 * every Space of that organization so its members' apps read their skills again. The Spaces are
 * found before the change, as a deletion takes the library row with it.
 */
export async function dozoAfterLibraryChange<T>(
  deps: Pick<RouterDeps, "prisma" | "events">,
  skillId: string,
  change: () => Promise<T>,
): Promise<T> {
  const spaceIds = await runAsSystem("find the Spaces reading a library skill", () =>
    libraryReaderSpaces(deps.prisma as PrismaClient, skillId),
  );
  const result = await change();
  if (spaceIds.length > 0)
    void bestEffort(
      "organization library signal",
      deps.events?.publishRosterChange?.({ spaceIds }),
    );
  return result;
}

/**
 * The organization skill library. Reading it is open to every member of the open Space, and each
 * member turns a library skill off or on for their own bots; putting a skill in or taking it out
 * is for the organization's owner, for a skill they wrote, checked on the server. A change to the
 * library signals every Space of the organization, whose apps read their skills again.
 */
export function dozoOrganizationLibraryRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoOrganizationLibrary: {
      get: authed.dozoOrganizationLibrary.get.handler(({ context }) =>
        runAsSystem("read the skill library of the open Space's organization", () =>
          readOrganizationLibrary(deps.prisma, context.actor),
        ),
      ),
      share: authed.dozoOrganizationLibrary.share.handler(({ context, input }) =>
        runAsSystem("put a skill in its owner's organization library", async () => {
          const { actor } = context;
          const { spaceIds } = await shareSkillWithOrganization(deps.prisma, actor, {
            ...input,
            builtinNames: BUILTIN_SKILL_NAMES,
          });
          await recordAuditEvent({
            action: input.shared ? "organization.skill_shared" : "organization.skill_unshared",
            actor: { type: "user", id: actor.userId },
            spaceId: actor.spaceId,
            target: { type: "skill", id: input.skillId },
          });
          void bestEffort(
            "organization library signal",
            deps.events?.publishRosterChange?.({ spaceIds }),
          );
          return readOrganizationLibrary(deps.prisma, actor);
        }),
      ),
      hide: authed.dozoOrganizationLibrary.hide.handler(({ context, input }) =>
        runAsSystem("turn a library skill off for one member", async () => {
          const { actor } = context;
          await hideLibrarySkill(deps.prisma, actor, input);
          void bestEffort(
            "organization library signal",
            deps.events?.publishRosterChange?.({ userIds: [actor.userId] }),
          );
          return readOrganizationLibrary(deps.prisma, actor);
        }),
      ),
    },
  };
}
