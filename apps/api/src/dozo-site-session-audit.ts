import {
  groupSiteSessions,
  hasSiteSessions,
  readCookieHosts,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { abortableDelay } from "@rakazo/core";
import type { Computer } from "@rakazo/db";
import { recordAuditEvent } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { RouterDeps } from "./router.js";
import { computerContext } from "./routes/shared.js";

/** More sites than a person signs in to by hand in one go are page clutter, not sign-ins. */
const MAX_SITES = 20;

/**
 * The browser writes new cookies to disk about every 30 seconds, and only the disk says when a
 * cookie was set: the check waits that out first.
 */
export const SITE_AUDIT_DELAY_MS = 40_000;

/**
 * After a person hands back a bot's screen, the sites whose first cookie was set while they held
 * it are recorded as sessions they opened there: who, which bot, which site, never a value. A
 * site that also only set tracking cookies is recorded the same way; the time alone cannot tell
 * a sign-in from a visit. Runs after the hand back, off its path, and only records. Best effort:
 * a computer that stops or an API that restarts within the wait records nothing.
 */
export function auditSiteSessionsAfterControl(
  deps: Pick<RouterDeps, "prisma" | "sandbox">,
  actor: Actor,
  computer: Computer,
  botId: string,
  leaseId: string,
  delayMs = SITE_AUDIT_DELAY_MS,
): void {
  if (computer.state !== "running" || !computer.providerRef || !hasSiteSessions(computer.kind))
    return;
  void bestEffort(
    "record the sites signed in to under a person's control",
    (async () => {
      await abortableDelay(delayMs);
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
      const opened = groupSiteSessions(
        // A host with no saved time yet cannot be placed in the lease; it is left out.
        hosts.filter((host) => host.created !== null && host.created >= since),
      );
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
