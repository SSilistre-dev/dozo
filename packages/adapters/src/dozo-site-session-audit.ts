import type { AdapterContext, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { readJsonColumn, recordAuditEvent } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import * as z from "zod";
import { toComputerRef } from "./computer-support.js";
import { groupSiteSessions, hasSiteSessions, readBrowserSites } from "./dozo-site-sessions.js";

/** More sites than a person signs in to by hand in one go are page clutter, not sign-ins. */
const MAX_SITES = 20;
/** The lease that just ended is among this bot's latest grants. */
const GRANTS_READ = 5;
const GrantPayload = z.object({ leaseId: z.string().optional() });

/**
 * When a person's control of a bot's screen ends, by hand back or by expiry, the sites they
 * opened at the top level while holding it and that got their first cookie then are recorded as
 * sessions they opened there: who, which bot, which site, never a value. A cookie the browser has
 * not saved yet was set within the last half minute, so it counts too. Runs off the path that
 * ended control, and only records.
 */
export function auditSiteSessionsAfterControl(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  computer: {
    spaceId: string;
    homeKey: string;
    kind: string;
    providerRef: string | null;
    state?: string;
    /** The person whose control ended; the row read before it was cleared. */
    controlUserId?: string | null;
  },
  botId: string | null,
  leaseId: string,
  context: AdapterContext,
): void {
  const userId = computer.controlUserId;
  if (!botId || !userId || computer.state !== "running" || !computer.providerRef) return;
  if (!hasSiteSessions(computer.kind)) return;
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
      const browser = await readBrowserSites(
        deps.sandbox,
        toComputerRef(computer),
        botId,
        { ...context, botId, operationId: "site-sessions.audit" },
        since,
      );
      const opened = groupSiteSessions({
        ...browser,
        hosts: browser.hosts.filter((host) => host.created === null || host.created >= since),
      });
      for (const { site } of opened.slice(0, MAX_SITES)) {
        await recordAuditEvent({
          action: "computer.site.session_opened",
          actor: { type: "user", id: userId },
          spaceId: computer.spaceId,
          target: { type: "bot", id: botId },
          metadata: { site, via: "control" },
        });
      }
    })(),
  );
}
