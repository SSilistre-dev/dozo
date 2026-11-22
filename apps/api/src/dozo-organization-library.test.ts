import { createRouterClient } from "@orpc/server";
import type { AgentSkill } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoOrganizationLibraryRoutes, dozoSkillView } from "./dozo-organization-library.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const fake = vi.hoisted(() => ({ read: vi.fn(), share: vi.fn(), audit: vi.fn() }));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  readOrganizationLibrary: fake.read,
  shareSkillWithOrganization: fake.share,
  recordAuditEvent: fake.audit,
}));

const publishRosterChange = vi.fn(async () => undefined);
const prisma = {};
const actor = {
  userId: "owner",
  spaceId: "space-1",
  email: "o@example.test",
  isDeploymentOwner: false,
};

function client() {
  const ctx = createRouterContext({
    prisma,
    events: { notify: () => undefined, publishSpaceChange: () => undefined, publishRosterChange },
    env: {},
  } as unknown as RouterDeps);
  return createRouterClient(dozoOrganizationLibraryRoutes(ctx), { context: { actor } })
    .dozoOrganizationLibrary;
}

const skill: AgentSkill = {
  id: "s",
  name: "expenses",
  description: "d",
  content: "c",
  source: "user",
  readOnly: false,
  availability: { allSpaces: true, spaceIds: ["space-9"] },
  createdAt: "2026-11-22T00:00:00.000Z",
  updatedAt: "2026-11-22T00:00:00.000Z",
};

describe("a skill as its reader sees it", () => {
  it("is the reader's own as it is, and someone else's library skill read only, without its places", () => {
    expect(dozoSkillView({ userId: "owner" })({ userId: "owner" }, skill)).toBe(skill);
    expect(dozoSkillView({ userId: "guest" })({ userId: "owner" }, skill)).toEqual({
      ...skill,
      readOnly: true,
      availability: undefined,
    });
  });
});

describe("organization library routes", () => {
  beforeEach(() => {
    fake.read.mockReset().mockResolvedValue({ skillIds: ["s"], canShare: true });
    fake.share.mockReset().mockResolvedValue({ spaceIds: ["space-1", "space-2"] });
    fake.audit.mockReset().mockResolvedValue(undefined);
    publishRosterChange.mockClear();
  });

  it("read the library of the open Space for the caller", async () => {
    expect(await client().get()).toEqual({ skillIds: ["s"], canShare: true });
    expect(fake.read).toHaveBeenCalledWith(prisma, actor);
  });

  it("share a skill, record it and signal every Space of the organization", async () => {
    expect(await client().share({ skillId: "s", shared: true })).toEqual({
      skillIds: ["s"],
      canShare: true,
    });
    expect(fake.share).toHaveBeenCalledWith(prisma, actor, { skillId: "s", shared: true });
    expect(fake.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "organization.skill_shared",
        target: { type: "skill", id: "s" },
      }),
    );
    expect(publishRosterChange).toHaveBeenCalledWith({ spaceIds: ["space-1", "space-2"] });
    await client().share({ skillId: "s", shared: false });
    expect(fake.audit).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "organization.skill_unshared" }),
    );
  });

  it("change nothing and signal nothing when the database refuses the caller", async () => {
    fake.share.mockRejectedValue(new IsolationError());
    await expect(client().share({ skillId: "s", shared: true })).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(fake.audit).not.toHaveBeenCalled();
    expect(publishRosterChange).not.toHaveBeenCalled();
  });
});
