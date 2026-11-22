import { describe, expect, it, vi } from "vitest";
import {
  inOrganizationLibrary,
  preferOwnSkills,
  readOrganizationLibrary,
  SkillInAnotherLibraryError,
  shareSkillWithOrganization,
  skillsReadableInSpace,
} from "./dozo-organization-skills.js";
import { IsolationError } from "./scope.js";

const scope = { spaceId: "space-1", userId: "user-1" };

type Sql = { strings: string[]; values: unknown[] };
const text = (sql: Sql) => sql.strings.join("?").replace(/\s+/g, " ");

/** A transaction that answers the member read with `role`, the library with `skillIds`. */
function fakeDb(options: {
  role?: string;
  skillIds?: string[];
  others?: number;
  skill?: boolean;
  /** The organization whose library already holds the skill. */
  sharedIn?: string;
}) {
  const statements: Sql[] = [];
  const tx = {
    $queryRaw: vi.fn(async (sql: Sql) => {
      statements.push(sql);
      const query = text(sql);
      if (query.includes('FROM "member" m'))
        return options.role === undefined ? [] : [{ organizationId: "org-1", role: options.role }];
      if (query.includes("count(*)")) return [{ others: options.others ?? 0 }];
      if (query.includes("FOR UPDATE"))
        return options.sharedIn ? [{ organizationId: options.sharedIn }] : [];
      return (options.skillIds ?? []).map((skillId) => ({ skillId }));
    }),
    $executeRaw: vi.fn(async (sql: Sql) => {
      statements.push(sql);
      return 1;
    }),
    agentSkill: {
      findFirst: vi.fn(async () => (options.skill === false ? null : { id: "skill-1" })),
    },
    space: { findMany: vi.fn(async () => [{ id: "space-1" }, { id: "space-2" }]) },
  };
  const db = { $transaction: vi.fn(async (work: (t: typeof tx) => unknown) => work(tx)) };
  return { db, tx, statements };
}

describe("reading the organization library", () => {
  it("adds the library of the Space's organization, for its members, to a person's own skills", () => {
    expect(inOrganizationLibrary(scope)).toEqual({
      source: "user",
      dozoLibrary: {
        is: {
          organization: {
            spaces: {
              some: {
                id: "space-1",
                deletingAt: null,
                memberships: { some: { userId: "user-1" } },
              },
            },
          },
        },
      },
    });
    const readable = skillsReadableInSpace(scope);
    expect(readable.OR[0]).toMatchObject({ userId: "user-1" });
    expect(readable.OR[1]).toEqual(inOrganizationLibrary(scope));
  });

  it("lets a person's own skill win over a library skill of the same name", () => {
    const rows = [
      { id: "a", userId: "owner", name: "Expenses" },
      { id: "b", userId: "user-1", name: "expenses" },
      { id: "c", userId: "owner", name: "Travel" },
    ];
    expect(preferOwnSkills(rows, "user-1").map((row) => row.id)).toEqual(["b", "c"]);
  });

  it("lists the library to a member, and offers sharing only to an owner with someone to share with", async () => {
    const member = fakeDb({ role: "guest", skillIds: ["s1"] });
    await expect(readOrganizationLibrary(member.db as never, scope)).resolves.toEqual({
      skillIds: ["s1"],
      canShare: false,
    });
    expect(text(member.statements[0]!)).toContain('"space_members"');
    const alone = fakeDb({ role: "owner", others: 0 });
    expect((await readOrganizationLibrary(alone.db as never, scope)).canShare).toBe(false);
    const team = fakeDb({ role: "member,owner", others: 2 });
    expect((await readOrganizationLibrary(team.db as never, scope)).canShare).toBe(true);
    const outsider = fakeDb({});
    expect((await readOrganizationLibrary(outsider.db as never, scope)).canShare).toBe(false);
  });
});

describe("putting a skill in the library", () => {
  it("is for the organization's owner, with their member row held, and names the Spaces to signal", async () => {
    const { db, tx, statements } = fakeDb({ role: "owner" });
    await expect(
      shareSkillWithOrganization(db as never, scope, { skillId: "skill-1", shared: true }),
    ).resolves.toEqual({ spaceIds: ["space-1", "space-2"] });
    expect(text(statements[0]!)).toContain("FOR SHARE OF m");
    expect(tx.agentSkill.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "skill-1", source: "user", userId: "user-1" }),
      select: { id: true },
    });
    const insert = statements.find((sql) => text(sql).includes("INSERT INTO"))!;
    expect(insert.values).toEqual(["skill-1", "org-1", "user-1"]);
  });

  it("takes it out again", async () => {
    const { db, statements } = fakeDb({ role: "owner" });
    await shareSkillWithOrganization(db as never, scope, { skillId: "skill-1", shared: false });
    const removal = statements.find((sql) => text(sql).includes("DELETE FROM"))!;
    expect(text(removal)).toContain('"organizationId" = ?');
    expect(removal.values).toEqual(["skill-1", "org-1"]);
  });

  it("refuses anyone who is not the owner, and a skill that is not theirs to share", async () => {
    for (const role of ["guest", "admin", "coowner", undefined]) {
      const { db, tx } = fakeDb({ role });
      await expect(
        shareSkillWithOrganization(db as never, scope, { skillId: "skill-1", shared: true }),
      ).rejects.toBeInstanceOf(IsolationError);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    }
    const { db, tx } = fakeDb({ role: "owner", skill: false });
    await expect(
      shareSkillWithOrganization(db as never, scope, { skillId: "skill-1", shared: true }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("never moves a skill out of another organization's library, nor takes it out from there", async () => {
    const elsewhere = fakeDb({ role: "owner", sharedIn: "org-2" });
    await expect(
      shareSkillWithOrganization(elsewhere.db as never, scope, {
        skillId: "skill-1",
        shared: true,
      }),
    ).rejects.toBeInstanceOf(SkillInAnotherLibraryError);
    expect(elsewhere.tx.$executeRaw).not.toHaveBeenCalled();
    const already = fakeDb({ role: "owner", sharedIn: "org-1" });
    await shareSkillWithOrganization(already.db as never, scope, {
      skillId: "skill-1",
      shared: true,
    });
    expect(already.tx.$executeRaw).not.toHaveBeenCalled();
    const unshareHere = fakeDb({ role: "owner", sharedIn: "org-2" });
    await shareSkillWithOrganization(unshareHere.db as never, scope, {
      skillId: "skill-1",
      shared: false,
    });
    const removal = unshareHere.statements.find((sql) => text(sql).includes("DELETE FROM"))!;
    expect(removal.values).toEqual(["skill-1", "org-1"]);
  });
});
