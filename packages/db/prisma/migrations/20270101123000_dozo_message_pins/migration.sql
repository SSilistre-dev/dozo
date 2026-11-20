-- Additive: the previous release never reads this table. It belongs to the fork: it has no model
-- in schema.prisma and is read and written with SQL in apps/api/src/dozo-message-pins.ts.

-- A message one member pinned in a chat. Pins are personal, like that member's read state: other
-- members of the Space never see them. A message that is deleted (a regenerated reply, a cleared
-- chat) takes its pins with it, and leaving the Space takes the member's pins there.
CREATE TABLE "dozo_message_pins" (
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE,
  "messageId" TEXT NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("userId", "messageId"),
  FOREIGN KEY ("spaceId", "userId") REFERENCES "space_members"("spaceId", "userId") ON DELETE CASCADE
);

CREATE INDEX "dozo_message_pins_userId_threadId_createdAt_idx"
  ON "dozo_message_pins"("userId", "threadId", "createdAt");
CREATE INDEX "dozo_message_pins_messageId_idx" ON "dozo_message_pins"("messageId");
CREATE INDEX "dozo_message_pins_threadId_idx" ON "dozo_message_pins"("threadId");
CREATE INDEX "dozo_message_pins_spaceId_userId_idx" ON "dozo_message_pins"("spaceId", "userId");

-- A member's own rows, as for their read state.
ALTER TABLE "dozo_message_pins" ENABLE ROW LEVEL SECURITY;
CREATE POLICY dozo_message_pins_tenant ON "dozo_message_pins"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
     AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY dozo_message_pins_system ON "dozo_message_pins"
  USING ((SELECT app_rls_bypass()));
