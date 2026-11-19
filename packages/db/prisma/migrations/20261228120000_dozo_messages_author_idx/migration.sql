-- Additive. Sole statement so the index builds outside an implicit transaction, without blocking
-- chat writes. The admin funnel finds each member's first message through it with one probe per
-- member; nothing else reads messages by author. Partial, like messages_tool_work_idx, so it has no
-- line in schema.prisma.
CREATE INDEX CONCURRENTLY "dozo_messages_author_idx" ON "messages" ("authorUserId", "createdAt")
WHERE "role" = 'user';
