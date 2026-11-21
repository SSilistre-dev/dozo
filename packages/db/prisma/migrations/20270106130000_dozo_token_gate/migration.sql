-- Additive: the previous release never reads these. They belong to the fork: no model in
-- schema.prisma; read and written with SQL in packages/db/src/dozo-access-tokens.ts and
-- packages/adapters/src/dozo-token-run.ts.

-- When a token stops working by itself; null for one made to never expire.
ALTER TABLE "dozo_access_tokens" ADD COLUMN "expiresAt" TIMESTAMPTZ(3);

-- A bot that text sent with a token reached through another bot: a marked run's message or answer
-- was delivered to it, it was handed off to, its instructions or tickets were written by one, or a
-- marked run made it (dozo-token-run.ts). Its runs ask before acting until its chat
-- is cleared after this; a lasting mark (a bot a marked run made, or one whose routine a marked
-- run made or changed) stays until that bot, or that routine, is deleted.
CREATE TABLE "dozo_token_taints" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "spaceId" TEXT NOT NULL,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "routineId" TEXT REFERENCES "routines"("id") ON DELETE CASCADE,
  "lasting" BOOLEAN NOT NULL DEFAULT false,
  "fromRunId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- One mark per bot (passing, or lasting) and per routine: marking again refreshes it.
CREATE UNIQUE INDEX "dozo_token_taints_passing_key" ON "dozo_token_taints"("botId")
  WHERE NOT "lasting" AND "routineId" IS NULL;
CREATE UNIQUE INDEX "dozo_token_taints_lasting_key" ON "dozo_token_taints"("botId")
  WHERE "lasting" AND "routineId" IS NULL;
CREATE UNIQUE INDEX "dozo_token_taints_routine_key" ON "dozo_token_taints"("routineId")
  WHERE "routineId" IS NOT NULL;
ALTER TABLE "dozo_token_taints" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_token_taints_tenant ON "dozo_token_taints"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY dozo_token_taints_system ON "dozo_token_taints"
  USING ((SELECT app_rls_bypass()));

-- Requests per key per minute, counted in Postgres so every API instance shares them:
-- "token:<id>" for a token's requests, "sends:<userId>" for an account's messages by token.
-- Not tenant data (a key and a count), so no row policy, as for dozo_bans.
CREATE TABLE "dozo_api_minutes" (
  "key" TEXT NOT NULL,
  "minute" TIMESTAMPTZ(3) NOT NULL,
  "count" INTEGER NOT NULL,
  PRIMARY KEY ("key", "minute")
);

-- When the owner trusted a marked bot again from the app (after confirming it is them): messages
-- sent with a token and marks from before this no longer make its runs ask. They stay in its
-- history, which still counts as outside content.
CREATE TABLE "dozo_token_trust" (
  "botId" TEXT NOT NULL PRIMARY KEY REFERENCES "bots"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL,
  "trustedAt" TIMESTAMPTZ(3) NOT NULL,
  "trustedByUserId" TEXT
);
ALTER TABLE "dozo_token_trust" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_token_trust_tenant ON "dozo_token_trust"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY dozo_token_trust_system ON "dozo_token_trust"
  USING ((SELECT app_rls_bypass()));
