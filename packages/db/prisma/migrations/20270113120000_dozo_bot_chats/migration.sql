-- Works with the previous release: it never reads the new table, and it never writes a thread
-- without an owner, so the owner rule it relies on still holds for everything it does. The table
-- belongs to the fork: it has no model in schema.prisma and is read and written with SQL in
-- apps/api/src/dozo-bot-chats.ts.

-- A bot's extra chats. A bot's main chat stays the one thread whose "botId" is the bot, unique as
-- before, so every query that finds a bot's chat by its bot still finds that one. An extra chat is
-- a thread of the bot's Space with no owner column set, tied to its bot here only; code that does
-- not know this table never reaches it through a bot, a group or a helper.
CREATE TABLE "dozo_bot_chats" (
  "threadId" TEXT PRIMARY KEY REFERENCES "threads"("id") ON DELETE CASCADE,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL CHECK (char_length("name") BETWEEN 1 AND 80),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archivedAt" TIMESTAMPTZ(3)
);

CREATE INDEX "dozo_bot_chats_botId_createdAt_idx" ON "dozo_bot_chats"("botId", "createdAt");
CREATE INDEX "dozo_bot_chats_spaceId_idx" ON "dozo_bot_chats"("spaceId");

-- Shared by the members of the Space, as the bot's main chat is.
ALTER TABLE "dozo_bot_chats" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_bot_chats_tenant ON "dozo_bot_chats"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY dozo_bot_chats_system ON "dozo_bot_chats"
  USING ((SELECT app_rls_bypass()));

-- A thread still has exactly one owner: its bot, group, chat-app conversation or helper's bot, or
-- else a row here. The check keeps "at most one" (it cannot see another table, and the rows it
-- already checked hold the stricter rule, so it is added without a scan and validated in the next
-- migration); the trigger below refuses an ownerless thread that has no row here when its
-- transaction commits, so the thread and its row are written in one transaction.
-- Upstream sync: a later upstream migration that adds the strict check back would fail once extra
-- chats exist (dozo/SYNC.md); keep this one instead.
ALTER TABLE "threads" DROP CONSTRAINT "threads_owner_chk";
ALTER TABLE "threads" ADD CONSTRAINT "threads_owner_chk" CHECK (
  num_nonnulls("botId", "groupId", "externalConversationId", "helperBotId") <= 1
) NOT VALID;

-- Reads the table as its owner: row security must not hide the row from a writer in another
-- context.
CREATE FUNCTION dozo_threads_owner_check() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.threads t WHERE t.id = NEW.id
      AND num_nonnulls(t."botId", t."groupId", t."externalConversationId", t."helperBotId") = 0)
    AND NOT EXISTS (SELECT 1 FROM public.dozo_bot_chats c WHERE c."threadId" = NEW.id) THEN
    RAISE EXCEPTION 'new row for relation "threads" violates check constraint "threads_owner_chk"'
      USING ERRCODE = 'check_violation', TABLE = 'threads', CONSTRAINT = 'threads_owner_chk';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER dozo_threads_owner
  AFTER INSERT OR UPDATE OF "botId", "groupId", "externalConversationId", "helperBotId"
  ON "threads" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (num_nonnulls(NEW."botId", NEW."groupId", NEW."externalConversationId", NEW."helperBotId") = 0)
  EXECUTE FUNCTION dozo_threads_owner_check();

-- The chat's thread goes with its row: deleting the bot takes its extra chats and their messages,
-- as it takes its main chat.
CREATE FUNCTION dozo_bot_chats_drop_thread() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  DELETE FROM public.threads WHERE id = OLD."threadId";
  RETURN OLD;
END
$$;
CREATE TRIGGER dozo_bot_chats_drop_thread AFTER DELETE ON "dozo_bot_chats"
  FOR EACH ROW EXECUTE FUNCTION dozo_bot_chats_drop_thread();
