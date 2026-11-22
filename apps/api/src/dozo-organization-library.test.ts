import { createRouterClient } from "@orpc/server";
import type { AgentSkill } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILTIN_SKILL_NAMES,
  dozoAfterLibraryChange,
  dozoOrganizationLibraryRoutes,
  dozoSkillView,
} from "./dozo-organization-library.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const fake = vi.hoisted(() => ({
  read: vi.fn(),
  share: vi.fn(),
  hide: vi.fn(),
  readers: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  readOrganizationLibrary: fake.read,
  shareSkillWithOrganization: fake.share,
  hideLibrarySkill: fake.hide,
  libraryReaderSpaces: fake.readers,
  recordAuditEvent: fake.audit,
}));

const publishRosterChange = vi.fn(async () => undefined);
const prisma = {};
const events = {
  notify: () => undefined,
  publishSpaceChange: () => undefined,
  publishRosterChange,
};
const actor = {
  userId: "owner",
  spaceId: "space-1",
  email: "o@example.test",
  isDeploymentOwner: false,
};
const LIBRARY = { skillIds: ["s"], canShare: true, hidden: [] };

function client() {
  const ctx = createRouterContext({ prisma, events, env: {} } as unknown as RouterDeps);
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

beforeEach(() => {
  fake.read.mockReset().mockResolvedValue(LIBRARY);
  fake.share.mockReset().mockResolvedValue({ spaceIds: ["space-1", "space-2"] });
  fake.hide.mockReset().mockResolvedValue(undefined);
  fake.readers.mockReset().mockResolvedValue([]);
  fake.audit.mockReset().mockResolvedValue(undefined);
  publishRosterChange.mockClear();
});

describe("a skill as its reader sees it", () => {
  it("is the reader's own as it is, and someone else's library skill read only, without its places", () => {
    expect(dozoSkillView({ userId: "owner" })({ userId: "owner" }, skill)).toBe(skill);
    expect(dozoSkillView({ userId: "guest" })({ userId: "owner" }, skill)).toEqual({
      ...skill,
      readOnly: true,
      availability: undefined,
    });
  });

  it("knows the built-in skill names a library skill may not stand in for", () => {
    expect(BUILTIN_SKILL_NAMES.length).toBeGreaterThan(0);
  });
});

describe("organization library routes", () => {
  it("read the library of the open Space for the caller", async () => {
    expect(await client().get()).toEqual(LIBRARY);
    expect(fake.read).toHaveBeenCalledWith(prisma, actor);
  });

  it("share a skill with the built-in names to refuse, record it and signal every Space of the organization", async () => {
    expect(await client().share({ skillId: "s", shared: true })).toEqual(LIBRARY);
    expect(fake.share).toHaveBeenCalledWith(prisma, actor, {
      skillId: "s",
      shared: true,
      builtinNames: BUILTIN_SKILL_NAMES,
    });
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

  it("turn a library skill off for the caller alone, and signal only their apps", async () => {
    expect(await client().hide({ skillId: "s", hidden: true })).toEqual(LIBRARY);
    expect(fake.hide).toHaveBeenCalledWith(prisma, actor, { skillId: "s", hidden: true });
    expect(publishRosterChange).toHaveBeenCalledWith({ userIds: ["owner"] });
  });
});

describe("an owner's change to a skill", () => {
  it("signals the organization's Spaces when the skill is in a library, found before the change", async () => {
    const order: string[] = [];
    fake.readers.mockImplementation(async () => {
      order.push("readers");
      return ["space-1", "space-2"];
    });
    const result = await dozoAfterLibraryChange({ prisma, events } as never, "s", async () => {
      order.push("change");
      return "done";
    });
    expect(result).toBe("done");
    expect(order).toEqual(["readers", "change"]);
    expect(fake.readers).toHaveBeenCalledWith(prisma, "s");
    expect(publishRosterChange).toHaveBeenCalledWith({ spaceIds: ["space-1", "space-2"] });
  });

  it("signals nothing for a skill in no library, nor when the change fails", async () => {
    await dozoAfterLibraryChange({ prisma, events } as never, "s", async () => "done");
    fake.readers.mockResolvedValue(["space-1"]);
    await expect(
      dozoAfterLibraryChange({ prisma, events } as never, "s", async () => {
        throw new IsolationError();
      }),
    ).rejects.toBeInstanceOf(IsolationError);
    expect(publishRosterChange).not.toHaveBeenCalled();
  });
});
