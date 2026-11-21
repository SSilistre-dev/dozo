-- Sole statement, own transaction: VALIDATE CONSTRAINT takes only a SHARE UPDATE EXCLUSIVE
-- lock, so chat reads and writes continue while it scans. Every row already holds the stricter
-- rule this one relaxes (20270113120000_dozo_bot_chats).
ALTER TABLE "threads" VALIDATE CONSTRAINT "threads_owner_chk";
