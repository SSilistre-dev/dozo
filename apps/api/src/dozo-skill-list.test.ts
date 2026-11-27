import type { Actor } from "@rakazo/contracts";
import { buildSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createAgentSkillsService } from "./bots/agent-skills.js";

const actor: Actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@example.test",
  isDeploymentOwner: false,
};

function skill(id: string, organizationId: string | null) {
  return {
    id,
    spaceId: organizationId ? null : actor.spaceId,
    userId: organizationId ? null : actor.userId,
    organizationId,
    name: "Expenses",
    description: id,
    content: buildSkillMd({ name: "Expenses", description: id, body: "Steps." }),
    source: "user",
    allSpaces: false,
    availableIn: [] as { spaceId: string }[],
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/** A person with a skill of their own and an organization skill of the same name, as `role`. */
function serviceAs(role: string) {
  const rows = [skill("own", null), skill("organization", "org-1")];
  const prisma = {
    agentSkill: { findMany: vi.fn(async () => rows.map((row) => ({ ...row }))) },
    space: { findUnique: vi.fn(async () => ({ organizationId: "org-1" })) },
    member: { findFirst: vi.fn(async () => ({ role })) },
    $queryRaw: vi.fn(async () => []),
  } as unknown as PrismaClient;
  return createAgentSkillsService(prisma);
}

const ids = (skills: Array<{ id: string; name: string }>) =>
  skills.filter((entry) => entry.name === "Expenses").map((entry) => entry.id);

describe("a name shared by a person's skill and their organization's", () => {
  it("is one row for a member, flagged or not, and with content", async () => {
    const service = serviceAs("member");
    expect(ids(await service.list(actor))).toEqual(["own"]);
    expect(ids(await service.list(actor, { manage: true }))).toEqual(["own"]);
    expect(ids(await service.listWithContent(actor))).toEqual(["own"]);
  });

  it("is one row for an admin who does not ask to manage, so a pick is what a bot uses", async () => {
    const service = serviceAs("admin");
    expect(ids(await service.list(actor))).toEqual(["own"]);
    expect(ids(await service.list(actor, { manage: false }))).toEqual(["own"]);
    expect(ids(await service.listWithContent(actor))).toEqual(["own"]);
  });

  it("keeps the organization's skill for an admin who asks to manage, and nowhere else", async () => {
    const service = serviceAs("admin");
    expect(ids(await service.list(actor, { manage: true }))).toEqual(["own", "organization"]);
    expect(ids(await service.listWithContent(actor))).toEqual(["own"]);
  });
});
