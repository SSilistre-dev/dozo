import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { SharedSpace, Stream } from "./dozo-stream-world.test-support.js";
import { assertStillWithin, ENDS_WITHIN_MS, streamWorld } from "./dozo-stream-world.test-support.js";
import { SESSION_RECHECK_MS } from "./routes/shared.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

/** How many frames of `type` a stream carried. */
const count = (stream: Stream, type: string) => stream.text.split(`"type":"${type}"`).length - 1;

/**
 * The live streams whose frames carry no chat sequence (board changes, roster and Space change
 * signals, incoming calls) after their caller stops being allowed: removed from the Space, signed
 * out, or deactivated. Each must end before the next frame instead of at the session re-check.
 */
describePostgres("a signal stream after its caller stops being allowed (PostgreSQL)", () => {
  const world = streamWorld();
  const { sharedSpace, openInApp, endings } = world;

  /** The member's stream, ended for `ending`, and the owner's, which goes on. */
  async function both(space: SharedSpace, path: string) {
    const ended = await openInApp(space.member, path, undefined);
    const stays = await openInApp(space.owner, path, undefined);
    return { ended, stays };
  }

  /** The ended stream stopped, unauthorized, without what came after; the other goes on. */
  async function endedBefore(ended: Stream, stays: Stream, delivered: (stream: Stream) => boolean) {
    await vi.waitFor(() => expect(delivered(stays)).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() => expect(ended.ended || delivered(ended)).toBe(true), {
      timeout: ENDS_WITHIN_MS,
    });
    expect(delivered(ended), "the ended caller's stream got the frame").toBe(false);
    expect(ended.unauthorized).toBe(true);
    expect(stays.ended).toBe(false);
  }

  it.each(endings)(
    "ends a board stream before a board change made after its caller is %s",
    async (_, ending) => {
      const space = await sharedSpace();
      const openedAt = Date.now();
      const { ended, stays } = await both(space, "boards/subscribe");
      const before = `ticket-${randomUUID()}`;
      const after = `ticket-${randomUUID()}`;
      await vi.waitFor(
        async () => {
          await world.deps.boardEvents.notify(space.spaceId, { ticketId: before });
          expect(ended.text).toContain(before);
          expect(stays.text).toContain(before);
        },
        { timeout: 5_000 },
      );

      await ending(space, ended);
      await world.deps.boardEvents.notify(space.spaceId, { ticketId: after });
      assertStillWithin(openedAt, SESSION_RECHECK_MS);
      await endedBefore(ended, stays, (stream) => stream.text.includes(after));
    },
  );

  it.each(endings)(
    "ends a notification stream before a roster or Space change signal sent after its caller is %s",
    async (_, ending) => {
      const space = await sharedSpace();
      const openedAt = Date.now();
      const { ended, stays } = await both(space, "notifications/subscribe");
      // The first signals of each kind, sent as a stream opens.
      for (const stream of [ended, stays])
        await vi.waitFor(
          () => {
            for (const type of ["roster", "computerUpdates", "runs", "routines"])
              expect(count(stream, type)).toBe(1);
          },
          { timeout: 5_000 },
        );

      await ending(space, ended);
      const signals = world.deps.events;
      await signals.publishSpaceChange!(space.spaceId, "runs");
      await signals.publishRosterChange!({ spaceIds: [space.spaceId] });
      assertStillWithin(openedAt, SESSION_RECHECK_MS);
      await endedBefore(
        ended,
        stays,
        (stream) => count(stream, "runs") > 1 && count(stream, "roster") > 1,
      );
      expect(count(ended, "runs")).toBe(1);
      expect(count(ended, "roster")).toBe(1);
    },
  );

  it.each(endings)(
    "ends a call stream before the incoming calls read after its caller is %s",
    async (_, ending) => {
      const space = await sharedSpace();
      const openedAt = Date.now();
      const { ended, stays } = await both(space, "notifications/subscribeCalls");
      for (const stream of [ended, stays])
        await vi.waitFor(() => expect(count(stream, "incoming.calls")).toBe(1), {
          timeout: 5_000,
        });

      await ending(space, ended);
      const ring = (actor: Actor) => world.deps.events.notifyIncomingCalls!(actor.userId);
      await Promise.all([ring(space.member), ring(space.owner)]);
      assertStillWithin(openedAt, SESSION_RECHECK_MS);
      await endedBefore(ended, stays, (stream) => count(stream, "incoming.calls") > 1);
    },
  );
});
