-- Additive: the previous release never reads this table. One row per member and kind ('bot',
-- 'message') once they made their first, so the first is reported once however many requests race:
-- the insert that adds the row is the one that reports. The table belongs to the fork: it has no
-- model in schema.prisma and is written with SQL in apps/api/src/dozo-events.ts. Not tenant data
-- (no content, only that it happened), so no row-level policy applies.
CREATE TABLE "dozo_member_firsts" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('bot', 'message')),
  "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "kind")
);

-- Members who already made one are not reported again.
INSERT INTO "dozo_member_firsts" ("userId", "kind", "at")
SELECT b."userId", 'bot', min(b."createdAt") FROM "bots" b JOIN "user" u ON u."id" = b."userId"
GROUP BY b."userId";

INSERT INTO "dozo_member_firsts" ("userId", "kind", "at")
SELECT u."id", 'message', f."at" FROM "user" u CROSS JOIN LATERAL (
  SELECT m."createdAt" AS "at" FROM "messages" m
  WHERE m."authorUserId" = u."id" AND m."role" = 'user'
  ORDER BY m."createdAt" LIMIT 1
) f;
