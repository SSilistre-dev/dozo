-- Counts one person's pictures drawn from a description over the last day across all their Spaces
-- (apps/api/src/dozo-avatar-generate.ts). The existing index leads with the Space, so a count by
-- person alone would read the whole table. Usage rows are written all the time, so the index is
-- built without blocking them: the sole statement in its file, as CONCURRENTLY needs.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "usage_records_dozo_user_created_idx"
ON "usage_records"("userId", "createdAt");
