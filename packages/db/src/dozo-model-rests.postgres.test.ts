import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  endModelRests,
  readActiveModelRests,
  readModelPool,
  recordModelConnectionCooldown,
  recordModelRest,
} from "./dozo-model-pool-store.js";
import { asSystem, runAsTenant } from "./row-security.js";

// Runs against a migrated database only: DATABASE_URL is the runtime login, which row security
// applies to. The fork's unit gate has no database and skips it.

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const HOUR = 60 * 60_000;

describePostgres("model rests outside a pool (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `rest-user-${suffix}`;
  const otherId = `rest-other-${suffix}`;
  // Two processes of the server: each its own client and connection pool.
  let one: ReturnType<typeof createDb>;
  let two: ReturnType<typeof createDb>;
  let owner: PrismaClient;
  let count = 0;

  const me = <T>(work: () => Promise<T>) =>
    runAsTenant({ spaceId: `space-${suffix}`, userId }, work);

  async function connection(user = userId, provider = "provider-a") {
    const id = `rest-connection-${suffix}-${count++}`;
    await owner.userModelCredential.create({
      data: { id, userId: user, provider, label: id, secretId: `secret-${id}` },
    });
    return id;
  }

  const rest = (
    db: PrismaClient,
    credentialId: string,
    modelId: string | null,
    resetsAt: Date,
    observedAt = new Date(),
    user = userId,
  ) =>
    me(() =>
      recordModelRest(db, {
        userId: user,
        credentialId,
        modelId,
        reason: modelId ? "exhausted" : "rejected",
        resetsAt,
        observedAt,
      }),
    );
  const active = (db: PrismaClient, at = Date.now()) =>
    me(() => readActiveModelRests(db, userId, new Date(at)));
  /** The rests of one connection that have not ended, model '' being the whole connection. */
  const read = async (db: PrismaClient, credentialId: string, modelId?: string) =>
    (await active(db)).filter(
      (rest) =>
        rest.credentialId === credentialId && (modelId === undefined || rest.modelId === modelId),
    );

  beforeAll(async () => {
    one = createDb(databaseUrl!);
    two = createDb(databaseUrl!);
    owner = asSystem(one.prisma);
    await owner.user.createMany({
      data: [userId, otherId].map((id) => ({
        id,
        name: id,
        email: `${id}@example.test`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    });
  });

  afterAll(async () => {
    await owner.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    for (const db of [one, two]) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("rests a connection that is in no pool, and one process sees what another wrote", async () => {
    const id = await connection();
    const now = Date.now();
    expect(await read(two.prisma, id)).toEqual([]);
    expect(await rest(one.prisma, id, "model-1", new Date(now + 2 * HOUR))).toBe(true);
    expect(await read(two.prisma, id, "model-1")).toEqual([
      { credentialId: id, modelId: "model-1", resetsAt: new Date(now + 2 * HOUR) },
    ]);
    // The pool still sees only pooled connections: this rest hands nothing over.
    expect(
      await me(() =>
        readModelPool(two.prisma, { userId, credentialIds: [id], modelId: "model-1" }),
      ),
    ).toEqual([]);
  });

  it("keeps the newest observation when two processes record the same model at once", async () => {
    const id = await connection();
    const now = Date.now();
    await Promise.all([
      rest(one.prisma, id, "model-1", new Date(now + 2 * HOUR), new Date(now)),
      rest(two.prisma, id, "model-1", new Date(now + 5 * HOUR), new Date(now + 1)),
    ]);
    expect(await rest(one.prisma, id, "model-1", new Date(now + 9 * HOUR), new Date(now - 1))).toBe(
      false,
    );
    // The instant itself, compared in SQL, so it holds in any database time zone.
    const rows = await owner.$queryRaw<Array<{ exact: boolean }>>`
      SELECT "resetsAt" = ${new Date(now + 5 * HOUR).toISOString()}::timestamptz AS "exact"
      FROM "dozo_model_connection_cooldowns" WHERE "credentialId" = ${id}`;
    expect(rows).toEqual([{ exact: true }]);
  });

  it("reads a rest of a model and of the whole connection apart, only while they last", async () => {
    const id = await connection();
    const now = Date.now();
    await rest(one.prisma, id, "model-2", new Date(now + 3 * HOUR));
    await rest(one.prisma, id, null, new Date(now + HOUR));
    const rows = await read(one.prisma, id);
    expect(rows.map((row) => [row.modelId, row.resetsAt.getTime()]).sort()).toEqual(
      [
        ["", now + HOUR],
        ["model-2", now + 3 * HOUR],
      ].sort(),
    );
    // Two hours on, only the model's rest is left.
    expect(
      (await active(one.prisma, now + 2 * HOUR)).filter((row) => row.credentialId === id),
    ).toEqual([{ credentialId: id, modelId: "model-2", resetsAt: new Date(now + 3 * HOUR) }]);
  });

  it("ends a rest when the connection gets a new key", async () => {
    const id = await connection();
    const now = Date.now();
    await rest(one.prisma, id, "model-1", new Date(now + HOUR), new Date(now));
    expect(await read(one.prisma, id, "model-1")).toHaveLength(1);
    await owner.userModelCredential.update({ where: { id }, data: { secretId: `new-${id}` } });
    expect(await read(one.prisma, id, "model-1")).toEqual([]);
  });

  it("rests a key refused again twice as long each time, up to a week, in the pool's store too", async () => {
    const id = await connection();
    const now = Date.now();
    const FIVE = 5 * 60_000;
    const refuse = (at: number) => rest(one.prisma, id, null, new Date(at + FIVE), new Date(at));
    await refuse(now);
    const ends = async () => (await read(one.prisma, id, ""))[0]?.resetsAt.getTime();
    expect(await ends()).toBe(now + FIVE);
    // Refused again once the rest ended: ten minutes, then twenty.
    await refuse(now + FIVE);
    expect(await ends()).toBe(now + FIVE + 2 * FIVE);
    await refuse(now + 3 * FIVE);
    expect(await ends()).toBe(now + 3 * FIVE + 4 * FIVE);
    // The pool's store keeps the same rule.
    await owner.$executeRaw`
      INSERT INTO "dozo_model_pool_members" ("credentialId", "userId") VALUES (${id}, ${userId})`;
    await me(() =>
      recordModelConnectionCooldown(one.prisma, {
        userId,
        credentialId: id,
        modelId: null,
        reason: "rejected",
        resetsAt: new Date(now + 7 * FIVE + FIVE),
        observedAt: new Date(now + 7 * FIVE),
      }),
    );
    expect(await ends()).toBe(now + 7 * FIVE + 8 * FIVE);
    // Never past a week.
    let at = now + 15 * FIVE;
    for (let i = 0; i < 14; i++) {
      await refuse(at);
      at = (await ends()) ?? at;
    }
    const last = (await read(one.prisma, id, ""))[0]!;
    const observed = await owner.$queryRaw<Array<{ ms: number }>>`
      SELECT (extract(epoch FROM "resetsAt" - "observedAt") * 1000)::bigint::int8 AS ms
      FROM "dozo_model_connection_cooldowns" WHERE "credentialId" = ${id} AND "modelId" = ''`;
    expect(Number(observed[0]?.ms)).toBe(168 * HOUR);
    expect(last.resetsAt.getTime()).toBeGreaterThan(now);
  });

  it("leaves a refused key's rest as it is while it lasts, however often it is refused meanwhile", async () => {
    const id = await connection();
    const now = Date.now();
    const FIVE = 5 * 60_000;
    const refuse = (at: number) => rest(one.prisma, id, null, new Date(at + FIVE), new Date(at));
    const ends = async () => (await read(one.prisma, id, ""))[0]?.resetsAt.getTime();
    await refuse(now);
    // A pinned routine, a run with no backup to start on, two runs ending together: all refused
    // while the rest lasts, none of them making it longer.
    for (let i = 1; i <= 6; i++) await refuse(now + i * 30_000);
    expect(await ends()).toBe(now + FIVE);
    // Refused again once it ended: twice as long, once.
    await refuse(now + FIVE + 1000);
    expect(await ends()).toBe(now + FIVE + 1000 + 2 * FIVE);
  });

  it("makes a refused key's rest twice as long once when two processes record it together", async () => {
    const id = await connection();
    const now = Date.now();
    const FIVE = 5 * 60_000;
    await rest(one.prisma, id, null, new Date(now + FIVE), new Date(now));
    const after = now + FIVE + 1000;
    await Promise.all([
      rest(one.prisma, id, null, new Date(after + FIVE), new Date(after)),
      rest(two.prisma, id, null, new Date(after + FIVE), new Date(after)),
    ]);
    expect((await read(one.prisma, id, ""))[0]?.resetsAt.getTime()).toBe(after + 2 * FIVE);
  });

  it("starts a refused key over at a few minutes on a new key, or a day after its rest ended", async () => {
    const id = await connection();
    const now = Date.now();
    const FIVE = 5 * 60_000;
    await rest(one.prisma, id, null, new Date(now + 4 * FIVE), new Date(now));
    await owner.userModelCredential.update({ where: { id }, data: { secretId: `new-${id}` } });
    await rest(one.prisma, id, null, new Date(now + FIVE + FIVE), new Date(now + FIVE));
    expect((await read(one.prisma, id, ""))[0]?.resetsAt.getTime()).toBe(now + 2 * FIVE);
    const later = now + 2 * FIVE + 25 * HOUR;
    await rest(one.prisma, id, null, new Date(later + FIVE), new Date(later));
    expect(
      (await active(one.prisma, later)).find((row) => row.credentialId === id)?.resetsAt.getTime(),
    ).toBe(later + FIVE);
  });

  it("clears the person's rests that ended over a day ago when it records a new one", async () => {
    const old = await connection();
    const fresh = await connection();
    const now = Date.now();
    await rest(one.prisma, old, "model-1", new Date(now - 30 * HOUR), new Date(now - 31 * HOUR));
    await rest(one.prisma, old, "model-2", new Date(now - 2 * HOUR), new Date(now - 3 * HOUR));
    await rest(one.prisma, fresh, "model-1", new Date(now + HOUR), new Date(now));
    const left = await owner.$queryRaw<Array<{ modelId: string }>>`
      SELECT "modelId" FROM "dozo_model_connection_cooldowns" WHERE "credentialId" = ${old}`;
    expect(left).toEqual([{ modelId: "model-2" }]);
  });

  it("reads by the person and the end of each rest on an index", async () => {
    const rows = await owner.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'dozo_model_connection_cooldowns'
        AND indexname = 'dozo_model_connection_cooldowns_userId_resetsAt_idx'`;
    expect(rows[0]?.indexdef).toContain('("userId", "resetsAt")');
  });

  it("ends a picked model's rests on the person's connections of that provider only", async () => {
    // Providers of this test only: a pick ends every rest of the provider's connections.
    const first = await connection(userId, "provider-picked");
    const second = await connection(userId, "provider-picked");
    const elsewhere = await connection(userId, "provider-kept");
    const now = Date.now();
    for (const id of [first, second, elsewhere])
      await rest(one.prisma, id, "model-9", new Date(now + HOUR));
    await rest(one.prisma, second, null, new Date(now + HOUR));
    await rest(one.prisma, first, "model-8", new Date(now + HOUR));
    expect(
      await me(() =>
        endModelRests(two.prisma, { userId, providers: ["provider-picked"], modelId: "model-9" }),
      ),
    ).toBe(3);
    expect(await read(one.prisma, first, "model-9")).toEqual([]);
    expect(await read(one.prisma, second, "model-9")).toEqual([]);
    expect(await read(one.prisma, elsewhere, "model-9")).toHaveLength(1);
    expect(await read(one.prisma, first, "model-8")).toHaveLength(1);
  });

  it("never rests or reads another person's connection", async () => {
    const theirs = await connection(otherId, "provider-theirs");
    const now = Date.now();
    expect(await rest(one.prisma, theirs, "model-1", new Date(now + HOUR))).toBe(false);
    await asSystem(one.prisma).$executeRaw`
      INSERT INTO "dozo_model_connection_cooldowns"
        ("credentialId", "userId", "modelId", "secretId", "reason", "resetsAt", "observedAt")
      VALUES (${theirs}, ${otherId}, 'model-1', ${`secret-${theirs}`}, 'exhausted',
        ${new Date(now + HOUR).toISOString()}::timestamptz, ${new Date(now).toISOString()}::timestamptz)`;
    expect(await read(one.prisma, theirs, "model-1")).toEqual([]);
    expect(
      await me(() =>
        endModelRests(one.prisma, { userId, providers: ["provider-theirs"], modelId: "model-1" }),
      ),
    ).toBe(0);
    const kept = await owner.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM "dozo_model_connection_cooldowns" WHERE "credentialId" = ${theirs}`;
    expect(kept).toEqual([{ n: 1 }]);
  });
});
