import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const voice = vi.hoisted(() => ({ ready: true, coHost: null as string | null }));
vi.mock("@rakazo/adapters", () => ({
  ownSpeechReady: vi.fn(async () => voice.ready),
  spokenBriefingCoHost: vi.fn(async () => voice.coHost),
}));

import {
  dozoSpokenBriefingRoutes,
  readSpokenBriefing,
  setSpokenBriefing,
} from "./dozo-spoken-briefings.js";
import type { RouterContext } from "./routes/context.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space-1",
  email: "a@example.test",
  isDeploymentOwner: false,
};
const nova = { id: "bot-2", name: "Nova" };

function fakes(routine: { id: string; bot: { id: string; voiceId: string | null } } | null) {
  const prisma = {
    routine: { findFirst: vi.fn(async () => routine) },
    bot: { findMany: vi.fn(async () => [nova]) },
    $executeRaw: vi.fn(async () => 1),
  };
  const events = { publishSpaceChange: vi.fn(async () => undefined) };
  return { prisma, events, db: prisma as unknown as PrismaClient };
}
const mine = { id: "routine-1", bot: { id: "bot-1", voiceId: "voice-a" } };

beforeEach(() => {
  voice.ready = true;
  voice.coHost = null;
});

describe("reading a routine's spoken briefing", () => {
  it("finds only the caller's own routine of a bot that is not archived", async () => {
    const { prisma, db } = fakes(mine);
    await readSpokenBriefing(db, actor, "routine-1");
    expect(prisma.routine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "routine-1", spaceId: "space-1", userId: "owner", bot: { archivedAt: null } },
      }),
    );
    expect(prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: "space-1",
          userId: "owner",
          archivedAt: null,
          id: { not: "bot-1" },
          AND: [{ voiceId: { not: null } }, { voiceId: { not: "" } }],
        },
      }),
    );
  });

  it("refuses anyone else's routine as not found", async () => {
    const { db } = fakes(null);
    await expect(readSpokenBriefing(db, actor, "routine-1")).rejects.toBeInstanceOf(IsolationError);
  });

  it("is available only while the owner's voice speaks and both bots have a voice", async () => {
    voice.coHost = "bot-2";
    expect(await readSpokenBriefing(fakes(mine).db, actor, "routine-1")).toEqual({
      available: true,
      coHostBotId: "bot-2",
      coHosts: [nova],
    });
    const silent = { ...mine, bot: { id: "bot-1", voiceId: null } };
    expect((await readSpokenBriefing(fakes(silent).db, actor, "routine-1")).available).toBe(false);
    voice.ready = false;
    expect((await readSpokenBriefing(fakes(mine).db, actor, "routine-1")).available).toBe(false);
  });
});

describe("setting a routine's co-host", () => {
  it("saves one of the owner's voiced bots and signals the Space's routines", async () => {
    const { prisma, events, db } = fakes(mine);
    await setSpokenBriefing({ prisma: db, events } as never, actor, {
      routineId: "routine-1",
      coHostBotId: "bot-2",
    });
    const [[sql, ...values]] = prisma.$executeRaw.mock.calls as unknown as [
      [string[], ...unknown[]],
    ];
    expect(sql.join("?")).toContain("INSERT INTO dozo_spoken_briefings");
    expect(values).toEqual(["routine-1", "space-1", "bot-2"]);
    expect(events.publishSpaceChange).toHaveBeenCalledWith("space-1", "routines");
  });

  it("turns it off", async () => {
    const { prisma, events, db } = fakes(mine);
    await setSpokenBriefing({ prisma: db, events } as never, actor, {
      routineId: "routine-1",
      coHostBotId: null,
    });
    const [[sql, ...values]] = prisma.$executeRaw.mock.calls as unknown as [
      [string[], ...unknown[]],
    ];
    expect(sql.join("?")).toContain("DELETE FROM dozo_spoken_briefings");
    expect(values).toEqual(["routine-1"]);
  });

  it("refuses a bot that is not one of the owner's voiced bots as not found", async () => {
    const { prisma, events, db } = fakes(mine);
    await expect(
      setSpokenBriefing({ prisma: db, events } as never, actor, {
        routineId: "routine-1",
        coHostBotId: "someone-elses-bot",
      }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("is served under the feature's key", async () => {
    const { db, events } = fakes(mine);
    const handler = (name: string) => ({
      handler: (run: (call: { context: { actor: Actor }; input: unknown }) => unknown) => ({
        name,
        run,
      }),
    });
    const ctx = {
      deps: { prisma: db, events },
      authed: { dozoSpokenBriefings: { get: handler("get"), set: handler("set") } },
    } as unknown as RouterContext;
    const routes = dozoSpokenBriefingRoutes(ctx).dozoSpokenBriefings as unknown as Record<
      string,
      { run: (call: { context: { actor: Actor }; input: unknown }) => Promise<unknown> }
    >;
    expect(
      await routes.get!.run({ context: { actor }, input: { routineId: "routine-1" } }),
    ).toEqual({
      available: true,
      coHostBotId: null,
      coHosts: [nova],
    });
    await routes.set!.run({
      context: { actor },
      input: { routineId: "routine-1", coHostBotId: null },
    });
    expect(events.publishSpaceChange).toHaveBeenCalled();
  });
});
