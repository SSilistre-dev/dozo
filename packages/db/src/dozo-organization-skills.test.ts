import { describe, expect, it, vi } from "vitest";
import {
  hideLibrarySkill,
  libraryReaderSpaces,
  organizationLibrarySkillIds,
  organizationLibrarySql,
  preferOwnSkills,
  readOrganizationLibrary,
  SkillInAnotherLibraryError,
  SkillNamedLikeBuiltinError,
  shareSkillWithOrganization,
  skillsReadableInSpace,
} from "./dozo-organization-skills.js";
import { IsolationError } from "./database/scope.js";

const scope = { spaceId: "space-1", userId: "user-1" };

type Sql = { strings: string[]; values: unknown[] };
const text = (sql: Sql) => sql.strings.join("?").replace(/\s+/g, " ");

type Row = { skillId: string; name: string; description: string; hidden: boolean };

/** A transaction answering the member read with `role`, the library read with `library`. */
function fakeDb(
  options: {
    role?: string;
    library?: Row[];
    others?: number;
    skill?: { id: string; name: string } | null;
    /** The organization whose library holds the skill once the insert has run. */
    heldBy?: string | null;
  } = {},
) {
  const statements: Sql[] = [];
  const tx = {
    $queryRaw: vi.fn(async (sql: Sql) => {
      statements.push(sql);
      const query = text(sql);
      if (query.includes('FROM "member" m'))
        return options.role === undefined ? [] : [{ organizationId: "org-1", role: options.role }];
      if (query.includes("count(*)")) return [{ others: options.others ?? 0 }];
      if (query.startsWith(' SELECT "organizationId" FROM "dozo_organization_skills"'))
        return options.heldBy === null ? [] : [{ organizationId: options.heldBy ?? "org-1" }];
      return options.library ?? [];
    }),
    $executeRaw: vi.fn(async (sql: Sql) => {
      statements.push(sql);
      return 1;
    }),
    agentSkill: {
      findFirst: vi.fn(async () =>
        options.skill === undefined ? { id: "skill-1", name: "Expenses" } : options.skill,
      ),
    },
    space: { findMany: vi.fn(async () => [{ id: "space-1" }, { id: "space-2" }]) },
  };
  const db = { ...tx, $transaction: vi.fn(async (work: (t: typeof tx) => unknown) => work(tx)) };
  return { db, tx, statements };
}

const row = (skillId: string, hidden = false): Row => ({
  skillId,
  name: `name-${skillId}`,
  description: "d",
  hidden,
});

describe("the organization library read", () => {
  it("holds every condition on each read, the sharer's ownership included", () => {
    const sql = organizationLibrarySql(scope);
    const query = text(sql);
    for (const condition of [
      'JOIN "agent_skills" k ON k."id" = l."skillId" AND k."source" = \'user\' AND k."userId" = l."sharedById"',
      'JOIN "spaces" s ON s."organizationId" = l."organizationId" AND s."id" = ? AND s."deletingAt" IS NULL',
      'JOIN "space_members" m ON m."spaceId" = s."id" AND m."userId" = ?',
      'JOIN "member" o ON o."organizationId" = l."organizationId" AND o."userId" = l."sharedById" AND dozo_is_owner_role(o."role")',
      'WHERE NOT EXISTS ( SELECT 1 FROM "dozo_organization_skill_hides" h WHERE h."skillId" = l."skillId" AND h."userId" = ?)',
    ])
      expect(query).toContain(condition);
    expect(sql.values).toEqual(["user-1", "space-1", "user-1", "user-1"]);
    // Listed with the ones turned off, for the switch that turns them back on.
    expect(text(organizationLibrarySql(scope, "include"))).not.toContain("WHERE NOT");
  });

  it("widens a person's own and their organization's skills with the library's, and nothing else", async () => {
    const { db } = fakeDb({ library: [row("a"), row("b")] });
    expect(await organizationLibrarySkillIds(db as never, scope)).toEqual(["a", "b"]);
    const readable = await skillsReadableInSpace(db as never, scope);
    expect(readable.OR).toHaveLength(3);
    expect(readable.OR[0]).toMatchObject({ userId: "user-1" });
    expect(readable.OR[1]).toHaveProperty("organization");
    expect(readable.OR[2]).toEqual({ source: "user", id: { in: ["a", "b"] } });
  });

  it("lets a person's own skill and a built-in skill win over a library skill of the same name", () => {
    const rows = [
      { id: "a", userId: "owner", name: "Expenses" },
      { id: "b", userId: "user-1", name: "expenses" },
      { id: "c", userId: "owner", name: "Travel" },
      { id: "d", userId: "owner", name: "Remember" },
      { id: "e", userId: "user-1", name: "remember" },
      // An organization's own skill has no owner and is not a library skill.
      { id: "f", userId: null, name: "Expenses" },
    ];
    expect(preferOwnSkills(rows, "user-1", ["Remember"]).map((entry) => entry.id)).toEqual([
      "b",
      "c",
      "e",
      "f",
    ]);
    // Compared as the resolver compares them: padding of any kind is no way around the rule.
    const padded = ["Remember ", " remember", "remember\u00a0", "\tRemember", "remember\n"].map(
      (name, index) => ({ id: `p${index}`, userId: "owner", name }),
    );
    expect(preferOwnSkills(padded, "user-1", [" Remember"])).toEqual([]);
    const ownPadded = [{ id: "o", userId: "owner", name: "\u00a0Expenses " }];
    expect(
      preferOwnSkills(
        [...ownPadded, { id: "m", userId: "user-1", name: "expenses" }],
        "user-1",
        [],
      ),
    ).toEqual([{ id: "m", userId: "user-1", name: "expenses" }]);
  });
});

describe("reading the library", () => {
  it("lists it, with what the member turned off, and offers sharing only to an owner with someone to share with", async () => {
    const member = fakeDb({ role: "guest", library: [row("s1"), row("s2", true)] });
    await expect(readOrganizationLibrary(member.db as never, scope)).resolves.toEqual({
      skillIds: ["s1", "s2"],
      canShare: false,
      hidden: [{ id: "s2", name: "name-s2", description: "d" }],
    });
    const alone = fakeDb({ role: "owner", others: 0 });
    expect((await readOrganizationLibrary(alone.db as never, scope)).canShare).toBe(false);
    const team = fakeDb({ role: "member,owner", others: 2 });
    expect((await readOrganizationLibrary(team.db as never, scope)).canShare).toBe(true);
    const outsider = fakeDb({});
    expect((await readOrganizationLibrary(outsider.db as never, scope)).canShare).toBe(false);
  });
});

describe("putting a skill in the library", () => {
  const share = (db: unknown, shared = true, builtinNames: string[] = []) =>
    shareSkillWithOrganization(db as never, scope, { skillId: "skill-1", shared, builtinNames });

  it("is for the organization's owner, with their member row held, and names the Spaces to signal", async () => {
    const { db, tx, statements } = fakeDb({ role: "owner" });
    await expect(share(db)).resolves.toEqual({ spaceIds: ["space-1", "space-2"] });
    expect(text(statements[0]!)).toContain("FOR SHARE OF m");
    expect(tx.agentSkill.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: "skill-1", source: "user", userId: "user-1" }),
      select: { id: true, name: true },
    });
    const insert = statements.find((sql) => text(sql).includes("INSERT INTO"))!;
    expect(insert.values).toEqual(["skill-1", "org-1", "user-1"]);
  });

  it("takes it out of this organization's library only", async () => {
    const { db, statements } = fakeDb({ role: "owner" });
    await share(db, false);
    const removal = statements.find((sql) => text(sql).includes("DELETE FROM"))!;
    expect(text(removal)).toContain('"organizationId" = ?');
    expect(removal.values).toEqual(["skill-1", "org-1"]);
  });

  it("refuses anyone who is not the owner, and a skill that is not theirs to share", async () => {
    for (const role of ["guest", "admin", "coowner", undefined]) {
      const { db, tx } = fakeDb({ role });
      await expect(share(db)).rejects.toBeInstanceOf(IsolationError);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    }
    const { db, tx } = fakeDb({ role: "owner", skill: null });
    await expect(share(db)).rejects.toBeInstanceOf(IsolationError);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("refuses a skill named like a built-in one, however its name is padded", async () => {
    for (const name of ["Remember", "Remember ", " remember", "remember\u00a0", "\tRemember"]) {
      const { db, tx } = fakeDb({ role: "owner", skill: { id: "skill-1", name } });
      await expect(share(db, true, ["remember"]), JSON.stringify(name)).rejects.toBeInstanceOf(
        SkillNamedLikeBuiltinError,
      );
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    }
  });

  it("tells the caller what happened when the skill is already in a library, a concurrent share's included", async () => {
    const here = fakeDb({ role: "owner", heldBy: "org-1" });
    await expect(share(here.db)).resolves.toEqual({ spaceIds: ["space-1", "space-2"] });
    const elsewhere = fakeDb({ role: "owner", heldBy: "org-2" });
    await expect(share(elsewhere.db)).rejects.toBeInstanceOf(SkillInAnotherLibraryError);
    const gone = fakeDb({ role: "owner", heldBy: null });
    await expect(share(gone.db)).rejects.toBeInstanceOf(SkillInAnotherLibraryError);
  });
});

describe("turning a library skill off for oneself", () => {
  it("is for a library skill the member reads, and only for themselves", async () => {
    const { db, statements } = fakeDb({ library: [row("skill-1")] });
    await hideLibrarySkill(db as never, scope, { skillId: "skill-1", hidden: true });
    const insert = statements.find((sql) => text(sql).includes("INSERT INTO"))!;
    expect(text(insert)).toContain('"dozo_organization_skill_hides"');
    expect(insert.values).toEqual(["skill-1", "user-1"]);
    await hideLibrarySkill(db as never, scope, { skillId: "skill-1", hidden: false });
    const removal = statements.find((sql) => text(sql).includes("DELETE FROM"))!;
    expect(removal.values).toEqual(["skill-1", "user-1"]);
    const outsider = fakeDb({ library: [] });
    await expect(
      hideLibrarySkill(outsider.db as never, scope, { skillId: "skill-1", hidden: true }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(outsider.tx.$executeRaw).not.toHaveBeenCalled();
  });
});

describe("the Spaces to signal after an owner's change", () => {
  it("are the organization's whose library holds the skill, else none", async () => {
    const held = fakeDb({ heldBy: "org-1" });
    expect(await libraryReaderSpaces(held.db as never, "skill-1")).toEqual(["space-1", "space-2"]);
    const free = fakeDb({ heldBy: null });
    expect(await libraryReaderSpaces(free.db as never, "skill-1")).toEqual([]);
  });
});
