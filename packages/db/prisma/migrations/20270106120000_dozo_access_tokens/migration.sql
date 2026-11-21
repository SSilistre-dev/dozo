-- Additive: the previous release never reads this table. It belongs to the fork: it has no model
-- in schema.prisma and is read and written with SQL in packages/db/src/dozo-access-tokens.ts.

-- A personal access token for the bot API (/api/v1/dozo): a member's own, for one Space, and for
-- one bot when "botId" is set. Only the SHA-256 of the token is kept; "hint" is its last four
-- characters, shown beside its name. Deleting the bot takes its tokens, and leaving the Space
-- takes the member's tokens there.
CREATE TABLE "dozo_access_tokens" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "botId" TEXT REFERENCES "bots"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "hint" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMPTZ(3),
  FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "dozo_access_tokens_tokenHash_key" ON "dozo_access_tokens"("tokenHash");
CREATE INDEX "dozo_access_tokens_spaceId_userId_idx" ON "dozo_access_tokens"("spaceId", "userId");
CREATE INDEX "dozo_access_tokens_botId_idx" ON "dozo_access_tokens"("botId");

-- A member's own rows. The API finds a token by its hash before it knows the member, as the system.
ALTER TABLE "dozo_access_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_access_tokens_tenant ON "dozo_access_tokens"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY dozo_access_tokens_system ON "dozo_access_tokens"
  USING ((SELECT app_rls_bypass()));
