-- Additive: the previous release never reads this table.
--
-- The runs a backup model answered, so a reply can say which model wrote it when it was not the
-- one chosen. One row per run, holding the backup it ran on last; no row means the chosen model
-- answered. The table belongs to the fork: it has no model in schema.prisma and is read and
-- written with SQL in packages/db/src/dozo-backup-replies.ts. Rows go with their run.
CREATE TABLE "dozo_backup_replies" (
  "runId" TEXT PRIMARY KEY REFERENCES "runs"("id") ON DELETE CASCADE,
  "threadId" TEXT NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "provider" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "dozo_backup_replies_threadId_idx" ON "dozo_backup_replies"("threadId");

-- Shared by the members of the run's Space, as its chat is.
ALTER TABLE "dozo_backup_replies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_backup_replies_tenant ON "dozo_backup_replies"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY dozo_backup_replies_system ON "dozo_backup_replies"
  USING ((SELECT app_rls_bypass()));
