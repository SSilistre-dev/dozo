-- Additive: the previous release never reads these tables. They belong to the fork: no model in
-- schema.prisma; packages/adapters/src/dozo-learning-store.ts reads and writes them with SQL.

-- Whether a bot learns from its owner's direct chat: 'off' (also when there is no row) or 'auto'.
-- 'ask' is kept for a later phase; the API accepts only the first two today.
CREATE TABLE "dozo_bot_learning" (
  "botId" TEXT PRIMARY KEY REFERENCES "bots"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "mode" TEXT NOT NULL DEFAULT 'off' CHECK ("mode" IN ('off', 'auto', 'ask')),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "dozo_bot_learning_spaceId_idx" ON "dozo_bot_learning"("spaceId");

-- One finished turn of the owner's direct chat that no review has read yet. Clearing the chat
-- deletes its messages, and the turn with them.
CREATE TABLE "dozo_learning_turns" (
  "id" TEXT PRIMARY KEY,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "threadId" TEXT NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE,
  "runId" TEXT NOT NULL UNIQUE REFERENCES "runs"("id") ON DELETE CASCADE,
  "messageId" TEXT NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  -- Outside content entered the run: only the owner's own words of it are read.
  "tainted" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "dozo_learning_turns_botId_createdAt_idx" ON "dozo_learning_turns"("botId", "createdAt");
CREATE INDEX "dozo_learning_turns_spaceId_idx" ON "dozo_learning_turns"("spaceId");

-- One line a review added, changed or removed in the bot's notes, which the owner can undo. A
-- line is the review's own only through its newest live change: a later change that replaced or
-- rewrote it names itself in "supersededBy", so a line the owner types back stays theirs.
CREATE TABLE "dozo_learning_changes" (
  "id" TEXT PRIMARY KEY,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "threadId" TEXT REFERENCES "threads"("id") ON DELETE SET NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('add', 'update', 'remove')),
  "before" TEXT,
  "after" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "undoneAt" TIMESTAMPTZ(3),
  "supersededBy" TEXT,
  CHECK (("kind" = 'add') = ("before" IS NULL)),
  CHECK (("kind" = 'remove') = ("after" IS NULL))
);
CREATE INDEX "dozo_learning_changes_botId_createdAt_idx" ON "dozo_learning_changes"("botId", "createdAt");
CREATE INDEX "dozo_learning_changes_spaceId_idx" ON "dozo_learning_changes"("spaceId");

-- Read and written within the bot's Space, as its notes are.
ALTER TABLE "dozo_bot_learning" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_bot_learning_tenant ON "dozo_bot_learning"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY dozo_bot_learning_system ON "dozo_bot_learning"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "dozo_learning_turns" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_learning_turns_tenant ON "dozo_learning_turns"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY dozo_learning_turns_system ON "dozo_learning_turns"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "dozo_learning_changes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_learning_changes_tenant ON "dozo_learning_changes"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY dozo_learning_changes_system ON "dozo_learning_changes"
  USING ((SELECT app_rls_bypass()));
