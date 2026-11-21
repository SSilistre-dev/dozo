import type { DozoCommandComputer, DozoCommandRuleEffect, DozoCommandRuleView } from "@rakazo/core";
import { commandRuleCwd, literalCommandWords } from "@rakazo/core";
import { z } from "zod";
import type { Prisma, PrismaClient } from "./client.js";
import { readJsonColumn } from "./json-column.js";

/**
 * The tools whose "Always allow this command" answer saves a command rule here instead of a rule
 * for the whole tool, with the computer each runs on.
 */
const COMMAND_TOOLS: Readonly<Record<string, DozoCommandComputer>> = {
  user_computer_shell: "user",
  shell: "hosted",
};

/** The computer a tool runs commands on, when its approvals save command rules. */
export function dozoCommandComputer(tool: string): DozoCommandComputer | undefined {
  return Object.hasOwn(COMMAND_TOOLS, tool) ? COMMAND_TOOLS[tool] : undefined;
}

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw"> | Prisma.TransactionClient;

type Member = { userId: string; spaceId: string };

export type DozoCommandRuleRow = DozoCommandRuleView & {
  id: string;
  botId: string;
  botName: string;
  words: string[];
};

/** Every command rule the member keeps for this bot, on both computers, for the run's gate. */
export function readDozoCommandRules(
  db: Db,
  key: { userId: string; botId: string },
): Promise<DozoCommandRuleView[]> {
  return db.$queryRaw<DozoCommandRuleView[]>`
    SELECT words, cwd, effect, computer FROM dozo_command_policies
    WHERE "userId" = ${key.userId} AND "botId" = ${key.botId}`;
}

const ShellRequest = z.object({ command: z.string(), cwd: z.unknown().optional() });

/**
 * Saves the rule an "Always allow this command" answer asks for, from the request the card showed,
 * as an exact allow on the computer the card was for. A command that is not one literal program and
 * its words saves nothing: it was allowed once. A rule already kept for those words keeps its effect,
 * so a block set while the card waited stays a block.
 */
export async function saveDozoCommandRule(
  tx: Prisma.TransactionClient,
  effect: { id: string; request: unknown },
  owner: Member & { botId: string; computer: DozoCommandComputer },
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
    INSERT INTO dozo_command_policies ("userId", "spaceId", "botId", computer, words, cwd)
    VALUES (${owner.userId}, ${owner.spaceId}, ${owner.botId}, ${owner.computer},
      ${words}::text[], ${commandRuleCwd(request.cwd)})
    ON CONFLICT ("userId", "botId", computer, words, cwd) DO NOTHING`;
}

/** The member's command rules in one Space, newest first, with the bot each is for. */
export function listDozoCommandRules(db: Db, member: Member): Promise<DozoCommandRuleRow[]> {
  return db.$queryRaw<DozoCommandRuleRow[]>`
    SELECT r.id, r."botId", b.name AS "botName", r.words, r.cwd, r.effect, r.computer
    FROM dozo_command_policies r JOIN bots b ON b.id = r."botId"
    WHERE r."userId" = ${member.userId} AND r."spaceId" = ${member.spaceId}
    ORDER BY r."createdAt" DESC, r.id DESC`;
}

/** The words and folder of one of the member's rules in the Space; another member's id finds nothing. */
export async function findDozoCommandRule(
  db: Db,
  member: Member,
  id: string,
): Promise<{ words: string[]; cwd: string } | undefined> {
  const rows = await db.$queryRaw<{ words: string[]; cwd: string }[]>`
    SELECT words, cwd FROM dozo_command_policies
    WHERE id = ${id} AND "userId" = ${member.userId} AND "spaceId" = ${member.spaceId}`;
  return rows[0];
}

/**
 * The previous release reads every row of dozo_command_rules as an exact allow, and this one copied
 * its rows here with the same ids. Until the deferred 20270112120100_dozo_drop_command_rules drops
 * that table, a rule removed or turned into anything but an exact allow here is removed there too,
 * so a previous release still running during a deploy, or rolled back to, never allows it. Callers
 * run it first, in the transaction that changes the rule here.
 */
async function retirePreviousRule(db: Db, member: Member, id: string): Promise<void> {
  const [table] = await db.$queryRaw<{ found: boolean }[]>`
    SELECT to_regclass('dozo_command_rules') IS NOT NULL AS found`;
  if (!table?.found) return;
  await db.$executeRaw`
    DELETE FROM dozo_command_rules
    WHERE id = ${id} AND "userId" = ${member.userId} AND "spaceId" = ${member.spaceId}`;
}

/**
 * Changes what one of the member's rules in the Space does, in one transaction with removing its
 * old copy; another member's id changes nothing.
 */
export async function updateDozoCommandRule(
  tx: Prisma.TransactionClient,
  member: Member,
  id: string,
  effect: DozoCommandRuleEffect,
): Promise<void> {
  if (effect !== "allow") await retirePreviousRule(tx, member, id);
  await tx.$executeRaw`
    UPDATE dozo_command_policies SET effect = ${effect}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = ${id} AND "userId" = ${member.userId} AND "spaceId" = ${member.spaceId}`;
}

/**
 * Removes one of the member's command rules in the Space, in one transaction with its old copy;
 * another member's id removes nothing.
 */
export async function removeDozoCommandRule(
  tx: Prisma.TransactionClient,
  member: Member,
  id: string,
): Promise<void> {
  await retirePreviousRule(tx, member, id);
  await tx.$executeRaw`
    DELETE FROM dozo_command_policies
    WHERE id = ${id} AND "userId" = ${member.userId} AND "spaceId" = ${member.spaceId}`;
}

/** Whether commands that change something on the bot's computer ask this member first. */
export async function readDozoHostedAsks(db: Db, userId: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ hostedAsks: boolean }[]>`
    SELECT "hostedAsks" FROM dozo_command_settings WHERE "userId" = ${userId}`;
  return rows[0]?.hostedAsks ?? false;
}

export async function saveDozoHostedAsks(
  db: Db,
  userId: string,
  hostedAsks: boolean,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO dozo_command_settings ("userId", "hostedAsks") VALUES (${userId}, ${hostedAsks})
    ON CONFLICT ("userId") DO UPDATE SET "hostedAsks" = EXCLUDED."hostedAsks",
      "updatedAt" = CURRENT_TIMESTAMP`;
}

/** Whether the Space has a computer of its bots' own, so the setting above means something there. */
export async function dozoSpaceHasComputer(db: Db, spaceId: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM computers WHERE "spaceId" = ${spaceId} LIMIT 1`;
  return rows.length > 0;
}
