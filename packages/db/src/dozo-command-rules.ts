import { commandRuleCwd, literalCommandWords } from "@rakazo/core";
import { z } from "zod";
import type { Prisma, PrismaClient } from "./client.js";
import { readJsonColumn } from "./json-column.js";

/** The tool whose "Always allow this command" answer saves a rule here instead of a tool rule. */
export const DOZO_COMMAND_TOOL = "user_computer_shell";

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw"> | Prisma.TransactionClient;

type RuleKey = { userId: string; botId: string; words: readonly string[]; cwd: string };

export type DozoCommandRuleRow = {
  id: string;
  botId: string;
  botName: string;
  words: string[];
  cwd: string;
};

/** Whether the member always allows this bot to run exactly these words in this folder. */
export async function dozoCommandRuleExists(db: Db, key: RuleKey): Promise<boolean> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM dozo_command_rules
    WHERE "userId" = ${key.userId} AND "botId" = ${key.botId}
      AND words = ${[...key.words]}::text[] AND cwd = ${key.cwd}
    LIMIT 1`;
  return rows.length > 0;
}

const ShellRequest = z.object({ command: z.string(), cwd: z.unknown().optional() });

/**
 * Saves the rule an "Always allow this command" answer asks for, from the request the card showed.
 * A command that is not one literal program and its words saves nothing: it was allowed once.
 */
export async function saveDozoCommandRule(
  tx: Prisma.TransactionClient,
  effect: { id: string; request: unknown },
  owner: { userId: string; spaceId: string; botId: string },
): Promise<void> {
  const request = readJsonColumn(
    ShellRequest.nullable(),
    effect.request,
    { table: "external_effects", column: "request", id: effect.id },
    { fallback: null },
  );
  const words = request && literalCommandWords(request.command);
  if (!request || !words) return;
  await tx.$executeRaw`
    INSERT INTO dozo_command_rules ("userId", "spaceId", "botId", words, cwd)
    VALUES (${owner.userId}, ${owner.spaceId}, ${owner.botId}, ${words}::text[],
      ${commandRuleCwd(request.cwd)})
    ON CONFLICT ("userId", "botId", words, cwd) DO NOTHING`;
}

/** The member's command rules in one Space, newest first, with the bot each is for. */
export function listDozoCommandRules(
  db: Db,
  member: { userId: string; spaceId: string },
): Promise<DozoCommandRuleRow[]> {
  return db.$queryRaw<DozoCommandRuleRow[]>`
    SELECT r.id, r."botId", b.name AS "botName", r.words, r.cwd
    FROM dozo_command_rules r JOIN bots b ON b.id = r."botId"
    WHERE r."userId" = ${member.userId} AND r."spaceId" = ${member.spaceId}
    ORDER BY r."createdAt" DESC, r.id DESC`;
}

/** Removes one of the member's command rules in the Space; another member's id removes nothing. */
export async function removeDozoCommandRule(
  db: Db,
  member: { userId: string; spaceId: string },
  id: string,
): Promise<void> {
  await db.$executeRaw`
    DELETE FROM dozo_command_rules
    WHERE id = ${id} AND "userId" = ${member.userId} AND "spaceId" = ${member.spaceId}`;
}
