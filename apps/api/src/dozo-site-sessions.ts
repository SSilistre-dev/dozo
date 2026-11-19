import {
  endSiteSessions,
  hasSiteSessions,
  listSiteSessions,
  openSiteInBrowser,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { createRepos, recordAuditEvent } from "@rakazo/db";
import { assertNotAnotherPersonsControl, takeComputerControl } from "./computer-control.js";
import type { RouterContext } from "./routes/context.js";
import { computerContext } from "./routes/shared.js";

/**
 * The sites a bot's browser is signed in to: list them, end one or all, and open one to sign in
 * to with control. Sessions stay on the bot's computer; only site names and times come here.
 * Anyone in the Space may do this, as anyone in it may take the screen and use those sessions.
 */
export function dozoSiteSessionsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const repos = createRepos(deps.prisma);

  /** The bot's running computer that can show its sessions, or nothing. */
  async function computerOf(actor: Actor, botId: string) {
    const bot = await repos.getBot(actor, botId);
    const computer = bot.computer;
    if (!computer?.providerRef || computer.state !== "running" || !hasSiteSessions(computer.kind))
      return null;
    return { bot, computer, ref: toComputerRef(computer) };
  }

  return {
    dozoSiteSessions: {
      list: authed.dozoSiteSessions.list.handler(async ({ context, input }) => {
        const found = await computerOf(context.actor, input.botId);
        if (!found) return { sites: [] };
        const sites = await listSiteSessions(
          deps.sandbox,
          found.ref,
          found.bot.id,
          computerContext(context.actor, found.bot.id, "site-sessions.list"),
        );
        return {
          sites: sites.map(({ site, since, lastUsedAt }) => ({
            site,
            since: since.toISOString(),
            lastUsedAt: lastUsedAt.toISOString(),
          })),
        };
      }),

      signOut: authed.dozoSiteSessions.signOut.handler(async ({ context, input }) => {
        const found = await computerOf(context.actor, input.botId);
        if (!found) throw new ClientError("CONFLICT", "Start the computer first.");
        assertNotAnotherPersonsControl(found.computer, context.actor);
        const adapterContext = computerContext(context.actor, found.bot.id, "site-sessions.end");
        const sites = await listSiteSessions(deps.sandbox, found.ref, found.bot.id, adapterContext);
        const ending = input.site ? sites.filter(({ site }) => site === input.site) : sites;
        if (input.site && !ending.length)
          throw new ClientError("NOT_FOUND", "Not signed in there.");
        await endSiteSessions(deps.sandbox, found.ref, found.bot.id, ending, adapterContext);
        for (const { site } of ending) {
          await recordAuditEvent({
            action: "computer.site.session_ended",
            actor: { type: "user", id: context.actor.userId },
            spaceId: context.actor.spaceId,
            target: { type: "bot", id: found.bot.id, label: found.bot.name },
            metadata: { site },
          });
        }
        return { ok: true as const };
      }),

      signIn: authed.dozoSiteSessions.signIn.handler(async ({ context, input }) => {
        const found = await computerOf(context.actor, input.botId);
        if (!found) throw new ClientError("CONFLICT", "Start the computer first.");
        // The same checks as Take control: refused while someone else or the bot is using it.
        const lease = await takeComputerControl(deps, context.actor, found.bot.id);
        await openSiteInBrowser(
          deps.sandbox,
          found.ref,
          found.bot.id,
          input.url,
          computerContext(context.actor, found.bot.id, "site-sessions.open"),
        );
        return lease;
      }),
    },
  };
}
