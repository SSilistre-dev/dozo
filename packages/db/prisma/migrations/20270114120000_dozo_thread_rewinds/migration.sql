-- Additive: the previous release never reads this column. Its Prisma field comes from an anchored
-- rule in dozo/brand/brand.json.

-- How many times the chat went back to an earlier message (apps/api/src/dozo-message-revision.ts).
-- History compaction compares it before it writes a summary, so one begun before a rewind, over
-- messages the rewind removed, is dropped.
ALTER TABLE "threads" ADD COLUMN "dozoRewinds" INTEGER NOT NULL DEFAULT 0;
