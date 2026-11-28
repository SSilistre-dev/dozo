-- Additive: the previous release never reads this table. It belongs to the fork: it has no model
-- in schema.prisma and is read and written with SQL in apps/api/src/dozo-replays.ts.

-- What the owner of a bot chose to publish from one finished reply of theirs: which of its steps,
-- and which of their screenshots. It holds positions only, never text: the steps are read from the
-- reply itself, which never changes once written. A share link of kind "replay" names a row here.
-- Deleting the reply or the bot, or the owner leaving the Space, removes the row and so closes
-- every link to it.
CREATE TABLE "dozo_replays" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "messageId" TEXT NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "steps" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE
);

CREATE INDEX "dozo_replays_messageId_idx" ON "dozo_replays"("messageId");
CREATE INDEX "dozo_replays_botId_idx" ON "dozo_replays"("botId");
CREATE INDEX "dozo_replays_spaceId_userId_idx" ON "dozo_replays"("spaceId", "userId");

-- The owner's own rows; a signed-out read goes through the system, by the link's target only.
ALTER TABLE "dozo_replays" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_replays_tenant ON "dozo_replays"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY dozo_replays_system ON "dozo_replays"
  USING ((SELECT app_rls_bypass()));
