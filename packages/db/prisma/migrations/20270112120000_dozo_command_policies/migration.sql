-- Additive: the previous release never reads these tables. Both belong to the fork: they have no
-- model in schema.prisma and are read and written with SQL in packages/db/src/dozo-command-rules.ts.
-- They replace dozo_command_rules, whose rows were all exact allows on the member's own computer;
-- the previous release keeps reading that table until the deferred
-- 20270112120100_dozo_drop_command_rules drops it, so it never reads a block, a prefix rule or a
-- rule for the bot's computer as an exact allow.

-- A command rule of one member for one bot: the command's words, in order, the folder it runs in
-- ('' for the home folder), what it does (allow exactly these words, allow them followed by words
-- that are not options, or block any command containing them), and the computer it was saved on
-- (the member's own, or the bot's). Deleting the bot takes its rules, and leaving the Space takes
-- the member's rules there.
CREATE TABLE "dozo_command_policies" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "computer" TEXT NOT NULL CHECK ("computer" IN ('user', 'hosted')),
  "words" TEXT[] NOT NULL,
  "cwd" TEXT NOT NULL,
  "effect" TEXT NOT NULL DEFAULT 'allow' CHECK ("effect" IN ('allow', 'allow_prefix', 'block')),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "dozo_command_policies_userId_botId_computer_words_cwd_key"
  ON "dozo_command_policies"("userId", "botId", "computer", "words", "cwd");
CREATE INDEX "dozo_command_policies_spaceId_userId_idx" ON "dozo_command_policies"("spaceId", "userId");
CREATE INDEX "dozo_command_policies_botId_idx" ON "dozo_command_policies"("botId");

-- A member's own rows.
ALTER TABLE "dozo_command_policies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_command_policies_tenant ON "dozo_command_policies"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY dozo_command_policies_system ON "dozo_command_policies"
  USING ((SELECT app_rls_bypass()));

INSERT INTO "dozo_command_policies" ("id", "userId", "spaceId", "botId", "computer", "words", "cwd", "createdAt")
SELECT "id", "userId", "spaceId", "botId", 'user', "words", "cwd", "createdAt" FROM "dozo_command_rules"
ON CONFLICT DO NOTHING;

-- Whether commands that change something on the bot's computer ask the member first. No row means
-- they do not, as before this table.
CREATE TABLE "dozo_command_settings" (
  "userId" TEXT NOT NULL PRIMARY KEY REFERENCES "user"("id") ON DELETE CASCADE,
  "hostedAsks" BOOLEAN NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
