import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { phoneGate } from "./dozo-phone.js";
import { PHONE_CALENDAR_READ_TOOL } from "./dozo-phone.tool-definition.js";
import type { RunContext } from "./run-context.js";

// Runs on the branded tree only, against a migrated database (dozo/docker/postgres-tests.sh), as
// the runtime login that row security applies to. The fork's unit gate has no database and skips
// it. The phone's consent is read with a JSON equality on the effect's request, which only a real
// jsonb column can prove.

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("the phone's consent (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  const users: string[] = [];
  const PAIRED = new Date(Date.now() - 60 * 60 * 1000);
  const RANGE = { from: "2026-11-22T00:00:00+03:00", to: "2026-11-29T00:00:00+03:00" };

  beforeAll(() => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = () => db.pool.end();
  });

  afterAll(async () => {
    await system.organization.deleteMany({ where: { id: { in: users } } });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await close();
  });

  /** The owner alone in their Space, a bot's chat there and a run of it. */
  async function ownRun() {
    const userId = `phone-consent-${randomUUID()}`;
    users.push(userId);
    const createdAt = new Date();
    await system.user.create({
      data: { id: userId, name: "Ada", email: `${userId}@example.test`, emailVerified: true },
    });
    await system.organization.create({
      data: { id: userId, name: "Personal", slug: userId, createdAt },
    });
    await system.member.create({
      data: { id: `m-${userId}`, organizationId: userId, userId, role: "owner", createdAt },
    });
    const spaceId = randomUUID();
    await system.space.create({
      data: { id: spaceId, organizationId: userId, name: "Home", createdByUserId: userId },
    });
    await system.spaceMember.create({
      data: { id: randomUUID(), spaceId, organizationId: userId, userId, role: "owner", createdAt },
    });
    const bot = await system.bot.create({
      data: { spaceId, userId, name: "Chef", color: "slate" },
    });
    const thread = await system.thread.create({ data: { spaceId, userId, botId: bot.id } });
    const newRun = async () => {
      const task = await system.task.create({
        data: {
          spaceId,
          userId,
          botId: bot.id,
          threadId: thread.id,
          prompt: "Work",
          status: "running",
        },
      });
      return system.run.create({
        data: {
          spaceId,
          userId,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "running",
          trigger: "user",
        },
      });
    };
    return { userId, spaceId, bot, thread, newRun };
  }

  type Owner = Awaited<ReturnType<typeof ownRun>>;

  /** An effect of the tool as run-tool-gate records it: its request is the call's arguments. */
  const effect = (owner: Owner, runId: string, status: string, request: object) =>
    system.externalEffect.create({
      data: {
        spaceId: owner.spaceId,
        runId,
        kind: PHONE_CALENDAR_READ_TOOL,
        idempotencyKey: randomUUID(),
        status,
        request: request as never,
      },
    });

  /** The real gate on a run of the owner's, with their phone connected. */
  const gate = (owner: Owner, runId: string, args: Record<string, unknown>) => {
    const ctx = {
      source: { userComputerOwner: owner.userId },
      deps: {
        prisma,
        userDevices: {
          connectedPhone: async () => ({ deviceId: "phone-1", pairedAt: PAIRED }),
        },
      },
      bot: { id: owner.bot.id },
      run: { id: runId, botId: owner.bot.id, threadId: owner.thread.id, spaceId: owner.spaceId },
      runId,
      thread: owner.thread,
      state: {},
      trust: { receivedOutsideMessage: async () => false },
    } as unknown as RunContext;
    return runAsTenant(owner, () => phoneGate(ctx, false, args));
  };

  it("lets the call whose own card was allowed run, whatever the order of its keys", async () => {
    const owner = await ownRun();
    const run = await owner.newRun();
    await effect(owner, run.id, "approved", { ...RANGE, query: "dentist" });
    expect(await gate(owner, run.id, { query: "dentist", to: RANGE.to, from: RANGE.from })).toBe(
      "allow",
    );
    // Without a query the call is another one, which its own card must allow.
    expect(await gate(owner, run.id, { ...RANGE })).toBe("ask");
    await effect(owner, run.id, "approved", { ...RANGE });
    expect(await gate(owner, run.id, { to: RANGE.to, from: RANGE.from })).toBe("allow");
  });

  it("does not let another range in the same run ride on that card", async () => {
    const owner = await ownRun();
    const run = await owner.newRun();
    await effect(owner, run.id, "approved", { ...RANGE });
    const other = { from: "2026-12-01T00:00:00+03:00", to: "2026-12-02T00:00:00+03:00" };
    expect(await gate(owner, run.id, other)).toBe("ask");
    // Nor a later run.
    const later = await owner.newRun();
    expect(await gate(owner, later.id, { ...RANGE })).toBe("ask");
  });

  it("counts a completed read of this bot and person in a clean run, and nothing a crash left", async () => {
    const owner = await ownRun();
    const earlier = await owner.newRun();
    const run = await owner.newRun();
    for (const status of ["executing", "uncertain", "intended", "denied"])
      await effect(owner, earlier.id, status, { ...RANGE });
    expect(await gate(owner, run.id, { ...RANGE })).toBe("ask");
    await effect(owner, earlier.id, "completed", { ...RANGE });
    const other = { from: "2026-12-01T00:00:00+03:00", to: "2026-12-02T00:00:00+03:00" };
    expect(await gate(owner, run.id, other)).toBe("allow");
  });
});
