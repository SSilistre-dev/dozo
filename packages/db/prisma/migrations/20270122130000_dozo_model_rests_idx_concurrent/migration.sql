-- Additive: an index the previous release does not use. A run's start reads the person's rests
-- that have not ended (readActiveModelRests in packages/db/src/dozo-model-pool-store.ts); since
-- rests are recorded outside a pool too, that read goes by the person and each rest's end. Built
-- without blocking writes: the sole statement in its file, as CONCURRENTLY needs.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "dozo_model_connection_cooldowns_userId_resetsAt_idx"
ON "dozo_model_connection_cooldowns"("userId", "resetsAt");
