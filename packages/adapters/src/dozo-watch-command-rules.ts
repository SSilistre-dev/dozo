import { matchCommandRules } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { readDozoCommandRules } from "@rakazo/db";

/**
 * Why a routine's command watch may not run its command now: a block rule of the routine's member
 * for its bot covers it. Read at every check, so a block added after the routine was made stops it.
 * Allow rules play no part: the watch was approved when it was made.
 */
export async function dozoWatchCommandRefusal(
  prisma: Pick<PrismaClient, "$queryRaw">,
  routine: { userId: string; botId: string },
  command: string,
): Promise<string | undefined> {
  const rules = await readDozoCommandRules(prisma as PrismaClient, routine);
  const blocks = rules.filter((rule) => rule.effect === "block");
  if (!blocks.length) return undefined;
  return matchCommandRules(blocks, { command, cwd: "", computer: "hosted" }) === "block"
    ? "The check command is blocked for this bot by the member's command rules."
    : undefined;
}
