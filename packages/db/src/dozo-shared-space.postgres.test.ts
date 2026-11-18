import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { SharedSpaceFullError, withSharedSpace } from "./dozo-shared-space.js";
import { asSystem, runAsTenant } from "./row-security.js";

// Runs on the branded tree only, against a migrated database: DATABASE_URL is the runtime login,
// which row security applies to. The fork's unit gate has no database and skips it.

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const MB = 1024 * 1024;

describePostgres("shared space (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `shared-space-user-${suffix}`;
  const organizations: string[] = [];
  let prisma: PrismaClient;
  let owner: PrismaClient;
  let close: () => Promise<void>;
  let files = 0;

  /** A new organization with two Spaces, on Free unless a tier is given. */
  async function organization(tier?: string) {
    const id = `shared-space-org-${suffix}-${organizations.length}`;
    organizations.push(id);
    await owner.organization.create({ data: { id, name: "Acme", slug: id, createdAt: new Date() } });
    const spaces = [`${id}-a`, `${id}-b`] as const;
    for (const space of spaces)
      await owner.space.create({ data: { id: space, organizationId: id, name: space } });
    if (tier)
      await owner.billingAccount.create({
        data: { organizationId: id, customerId: `customer-${id}`, status: "active", byokTier: tier },
      });
    return { id, spaces };
  }

  const file = (spaceId: string, size: number) => ({
    data: {
      spaceId,
      userId,
      name: `file-${files}`,
      mimeType: "text/plain",
      size,
      hash: "hash",
      storageKey: `shared-space-${suffix}-${files++}`,
    },
  });

  /** One write of one file, as the Space's own member. */
  const add = (
    spaceId: string,
    size: number,
    write = (tx: Prisma.TransactionClient) => tx.artifact.create(file(spaceId, size)),
  ) => runAsTenant({ spaceId, userId }, () => withSharedSpace(prisma, spaceId, write));

  const used = async (organizationId: string) =>
    (
      await owner.artifact.aggregate({
        where: { space: { organizationId } },
        _sum: { size: true },
      })
    )._sum.size ?? 0;

  const bills = (modelCreditsEnabled: boolean) =>
    owner.deploymentSettings.upsert({
      where: { id: "default" },
      create: { id: "default", modelCreditsEnabled },
      update: { modelCreditsEnabled },
    });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    owner = asSystem(db.prisma);
    const before = await owner.deploymentSettings.findUnique({ where: { id: "default" } });
    close = async () => {
      await owner.organization.deleteMany({ where: { id: { in: organizations } } });
      await bills(before?.modelCreditsEnabled ?? false);
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    await bills(true);
  });

  afterAll(async () => {
    await close();
  });

  it("runs as a login row security applies to", async () => {
    const [role] = await prisma.$queryRaw<Array<{ free: boolean }>>`
      SELECT (r.rolsuper OR r.rolbypassrls) AS "free" FROM pg_roles r WHERE r.rolname = session_user`;
    expect(role?.free).toBe(false);
  });

  it("lets writes running together fill the limit and not pass it", async () => {
    const { id, spaces } = await organization();
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => add(spaces[i % 2]!, 100 * MB)),
    );
    const refused = results.filter(
      (result) => result.status === "rejected" && result.reason instanceof SharedSpaceFullError,
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(refused).toHaveLength(7);
    expect(await used(id)).toBe(500 * MB);
  });

  it("lets only one of two writes that together go over through", async () => {
    const { id, spaces } = await organization();
    await add(spaces[0], 300 * MB);
    const results = await Promise.allSettled([add(spaces[0], 150 * MB), add(spaces[1], 150 * MB)]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await used(id)).toBe(450 * MB);
  });

  it("counts a file added inside a savepoint and refuses it", async () => {
    const { id, spaces } = await organization();
    await add(spaces[0], 500 * MB);
    const inSavepoint = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SAVEPOINT nested`;
      await tx.artifact.create(file(spaces[0], MB));
      await tx.$executeRaw`RELEASE SAVEPOINT nested`;
    };
    await expect(add(spaces[0], MB, inSavepoint)).rejects.toBeInstanceOf(SharedSpaceFullError);
    expect(await used(id)).toBe(500 * MB);
  });

  it("counts every Space of the organization and no other organization", async () => {
    const other = await organization();
    await add(other.spaces[0], 500 * MB);
    const { id, spaces } = await organization();
    await add(spaces[0], 300 * MB);
    // The other organization is full; this one still has room, across its two Spaces.
    await add(spaces[1], 200 * MB);
    await expect(add(spaces[1], 1)).rejects.toBeInstanceOf(SharedSpaceFullError);
    expect(await used(id)).toBe(500 * MB);
  });

  it("gives a paid plan its limit, keeps an ended plan's files, and takes more once room is made", async () => {
    const { id, spaces } = await organization("pro");
    await add(spaces[0], 1024 * MB);
    await add(spaces[1], 1024 * MB);
    await expect(add(spaces[0], 1)).rejects.toBeInstanceOf(SharedSpaceFullError);
    await owner.billingAccount.update({
      where: { organizationId: id },
      data: { status: "canceled" },
    });
    await expect(add(spaces[0], 1)).rejects.toBeInstanceOf(SharedSpaceFullError);
    expect(await used(id)).toBe(2048 * MB);
    const tenant = { spaceId: spaces[0], userId };
    // Reading and deleting pass no check.
    expect(await runAsTenant(tenant, () => prisma.artifact.count())).toBe(1);
    await runAsTenant(tenant, () => prisma.artifact.deleteMany({ where: { spaceId: spaces[0] } }));
    await expect(add(spaces[0], 1)).rejects.toBeInstanceOf(SharedSpaceFullError);
    await runAsTenant({ spaceId: spaces[1], userId }, () =>
      prisma.artifact.deleteMany({ where: { spaceId: spaces[1] } }),
    );
    await expect(add(spaces[0], MB)).resolves.toBeTruthy();
  });

  it("runs no query of its own on a server that does not bill", async () => {
    const { id, spaces } = await organization();
    await bills(false);
    try {
      let queries: ReturnType<typeof vi.spyOn> | undefined;
      await add(spaces[0], 600 * MB, async (tx) => {
        await tx.artifact.create(file(spaces[0], 600 * MB));
        // From here on only the check runs: neither its lock nor its count may.
        queries = vi.spyOn(tx, "$queryRaw");
      });
      expect(queries).toHaveBeenCalledTimes(0);
      expect(await used(id)).toBe(600 * MB);
    } finally {
      await bills(true);
    }
  });
});
