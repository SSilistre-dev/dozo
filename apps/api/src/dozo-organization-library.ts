import type { Actor, AgentSkill } from "@rakazo/contracts";
import {
  readOrganizationLibrary,
  recordAuditEvent,
  runAsSystem,
  shareSkillWithOrganization,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { RouterContext } from "./routes/context.js";

/**
 * A skill as the person reading it sees it. A skill of the organization library that is someone
 * else's is read only for them, and where its owner keeps it is not theirs to know.
 */
export function dozoSkillView(actor: Pick<Actor, "userId">) {
  return <T extends { userId: string }>(row: T, skill: AgentSkill): AgentSkill =>
    row.userId === actor.userId ? skill : { ...skill, readOnly: true, availability: undefined };
}

/**
 * The organization skill library. Reading it is open to every member of the open Space; putting a
 * skill in or taking it out is for the organization's owner, for a skill they wrote, checked on the
 * server. A change signals every Space of the organization, whose apps read their skills again.
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
          const { spaceIds } = await shareSkillWithOrganization(deps.prisma, actor, input);
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
    },
  };
}
