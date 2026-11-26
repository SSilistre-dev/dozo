import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import {
  listAgentSkillRecords,
  skillDeleteFromTool,
  skillReadFromTool,
  skillUpdateFromTool,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  createDb,
  IsolationError,
  isOwnerRole,
  rehomeSharedItems,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentSkillsService } from "./bots/agent-skills.js";
import {
  BUILTIN_SKILL_NAMES,
  dozoAfterLibraryChange,
  dozoOrganizationLibraryRoutes,
} from "./dozo-organization-library.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

// Runs on the branded tree only, with the runtime login, so row-level security applies exactly as
// in a deployment. The fork's unit gate has no database and skips it.
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("organization skill library (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const suffix = randomUUID().slice(0, 8);
  const id = (name: string) => `lib-${name}-${suffix}`;
  // Acme: its owner, a guest invited to its shared Space, and a guest who will leave. Other: a
  // stranger who owns another organization.
  const acme = id("acme");
  const other = id("other");
  const [owner, guest, departed, stranger] = ["owner", "guest", "departed", "stranger"].map(id) as [
    string,
    string,
    string,
    string,
  ];
  const acmeHome = id("acme-home");
  const acmeShared = id("acme-shared");
  const otherHome = id("other-home");
  const actorIn = (spaceId: string, userId: string): Actor => ({
    spaceId,
    userId,
    email: `${userId}@example.test`,
    isDeploymentOwner: false,
  });
  const skills = () => createAgentSkillsService(prisma);
  const publishRosterChange = vi.fn(async () => undefined);
  const library = (actor: Actor) =>
    createRouterClient(
      dozoOrganizationLibraryRoutes(
        createRouterContext({
          prisma,
          events: {
            notify: () => undefined,
            publishSpaceChange: () => undefined,
            publishRosterChange,
          },
          env: {},
        } as unknown as RouterDeps),
      ),
      { context: { actor } },
    ).dozoOrganizationLibrary;
  /** The user skills a person's skills page lists, as `name` or `name (read only)`. */
  const listed = (actor: Actor) =>
    runAsTenant(actor, async () =>
      (await skills().list(actor))
        .filter((skill) => skill.source === "user")
        .map((skill) => `${skill.name}${skill.readOnly ? " (read only)" : ""}`),
    );
  /** The skill names in a bot's catalog for a run of this person in this Space. */
  const catalog = (actor: Actor) =>
    runAsTenant(actor, async () =>
      (await listAgentSkillRecords(prisma, actor))
        .filter((skill) => skill.source === "user")
        .map((skill) => skill.name),
    );
  /** Every agent_skills row the database itself lets this tenant read, with no app filter. */
  const visibleRows = (actor: Actor) =>
    runAsTenant(actor, async () =>
      (await prisma.agentSkill.findMany({ select: { name: true } })).map((row) => row.name),
    );
  const refused = async (call: Promise<unknown>) =>
    call.then(
      () => "allowed",
      (error: unknown) => (error instanceof IsolationError ? "refused" : String(error)),
    );

  let expenses: string;
  let notes: string;
  let pluginSkill: string;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    await runAsSystem("library fixture", async () => {
      for (const user of [owner, guest, departed, stranger])
        await prisma.user.create({
          data: { id: user, name: user, email: `${user}@example.test`, emailVerified: false },
        });
      for (const [org, name] of [
        [acme, "Acme"],
        [other, "Other"],
      ] as const)
        await prisma.organization.create({
          data: { id: org, name, slug: org, createdAt: new Date() },
        });
      await prisma.space.create({
        data: { id: acmeHome, organizationId: acme, name: "Home", isDefault: true },
      });
      await prisma.space.create({ data: { id: acmeShared, organizationId: acme, name: "Shared" } });
      await prisma.space.create({
        data: { id: otherHome, organizationId: other, name: "Home", isDefault: true },
      });
      const member = (organizationId: string, userId: string, role: string) =>
        prisma.member.create({
          data: { id: id(`m-${userId}`), organizationId, userId, role, createdAt: new Date() },
        });
      // A new member joins its organization's default Space by a trigger; guests are then moved
      // to the one Space they were invited to, as an invite does.
      await member(acme, owner, "owner");
      await member(other, stranger, "owner");
      for (const user of [guest, departed]) {
        await member(acme, user, "guest");
        await prisma.spaceMember.deleteMany({ where: { userId: user, spaceId: acmeHome } });
        await prisma.spaceMember.create({
          data: {
            id: id(`sm-${user}`),
            spaceId: acmeShared,
            organizationId: acme,
            userId: user,
            createdAt: new Date(),
          },
        });
      }
      await prisma.spaceMember.upsert({
        where: { spaceId_userId: { spaceId: acmeShared, userId: owner } },
        create: {
          id: id("sm-owner-shared"),
          spaceId: acmeShared,
          organizationId: acme,
          userId: owner,
          role: "owner",
          createdAt: new Date(),
        },
        update: {},
      });
    });
    const create = (name: string) =>
      runAsTenant(actorIn(acmeHome, owner), () =>
        skills().create(actorIn(acmeHome, owner), { name, description: `How to do ${name}` }),
      );
    expenses = (await create("expenses")).id;
    notes = (await create("private-notes")).id;
    pluginSkill = (await create("plugin-thing")).id;
    await runAsSystem("library fixture", async () => {
      // Reference files beside the text, as a plugin or GitHub skill has them.
      await prisma.agentSkill.update({
        where: { id: expenses },
        data: { files: { "receipts.md": "Keep every receipt." } },
      });
      await prisma.agentSkill.update({ where: { id: pluginSkill }, data: { source: "plugin" } });
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await runAsSystem("library fixture", async () => {
      await prisma.organization.deleteMany({ where: { id: { in: [acme, other] } } });
      await prisma.user.deleteMany({ where: { id: { in: [owner, guest, departed, stranger] } } });
    });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("shows nothing of the owner's skills to anyone else until one is put in the library", async () => {
    expect(await listed(actorIn(acmeShared, guest))).toEqual([]);
    expect(await visibleRows(actorIn(acmeShared, guest))).toEqual([]);
    expect(await library(actorIn(acmeHome, owner)).get()).toEqual({
      skillIds: [],
      canShare: true,
      hidden: [],
    });
    // A lone owner has nobody to share with, so the switch is not offered.
    expect(await library(actorIn(otherHome, stranger)).get()).toEqual({
      skillIds: [],
      canShare: false,
      hidden: [],
    });
  });

  it("lets only the owner put a skill they wrote in, and signals every Space of the organization", async () => {
    expect(
      await refused(library(actorIn(acmeShared, guest)).share({ skillId: expenses, shared: true })),
    ).toBe("refused");
    expect(
      await refused(
        library(actorIn(otherHome, stranger)).share({ skillId: expenses, shared: true }),
      ),
    ).toBe("refused");
    // A plugin's skill comes with the owner's install, so it never goes in.
    expect(
      await refused(
        library(actorIn(acmeHome, owner)).share({ skillId: pluginSkill, shared: true }),
      ),
    ).toBe("refused");
    expect(publishRosterChange).not.toHaveBeenCalled();
    expect(
      await library(actorIn(acmeHome, owner)).share({ skillId: expenses, shared: true }),
    ).toEqual({
      skillIds: [expenses],
      canShare: true,
      hidden: [],
    });
    expect(publishRosterChange).toHaveBeenCalledWith({
      spaceIds: expect.arrayContaining([acmeHome, acmeShared]),
    });
  });

  it("gives every member of its Spaces the skill's text and files, read only, and nothing else of the owner's", async () => {
    const member = actorIn(acmeShared, guest);
    expect(await listed(member)).toEqual(["expenses (read only)"]);
    expect(await catalog(member)).toEqual(["expenses"]);
    // The database itself shows the guest that one row, not the owner's other skills.
    expect(await visibleRows(member)).toEqual(["expenses"]);
    const opened = await runAsTenant(member, () => skills().get(member, { skillId: expenses }));
    expect(opened).toMatchObject({ name: "expenses", readOnly: true });
    expect(opened.availability).toBeUndefined();
    expect(
      await runAsTenant(member, () =>
        skillReadFromTool(prisma, member, { name: "expenses", file: "receipts.md" }),
      ),
    ).toEqual({
      name: "expenses",
      file: "receipts.md",
      content: "Keep every receipt.",
    });
    expect(await refused(runAsTenant(member, () => skills().get(member, { skillId: notes })))).toBe(
      "refused",
    );
  });

  it("never lets a member change or remove it, through the app or a bot", async () => {
    const member = actorIn(acmeShared, guest);
    expect(
      await refused(
        runAsTenant(member, () => skills().update(member, { skillId: expenses, body: "Mine now" })),
      ),
    ).toBe("refused");
    expect(await refused(runAsTenant(member, () => skills().remove(member, expenses)))).toBe(
      "refused",
    );
    expect(
      await runAsTenant(member, () =>
        skillUpdateFromTool(prisma, member, { name: "expenses", body: "Mine now" }),
      ),
    ).toHaveProperty("error");
    expect(
      await runAsTenant(member, () => skillDeleteFromTool(prisma, member, { name: "expenses" })),
    ).toHaveProperty("error");
    const kept = await runAsSystem("check", () =>
      prisma.agentSkill.findUniqueOrThrow({ where: { id: expenses }, select: { content: true } }),
    );
    expect(kept.content).not.toContain("Mine now");
  });

  it("stays inside its organization", async () => {
    const outsider = actorIn(otherHome, stranger);
    expect(await listed(outsider)).toEqual([]);
    expect(await catalog(outsider)).toEqual([]);
    expect(await visibleRows(outsider)).toEqual([]);
    expect(
      await refused(runAsTenant(outsider, () => skills().get(outsider, { skillId: expenses }))),
    ).toBe("refused");
    // Naming a Space of Acme is not enough without being its member.
    expect(await visibleRows(actorIn(acmeShared, stranger))).toEqual([]);
    expect(await library(actorIn(acmeShared, stranger)).get()).toEqual({
      skillIds: [],
      canShare: false,
      hidden: [],
    });
  });

  it("is gone for a member the moment they leave", async () => {
    const leaving = actorIn(acmeShared, departed);
    expect(await catalog(leaving)).toEqual(["expenses"]);
    await runAsSystem("leave", async () => {
      await prisma.spaceMember.deleteMany({ where: { userId: departed } });
      await prisma.member.deleteMany({ where: { userId: departed } });
    });
    expect(await listed(leaving)).toEqual([]);
    expect(await catalog(leaving)).toEqual([]);
    expect(await visibleRows(leaving)).toEqual([]);
  });

  it("gives way to a member's own skill of the same name", async () => {
    const member = actorIn(acmeShared, guest);
    await runAsTenant(member, () =>
      skills().create(member, { name: "expenses", description: "My own way" }),
    );
    expect(await listed(member)).toEqual(["expenses"]);
    const own = await runAsTenant(member, () => skills().get(member, { name: "expenses" }));
    expect(own).toMatchObject({ description: "My own way", readOnly: false });
  });

  it("leaves the library when the owner takes it out or deletes the skill", async () => {
    const reader = actorIn(acmeShared, owner);
    await library(actorIn(acmeHome, owner)).share({ skillId: notes, shared: true });
    await library(actorIn(acmeHome, owner)).share({ skillId: notes, shared: false });
    expect((await library(reader).get()).skillIds).toEqual([expenses]);
    await runAsTenant(actorIn(acmeHome, owner), () =>
      skills().remove(actorIn(acmeHome, owner), expenses),
    );
    expect((await library(reader).get()).skillIds).toEqual([]);
    expect(await catalog(actorIn(acmeShared, guest))).toEqual(["expenses"]);
    expect(await listed(actorIn(acmeShared, guest))).toEqual(["expenses"]);
  });

  it("never moves a skill from one organization's library to another's", async () => {
    const both = await runAsTenant(actorIn(acmeHome, owner), () =>
      skills().create(actorIn(acmeHome, owner), { name: "two-libraries", description: "Both" }),
    );
    await library(actorIn(acmeHome, owner)).share({ skillId: both.id, shared: true });
    // The same person also owns Other, and opens its Space.
    await runAsSystem("second organization", async () => {
      await prisma.member.create({
        data: {
          id: id("m-owner-other"),
          organizationId: other,
          userId: owner,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await prisma.spaceMember.upsert({
        where: { spaceId_userId: { spaceId: otherHome, userId: owner } },
        create: {
          id: id("sm-owner-other"),
          spaceId: otherHome,
          organizationId: other,
          userId: owner,
          createdAt: new Date(),
        },
        update: {},
      });
    });
    const fromOther = library(actorIn(otherHome, owner));
    await expect(fromOther.share({ skillId: both.id, shared: true })).rejects.toMatchObject({
      kind: "CONFLICT",
    });
    await fromOther.share({ skillId: both.id, shared: false });
    expect((await library(actorIn(acmeShared, guest)).get()).skillIds).toContain(both.id);
    expect(await catalog(actorIn(acmeShared, guest))).toContain("two-libraries");
    expect(await catalog(actorIn(otherHome, stranger))).not.toContain("two-libraries");

    // Shared from both at once: one library gets it, the other caller is told so.
    const race = await runAsTenant(actorIn(acmeHome, owner), () =>
      skills().create(actorIn(acmeHome, owner), { name: "race", description: "Both at once" }),
    );
    const outcomes = await Promise.allSettled([
      library(actorIn(acmeHome, owner)).share({ skillId: race.id, shared: true }),
      library(actorIn(otherHome, owner)).share({ skillId: race.id, shared: true }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const lost = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ kind: "CONFLICT" });
    // Twice into the same library is simply done.
    const twice = await runAsTenant(actorIn(acmeHome, owner), () =>
      skills().create(actorIn(acmeHome, owner), { name: "twice", description: "Same library" }),
    );
    const same = await Promise.all([
      library(actorIn(acmeHome, owner)).share({ skillId: twice.id, shared: true }),
      library(actorIn(acmeShared, owner)).share({ skillId: twice.id, shared: true }),
    ]);
    for (const result of same) expect(result.skillIds).toContain(twice.id);
  });

  it("reads the owner role in SQL exactly as isOwnerRole does", async () => {
    const roles = [
      "owner",
      "member,owner",
      "member, owner",
      " owner ",
      "admin",
      "coowner",
      "owners",
      "guest",
      "",
    ];
    const answers = await runAsSystem("owner role parity", () =>
      Promise.all(
        roles.map(async (role) => {
          const [{ owner: answer }] = await prisma.$queryRaw<[{ owner: boolean }]>`
            SELECT dozo_is_owner_role(${role}) AS "owner"`;
          return answer;
        }),
      ),
    );
    expect(answers).toEqual(roles.map(isOwnerRole));
  });
});

describe.skipIf(!enabled)("organization skill library, while things change (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const suffix = randomUUID().slice(0, 8);
  const id = (name: string) => `libc-${name}-${suffix}`;
  // Gamma: its owner, who shares; two guests of its team Space. The first guest owns an
  // organization of their own too.
  const gamma = id("gamma");
  const guestOwn = id("guest-own");
  const [owner, guest, other] = ["owner", "guest", "other"].map(id) as [string, string, string];
  const home = id("home");
  const team = id("team");
  const guestHome = id("guest-home");
  const actorIn = (spaceId: string, userId: string): Actor => ({
    spaceId,
    userId,
    email: `${userId}@example.test`,
    isDeploymentOwner: false,
  });
  const skills = () => createAgentSkillsService(prisma);
  const publishRosterChange = vi.fn(async () => undefined);
  const events = {
    notify: () => undefined,
    publishSpaceChange: () => undefined,
    publishRosterChange,
  };
  const library = (actor: Actor) =>
    createRouterClient(
      dozoOrganizationLibraryRoutes(
        createRouterContext({ prisma, events, env: {} } as unknown as RouterDeps),
      ),
      { context: { actor } },
    ).dozoOrganizationLibrary;
  const catalog = (actor: Actor) =>
    runAsTenant(actor, async () =>
      (await listAgentSkillRecords(prisma, actor)).map((skill) => `${skill.source}:${skill.name}`),
    );
  const listed = (actor: Actor) =>
    runAsTenant(actor, async () =>
      (await skills().list(actor)).map((skill) => `${skill.source}:${skill.name}`),
    );
  const visibleRows = (actor: Actor) =>
    runAsTenant(actor, async () =>
      (await prisma.agentSkill.findMany({ select: { name: true } })).map((row) => row.name),
    );
  /** What the guest of the team Space reads of the playbook, everywhere a member reads skills. */
  const guestReads = async () => {
    const member = actorIn(team, guest);
    return {
      catalog: (await catalog(member)).includes("user:playbook"),
      listed: (await listed(member)).includes("user:playbook"),
      database: (await visibleRows(member)).includes("playbook"),
    };
  };
  const READS = { catalog: true, listed: true, database: true };
  const NOTHING = { catalog: false, listed: false, database: false };
  let playbook: string;

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    await runAsSystem("library fixture", async () => {
      for (const user of [owner, guest, other])
        await prisma.user.create({
          data: { id: user, name: user, email: `${user}@example.test`, emailVerified: false },
        });
      for (const [org, name] of [
        [gamma, "Gamma"],
        [guestOwn, "Guest's own"],
      ] as const)
        await prisma.organization.create({
          data: { id: org, name, slug: org, createdAt: new Date() },
        });
      await prisma.space.create({
        data: { id: home, organizationId: gamma, name: "Home", isDefault: true },
      });
      await prisma.space.create({ data: { id: team, organizationId: gamma, name: "Team" } });
      await prisma.space.create({
        data: { id: guestHome, organizationId: guestOwn, name: "Home", isDefault: true },
      });
      const join = (spaceId: string, organizationId: string, userId: string) =>
        prisma.spaceMember.upsert({
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
      await prisma.member.create({
        data: {
          id: id("m-owner"),
          organizationId: gamma,
          userId: owner,
          role: "owner",
          createdAt: new Date(),
        },
      });
      await join(team, gamma, owner);
      for (const user of [guest, other]) {
        await prisma.member.create({
          data: {
            id: id(`m-${user}`),
            organizationId: gamma,
            userId: user,
            role: "guest",
            createdAt: new Date(),
          },
        });
        await prisma.spaceMember.deleteMany({ where: { userId: user, spaceId: home } });
        await join(team, gamma, user);
      }
      await prisma.member.create({
        data: {
          id: id("m-guest-own"),
          organizationId: guestOwn,
          userId: guest,
          role: "owner",
          createdAt: new Date(),
        },
      });
    });
    // Written in the owner's home Space, so the database shows it in the team Space only through
    // the library (a skill added in a Space is that Space's rows too).
    playbook = (
      await runAsTenant(actorIn(home, owner), () =>
        skills().create(actorIn(home, owner), { name: "playbook", description: "How we work" }),
      )
    ).id;
    await library(actorIn(team, owner)).share({ skillId: playbook, shared: true });
  });

  afterAll(async () => {
    if (!prisma) return;
    await runAsSystem("library fixture", async () => {
      await prisma.organization.deleteMany({ where: { id: { in: [gamma, guestOwn] } } });
      await prisma.agentSkill.deleteMany({ where: { userId: { in: [owner, guest, other] } } });
      await prisma.user.deleteMany({ where: { id: { in: [owner, guest, other] } } });
    });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("is read in the organization's Spaces only, never in a guest's own organization", async () => {
    expect(await guestReads()).toEqual(READS);
    const inOwn = actorIn(guestHome, guest);
    expect(await catalog(inOwn)).not.toContain("user:playbook");
    expect(await visibleRows(inOwn)).not.toContain("playbook");
    expect((await library(inOwn).get()).skillIds).toEqual([]);
  });

  it("can be turned off by a member for their own bots alone, and back on", async () => {
    const member = actorIn(team, guest);
    await library(member).hide({ skillId: playbook, hidden: true });
    expect(await catalog(member)).not.toContain("user:playbook");
    expect(await listed(member)).not.toContain("user:playbook");
    expect(
      await runAsTenant(member, () => skillReadFromTool(prisma, member, { name: "playbook" })),
    ).toHaveProperty("error");
    expect((await library(member).get()).hidden).toEqual([
      { id: playbook, name: "playbook", description: "How we work" },
    ]);
    // Another member still reads it.
    expect(await catalog(actorIn(team, other))).toContain("user:playbook");
    await library(member).hide({ skillId: playbook, hidden: false });
    expect(await catalog(member)).toContain("user:playbook");
  });

  it("never stands in for a built-in skill: refused when shared, and given way to when renamed later", async () => {
    const builtin = BUILTIN_SKILL_NAMES[0]!;
    const named = await runAsTenant(actorIn(team, owner), () =>
      skills().create(actorIn(team, owner), { name: `${builtin}-draft`, description: "A draft" }),
    );
    await runAsSystem("rename", () =>
      prisma.agentSkill.update({ where: { id: named.id }, data: { name: builtin.toUpperCase() } }),
    );
    await expect(
      library(actorIn(team, owner)).share({ skillId: named.id, shared: true }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
    });
    // Shared under another name, then renamed to the built-in's: the built-in still answers.
    await runAsSystem("rename back", () =>
      prisma.agentSkill.update({ where: { id: named.id }, data: { name: `${builtin}-draft` } }),
    );
    await library(actorIn(team, owner)).share({ skillId: named.id, shared: true });
    await runAsSystem("rename to the built-in's", () =>
      prisma.agentSkill.update({ where: { id: named.id }, data: { name: builtin } }),
    );
    const member = actorIn(team, guest);
    const sameName = (entries: string[]) =>
      entries.filter((entry) => entry.endsWith(`:${builtin}`));
    expect(sameName(await catalog(member))).toEqual([`builtin:${builtin}`]);
    expect(sameName(await listed(member))).toEqual([`builtin:${builtin}`]);
    // The owner's own skill of that name is theirs to keep, as before.
    expect(sameName(await catalog(actorIn(team, owner)))).toEqual([`user:${builtin}`]);
    await library(actorIn(team, owner)).share({ skillId: named.id, shared: false });
  });

  it("never stands in for a built-in skill under a padded name, shared, renamed or imported", async () => {
    const builtin = BUILTIN_SKILL_NAMES[0]!;
    const member = actorIn(team, guest);
    const sameName = (entries: string[]) =>
      entries.filter(
        (entry) =>
          entry.split(":").slice(1).join(":").trim().toLowerCase() === builtin.toLowerCase(),
      );
    const ownerInTeam = actorIn(team, owner);
    for (const padded of [
      `${builtin} `,
      ` ${builtin.toLowerCase()}`,
      `${builtin}\u00a0`,
      `\t${builtin}`,
    ]) {
      const skill = await runAsTenant(ownerInTeam, () =>
        skills().create(ownerInTeam, {
          name: `padded-${randomUUID().slice(0, 6)}`,
          description: "Padded",
        }),
      );
      // The name as a write that does not trim it leaves it (the account import keeps names as given).
      await runAsSystem("pad the name", () =>
        prisma.agentSkill.update({ where: { id: skill.id }, data: { name: padded } }),
      );
      await expect(
        library(ownerInTeam).share({ skillId: skill.id, shared: true }),
        JSON.stringify(padded),
      ).rejects.toMatchObject({ kind: "CONFLICT" });
    }
    // Shared under another name, then renamed to the built-in's padded with a tab.
    const later = await runAsTenant(ownerInTeam, () =>
      skills().create(ownerInTeam, { name: "renamed-later", description: "Renamed" }),
    );
    await library(ownerInTeam).share({ skillId: later.id, shared: true });
    await runAsSystem("rename", () =>
      prisma.agentSkill.update({ where: { id: later.id }, data: { name: `\t${builtin} ` } }),
    );
    expect(sameName(await catalog(member))).toEqual([`builtin:${builtin}`]);
    expect(sameName(await listed(member))).toEqual([`builtin:${builtin}`]);
    await library(ownerInTeam).share({ skillId: later.id, shared: false });
    // A skill written as the account import writes one: in the imported Space, its name as given.
    const imported = randomUUID();
    await runAsSystem("import", () =>
      prisma.agentSkill.create({
        data: {
          id: imported,
          spaceId: team,
          userId: owner,
          name: `\u3000${builtin}\n`,
          description: "Imported",
          content: "Imported text",
          source: "user",
          allSpaces: false,
        },
      }),
    );
    await expect(
      library(ownerInTeam).share({ skillId: imported, shared: true }),
    ).rejects.toMatchObject({
      kind: "CONFLICT",
    });
    await runAsSystem("clean up", () => prisma.agentSkill.delete({ where: { id: imported } }));
  });

  it("signals its organization's Spaces when the owner changes the skill, and nothing for one in no library", async () => {
    publishRosterChange.mockClear();
    const ownerActor = actorIn(team, owner);
    await dozoAfterLibraryChange({ prisma, events } as never, playbook, () =>
      runAsTenant(ownerActor, () =>
        skills().update(ownerActor, { skillId: playbook, body: "The new way" }),
      ),
    );
    expect(publishRosterChange).toHaveBeenCalledWith({
      spaceIds: expect.arrayContaining([home, team]),
    });
    publishRosterChange.mockClear();
    const loose = await runAsTenant(ownerActor, () =>
      skills().create(ownerActor, { name: "loose", description: "In no library" }),
    );
    await dozoAfterLibraryChange({ prisma, events } as never, loose.id, () =>
      runAsTenant(ownerActor, () => skills().remove(ownerActor, loose.id)),
    );
    expect(publishRosterChange).not.toHaveBeenCalled();
  });

  it("stops being read the moment its sharer no longer owns the organization, and again when they do", async () => {
    const setRole = (role: string) =>
      runAsSystem("role", () =>
        prisma.member.updateMany({
          where: { organizationId: gamma, userId: owner },
          data: { role },
        }),
      );
    for (const role of ["member", "admin", "coowner", "guest"]) {
      await setRole(role);
      expect(await guestReads(), role).toEqual(NOTHING);
    }
    await setRole("member,owner");
    expect(await guestReads()).toEqual(READS);
    await setRole("owner");
  });

  it("stops being read when its sharer is removed from the organization", async () => {
    await runAsSystem("remove", () =>
      prisma.member.deleteMany({ where: { organizationId: gamma, userId: owner } }),
    );
    expect(await guestReads()).toEqual(NOTHING);
    await runAsSystem("restore", () =>
      prisma.member.create({
        data: {
          id: id("m-owner-again"),
          organizationId: gamma,
          userId: owner,
          role: "owner",
          createdAt: new Date(),
        },
      }),
    );
    expect(await guestReads()).toEqual(READS);
  });

  it("is still the owner's skill, still read, once it moves to another of their Spaces", async () => {
    const ownerInTeam = actorIn(team, owner);
    const moving = await runAsTenant(ownerInTeam, () =>
      skills().create(ownerInTeam, { name: "moving", description: "Moves home" }),
    );
    await library(ownerInTeam).share({ skillId: moving.id, shared: true });
    // The owner leaves the team Space: what they made available elsewhere moves to their home.
    await runAsSystem("leave the team Space", () =>
      prisma.$transaction((tx) => rehomeSharedItems(tx, { spaceId: team, userId: owner })),
    );
    const moved = await runAsSystem("check", () =>
      prisma.agentSkill.findUniqueOrThrow({
        where: { id: moving.id },
        select: { spaceId: true, userId: true },
      }),
    );
    expect(moved).toEqual({ spaceId: home, userId: owner });
    const member = actorIn(team, guest);
    expect(await catalog(member)).toContain("user:moving");
    expect(await listed(member)).toContain("user:moving");
    expect(await visibleRows(member)).toContain("moving");
    expect(await guestReads()).toEqual(READS);
  });

  it("stops being read when its sharer's account is deleted", async () => {
    await runAsSystem("delete the account", () => prisma.user.delete({ where: { id: owner } }));
    // The skill now lives in the team Space (moved above), whose own rows the database shows its
    // members as before; what reads it as a skill is the app, and the library has nothing.
    const reads = await guestReads();
    expect({ catalog: reads.catalog, listed: reads.listed }).toEqual({
      catalog: false,
      listed: false,
    });
    expect((await library(actorIn(team, guest)).get()).skillIds).toEqual([]);
    const row = await runAsSystem(
      "check",
      () =>
        prisma.$queryRaw<Array<{ sharedById: string | null }>>`
        SELECT "sharedById" FROM "dozo_organization_skills" WHERE "skillId" = ${playbook}`,
    );
    expect(row).toEqual(row.length ? [{ sharedById: null }] : []);
  });
});
