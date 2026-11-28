-- Additive: the previous release never reads this table. It belongs to the fork: it has no model
-- in schema.prisma and is read and written with SQL in apps/api/src/dozo-bot-share-kind.ts and
-- apps/api/src/dozo-bot-shares.ts.

-- What a bot's owner published behind its share link: a snapshot of the definition as they
-- confirmed it, so later edits to the bot do not change it. One per bot; publishing again replaces
-- it and revokes the earlier links. Deleting the bot, or its owner leaving the Space, takes it.
CREATE TABLE "dozo_bot_shares" (
  "botId" TEXT PRIMARY KEY REFERENCES "bots"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "definition" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE
);

CREATE INDEX "dozo_bot_shares_spaceId_userId_idx" ON "dozo_bot_shares"("spaceId", "userId");

-- A member's own rows; a link's signed-out read goes through the system, by bot id only.
ALTER TABLE "dozo_bot_shares" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_bot_shares_tenant ON "dozo_bot_shares"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY dozo_bot_shares_system ON "dozo_bot_shares"
  USING ((SELECT app_rls_bypass()));
