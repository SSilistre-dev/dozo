import { encodeOrganizationLogo } from "@rakazo/adapters";
import { DOZO_ORGANIZATION_LOGO_ERROR } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import {
  IsolationError,
  readOrganizationLogo,
  readOrganizationMark,
  recordAuditEvent,
  runAsSystem,
  setOrganizationLogo,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { RouterContext } from "./routes/context.js";

/** An uploaded logo that is not a real picture of the kind it claims to be. */
export class OrganizationLogoError extends ClientError {
  constructor() {
    super("BAD_REQUEST", "Couldn't use that image as a logo", DOZO_ORGANIZATION_LOGO_ERROR);
  }
}

/**
 * How an organization looks in its members' sidebars: its logo. Only its owner changes it,
 * the role is checked before the picture is decoded, and every member of its Spaces is signalled
 * to read it again.
 */
export function dozoOrganizationLogoRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoOrganizationLogo: {
      mark: authed.dozoOrganizationLogo.mark.handler(({ context }) =>
        runAsSystem("read the logo of the organization a Space belongs to", () =>
          readOrganizationMark(deps.prisma, context.actor),
        ),
      ),
      get: authed.dozoOrganizationLogo.get.handler(({ context, input }) =>
        runAsSystem("read an organization's logo for its member", () =>
          readOrganizationLogo(deps.prisma, { userId: context.actor.userId, ...input }),
        ),
      ),
      set: authed.dozoOrganizationLogo.set.handler(({ context, input }) =>
        runAsSystem("change an organization's logo for its owner", async () => {
          const who = { userId: context.actor.userId, organizationId: input.organizationId };
          const current = await readOrganizationLogo(deps.prisma, who);
          if (!current.canManage) throw new IsolationError();
          const logo = input.logo === null ? null : await encodeOrganizationLogo(input.logo);
          if (input.logo !== null && !logo) throw new OrganizationLogoError();
          const { spaceIds } = await setOrganizationLogo(deps.prisma, { ...who, logo });
          await recordAuditEvent({
            action: "organization.logo_changed",
            actor: { type: "user", id: who.userId },
            organizationId: who.organizationId,
            target: { type: "organization", id: who.organizationId },
          });
          void bestEffort(
            "organization logo signal",
            deps.events?.publishRosterChange?.({ spaceIds }),
          );
          return { logo, canManage: true };
        }),
      ),
    },
  };
}
