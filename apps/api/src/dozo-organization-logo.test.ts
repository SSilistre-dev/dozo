import { createRouterClient } from "@orpc/server";
import { DOZO_ORGANIZATION_LOGO_ERROR } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoOrganizationLogoRoutes } from "./dozo-organization-logo.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const fake = vi.hoisted(() => ({ audit: vi.fn(), encode: vi.fn() }));

vi.mock("@rakazo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/adapters")>();
  fake.encode.mockImplementation(actual.encodeOrganizationLogo);
  return { ...actual, encodeOrganizationLogo: fake.encode };
});
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  recordAuditEvent: fake.audit,
}));

type Where = Record<string, unknown>;

/**
 * Two organizations as the tables hold them. Acme: its owner and a look-alike "superadmin" in its home Space, a
 * guest invited to its shared Space. Other: a stranger who owns it.
 */
function world() {
  const organizations: Record<string, { name: string; logo: string | null; spaces: string[] }> = {
    acme: { name: "Acme", logo: null, spaces: ["acme-home", "acme-shared"] },
    other: { name: "Other", logo: null, spaces: ["other-home"] },
  };
  const members = new Map([
    ["acme:owner", "owner"],
    ["acme:admin", "superadmin"],
    ["acme:guest", "guest"],
    ["acme:member", "member"],
    ["other:stranger", "owner"],
  ]);
  const spaceMembers = new Set([
    "acme-home:owner",
    "acme-home:admin",
    "acme-shared:guest",
    "acme-home:member",
    "other-home:stranger",
  ]);
  const organizationOf = (spaceId: string) =>
    Object.keys(organizations).find((id) => organizations[id]!.spaces.includes(spaceId))!;
  const prisma = {
    spaceMember: {
      findUnique: async ({ where }: { where: { spaceId_userId: Where } }) => {
        const { spaceId, userId } = where.spaceId_userId as { spaceId: string; userId: string };
        if (!spaceMembers.has(`${spaceId}:${userId}`)) return null;
        const { name, logo } = organizations[organizationOf(spaceId)]!;
        return { space: { deletingAt: null, organization: { name, logo } } };
      },
    },
    member: {
      findFirst: async ({ where }: { where: Where }) => {
        const role = members.get(`${where.organizationId}:${where.userId}`);
        if (!role || role === "guest") return null;
        return {
          role,
          organization: { logo: organizations[where.organizationId as string]!.logo },
        };
      },
    },
    // The locking read of the caller's member row, as Postgres answers it.
    $queryRaw: async (sql: { values: string[] }) => {
      const [organizationId, userId] = sql.values;
      const role = members.get(`${organizationId}:${userId}`);
      return role ? [{ role }] : [];
    },
    $transaction: async (work: (tx: unknown) => unknown) => work(prisma),
    organization: {
      updateMany: async ({ where, data }: { where: Where; data: { logo: string | null } }) => {
        organizations[where.id as string]!.logo = data.logo;
        return { count: 1 };
      },
    },
    space: {
      findMany: async ({ where }: { where: Where }) =>
        organizations[where.organizationId as string]!.spaces.map((id) => ({ id })),
      findUnique: async () => null,
    },
  };
  const leave = (organizationId: string, userId: string) => {
    members.delete(`${organizationId}:${userId}`);
    for (const key of spaceMembers) if (key.endsWith(`:${userId}`)) spaceMembers.delete(key);
  };
  return { prisma, organizations, leave };
}

let w = world();
const publishRosterChange = vi.fn(async () => undefined);

function as(userId: string, spaceId: string) {
  const ctx = createRouterContext({
    prisma: w.prisma,
    events: { notify: () => undefined, publishSpaceChange: () => undefined, publishRosterChange },
    env: {},
  } as unknown as RouterDeps);
  return createRouterClient(dozoOrganizationLogoRoutes(ctx), {
    context: {
      actor: { userId, spaceId, email: `${userId}@example.test`, isDeploymentOwner: false },
    },
  }).dozoOrganizationLogo;
}

/** A real 1 × 1 PNG, as a person's upload arrives. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const upload = async () => PNG;

/** What a call was refused with: a foreign or missing organization is an isolation error. */
async function refusal(call: Promise<unknown>) {
  const error = await call.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (error instanceof IsolationError) return "NOT_FOUND";
  return (error as { kind?: string } | null)?.kind;
}

describe("organization logo routes", () => {
  beforeEach(() => {
    w = world();
    publishRosterChange.mockClear();
    fake.audit.mockReset().mockResolvedValue(undefined);
    fake.encode.mockClear();
  });

  it("let the owner set a logo, stored as the server's own picture, shown in every Space", async () => {
    const saved = await as("owner", "acme-home").set({
      organizationId: "acme",
      logo: await upload(),
    });
    expect(saved).toEqual({
      logo: expect.stringMatching(/^data:image\/webp;base64,/),
      canManage: true,
    });
    expect(w.organizations.acme!.logo).toBe(saved.logo);
    expect(publishRosterChange).toHaveBeenCalledWith({ spaceIds: ["acme-home", "acme-shared"] });
    expect(fake.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "organization.logo_changed",
        actor: { type: "user", id: "owner" },
        organizationId: "acme",
      }),
    );
    expect(await as("owner", "acme-home").mark()).toEqual({ name: "Acme", logo: saved.logo });
    // A guest of the shared Space sees the host's logo there.
    expect(await as("guest", "acme-shared").mark()).toEqual({ name: "Acme", logo: saved.logo });
  });

  it("let the owner remove it, and refuse a role that only looks like the owner's", async () => {
    await as("owner", "acme-home").set({ organizationId: "acme", logo: await upload() });
    fake.encode.mockClear();
    expect(
      await refusal(as("admin", "acme-home").set({ organizationId: "acme", logo: null })),
    ).toBe("NOT_FOUND");
    expect(fake.encode).not.toHaveBeenCalled();
    expect(w.organizations.acme!.logo).toMatch(/^data:image\/webp;base64,/);
    expect(await as("owner", "acme-home").set({ organizationId: "acme", logo: null })).toEqual({
      logo: null,
      canManage: true,
    });
    expect(w.organizations.acme!.logo).toBeNull();
  });

  it("refuse a guest member before the picture is decoded, and show them the logo only", async () => {
    expect(
      await refusal(
        as("guest", "acme-shared").set({ organizationId: "acme", logo: await upload() }),
      ),
    ).toBe("NOT_FOUND");
    expect(await refusal(as("guest", "acme-shared").get({ organizationId: "acme" }))).toBe(
      "NOT_FOUND",
    );
    expect(fake.encode).not.toHaveBeenCalled();
    expect(w.organizations.acme!.logo).toBeNull();
    expect(publishRosterChange).not.toHaveBeenCalled();
  });

  it("refuse a member who is neither its owner nor an admin, and show them the logo", async () => {
    await as("owner", "acme-home").set({ organizationId: "acme", logo: await upload() });
    fake.encode.mockClear();
    const member = as("member", "acme-home");
    expect(await member.get({ organizationId: "acme" })).toEqual({
      logo: w.organizations.acme!.logo,
      canManage: false,
    });
    expect(await refusal(member.set({ organizationId: "acme", logo: null }))).toBe("NOT_FOUND");
    expect(fake.encode).not.toHaveBeenCalled();
    expect(w.organizations.acme!.logo).not.toBeNull();
  });

  it("refuse another organization's owner everything about it", async () => {
    const stranger = as("stranger", "other-home");
    expect(await refusal(stranger.set({ organizationId: "acme", logo: null }))).toBe("NOT_FOUND");
    expect(await refusal(stranger.get({ organizationId: "acme" }))).toBe("NOT_FOUND");
    expect(await refusal(as("stranger", "acme-shared").mark())).toBe("NOT_FOUND");
    expect(await stranger.mark()).toEqual({ name: "Other", logo: null });
    expect(w.organizations.acme!.logo).toBeNull();
  });

  it("stop showing it to a member the moment they leave", async () => {
    await as("owner", "acme-home").set({ organizationId: "acme", logo: await upload() });
    expect((await as("guest", "acme-shared").mark()).logo).not.toBeNull();
    w.leave("acme", "guest");
    expect(await refusal(as("guest", "acme-shared").mark())).toBe("NOT_FOUND");
  });

  it("refuse bytes that are not the picture they claim, and keep the logo", async () => {
    const svg = `data:image/png;base64,${Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64")}`;
    const error = await as("owner", "acme-home")
      .set({ organizationId: "acme", logo: svg })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toMatchObject({
      kind: "BAD_REQUEST",
      code: DOZO_ORGANIZATION_LOGO_ERROR,
      message: "Couldn't use that image as a logo",
    });
    expect(w.organizations.acme!.logo).toBeNull();
    expect(publishRosterChange).not.toHaveBeenCalled();
    expect(
      await refusal(
        as("owner", "acme-home").set({
          organizationId: "acme",
          logo: "data:image/svg+xml;base64,PHN2Zz4=",
        }),
      ),
    ).toBe("BAD_REQUEST");
  });

  it("show the owner's settings copy with the right to change it", async () => {
    expect(await as("owner", "acme-home").get({ organizationId: "acme" })).toEqual({
      logo: null,
      canManage: true,
    });
  });
});
