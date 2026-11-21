-- Additive: the previous release never reads this table, and no existing column or constraint
-- changes. It belongs to the fork: it has no model in schema.prisma and is read and written with
-- SQL in apps/api/src/dozo-bot-chats.ts.

-- A bot's extra chats. A bot's main chat stays the one thread whose "botId" is the bot, unique as
-- before, so every query that finds a bot's chat by its bot still finds that one. An extra chat is
-- an ordinary thread of the bot's Space with no "botId", tied to its bot here only; code that does
-- not know this table never reaches it through a bot.
CREATE TABLE "dozo_bot_chats" (
  "threadId" TEXT PRIMARY KEY REFERENCES "threads"("id") ON DELETE CASCADE,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL CHECK (char_length("name") BETWEEN 1 AND 80),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3)
);

CREATE INDEX "dozo_bot_chats_botId_createdAt_idx" ON "dozo_bot_chats"("botId", "createdAt");
CREATE INDEX "dozo_bot_chats_spaceId_idx" ON "dozo_bot_chats"("spaceId");

-- The chat's thread goes with its row: deleting the bot takes its extra chats and their messages,
-- as it takes its main chat.
CREATE FUNCTION dozo_bot_chats_drop_thread() RETURNS trigger AS $$
BEGIN
  DELETE FROM "threads" WHERE "id" = OLD."threadId";
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER dozo_bot_chats_drop_thread AFTER DELETE ON "dozo_bot_chats"
  FOR EACH ROW EXECUTE FUNCTION dozo_bot_chats_drop_thread();

-- Shared by the members of the Space, as the bot's main chat is.
ALTER TABLE "dozo_bot_chats" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_bot_chats_tenant ON "dozo_bot_chats"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY dozo_bot_chats_system ON "dozo_bot_chats"
  USING ((SELECT app_rls_bypass()));
