import type { Actor, DozoComputerTile } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { toComputerStatus } from "./computers/computer-status.js";
import type { RouterContext } from "./routes/context.js";

/**
 * The computer of every bot in the caller's Space, read from the database only: nothing here
 * reaches a provider, so a read never starts, wakes or keeps a computer awake. A bot without a
 * computer is left out. Watching one is the view-only screen read (`computer.screenUrl` with
 * `preview`), under the same per-bot authorization as the single view.
 */
export async function listComputerTiles(
  prisma: Pick<PrismaClient, "bot">,
  actor: Actor,
): Promise<DozoComputerTile[]> {
  const bots = await prisma.bot.findMany({
    where: { spaceId: actor.spaceId, archivedAt: null, computerId: { not: null } },
    select: {
      id: true,
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
  return bots.flatMap(({ id, computer }) => {
    if (!computer) return [];
    const status = toComputerStatus(id, computer);
    // A computer still going to sleep reads as running, but its screen is about to close.
    const screen =
      computer.state === "running" &&
      Boolean(computer.providerRef) &&
      status.screenAvailable &&
      !status.runsOnUserMachine;
    return [{ botId: id, state: status.state, screen }];
  });
}

export function dozoComputerWallRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoComputerWall: {
      list: authed.dozoComputerWall.list.handler(({ context }) =>
        listComputerTiles(deps.prisma, context.actor),
      ),
    },
  };
}
