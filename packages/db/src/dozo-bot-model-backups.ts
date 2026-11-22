import type { ModelRoleChoice } from "@rakazo/contracts";
import { ModelRoleChoiceSchema, modelChoiceListSchema } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import { readJsonColumn } from "./json-column.js";

/**
 * A bot's own ordered backup models (`dozo_bot_model_backups`, migration
 * `20270122120000_dozo_bot_model_backups`). No row, or an empty list, means the bot has none of its
 * own and its runs take the runner's backups as before.
 */

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

const BotBackupsSchema = modelChoiceListSchema(ModelRoleChoiceSchema);

/** The bot's own backups, first first; empty when it has none or the stored list is unreadable. */
export async function readBotModelBackups(db: Db, botId: string): Promise<ModelRoleChoice[]> {
  const [row] = await db.$queryRaw<Array<{ backups: unknown }>>`
    SELECT "backups" FROM "dozo_bot_model_backups" WHERE "botId" = ${botId}`;
  if (!row) return [];
  // A list that no longer reads falls back to the runner's backups, as having none does.
  return readJsonColumn(
    BotBackupsSchema,
    row.backups,
    { table: "dozo_bot_model_backups", column: "backups", id: botId },
    { fallback: [] },
  );
}

/**
 * Saves the bot's own backups in order, or clears them with an empty list. The bot must be in
 * `spaceId`; a bot elsewhere writes nothing and answers false.
 */
export async function writeBotModelBackups(
  db: Db,
  bot: { botId: string; spaceId: string },
  backups: readonly ModelRoleChoice[],
): Promise<boolean> {
  if (!backups.length) {
    await db.$executeRaw`
      DELETE FROM "dozo_bot_model_backups"
      WHERE "botId" = ${bot.botId} AND "spaceId" = ${bot.spaceId}`;
    return true;
  }
  const written = await db.$executeRaw`
    INSERT INTO "dozo_bot_model_backups" ("botId", "spaceId", "backups", "updatedAt")
    SELECT b."id", b."spaceId", ${JSON.stringify(backups)}::jsonb, CURRENT_TIMESTAMP
    FROM "bots" b WHERE b."id" = ${bot.botId} AND b."spaceId" = ${bot.spaceId}
    ON CONFLICT ("botId") DO UPDATE SET
      "backups" = EXCLUDED."backups",
      "updatedAt" = EXCLUDED."updatedAt"`;
  return written > 0;
}
