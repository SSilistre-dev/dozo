import { createRouterClient } from "@orpc/server";
import { addressFingerprint } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { dozoAdminAccessRoutes } from "./dozo-admin-access.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

type Grant = {
  id: string;
  email: string;
  creditCents: number;
  freeMonths: number;
  organizationId: string | null;
  appliedAt: Date | null;
  revokedAt: Date | null;
};

const grant = (id: string, more: Partial<Grant> = {}): Grant => ({
  id,
  email: `${id}@example.test`,
  creditCents: 1000,
  freeMonths: 0,
  organizationId: null,
  appliedAt: null,
  revokedAt: null,
  ...more,
});

type Where = Partial<Grant>;
const matches = (row: Grant, where: Where) =>
  Object.entries(where).every(([key, value]) => row[key as keyof Grant] === value);

/** The grants table, matched on exactly the fields a call names, as Prisma's `where` does. */
function setup(initial: Grant[], modelCreditsEnabled = true) {
  let grants = initial.map((row) => ({ ...row }));
  const events: Record<string, unknown>[] = [];
  const failEvent = { next: false };
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        email: where.id === "admin" ? "owner@example.test" : `${where.id}@example.test`,
        emailVerified: true,
      })),
    },
    accessGrant: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          grants.find((row) => row.id === where.id) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: { where: Where }) => grants.find((row) => matches(row, where)) ?? null,
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<Grant> }) => {
        const hit = grants.filter((row) => matches(row, where));
        grants = grants.map((row) => (hit.includes(row) ? { ...row, ...data } : row));
        return { count: hit.length };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Where }) => {
        const before = grants.length;
        grants = grants.filter((row) => !matches(row, where));
        return { count: before - grants.length };
      }),
    },
    securityEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (failEvent.next) throw new Error("security_events is unavailable");
        events.push(data);
        return data;
      }),
    },
    $queryRaw: vi.fn(async () => []),
    // A transaction commits the grants and the events together, or neither, as Postgres does.
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const [grantsBefore, eventsBefore] = [grants, events.length];
      try {
        return await work(prisma);
      } catch (error) {
        grants = grantsBefore;
        events.length = eventsBefore;
        throw error;
      }
    }),
  };
  const deps = {
    prisma,
    billing: { modelCreditsEnabled },
    env: { adminEmails: ["owner@example.test"] },
  } as unknown as RouterDeps;
  const routes = { dozoAdmin: { accessGrants: dozoAdminAccessRoutes(createRouterContext(deps)) } };
  const as = (userId: string) =>
    createRouterClient(routes, {
      context: {
        actor: { userId, spaceId: `space-${userId}`, email: "", isDeploymentOwner: false },
      },
    }).dozoAdmin.accessGrants;
  return { prisma, as, grants: () => grants, events, failEvent };
}

const change = { email: "New@Example.test", creditCents: 2500, freeMonths: 2 };

describe("changing a free-access grant", () => {
  it("is refused to anyone who is not an admin, before anything is read", async () => {
    const { as, prisma } = setup([grant("g1")]);
    const refused = { code: "FORBIDDEN" };
    await expect(as("ada").update({ id: "g1", grant: change })).rejects.toMatchObject(refused);
    await expect(as("ada").delete({ id: "g1" })).rejects.toMatchObject(refused);
    expect(prisma.accessGrant.updateMany).not.toHaveBeenCalled();
    expect(prisma.accessGrant.deleteMany).not.toHaveBeenCalled();
  });

  it("is not found while the deployment does not bill, as upstream's grant procedures are", async () => {
    const { as } = setup([grant("g1")], false);
    await expect(as("admin").update({ id: "g1", grant: change })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("edits a pending grant, its address stored as the create stores it", async () => {
    const { as, grants } = setup([grant("g1")]);
    await expect(as("admin").update({ id: "g1", grant: change })).resolves.toEqual({ ok: true });
    expect(grants()[0]).toMatchObject({
      email: "new@example.test",
      creditCents: 2500,
      freeMonths: 2,
    });
  });

  it("records who moved what from which address to which, as fingerprints", async () => {
    const { as, events } = setup([grant("g1")]);
    await as("admin").update({ id: "g1", grant: change });
    expect(events).toEqual([
      expect.objectContaining({
        type: "deployment.settings.changed",
        userId: "admin",
        metadata: {
          setting: "access_grant",
          change: "updated",
          grant: "g1",
          fromAddress: addressFingerprint("g1@example.test"),
          toAddress: addressFingerprint("new@example.test"),
          fromCreditCents: 1000,
          toCreditCents: 2500,
          fromFreeMonths: 0,
          toFreeMonths: 2,
        },
      }),
    ]);
    // A fingerprint tells the addresses apart without holding them.
    expect(addressFingerprint(" New@Example.test")).toBe(addressFingerprint("new@example.test"));
    expect(JSON.stringify(events)).not.toContain("example.test");
  });

  it("undoes an edit whose record cannot be written", async () => {
    const { as, grants, failEvent } = setup([grant("g1")]);
    failEvent.next = true;
    await expect(as("admin").update({ id: "g1", grant: change })).rejects.toThrow();
    expect(grants()[0]).toMatchObject({ email: "g1@example.test", creditCents: 1000 });
  });

  it("refuses an edit that grants nothing, as the create does", async () => {
    const { as } = setup([grant("g1")]);
    await expect(
      as("admin").update({ id: "g1", grant: { email: "a@example.test", creditCents: 0 } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("never edits a grant that was received, claimed or revoked", async () => {
    const { as, grants } = setup([
      grant("received", { organizationId: "org-1", appliedAt: new Date() }),
      // A sign-up claimed it and is applying it right now.
      grant("claimed", { organizationId: "org-1" }),
      grant("revoked", { revokedAt: new Date() }),
    ]);
    for (const id of ["received", "claimed", "revoked"])
      await expect(as("admin").update({ id, grant: change })).rejects.toMatchObject({
        code: "CONFLICT",
      });
    expect(grants().map((row) => row.creditCents)).toEqual([1000, 1000, 1000]);
    await expect(as("admin").update({ id: "gone", grant: change })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("a sign-up claiming the grant between the read and the write", () => {
  it("wins: the edit or deletion is refused and nothing is recorded", async () => {
    const { as, prisma, grants, events } = setup([grant("g1")]);
    // The claim lands after the change read the grant: its state no longer matches.
    const claim = async () => {
      grants()[0]!.organizationId = "org-1";
      return { count: 0 };
    };
    prisma.accessGrant.updateMany.mockImplementationOnce(claim);
    await expect(as("admin").update({ id: "g1", grant: change })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    grants()[0]!.organizationId = null;
    prisma.accessGrant.deleteMany.mockImplementationOnce(claim);
    await expect(as("admin").delete({ id: "g1" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(grants()).toHaveLength(1);
    expect(events).toEqual([]);
  });
});

describe("deleting a free-access grant", () => {
  it("deletes a pending or a revoked grant, and records what it gave", async () => {
    const { as, grants, events } = setup([
      grant("g1"),
      grant("g2", { revokedAt: new Date(), freeMonths: 3 }),
    ]);
    await as("admin").delete({ id: "g1" });
    await as("admin").delete({ id: "g2" });
    expect(grants()).toEqual([]);
    expect(events.map((event) => event.metadata)).toEqual([
      {
        setting: "access_grant",
        change: "deleted",
        grant: "g1",
        status: "pending",
        address: addressFingerprint("g1@example.test"),
        creditCents: 1000,
        freeMonths: 0,
      },
      {
        setting: "access_grant",
        change: "deleted",
        grant: "g2",
        status: "revoked",
        address: addressFingerprint("g2@example.test"),
        creditCents: 1000,
        freeMonths: 3,
      },
    ]);
  });

  it("keeps a grant whose deletion cannot be recorded", async () => {
    const { as, grants, failEvent } = setup([grant("g1")]);
    failEvent.next = true;
    await expect(as("admin").delete({ id: "g1" })).rejects.toThrow();
    expect(grants()).toHaveLength(1);
  });

  it("keeps a grant an account received or claimed, which is its record of what it got", async () => {
    const { as, grants } = setup([
      grant("received", { organizationId: "org-1", appliedAt: new Date() }),
      grant("claimed", { organizationId: "org-1" }),
    ]);
    for (const id of ["received", "claimed"])
      await expect(as("admin").delete({ id })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(grants()).toHaveLength(2);
    await expect(as("admin").delete({ id: "gone" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
