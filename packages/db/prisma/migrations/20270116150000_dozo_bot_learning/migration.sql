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
  -- Whether the review may read the bot's reply: the run read no outside content, no recalled
  -- memory and no other chat, memory or skill. False or unknown (NULL): only the owner's words.
  "botReplyReadable" BOOLEAN,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "dozo_learning_turns_botId_createdAt_idx" ON "dozo_learning_turns"("botId", "createdAt");
CREATE INDEX "dozo_learning_turns_spaceId_idx" ON "dozo_learning_turns"("spaceId");

-- One line a review added, changed or removed in the bot's notes, which the owner can undo. A
-- line is the review's own only through its newest live change: a later change that replaced or
-- rewrote it names itself in "supersededBy", so a line the owner types back stays theirs. Its
-- text came from the chat of "messageId" (the newest message the review read): clearing or
-- deleting that chat deletes the row, and the note stays as the owner's line.
CREATE TABLE "dozo_learning_changes" (
  "id" TEXT PRIMARY KEY,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "threadId" TEXT REFERENCES "threads"("id") ON DELETE CASCADE,
  "messageId" TEXT REFERENCES "messages"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('add', 'update', 'remove')),
  "before" TEXT,
  "after" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "undoneAt" TIMESTAMPTZ(3),
  "supersededBy" TEXT,
  -- The owner changed or removed the line in the memory panel: it is theirs now.
  "ownerEditedAt" TIMESTAMPTZ(3),
  -- A write of the notes for this change is under way ('apply' by a review, 'undo'), tagged on
  -- the memory revision it makes, so a write cut short is settled by whether that revision exists.
  "pending" TEXT CHECK ("pending" IN ('apply', 'undo')),
  "pendingTag" TEXT,
  "pendingSince" TIMESTAMPTZ(3),
  CHECK (("pending" IS NULL) = ("pendingTag" IS NULL)),
  CHECK (("kind" = 'add') = ("before" IS NULL)),
  CHECK (("kind" = 'remove') = ("after" IS NULL))
);
CREATE INDEX "dozo_learning_changes_botId_createdAt_idx" ON "dozo_learning_changes"("botId", "createdAt");
CREATE INDEX "dozo_learning_changes_spaceId_idx" ON "dozo_learning_changes"("spaceId");
CREATE INDEX "dozo_learning_changes_threadId_idx" ON "dozo_learning_changes"("threadId");
CREATE INDEX "dozo_learning_changes_messageId_idx" ON "dozo_learning_changes"("messageId");
CREATE INDEX "dozo_learning_changes_pendingTag_idx" ON "dozo_learning_changes"("pendingTag")
  WHERE "pendingTag" IS NOT NULL;

-- A learned line the owner turned down (undid, or changed or removed in the memory panel), which
-- no review writes again. Only that line is kept, with no link to the chat it came from, so
-- deleting the chat does not let it be learned again; it goes with the bot.
CREATE TABLE "dozo_learning_rejections" (
  "id" TEXT PRIMARY KEY,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "text" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "dozo_learning_rejections_botId_createdAt_idx"
  ON "dozo_learning_rejections"("botId", "createdAt");
CREATE INDEX "dozo_learning_rejections_spaceId_idx" ON "dozo_learning_rejections"("spaceId");

-- When each of a bot's reviews asked a model, kept for a day: a bot makes a bounded number a day.
CREATE TABLE "dozo_learning_reviews" (
  "id" TEXT PRIMARY KEY,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "dozo_learning_reviews_botId_createdAt_idx" ON "dozo_learning_reviews"("botId", "createdAt");
CREATE INDEX "dozo_learning_reviews_spaceId_idx" ON "dozo_learning_reviews"("spaceId");

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

ALTER TABLE "dozo_learning_reviews" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_learning_reviews_tenant ON "dozo_learning_reviews"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY dozo_learning_reviews_system ON "dozo_learning_reviews"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "dozo_learning_rejections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_learning_rejections_tenant ON "dozo_learning_rejections"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY dozo_learning_rejections_system ON "dozo_learning_rejections"
  USING ((SELECT app_rls_bypass()));
