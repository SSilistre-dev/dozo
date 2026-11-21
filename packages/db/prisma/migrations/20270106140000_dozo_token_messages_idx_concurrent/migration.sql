-- Finds a chat's messages sent with a token without reading the rest (the token gate,
-- packages/adapters/src/dozo-token-run.ts). Messages are written all the time, so the index is
-- built without blocking them: the sole statement in its file, as CONCURRENTLY needs.
CREATE INDEX CONCURRENTLY "messages_dozo_token_idx"
ON "messages"("threadId") WHERE "clientNonce" LIKE 'api:%';
