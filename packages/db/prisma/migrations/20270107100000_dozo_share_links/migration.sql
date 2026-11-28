-- Additive: the previous release never reads this table. It belongs to the fork: it has no model
-- in schema.prisma and is read and written with SQL in apps/api/src/dozo-share-links.ts.

-- A public, expiring, revocable link one member made to something of theirs (a replay, a card, a
-- bot). Only the token's SHA-256 is kept; the token itself is shown once, to its maker. What a link
-- shows is decided by its kind when it is read. Leaving the Space takes the member's links there.
CREATE TABLE "dozo_share_links" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "dozo_share_links_tokenHash_key" ON "dozo_share_links"("tokenHash");
CREATE INDEX "dozo_share_links_spaceId_userId_createdAt_idx"
  ON "dozo_share_links"("spaceId", "userId", "createdAt");

-- A member's own rows; a signed-out read goes through the system, by token hash only.
ALTER TABLE "dozo_share_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_share_links_tenant ON "dozo_share_links"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY dozo_share_links_system ON "dozo_share_links"
  USING ((SELECT app_rls_bypass()));
