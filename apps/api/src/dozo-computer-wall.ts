import { watchesScreenWithoutWake, watchScreen } from "@rakazo/adapters";
import type { Actor, DozoComputerTile } from "@rakazo/contracts";
import { addScreenProxyCapability } from "@rakazo/core/node/screen-capability";
import type { PrismaClient } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { withViewOnly } from "./computers/computer-control.js";
import { toComputerStatus } from "./computers/computer-status.js";
import type { RouterContext } from "./routes/context.js";
import { computerContext } from "./routes/shared.js";

type WallComputer = {
  kind: string;
  state: string;
  scope: string;
  controlHolder: string;
  homeRevision: string;
  maintenanceId: string | null;
  providerRef: string | null;
};

/**
 * Whether the wall may stream this computer: the caller's own bot (in a shared Space another
 * member's bot shows as its avatar, and opens only in the single view), running now, and of a kind
 * that can show its screen without starting, resuming or extending it, without changing who
 * controls it and without minting a single-use sign-in.
 */
function streams(bot: { userId: string }, computer: WallComputer, actor: Actor): boolean {
  const status = toComputerStatus("", computer);
  return (
    bot.userId === actor.userId &&
    computer.state === "running" &&
    Boolean(computer.providerRef) &&
    status.screenAvailable &&
    !status.runsOnUserMachine &&
    watchesScreenWithoutWake(computer.kind)
  );
}

/**
 * The computer of every bot in the caller's Space, read from the database only: nothing here
 * reaches a provider, so a read never starts, wakes or keeps a computer awake. A bot without a
 * computer is left out.
 */
export async function listComputerTiles(
  prisma: Pick<PrismaClient, "bot">,
  actor: Actor,
): Promise<DozoComputerTile[]> {
  const bots = await prisma.bot.findMany({
    where: { spaceId: actor.spaceId, archivedAt: null, computerId: { not: null } },
    select: {
      id: true,
      userId: true,
      computer: {
        select: {
          kind: true,
          state: true,
          scope: true,
          controlHolder: true,
          homeRevision: true,
          maintenanceId: true,
          providerRef: true,
        },
      },
    },
  });
  return bots.flatMap((bot) => {
    if (!bot.computer) return [];
    const { state } = toComputerStatus(bot.id, bot.computer);
    return [{ botId: bot.id, state, screen: streams(bot, bot.computer, actor) }];
  });
}

/**
 * A view-only address for one tile under the rules of `streams`, or null. It is never interactive
 * and holds no control lease, so it neither repeats a controller's command nor reschedules sleep;
 * a computer the provider finds not running, or any failure, is simply no screen.
 */
export async function wallScreen(ctx: RouterContext, actor: Actor, botId: string) {
  const { deps, repos } = ctx;
  const bot = await repos.getBot(actor, botId);
  const computer = bot.computer;
  if (!computer || !streams(bot, computer, actor)) return null;
  const session = await bestEffort(
    "watch a computer screen",
    watchScreen(deps.sandbox, computer, computerContext(actor, bot.id, "screen")),
  );
  if (!session?.url || session.singleUseSignIn) return null;
  return addScreenProxyCapability(
    withViewOnly(session.url, true),
    deps.env.screenProxySecret,
    deps.env.webOrigin,
    {
      botId: bot.id,
      computerId: computer.id,
      botGeneration: bot.screenGeneration,
      computerGeneration: computer.screenGeneration,
      controlLeaseId: computer.controlLeaseId,
    },
    undefined,
    session.headers,
  );
}

export function dozoComputerWallRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoComputerWall: {
      list: authed.dozoComputerWall.list.handler(({ context }) =>
        listComputerTiles(deps.prisma, context.actor),
      ),
      screen: authed.dozoComputerWall.screen.handler(async ({ context, input }) => ({
        url: await wallScreen(ctx, context.actor, input.botId),
      })),
    },
  };
}
