import {
  groupSiteSessions,
  hasSiteSessions,
  readCookieHosts,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { Computer } from "@rakazo/db";
import { recordAuditEvent } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { RouterDeps } from "./router.js";
import { computerContext } from "./routes/shared.js";

/** More sites than a person signs in to by hand in one go are page clutter, not sign-ins. */
const MAX_SITES = 20;

/**
 * After a person hands back a bot's screen, the sites whose first cookie was set while they held
 * it are recorded as sessions they opened there: who, which bot, which site, never a value. A
 * site that also only set tracking cookies is recorded the same way; the time alone cannot tell
 * a sign-in from a visit. Runs after the hand back, off its path, and only records.
 */
export function auditSiteSessionsAfterControl(
  deps: Pick<RouterDeps, "prisma" | "sandbox">,
  actor: Actor,
  computer: Computer,
  botId: string,
  leaseId: string,
): void {
  if (computer.state !== "running" || !computer.providerRef || !hasSiteSessions(computer.kind))
    return;
  void bestEffort(
    "record the sites signed in to under a person's control",
    (async () => {
      const granted = await deps.prisma.event.findFirst({
        where: {
          botId,
          type: "computer.takeover.granted",
          payload: { path: ["leaseId"], equals: leaseId },
        },
        select: { createdAt: true },
      });
      if (!granted) return;
      const since = granted.createdAt.getTime();
      const hosts = await readCookieHosts(
        deps.sandbox,
        toComputerRef(computer),
        botId,
        computerContext(actor, botId, "site-sessions.audit"),
      );
      const opened = groupSiteSessions(hosts.filter((host) => host.created >= since));
      for (const { site } of opened.slice(0, MAX_SITES)) {
        await recordAuditEvent({
          action: "computer.site.session_opened",
          actor: { type: "user", id: actor.userId },
          spaceId: actor.spaceId,
          target: { type: "bot", id: botId },
          metadata: { site, via: "control" },
        });
      }
    })(),
  );
}
