import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { TeachComputerInput, TeachingSessionDeps } from "@rakazo/adapters";
import { recordTeachingInputEvent } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createThreadEvents, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// What one input costs the server while recording, the share of a click's delay the page cannot
// see: each input takes the recording's row lock twice and rewrites the whole recording. A click
// as one input is half the work of a press and a release. The time is printed, not asserted (it
// depends on the machine); the count of inputs written is.

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;
const CLICKS = 20;

describePostgres("the server's cost of a click while teaching (PostgreSQL)", () => {
  const id = `cost-${randomUUID()}`;
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const teacher = { userId: id, spaceId: id, email: `${id}@example.test` } as Actor;

  beforeAll(async () => {
    db = createDb(databaseUrl!, { encryptContent: true });
    system = asSystem(db.prisma);
    await system.user.create({
      data: { id, name: id, email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({ data: { id, name: "Team", slug: id, createdAt: new Date() } });
    await system.member.create({
      data: { id: `m-${id}`, organizationId: id, userId: id, role: "owner", createdAt: new Date() },
    });
    await system.space.create({ data: { id, organizationId: id, name: "Home" } });
  });

  afterAll(async () => {
    await system.organization.deleteMany({ where: { id } });
    await system.user.deleteMany({ where: { id } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  async function timeInputs(inputs: TeachComputerInput[]) {
    const bot = await system.bot.create({
      data: { spaceId: id, userId: id, name: "Clerk", color: "test" },
    });
    const skill = await system.taughtSkill.create({
      data: {
        spaceId: id,
        botId: bot.id,
        userId: id,
        goal: "Click",
        status: "recording",
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
        recording: { events: [], snapshots: [] } as never,
      },
    });
    const deps: TeachingSessionDeps = {
      prisma: db.prisma,
      events: createThreadEvents(db.prisma),
      jobs: { enqueue: vi.fn(), cancel: vi.fn() } as unknown as JobPublisher,
      sandbox: {} as never,
    };
    const started = performance.now();
    for (const input of inputs) {
      await runAsTenant(teacher, () => recordTeachingInputEvent(deps, teacher, bot.id, input));
    }
    const ms = performance.now() - started;
    const [row] = await system.$queryRaw<Array<{ count: number }>>`
      SELECT jsonb_array_length(recording->'events')::int AS count
      FROM taught_skills WHERE id = ${skill.id}`;
    return { ms, written: row?.count ?? 0 };
  }

  it("writes one event and takes the lock once per click, not two", async () => {
    const pair = (type: "down" | "up"): TeachComputerInput => ({
      kind: "pointer",
      x: 10,
      y: 20,
      button: "left",
      type,
    });
    const asPairs = await timeInputs(
      Array.from({ length: CLICKS }, () => [pair("down"), pair("up")]).flat(),
    );
    const asClicks = await timeInputs(
      Array.from({ length: CLICKS }, () => ({ ...pair("down"), type: "click" as const })),
    );
    console.info(
      `[teach input cost] ${CLICKS} clicks: press+release ${(asPairs.ms / CLICKS).toFixed(1)} ms each, click ${(asClicks.ms / CLICKS).toFixed(1)} ms each`,
    );
    expect(asPairs.written).toBe(CLICKS * 2);
    expect(asClicks.written).toBe(CLICKS);
  });
});
