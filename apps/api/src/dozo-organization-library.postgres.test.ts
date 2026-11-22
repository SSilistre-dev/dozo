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
import { createDb, IsolationError, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentSkillsService } from "./agent-skills.js";
import { dozoOrganizationLibraryRoutes } from "./dozo-organization-library.js";
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
    expect(await library(actorIn(acmeHome, owner)).get()).toEqual({ skillIds: [], canShare: true });
    // A lone owner has nobody to share with, so the switch is not offered.
    expect(await library(actorIn(otherHome, stranger)).get()).toEqual({
      skillIds: [],
      canShare: false,
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
  });
});
