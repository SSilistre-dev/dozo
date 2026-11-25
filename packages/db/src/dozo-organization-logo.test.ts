import { describe, expect, it, vi } from "vitest";
import {
  readOrganizationLogo,
  readOrganizationMark,
  setOrganizationLogo,
} from "./dozo-organization-logo.js";
import { IsolationError } from "./database/scope.js";

const LOGO = "data:image/webp;base64,UklGRg==";

function fakeDb(
  rows: {
    membership?: unknown;
    member?: unknown;
    /** The caller's member row as the locking read finds it. */
    role?: string;
    updated?: number;
    spaces?: Array<{ id: string }>;
  } = {},
) {
  const db = {
    spaceMember: { findUnique: vi.fn(async () => rows.membership ?? null) },
    member: { findFirst: vi.fn(async () => rows.member ?? null) },
    $queryRaw: vi.fn(async (..._sql: unknown[]) =>
      rows.role === undefined ? [] : [{ role: rows.role }],
    ),
    organization: { updateMany: vi.fn(async () => ({ count: rows.updated ?? 0 })) },
    space: { findMany: vi.fn(async () => rows.spaces ?? []) },
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)),
  };
  return db;
}

const sqlOf = (db: ReturnType<typeof fakeDb>) =>
  (db.$queryRaw.mock.calls[0]?.[0] as { strings: string[] } | undefined)?.strings.join("?") ?? "";

describe("the sidebar's organization mark", () => {
  it("is the logo of the organization that holds the Space", async () => {
    const db = fakeDb({
      membership: { space: { deletingAt: null, organization: { name: "Acme", logo: LOGO } } },
    });
    await expect(readOrganizationMark(db as never, { userId: "u", spaceId: "s" })).resolves.toEqual(
      { name: "Acme", logo: LOGO },
    );
    expect(db.spaceMember.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { spaceId_userId: { spaceId: "s", userId: "u" } } }),
    );
  });

  it("hands an app nothing to load that the server did not draw", async () => {
    const db = fakeDb({
      membership: {
        space: {
          deletingAt: null,
          organization: { name: "Acme", logo: "https://tracker.example.test/pixel.png" },
        },
      },
    });
    expect((await readOrganizationMark(db as never, { userId: "u", spaceId: "s" })).logo).toBe(
      null,
    );
    const huge = fakeDb({
      membership: {
        space: {
          deletingAt: null,
          organization: { name: "Acme", logo: `${LOGO}${"A".repeat(200_000)}` },
        },
      },
    });
    expect((await readOrganizationMark(huge as never, { userId: "u", spaceId: "s" })).logo).toBe(
      null,
    );
  });

  it("is refused to someone who is not in the Space, and in a Space being deleted", async () => {
    await expect(
      readOrganizationMark(fakeDb() as never, { userId: "u", spaceId: "s" }),
    ).rejects.toBeInstanceOf(IsolationError);
    const deleting = fakeDb({
      membership: { space: { deletingAt: new Date(), organization: { name: "A", logo: LOGO } } },
    });
    await expect(
      readOrganizationMark(deleting as never, { userId: "u", spaceId: "s" }),
    ).rejects.toBeInstanceOf(IsolationError);
  });
});

describe("an organization's logo in its settings", () => {
  it("may be changed by its owner only: one rule, the role list read whole", async () => {
    const canManage = async (role: string) =>
      (
        await readOrganizationLogo(
          fakeDb({ member: { role, organization: { logo: LOGO } } }) as never,
          {
            userId: "u",
            organizationId: "o",
          },
        )
      ).canManage;
    expect(await canManage("owner")).toBe(true);
    expect(await canManage("member, owner")).toBe(true);
    for (const role of ["admin", "member", "coowner", "superadmin", "owners"])
      expect(await canManage(role), role).toBe(false);
  });

  it("is read only for the organization's own members, never its guests", async () => {
    const db = fakeDb();
    await expect(
      readOrganizationLogo(db as never, { userId: "u", organizationId: "o" }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(db.member.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "u", role: { not: "guest" } }),
      }),
    );
  });
});

describe("changing an organization's logo", () => {
  it("lets the owner change it while their member row is held, and names the Spaces to signal", async () => {
    const db = fakeDb({ role: "owner", updated: 1, spaces: [{ id: "s1" }, { id: "s2" }] });
    await expect(
      setOrganizationLogo(db as never, { userId: "u", organizationId: "o", logo: LOGO }),
    ).resolves.toEqual({ spaceIds: ["s1", "s2"] });
    expect(sqlOf(db)).toMatch(/FROM "member".*FOR SHARE/s);
    const [locked] = db.$queryRaw.mock.calls[0] as [{ values: unknown[] }];
    expect(locked.values).toEqual(["o", "u"]);
    expect(db.organization.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "o" }),
      data: { logo: LOGO },
    });
    const listed = fakeDb({ role: "member,owner", updated: 1 });
    await setOrganizationLogo(listed as never, { userId: "u", organizationId: "o", logo: null });
    expect(listed.organization.updateMany).toHaveBeenCalled();
  });

  it("changes nothing for a role that only looks like the owner's, nor for anyone without one", async () => {
    for (const role of ["coowner", "superadmin", "admin", "guest", "owners", undefined]) {
      const db = fakeDb({ role, updated: 1 });
      await expect(
        setOrganizationLogo(db as never, { userId: "u", organizationId: "o", logo: null }),
        String(role),
      ).rejects.toBeInstanceOf(IsolationError);
      expect(db.organization.updateMany).not.toHaveBeenCalled();
    }
  });

  it("changes nothing in an organization being deleted", async () => {
    const db = fakeDb({ role: "owner", updated: 0 });
    await expect(
      setOrganizationLogo(db as never, { userId: "u", organizationId: "o", logo: null }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(db.space.findMany).not.toHaveBeenCalled();
  });
});
