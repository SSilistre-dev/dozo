import { describe, expect, it, vi } from "vitest";
import {
  managesOrganizationLook,
  readOrganizationLogo,
  readOrganizationMark,
  setOrganizationLogo,
} from "./dozo-organization-logo.js";
import { IsolationError } from "./scope.js";

const LOGO = "data:image/webp;base64,UklGRg==";

function fakeDb(
  rows: {
    membership?: unknown;
    member?: unknown;
    updated?: number;
    spaces?: Array<{ id: string }>;
  } = {},
) {
  return {
    spaceMember: { findUnique: vi.fn(async () => rows.membership ?? null) },
    member: { findFirst: vi.fn(async () => rows.member ?? null) },
    organization: { updateMany: vi.fn(async () => ({ count: rows.updated ?? 0 })) },
    space: { findMany: vi.fn(async () => rows.spaces ?? []) },
  };
}

describe("who manages how an organization looks", () => {
  it("is its owner or an admin, never a member or a guest", () => {
    expect(managesOrganizationLook("owner")).toBe(true);
    expect(managesOrganizationLook("member, admin")).toBe(true);
    expect(managesOrganizationLook("member")).toBe(false);
    expect(managesOrganizationLook("guest")).toBe(false);
    expect(managesOrganizationLook("superadmin")).toBe(false);
  });
});

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
  it("says whether the member may change it", async () => {
    const owner = fakeDb({ member: { role: "owner", organization: { logo: LOGO } } });
    await expect(
      readOrganizationLogo(owner as never, { userId: "u", organizationId: "o" }),
    ).resolves.toEqual({ logo: LOGO, canManage: true });
    const member = fakeDb({ member: { role: "member", organization: { logo: null } } });
    await expect(
      readOrganizationLogo(member as never, { userId: "u", organizationId: "o" }),
    ).resolves.toEqual({ logo: null, canManage: false });
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
  it("checks the role in the same statement and names the Spaces to signal", async () => {
    const db = fakeDb({ updated: 1, spaces: [{ id: "s1" }, { id: "s2" }] });
    await expect(
      setOrganizationLogo(db as never, { userId: "u", organizationId: "o", logo: LOGO }),
    ).resolves.toEqual({ spaceIds: ["s1", "s2"] });
    expect(db.organization.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "o",
        members: {
          some: {
            userId: "u",
            OR: [{ role: { contains: "owner" } }, { role: { contains: "admin" } }],
          },
        },
      }),
      data: { logo: LOGO },
    });
  });

  it("changes nothing for anyone else", async () => {
    const db = fakeDb({ updated: 0 });
    await expect(
      setOrganizationLogo(db as never, { userId: "u", organizationId: "o", logo: null }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(db.space.findMany).not.toHaveBeenCalled();
  });
});
