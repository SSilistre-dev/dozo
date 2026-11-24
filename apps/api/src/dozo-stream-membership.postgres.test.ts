import { randomUUID } from "node:crypto";
import type { ChatAlert } from "@rakazo/contracts";
import { Prisma } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { Stream } from "./dozo-stream-world.test-support.js";
import { ENDS_WITHIN_MS, streamWorld } from "./dozo-stream-world.test-support.js";
import { SESSION_RECHECK_MS } from "./routes/shared.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

/**
 * An open chat or notification stream whose caller stops being allowed: removed from the Space,
 * signed out, deactivated, or what they signed in with ran out. Through the app's own routes.
 */
describePostgres("a stream after its caller stops being allowed (PostgreSQL)", () => {
  const world = streamWorld();
  const { sharedSpace, call, openInApp, botSays, endings, followers } = world;
  const publishAlert = (userId: string, alert: ChatAlert) =>
    world.deps.events.publishChatAlert!(userId, alert);

  it.each(
    followers.flatMap(([name, which]) =>
      endings.map(([why, ending]) => [name, why, which, ending] as const),
    ),
  )(
    "ends a chat stream before anything written after its caller is %s %s reaches it",
    async (_, __, which, ending) => {
      const follow = which();
      const space = await sharedSpace();
      const { spaceId, owner, member, botId, thread } = space;
      const before = `before-${randomUUID()}`;
      const after = `after-${randomUUID()}`;
      const openedAt = Date.now();
      const ended = await follow(member, { botId, cursor: -1 });
      const stays = await follow(owner, { botId, cursor: -1 });

      // While allowed, they see the chat.
      await botSays(spaceId, thread.id, botId, before);
      await vi.waitFor(() => expect(ended.text).toContain(before), { timeout: 5_000 });

      await ending(space, ended);
      expect(
        await call(owner, "threads/send", { botId, text: after, clientNonce: randomUUID() }),
      ).toBe(200);
      const writtenAt = Date.now();
      // Inside the session re-check window, so only the stream's own check can end it now.
      expect(writtenAt - openedAt).toBeLessThan(SESSION_RECHECK_MS);

      // The owner's stream gets the message, so it was there to be delivered.
      await vi.waitFor(() => expect(stays.text).toContain(after), { timeout: 5_000 });
      await vi.waitFor(() => expect(ended.ended || ended.text.includes(after)).toBe(true), {
        timeout: ENDS_WITHIN_MS,
      });
      expect(ended.text, "the ended caller's stream got the message").not.toContain(after);
      expect(ended.ended).toBe(true);
      expect(Date.now() - writtenAt).toBeLessThan(ENDS_WITHIN_MS);
      expect(ended.unauthorized).toBe(true);
      expect(stays.ended).toBe(false);
    },
  );

  it.each(endings)(
    "ends a notification stream before a chat alert reaches a caller %s",
    async (_, ending) => {
      const space = await sharedSpace();
      const { spaceId, owner, member, botId, thread } = space;
      const alert = (title: string): ChatAlert => ({
        kind: "completion",
        title,
        body: "Done",
        spaceId,
        botId,
        threadId: thread.id,
      });
      const before = `before-${randomUUID()}`;
      const after = `after-${randomUUID()}`;
      const openedAt = Date.now();
      const ended = await openInApp(member, "notifications/subscribe", undefined);
      const stays = await openInApp(owner, "notifications/subscribe", undefined);

      // While allowed, alerts reach them.
      await vi.waitFor(
        async () => {
          for (const userId of [member.userId, owner.userId])
            await publishAlert(userId, alert(before));
          expect(ended.text).toContain(before);
          expect(stays.text).toContain(before);
        },
        { timeout: 5_000 },
      );

      // Both were recipients when the alert was read; the caller stops being allowed before the
      // preview goes out.
      await ending(space, ended);
      for (const userId of [member.userId, owner.userId]) await publishAlert(userId, alert(after));
      const publishedAt = Date.now();
      expect(publishedAt - openedAt).toBeLessThan(SESSION_RECHECK_MS);

      await vi.waitFor(() => expect(stays.text).toContain(after), { timeout: 5_000 });
      await vi.waitFor(() => expect(ended.ended || ended.text.includes(after)).toBe(true), {
        timeout: ENDS_WITHIN_MS,
      });
      expect(ended.text, "the ended caller's stream got the preview").not.toContain(after);
      expect(ended.ended).toBe(true);
      expect(ended.unauthorized).toBe(true);
      expect(stays.ended).toBe(false);
    },
  );

  /** Runs out the session or access token the stream was opened with, or extends it. */
  async function expiresIn(stream: Stream, ms: number) {
    const at = new Date(Date.now() + ms);
    if (stream.sessionId)
      await world.system.session.update({
        where: { id: stream.sessionId },
        data: { expiresAt: at },
      });
    else
      await world.system.$executeRaw(
        Prisma.sql`UPDATE dozo_access_tokens SET "expiresAt" = ${at.toISOString()}::timestamptz
          WHERE id = ${stream.tokenId}`,
      );
  }

  it.each(followers)(
    "ends %s before anything written after its sign-in runs out reaches it",
    async (_, which) => {
      const follow = which();
      const { spaceId, owner, member, botId, thread } = await sharedSpace();
      const before = `before-${randomUUID()}`;
      const after = `after-${randomUUID()}`;
      const ended = await follow(member, { botId, cursor: -1 });
      const stays = await follow(owner, { botId, cursor: -1 });
      await botSays(spaceId, thread.id, botId, before);
      await vi.waitFor(() => expect(ended.text).toContain(before), { timeout: 5_000 });

      await expiresIn(ended, -60_000);
      expect(
        await call(owner, "threads/send", { botId, text: after, clientNonce: randomUUID() }),
      ).toBe(200);

      await vi.waitFor(() => expect(stays.text).toContain(after), { timeout: 5_000 });
      await vi.waitFor(() => expect(ended.ended || ended.text.includes(after)).toBe(true), {
        timeout: ENDS_WITHIN_MS,
      });
      expect(ended.text, "the expired caller's stream got the message").not.toContain(after);
      expect(ended.unauthorized).toBe(true);
      expect(stays.ended).toBe(false);
    },
  );

  it.each(followers)("keeps %s delivering while its sign-in is extended", async (_, which) => {
    const follow = which();
    const { spaceId, botId, thread, member } = await sharedSpace();
    const stream = await follow(member, { botId, cursor: -1 });
    const first = `first-${randomUUID()}`;
    await botSays(spaceId, thread.id, botId, first);
    await vi.waitFor(() => expect(stream.text).toContain(first), { timeout: 5_000 });
    // Close to running out, then extended, as the auth library refreshes a session in use. The
    // first message is in before this: delivered under the short end, it would race that end.
    const oldEnd = Date.now() + 2_000;
    await expiresIn(stream, oldEnd - Date.now());
    await expiresIn(stream, 60 * 60_000);

    // Past the old end, so only the extension lets the next message through.
    await vi.waitUntil(() => Date.now() > oldEnd + 500, { timeout: 5_000, interval: 100 });
    const second = `second-${randomUUID()}`;
    await botSays(spaceId, thread.id, botId, second);
    await vi.waitFor(() => expect(stream.text).toContain(second), { timeout: 5_000 });
    expect(stream.ended).toBe(false);
    expect(stream.unauthorized).toBe(false);
  });
});
