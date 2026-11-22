-- Additive: the previous release never reads this table.
--
-- A bot's own ordered backup models. Without a row its runs take the backups of the member who
-- runs them, as before. The table belongs to the fork: it has no model in schema.prisma and is
-- read and written with SQL in packages/db/src/dozo-bot-model-backups.ts. "backups" is the same
-- list a member's model settings hold (provider, model, effort and, when picked, a connection),
-- which a run resolves on the runner's own connections only.
CREATE TABLE "dozo_bot_model_backups" (
  "botId" TEXT PRIMARY KEY REFERENCES "bots"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "backups" JSONB NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "dozo_bot_model_backups_spaceId_idx" ON "dozo_bot_model_backups"("spaceId");

-- Shared by the members of the bot's Space, as the bot is.
ALTER TABLE "dozo_bot_model_backups" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_bot_model_backups_tenant ON "dozo_bot_model_backups"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY dozo_bot_model_backups_system ON "dozo_bot_model_backups"
  USING ((SELECT app_rls_bypass()));
