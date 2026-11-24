import { createRouterClient } from "@orpc/server";
import type { ProductAnalytics } from "@rakazo/adapter-kit";
import { AnalyticsEvent } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOZO_EVENT_REPEAT_MS,
  DOZO_EVENTS_PER_MINUTE,
  DOZO_FIRSTS_REMEMBERED,
  DOZO_SIGNUP_FORM_MS,
  dozoEventsRoutes,
  dozoFirstBot,
  dozoFirstMessage,
  dozoReportingRepos,
  forgetRecordedFirsts,
} from "./dozo-events.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const actor = { userId: "ada", spaceId: "space-ada", email: "", isDeploymentOwner: false };
const createdAt = new Date("2026-11-19T12:00:00.000Z");

function analytics() {
  return { capture: vi.fn(), flush: vi.fn() } satisfies ProductAnalytics;
}

describe("the event schema", () => {
  it("takes the fork's events with fixed values only", () => {
    for (const event of [
      { name: "signup_started" },
      { name: "first_bot_created" },
      { name: "first_message_sent" },
    ])
      expect(AnalyticsEvent.safeParse(event).success).toBe(true);
    // Upstream's own events are unchanged.
    expect(AnalyticsEvent.safeParse({ name: "message_sent", trigger: "user" }).success).toBe(true);
    // Nothing that could carry personal data gets through.
    expect(AnalyticsEvent.safeParse({ name: "first_message_sent", text: "hello" }).success).toBe(
      false,
    );
    // The events of the removed plans are not taken.
    expect(AnalyticsEvent.safeParse({ name: "upgrade_viewed", source: "app" }).success).toBe(false);
  });
});

describe("the apps' reports", () => {
  function setup(sink?: ProductAnalytics, clock = () => Date.now()) {
    const prisma = { user: { findUnique: vi.fn(async () => ({ createdAt })) } };
    const deps = { prisma, ...(sink ? { analytics: sink } : {}) } as unknown as RouterDeps;
    const client = createRouterClient(dozoEventsRoutes(createRouterContext(deps), clock), {
      context: { actor },
    });
    return { prisma, track: client.dozoEvents.track };
  }

  it("sends the same report once per window, and refuses a flood", async () => {
    let time = 0;
    const sink = analytics();
    const { track } = setup(sink, () => time);
    const report = { name: "signup_started" as const, startedAt: createdAt.toISOString() };
    for (let index = 0; index < 5; index++) await track(report);
    expect(sink.capture).toHaveBeenCalledTimes(1);
    time = DOZO_EVENT_REPEAT_MS;
    await track(report);
    expect(sink.capture).toHaveBeenCalledTimes(2);
    for (let index = 0; index < DOZO_EVENTS_PER_MINUTE; index++)
      await track(report).catch((error) => error);
    await expect(track(report)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("sends nothing, and reads nothing, without analytics", async () => {
    const { prisma, track } = setup();
    await expect(
      track({ name: "signup_started", startedAt: createdAt.toISOString() }),
    ).resolves.toEqual({ ok: true });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("refuses what is not a fixed value", async () => {
    const { track } = setup(analytics());
    await expect(
      track({ name: "upgrade_viewed", source: "ada@example.test" } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("takes a sign-up start only from within the hour before the account was made", async () => {
    const opened = new Date(createdAt.getTime() - 5 * 60_000);
    // An hour and a millisecond before, and after the account: neither started it.
    const early = new Date(createdAt.getTime() - DOZO_SIGNUP_FORM_MS - 1);
    const later = new Date(createdAt.getTime() + 1);
    const sent = [];
    for (const startedAt of [opened, early, later]) {
      const sink = analytics();
      await setup(sink).track({ name: "signup_started", startedAt: startedAt.toISOString() });
      sent.push(sink.capture.mock.calls);
    }
    expect(sent).toEqual([
      [["ada", { name: "signup_started" }, { id: "ada", at: opened }]],
      [],
      [],
    ]);
  });

  it("takes one sign-up start per account, whatever time a repeat carries", async () => {
    const sink = analytics();
    const { prisma, track } = setup(sink);
    await track({ name: "signup_started", startedAt: createdAt.toISOString() });
    await track({
      name: "signup_started",
      startedAt: new Date(createdAt.getTime() - 1).toISOString(),
    });
    expect(sink.capture).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it("drops a sign-up start for an account it cannot find", async () => {
    const sink = analytics();
    const { prisma, track } = setup(sink);
    prisma.user.findUnique.mockResolvedValueOnce(null as never);
    await track({ name: "signup_started", startedAt: createdAt.toISOString() });
    expect(sink.capture).not.toHaveBeenCalled();
  });
});

describe("a first bot and a first message", () => {
  /** The marks table: an insert adds a row only when the member has none of that kind. */
  function marks() {
    const rows = new Set<string>();
    return {
      rows,
      $executeRaw: vi.fn(async (_strings: TemplateStringsArray, userId: string, kind: string) => {
        const key = `${kind}:${userId}`;
        if (rows.has(key)) return 0;
        rows.add(key);
        return 1;
      }),
    };
  }
  beforeEach(() => forgetRecordedFirsts());

  it("is reported once per member, however many race, and never asked again after", async () => {
    const sink = analytics();
    const db = marks();
    const deps = { prisma: db as unknown as PrismaClient, analytics: sink };
    await Promise.all([dozoFirstBot(deps, actor), dozoFirstBot(deps, actor)]);
    await Promise.all([
      dozoFirstMessage(deps, actor, { createdAt }),
      dozoFirstMessage(deps, actor, { createdAt }),
    ]);
    expect(sink.capture.mock.calls).toEqual([
      ["ada", { name: "first_bot_created" }, { id: "ada", at: expect.any(Date) }],
      ["ada", { name: "first_message_sent" }, { id: "ada", at: createdAt }],
    ]);
    const asked = db.$executeRaw.mock.calls.length;
    await dozoFirstMessage(deps, actor, { createdAt });
    await dozoFirstBot(deps, actor);
    expect(db.$executeRaw).toHaveBeenCalledTimes(asked);
  });

  it("is not reported for a member already recorded, as the migration records earlier ones", async () => {
    const sink = analytics();
    const db = marks();
    db.rows.add("message:ada");
    await dozoFirstMessage({ prisma: db as unknown as PrismaClient, analytics: sink }, actor, {
      createdAt,
    });
    expect(sink.capture).not.toHaveBeenCalled();
  });

  it("forgets the longest remembered member past its limit", async () => {
    const db = marks();
    const deps = { prisma: db as unknown as PrismaClient, analytics: analytics() };
    for (let index = 0; index <= DOZO_FIRSTS_REMEMBERED; index++)
      await dozoFirstMessage(deps, { ...actor, userId: `user-${index}` }, { createdAt });
    const asked = db.$executeRaw.mock.calls.length;
    await dozoFirstMessage(deps, { ...actor, userId: "user-0" }, { createdAt });
    await dozoFirstMessage(
      deps,
      { ...actor, userId: `user-${DOZO_FIRSTS_REMEMBERED}` },
      { createdAt },
    );
    expect(db.$executeRaw).toHaveBeenCalledTimes(asked + 1);
  });

  it("reads nothing without analytics, and never throws", async () => {
    const quiet = marks();
    await dozoFirstBot({ prisma: quiet as unknown as PrismaClient }, actor);
    await dozoFirstMessage({ prisma: quiet as unknown as PrismaClient }, actor, { createdAt });
    expect(quiet.$executeRaw).not.toHaveBeenCalled();

    const broken = {
      $executeRaw: vi.fn(async () => Promise.reject(new Error("down"))),
    } as unknown as PrismaClient;
    const sink = analytics();
    await expect(dozoFirstBot({ prisma: broken, analytics: sink }, actor)).resolves.toBe(undefined);
    await expect(
      dozoFirstMessage({ prisma: broken, analytics: sink }, actor, { createdAt }),
    ).resolves.toBe(undefined);
    expect(sink.capture).not.toHaveBeenCalled();
  });

  it("reports a first bot from every creation that goes through the repositories", async () => {
    const sink = analytics();
    const db = marks();
    const repos = {
      createBot: vi.fn(async (_actor: typeof actor, input: { name: string }) => ({
        id: input.name,
      })),
      getBot: vi.fn(),
    };
    const wrapped = dozoReportingRepos(repos, {
      prisma: db as unknown as PrismaClient,
      analytics: sink,
    });
    expect(await wrapped.createBot(actor, { name: "first" })).toEqual({ id: "first" });
    expect(wrapped.getBot).toBe(repos.getBot);
    await vi.waitFor(() => expect(sink.capture).toHaveBeenCalledTimes(1));
    expect(repos.createBot).toHaveBeenCalledWith(actor, { name: "first" });
    // Without analytics the repositories are as they were.
    expect(dozoReportingRepos(repos, { prisma: db as unknown as PrismaClient })).toBe(repos);
  });
});
