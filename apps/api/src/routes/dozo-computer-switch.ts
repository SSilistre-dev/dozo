import type { AdapterContext } from "@rakazo/adapter-kit";
import { createAdapterContext } from "@rakazo/adapter-kit";
import type { ComputerMoveDeps } from "@rakazo/adapters";
import {
  BotFilesNotMovedError,
  moveBotComputerFiles,
  recoverBotComputerSwitch,
  switchDueKey,
  switchLeaseKey,
} from "@rakazo/adapters";
import type { Actor, Bot, ComputerMode } from "@rakazo/contracts";
import {
  assertLeaseHeld,
  ensureComputerRecord,
  LeaseHeldError,
  runAsSystem,
  teamComputerUserId,
  withLease,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** How long a switch outlives its last renewal; one whose process died is finished after this. */
const SWITCH_LEASE_MS = 2 * 60_000;
/** A switching flag this old with no switch holding the lease is a dead switch's. */
const DEAD_SWITCH_MS = 5 * 60_000;
/** The slow safety net: a switch is finished in the process that started it. */
const SWEEP_MS = 60_000;
const SWEEP_BATCH = 100;

const COMPUTER_FIELDS = {
  id: true,
  homeKey: true,
  kind: true,
  providerRef: true,
  scope: true,
} as const;

/**
 * Switch the bot's computer and move its files and browser sign-ins with it, holding the bot's
 * switch lease. The switch counts only once they are on the new computer: when they cannot be,
 * it is undone and the refusal says why. A switch already under way for the bot refuses.
 *
 * The bot's computer changes in one transaction with a check that the lease is still this
 * switch's, together with a lapsed `switchDueKey` row: from then the computer it left is due a
 * cleanup, which this switch does and clears, or the sweep does. `read` answers the bot as the
 * caller shows it, once the switch has happened.
 */
export async function switchBotComputerWithFiles(
  deps: ComputerMoveDeps,
  input: {
    actor: Actor;
    bot: { id: string; userId: string };
    fromComputerId: string;
    mode: ComputerMode;
    context: AdapterContext;
  },
  read: () => Promise<Bot>,
): Promise<Bot> {
  const { actor, bot, mode, context } = input;
  try {
    await withLease(
      deps.prisma,
      switchLeaseKey(bot.id),
      { ttlMs: SWITCH_LEASE_MS, signal: context.signal },
      async (lease) => {
        const from = await deps.prisma.computer.findUniqueOrThrow({
          where: { id: input.fromComputerId },
          select: COMPUTER_FIELDS,
        });
        // The computer it joins, made as the switch would make it (and refused at the limit).
        const userId =
          mode === "team"
            ? await teamComputerUserId(deps.prisma, { spaceId: actor.spaceId, userId: bot.userId })
            : bot.userId;
        const record = { mode, spaceId: actor.spaceId, userId, botId: bot.id, kind: from.kind };
        const to = await ensureComputerRecord(deps.prisma, record);
        await moveBotComputerFiles(
          deps,
          {
            botId: bot.id,
            from,
            to,
            flip: () =>
              deps.prisma.$transaction(async (tx) => {
                await assertLeaseHeld(tx, lease);
                // Again inside the transaction, so the per-person computer limit holds with the link.
                await ensureComputerRecord(tx, record);
                await tx.bot.update({ where: { id: bot.id }, data: { computerId: to.id } });
                await tx.$executeRaw`
                  INSERT INTO "leases" ("key", "fence", "expiresAt")
                  VALUES (${switchDueKey(bot.id)}, nextval('leases_fence_seq'), clock_timestamp())
                  ON CONFLICT ("key") DO NOTHING`;
              }),
            stillHeld: () => deps.prisma.$transaction((tx) => assertLeaseHeld(tx, lease)),
            cleared: async () => {
              await deps.prisma
                .$executeRaw`DELETE FROM "leases" WHERE "key" = ${switchDueKey(bot.id)}`;
            },
          },
          { ...context, signal: lease.signal },
        );
      },
    );
  } catch (error) {
    if (error instanceof LeaseHeldError) throw new BotFilesNotMovedError();
    throw error;
  }
  return read();
}

/** A lapsed row that brings the sweep back to a bot it could not finish yet. */
const retryKey = (botId: string) => `dozo-computer-switch-retry:${botId}`;

/**
 * Finish the switches whose process died or whose computer left behind could not be cleared:
 * each left a lapsed row in the lease table. A `switchDueKey` row means the bot's computer had
 * changed, so the computer it left is cleared too (`recoverBotComputerSwitch`).
 */
export async function sweepComputerSwitches(deps: ComputerMoveDeps, signal: AbortSignal) {
  const rows = await deps.prisma.$queryRaw<Array<{ key: string }>>`
    SELECT "key" FROM "leases"
    WHERE "key" LIKE 'dozo-computer-switch%' AND "expiresAt" <= clock_timestamp()
    ORDER BY "expiresAt" LIMIT ${SWEEP_BATCH}`;
  const botIds = new Set(rows.map((row) => row.key.slice(row.key.indexOf(":") + 1)));
  for (const botId of botIds) {
    if (signal.aborted) return;
    const context = createAdapterContext({ spaceId: "", userId: "" }, botId, "computer.switch");
    await withLease(deps.prisma, switchLeaseKey(botId), { ttlMs: SWITCH_LEASE_MS }, async () => {
      const due = await deps.prisma.$queryRaw<unknown[]>`
        SELECT 1 FROM "leases" WHERE "key" = ${switchDueKey(botId)}`;
      if (await recoverBotComputerSwitch(deps, botId, context, DEAD_SWITCH_MS, due.length > 0)) {
        await deps.prisma.$executeRaw`
          DELETE FROM "leases" WHERE "key" IN (${switchDueKey(botId)}, ${retryKey(botId)})`;
      } else {
        await deps.prisma.$executeRaw`
          INSERT INTO "leases" ("key", "fence", "expiresAt")
          VALUES (${retryKey(botId)}, nextval('leases_fence_seq'), clock_timestamp())
          ON CONFLICT ("key") DO NOTHING`;
      }
    }).catch((error: unknown) => {
      // A switch under way finishes its own work.
      if (!(error instanceof LeaseHeldError)) getLogger().error("computer switch sweep", error);
    });
  }
}

/** Runs the sweep at start and every minute. Stopping waits for a running pass. */
export function startComputerSwitchSweep(deps: ComputerMoveDeps, everyMs = SWEEP_MS) {
  const stopping = new AbortController();
  let running: Promise<void> | undefined;
  const tick = () => {
    running ??= runAsSystem("finish computer switches", () =>
      sweepComputerSwitches(deps, stopping.signal),
    )
      .catch((error: unknown) => getLogger().error("computer switch sweep", error))
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    stopping.abort();
    await running;
  };
}
