-- Additive: the previous release never reads this table. It belongs to the fork: it has no model
-- in schema.prisma and is read and written with SQL in packages/db/src/dozo-command-rules.ts.

-- A command a member always allows one bot to run on their own computer, from "Always allow this
-- command" on its approval card: the command's words, in order, and the folder it runs in
-- ('' for the home folder). Deleting the bot takes its rules, and leaving the Space takes the
-- member's rules there.
CREATE TABLE "dozo_command_rules" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "words" TEXT[] NOT NULL,
  "cwd" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "dozo_command_rules_userId_botId_words_cwd_key"
  ON "dozo_command_rules"("userId", "botId", "words", "cwd");
CREATE INDEX "dozo_command_rules_spaceId_userId_idx" ON "dozo_command_rules"("spaceId", "userId");
CREATE INDEX "dozo_command_rules_botId_idx" ON "dozo_command_rules"("botId");

-- A member's own rows.
ALTER TABLE "dozo_command_rules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_command_rules_tenant ON "dozo_command_rules"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY dozo_command_rules_system ON "dozo_command_rules"
  USING ((SELECT app_rls_bypass()));
