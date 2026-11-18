import { randomBytes } from "node:crypto";
import { createDb, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addBan,
  bannedEntries,
  emailBanned,
  listBans,
  removeBan,
} from "./dozo-operator.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

describePostgres("the ban list (PostgreSQL)", () => {
  // A domain of its own, so a run leaves the list as it found it.
  const domain = `ban-${process.pid}-${randomBytes(3).toString("hex")}.test`;
  let db: ReturnType<typeof createDb>;

  beforeAll(() => {
    db = createDb(databaseUrl!);
  });

  afterAll(async () => {
    if (!db) return;
    await db.prisma.$executeRaw`DELETE FROM "dozo_bans" WHERE "value" LIKE ${`%${domain}`}`;
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("adds once, finds, lists and removes with no database context, as sign-in has none", async () => {
    const { prisma } = db;
    await addBan(prisma, `eve@${domain}`, "admin-1");
    await addBan(prisma, `eve@${domain}`, "admin-2");
    expect(await emailBanned(prisma, `EVE+tag@${domain}`)).toBe(true);
    expect(await emailBanned(prisma, `adam@${domain}`)).toBe(false);

    await addBan(prisma, domain, "admin-1");
    expect(await bannedEntries(prisma, [`adam@mail.${domain}`, `eve@${domain}`])).toEqual(
      new Set([domain, `eve@${domain}`]),
    );
    const listed = (await listBans(prisma)).filter((ban) => ban.value.endsWith(domain));
    expect(listed.map((ban) => ban.value).sort()).toEqual([domain, `eve@${domain}`].sort());
    expect(listed[0]?.createdAt).toBeInstanceOf(Date);

    await removeBan(prisma, domain);
    await removeBan(prisma, `eve@${domain}`);
    expect(await emailBanned(prisma, `eve@${domain}`)).toBe(false);
  });

  it("reads and writes the same from inside a tenant, as the admin page does", async () => {
    const { prisma } = db;
    await runAsTenant({ spaceId: "space-none", userId: "user-none" }, async () => {
      await addBan(prisma, `mal@${domain}`, "admin-1");
      expect(await emailBanned(prisma, `mal@${domain}`)).toBe(true);
      await removeBan(prisma, `mal@${domain}`);
      expect(await emailBanned(prisma, `mal@${domain}`)).toBe(false);
    });
  });
});
