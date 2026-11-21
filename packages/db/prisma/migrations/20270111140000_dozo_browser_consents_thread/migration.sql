-- Additive for the previous release, which inserts without a thread and conflicts on nothing it
-- names. Read and written with SQL in packages/adapters/src/dozo-user-browser-gate.ts.

-- A bot's consents for its browser on the user's computer now hold in one thread (conversation)
-- only. Rows from before have no thread and no longer match anything; deleting the thread takes
-- its rows.
ALTER TABLE "dozo_browser_consents"
  ADD COLUMN "threadId" TEXT REFERENCES "threads"("id") ON DELETE CASCADE;
ALTER TABLE "dozo_browser_consents" DROP CONSTRAINT "dozo_browser_consents_pkey";
CREATE UNIQUE INDEX "dozo_browser_consents_key"
  ON "dozo_browser_consents"("botId", "deviceId", "threadId", "site");
CREATE INDEX "dozo_browser_consents_threadId_idx" ON "dozo_browser_consents"("threadId");
