import {
  groupSiteSessions,
  hasSiteSessions,
  readCookieHosts,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { Computer } from "@rakazo/db";
import { readJsonColumn, recordAuditEvent } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import * as z from "zod";
import type { RouterDeps } from "./router.js";
import { computerContext } from "./routes/shared.js";

/** More sites than a person signs in to by hand in one go are page clutter, not sign-ins. */
const MAX_SITES = 20;
/** The lease that just ended is among this bot's latest grants. */
const GRANTS_READ = 5;
const GrantPayload = z.object({ leaseId: z.string().optional() });

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
      // Payloads are sealed at rest, so the lease is matched after reading, not in the query.
      const grants = await deps.prisma.event.findMany({
        where: { botId, type: "computer.takeover.granted" },
        orderBy: { createdAt: "desc" },
        take: GRANTS_READ,
        select: { id: true, createdAt: true, payload: true },
      });
      const granted = grants.find(
        (event) =>
          readJsonColumn(
            GrantPayload,
            event.payload,
            { table: "events", column: "payload", id: event.id },
            { fallback: {} },
          ).leaseId === leaseId,
      );
      if (!granted) return;
      const since = granted.createdAt.getTime();
      const hosts = await readCookieHosts(
        deps.sandbox,
        toComputerRef(computer),
        botId,
        computerContext(actor, botId, "site-sessions.audit"),
      );
      const opened = groupSiteSessions(
        // A host the browser has not saved yet got its cookie within the last ~30 seconds.
        hosts.filter((host) => host.created === null || host.created >= since),
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
