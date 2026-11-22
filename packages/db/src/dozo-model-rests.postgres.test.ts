import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  endModelRests,
  hasModelRests,
  readModelPool,
  readModelRests,
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
  const read = (db: PrismaClient, credentialId: string, modelId: string) =>
    me(() => readModelRests(db, { userId, models: [{ credentialId, modelId }] }));

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
    expect(await me(() => hasModelRests(two.prisma, userId, new Date(now)))).toBe(false);
    expect(await rest(one.prisma, id, "model-1", new Date(now + 2 * HOUR))).toBe(true);
    expect(await read(two.prisma, id, "model-1")).toEqual([
      { credentialId: id, modelId: "model-1", resetsAt: new Date(now + 2 * HOUR) },
    ]);
    expect(await me(() => hasModelRests(two.prisma, userId, new Date(now)))).toBe(true);
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

  it("reads a rest of the model or of the whole connection, never of another model", async () => {
    const id = await connection();
    const now = Date.now();
    await rest(one.prisma, id, "model-2", new Date(now + 3 * HOUR));
    expect(await read(one.prisma, id, "model-1")).toEqual([]);
    await rest(one.prisma, id, null, new Date(now + HOUR));
    expect(await read(one.prisma, id, "model-1")).toEqual([
      { credentialId: id, modelId: "model-1", resetsAt: new Date(now + HOUR) },
    ]);
    expect(await read(one.prisma, id, "model-2")).toEqual([
      { credentialId: id, modelId: "model-2", resetsAt: new Date(now + 3 * HOUR) },
    ]);
  });

  it("ends a rest when the connection gets a new key, and once its end has passed", async () => {
    const id = await connection();
    const now = Date.now();
    await rest(one.prisma, id, "model-1", new Date(now - 1000), new Date(now - HOUR));
    expect((await read(one.prisma, id, "model-1"))[0]?.resetsAt.getTime()).toBeLessThan(now);
    await rest(one.prisma, id, "model-1", new Date(now + HOUR), new Date(now));
    await owner.userModelCredential.update({ where: { id }, data: { secretId: `new-${id}` } });
    expect(await read(one.prisma, id, "model-1")).toEqual([]);
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
