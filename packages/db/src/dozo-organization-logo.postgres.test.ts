import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  readOrganizationLogo,
  readOrganizationMark,
  setOrganizationLogo,
} from "./dozo-organization-logo.js";
import { asSystem } from "./row-security.js";
import { IsolationError } from "./scope.js";

// Runs on the branded tree only, against a migrated database, the way the routes call it (as the
// system, after the caller's own Space was resolved). The fork's unit gate skips it.

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const LOGO = "data:image/webp;base64,UklGRkxPR08=";
const OTHER_LOGO = "data:image/webp;base64,T1RIRVI=";

describePostgres("organization logo (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const id = (name: string) => `org-logo-${name}-${suffix}`;
  const users = ["owner", "admin", "guest", "departed", "stranger"].map(id);
  const [owner, admin, guest, departed, stranger] = users as [
    string,
    string,
    string,
    string,
    string,
  ];
  const acme = { id: id("acme"), home: id("acme-home"), shared: id("acme-shared") };
  const other = { id: id("other"), home: id("other-home") };
  let db: PrismaClient;
  let close: () => Promise<void>;

  async function member(organizationId: string, userId: string, role: string) {
    await db.member.create({
      data: {
        id: id(`m-${organizationId}-${userId}`),
        organizationId,
        userId,
        role,
        createdAt: new Date(),
      },
    });
  }

  async function joinSpace(spaceId: string, organizationId: string, userId: string) {
    await db.spaceMember.upsert({
      where: { spaceId_userId: { spaceId, userId } },
      create: {
        id: id(`sm-${spaceId}-${userId}`),
        spaceId,
        organizationId,
        userId,
        createdAt: new Date(),
      },
      update: {},
    });
  }

  beforeAll(async () => {
    const created = createDb(databaseUrl!);
    db = asSystem(created.prisma);
    close = async () => {
      await db.organization.deleteMany({ where: { id: { in: [acme.id, other.id] } } });
      await db.user.deleteMany({ where: { id: { in: users } } });
      await created.prisma.$disconnect();
      await created.pool.end();
    };
    for (const user of users)
      await db.user.create({ data: { id: user, name: user, email: `${user}@example.test` } });
    for (const org of [acme, other]) {
      await db.organization.create({
        data: {
          id: org.id,
          name: org === acme ? "Acme" : "Other",
          slug: org.id,
          createdAt: new Date(),
        },
      });
      await db.space.create({
        data: { id: org.home, organizationId: org.id, name: "Home", isDefault: true },
      });
    }
    await db.space.create({ data: { id: acme.shared, organizationId: acme.id, name: "Shared" } });
    await member(acme.id, owner, "owner");
    await member(acme.id, admin, "admin");
    // A guest belongs through the Spaces they were invited to; here the shared one.
    await member(acme.id, guest, "guest");
    await member(acme.id, departed, "guest");
    await member(other.id, stranger, "owner");
    await joinSpace(acme.shared, acme.id, guest);
    await joinSpace(acme.shared, acme.id, departed);
  });

  afterAll(async () => {
    await close?.();
  });

  it("is set by the owner and shown to everyone in its Spaces, guests included", async () => {
    await expect(
      setOrganizationLogo(db, { userId: owner, organizationId: acme.id, logo: LOGO }),
    ).resolves.toEqual({ spaceIds: expect.arrayContaining([acme.home, acme.shared]) });
    expect(await readOrganizationMark(db, { userId: owner, spaceId: acme.home })).toEqual({
      name: "Acme",
      logo: LOGO,
    });
    expect(await readOrganizationMark(db, { userId: guest, spaceId: acme.shared })).toEqual({
      name: "Acme",
      logo: LOGO,
    });
    expect(await readOrganizationLogo(db, { userId: owner, organizationId: acme.id })).toEqual({
      logo: LOGO,
      canManage: true,
    });
  });

  it("is changed by an admin too", async () => {
    await setOrganizationLogo(db, { userId: admin, organizationId: acme.id, logo: OTHER_LOGO });
    expect(await readOrganizationLogo(db, { userId: admin, organizationId: acme.id })).toEqual({
      logo: OTHER_LOGO,
      canManage: true,
    });
    await setOrganizationLogo(db, { userId: owner, organizationId: acme.id, logo: LOGO });
  });

  it("is never changed by a guest, and a guest cannot read the settings copy", async () => {
    await expect(
      setOrganizationLogo(db, { userId: guest, organizationId: acme.id, logo: OTHER_LOGO }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      readOrganizationLogo(db, { userId: guest, organizationId: acme.id }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect((await readOrganizationMark(db, { userId: owner, spaceId: acme.home })).logo).toBe(LOGO);
  });

  it("stays inside its organization: another organization's owner can neither read nor change it", async () => {
    await expect(
      setOrganizationLogo(db, { userId: stranger, organizationId: acme.id, logo: OTHER_LOGO }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      readOrganizationLogo(db, { userId: stranger, organizationId: acme.id }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      readOrganizationMark(db, { userId: stranger, spaceId: acme.shared }),
    ).rejects.toBeInstanceOf(IsolationError);
    // Their own organization shows its own, which it does not have.
    expect(await readOrganizationMark(db, { userId: stranger, spaceId: other.home })).toEqual({
      name: "Other",
      logo: null,
    });
  });

  it("is gone for a member the moment they leave", async () => {
    expect((await readOrganizationMark(db, { userId: departed, spaceId: acme.shared })).logo).toBe(
      LOGO,
    );
    // Leaving the last Space removes the Space membership and, for a guest, the organization's.
    await db.spaceMember.deleteMany({ where: { userId: departed, organizationId: acme.id } });
    await db.member.deleteMany({ where: { userId: departed, organizationId: acme.id } });
    await expect(
      readOrganizationMark(db, { userId: departed, spaceId: acme.shared }),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(
      setOrganizationLogo(db, { userId: departed, organizationId: acme.id, logo: null }),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("is removed with null, and an owner who lost the role changes nothing", async () => {
    await setOrganizationLogo(db, { userId: owner, organizationId: acme.id, logo: null });
    expect((await readOrganizationMark(db, { userId: guest, spaceId: acme.shared })).logo).toBe(
      null,
    );
    await db.member.updateMany({
      where: { organizationId: acme.id, userId: admin },
      data: { role: "member" },
    });
    await expect(
      setOrganizationLogo(db, { userId: admin, organizationId: acme.id, logo: LOGO }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(await readOrganizationLogo(db, { userId: admin, organizationId: acme.id })).toEqual({
      logo: null,
      canManage: false,
    });
  });
});
