-- Additive: the previous release never reads this table. It belongs to the fork: it has no model
-- in schema.prisma and is read and written with SQL in packages/adapters/src/dozo-bot-calls.ts.
--
-- A person's permission for one of their bots to ring them from a routine. A row means allowed,
-- no row means not. Calls the person asks for in the chat need no row. It is the person's own
-- choice, so other members of the Space never see or share it; deleting the bot or leaving the
-- Space takes it away.
CREATE TABLE "dozo_bot_calls" (
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "botId"),
  FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE
);

CREATE INDEX "dozo_bot_calls_botId_idx" ON "dozo_bot_calls"("botId");
CREATE INDEX "dozo_bot_calls_spaceId_userId_idx" ON "dozo_bot_calls"("spaceId", "userId");

ALTER TABLE "dozo_bot_calls" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_bot_calls_tenant ON "dozo_bot_calls"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY dozo_bot_calls_system ON "dozo_bot_calls"
  USING ((SELECT app_rls_bypass()));

-- One row per call a routine or watch made (or is making) for a bot, to hold the most a bot may
-- make in a day. Calls a person asked for in the chat are not counted. A row is written under the
-- call lock before the call rings and removed again if it is refused; rows older than two days are
-- removed as new ones are written. It holds no text.
CREATE TABLE "dozo_bot_call_log" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId" TEXT NOT NULL,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "dozo_bot_call_log_botId_createdAt_idx" ON "dozo_bot_call_log"("botId", "createdAt");
CREATE INDEX "dozo_bot_call_log_createdAt_idx" ON "dozo_bot_call_log"("createdAt");

-- Written and read by the server for the person's own bot, never by a member's request.
ALTER TABLE "dozo_bot_call_log" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_bot_call_log_system ON "dozo_bot_call_log"
  USING ((SELECT app_rls_bypass()));
