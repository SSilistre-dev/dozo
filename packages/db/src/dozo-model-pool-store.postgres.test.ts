import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  readModelPool,
  readModelPoolMembers,
  recordModelConnectionCooldown,
  setModelPoolMember,
} from "./dozo-model-pool-store.js";
import { asSystem, runAsTenant } from "./row-security.js";

// Runs against a migrated database only: DATABASE_URL is the runtime login, which row security
// applies to. The fork's unit gate has no database and skips it.

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const HOUR = 60 * 60_000;

describePostgres("the model pool store (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `pool-user-${suffix}`;
  const otherId = `pool-other-${suffix}`;
  const model = "model-1";
  let prisma: PrismaClient;
  let owner: PrismaClient;
  let close: () => Promise<void>;
  let count = 0;

  const asUser =
    (id: string) =>
    <T>(work: () => Promise<T>) =>
      runAsTenant({ spaceId: `space-${suffix}`, userId: id }, work);
  const me = asUser(userId);

  async function connection(user = userId) {
    const id = `pool-connection-${suffix}-${count++}`;
    await owner.userModelCredential.create({
      data: { id, userId: user, provider: "provider-a", label: id, secretId: `secret-${id}` },
    });
    return id;
  }

  const rest = (credentialId: string, observedAt: Date, resetsAt: Date, modelId: string | null) =>
    me(() =>
      recordModelConnectionCooldown(prisma, {
        userId,
        credentialId,
        modelId,
        reason: modelId ? "exhausted" : "rejected",
        resetsAt,
        observedAt,
      }),
    );

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    owner = asSystem(db.prisma);
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
    close = async () => {
      await owner.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
      await db.prisma.$disconnect();
      await db.pool.end();
    };
  });

  afterAll(async () => {
    await close();
  });

  it("pools only the owner's own connections and reads only the pooled ones", async () => {
    const pooled = await connection();
    const alone = await connection();
    const theirs = await connection(otherId);
    expect(await me(() => setModelPoolMember(prisma, { userId, credentialId: pooled }, true))).toBe(
      true,
    );
    // Adding it again changes nothing and still says it is pooled.
    expect(await me(() => setModelPoolMember(prisma, { userId, credentialId: pooled }, true))).toBe(
      true,
    );
    expect(await me(() => setModelPoolMember(prisma, { userId, credentialId: theirs }, true))).toBe(
      false,
    );
    expect(
      await me(() =>
        readModelPool(prisma, { userId, credentialIds: [pooled, alone, theirs], modelId: model }),
      ),
    ).toEqual([{ credentialId: pooled, resetsAt: null }]);
    // Another person's request sees none of it.
    expect(
      await asUser(otherId)(() =>
        readModelPool(prisma, { userId, credentialIds: [pooled], modelId: model }),
      ),
    ).toEqual([]);
    await me(() => setModelPoolMember(prisma, { userId, credentialId: pooled }, false));
    expect(
      await me(() => readModelPool(prisma, { userId, credentialIds: [pooled], modelId: model })),
    ).toEqual([]);
  });

  it("keeps the newest observation when two runs record the same connection at once", async () => {
    const id = await connection();
    await me(() => setModelPoolMember(prisma, { userId, credentialId: id }, true));
    const now = Date.now();
    const written = await Promise.all([
      rest(id, new Date(now), new Date(now + 2 * HOUR), model),
      rest(id, new Date(now + 1), new Date(now + 5 * HOUR), model),
    ]);
    expect(written.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    // An older observation arriving late does not undo the newer one.
    expect(await rest(id, new Date(now - 1000), new Date(now + 9 * HOUR), model)).toBe(false);
    const rows = await owner.$queryRaw<Array<{ resetsAt: Date }>>`
      SELECT "resetsAt" FROM "dozo_model_connection_cooldowns" WHERE "credentialId" = ${id}`;
    expect(rows.map((row) => row.resetsAt.getTime())).toEqual([now + 5 * HOUR]);
    expect(
      await me(() => readModelPool(prisma, { userId, credentialIds: [id], modelId: model })),
    ).toEqual([{ credentialId: id, resetsAt: new Date(now + 5 * HOUR) }]);
  });

  it("reads a rest of the whole connection or of the model, never of another model", async () => {
    const id = await connection();
    await me(() => setModelPoolMember(prisma, { userId, credentialId: id }, true));
    const now = Date.now();
    await rest(id, new Date(now), new Date(now + 3 * HOUR), "model-2");
    const read = (modelId: string) =>
      me(() => readModelPool(prisma, { userId, credentialIds: [id], modelId }));
    expect(await read(model)).toEqual([{ credentialId: id, resetsAt: null }]);
    await rest(id, new Date(now), new Date(now + HOUR), null);
    expect(await read(model)).toEqual([{ credentialId: id, resetsAt: new Date(now + HOUR) }]);
    expect(await read("model-2")).toEqual([
      { credentialId: id, resetsAt: new Date(now + 3 * HOUR) },
    ]);
  });

  it("shows settings the latest rest of any model, for the current key only", async () => {
    const id = await connection();
    const alone = await connection();
    await me(() => setModelPoolMember(prisma, { userId, credentialId: id }, true));
    const now = Date.now();
    await rest(id, new Date(now), new Date(now + HOUR), null);
    await rest(id, new Date(now), new Date(now + 3 * HOUR), "model-2");
    const read = () =>
      me(() => readModelPoolMembers(prisma, { userId, credentialIds: [id, alone] }));
    expect(await read()).toEqual([{ credentialId: id, resetsAt: new Date(now + 3 * HOUR) }]);
    expect(
      await asUser(otherId)(() => readModelPoolMembers(prisma, { userId, credentialIds: [id] })),
    ).toEqual([]);
    await owner.userModelCredential.update({ where: { id }, data: { secretId: `new-${id}` } });
    expect(await read()).toEqual([{ credentialId: id, resetsAt: null }]);
  });

  it("ends a rest when a new key is saved, not when the connection is renamed", async () => {
    const id = await connection();
    await me(() => setModelPoolMember(prisma, { userId, credentialId: id }, true));
    const now = Date.now();
    await rest(id, new Date(now), new Date(now + HOUR), null);
    const read = () =>
      me(() => readModelPool(prisma, { userId, credentialIds: [id], modelId: model }));
    await owner.userModelCredential.update({ where: { id }, data: { label: "renamed" } });
    expect(await read()).toEqual([{ credentialId: id, resetsAt: new Date(now + HOUR) }]);
    await owner.userModelCredential.update({ where: { id }, data: { secretId: `new-${id}` } });
    expect(await read()).toEqual([{ credentialId: id, resetsAt: null }]);
  });

  it("keeps a subscription's rest for its account across a refresh and a new sign-in", async () => {
    const id = await connection();
    await me(() => setModelPoolMember(prisma, { userId, credentialId: id }, true));
    const now = Date.now();
    await me(() =>
      recordModelConnectionCooldown(prisma, {
        userId,
        credentialId: id,
        modelId: model,
        reason: "exhausted",
        resetsAt: new Date(now + 5 * HOUR),
        observedAt: new Date(now),
        holder: "account:one",
      }),
    );
    const read = (account: string) =>
      me(() =>
        readModelPool(prisma, {
          userId,
          credentialIds: [id],
          modelId: model,
          accounts: new Map([[id, account]]),
        }),
      );
    const resting = [{ credentialId: id, resetsAt: new Date(now + 5 * HOUR) }];
    // A token refresh rewrites the secret in place: the connection row does not change.
    expect(await read("account:one")).toEqual(resting);
    // Signing in again gives the connection a new secret; the same account keeps its rest.
    await owner.userModelCredential.update({ where: { id }, data: { secretId: `again-${id}` } });
    expect(await read("account:one")).toEqual(resting);
    expect(
      await me(() =>
        readModelPoolMembers(prisma, {
          userId,
          credentialIds: [id],
          accounts: new Map([[id, "account:one"]]),
        }),
      ),
    ).toEqual(resting);
    // Another account on the same connection starts open.
    expect(await read("account:two")).toEqual([{ credentialId: id, resetsAt: null }]);
    // A refused sign-in rests only until the next one.
    await rest(id, new Date(now + 1), new Date(now + HOUR), null);
    expect(await read("account:two")).toEqual([
      { credentialId: id, resetsAt: new Date(now + HOUR) },
    ]);
    await owner.userModelCredential.update({ where: { id }, data: { secretId: `third-${id}` } });
    expect(await read("account:two")).toEqual([{ credentialId: id, resetsAt: null }]);
  });

  it("writes no rest for a connection that is not pooled", async () => {
    const now = Date.now();
    const alone = await connection();
    expect(await rest(alone, new Date(now), new Date(now + HOUR), null)).toBe(false);
  });

  it("goes with the connection", async () => {
    const id = await connection();
    await me(() => setModelPoolMember(prisma, { userId, credentialId: id }, true));
    await rest(id, new Date(), new Date(Date.now() + HOUR), null);
    await owner.userModelCredential.delete({ where: { id } });
    const left = await owner.$queryRaw<Array<{ n: number }>>`
      SELECT (SELECT count(*) FROM "dozo_model_pool_members" WHERE "credentialId" = ${id})::int
        + (SELECT count(*) FROM "dozo_model_connection_cooldowns" WHERE "credentialId" = ${id})::int
        AS n`;
    expect(left[0]?.n).toBe(0);
  });
});
