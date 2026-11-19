import { beforeEach, describe, expect, it, vi } from "vitest";
import { granted, inDays, setup } from "./dozo-admin.test-support.js";
import { audit } from "./dozo-admin-mocks.test-support.js";

vi.mock("./routes/computer.js", async () =>
  (await import("./dozo-admin-mocks.test-support.js")).computerRoutesMock(),
);
vi.mock("@rakazo/adapters", async (original) =>
  (await import("./dozo-admin-mocks.test-support.js")).adaptersMock(original),
);
vi.mock("@rakazo/db", async (original) =>
  (await import("./dozo-admin-mocks.test-support.js")).dbMock(original),
);

beforeEach(() => {
  audit.events.length = 0;
});

describe("the plan in the list", () => {
  const plan = async (as: ReturnType<typeof setup>["as"], query: string) =>
    (await as("admin").users({ query })).users[0]?.plan;

  it("is Free for everyone by default, and for an account with no organization of its own", async () => {
    const { as } = setup();
    expect(await plan(as, "ada")).toEqual({ tier: "standard", grantedUntil: null, ends: null });
    expect(await plan(as, "bob")).toEqual({ tier: "standard", grantedUntil: null, ends: null });
  });

  it("is the subscription's tier while it is live", async () => {
    const { as, organizations } = setup();
    const row = organizations.get("org-ada");
    if (!row) throw new Error("fixture");
    row.billing = { status: "active", byokTier: "pro" };
    expect(await plan(as, "ada")).toEqual({ tier: "pro", grantedUntil: null, ends: null });
    row.billing = { status: "canceled", byokTier: "pro" };
    expect(await plan(as, "ada")).toEqual({ tier: "standard", grantedUntil: null, ends: null });
    row.billing = { status: "active", byokTier: null };
    expect(await plan(as, "ada")).toEqual({ tier: "standard", grantedUntil: null, ends: null });
  });

  it("is the higher of the subscription and an unexpired grant, with the grant's end", async () => {
    const { as, organizations } = setup();
    const row = organizations.get("org-ada");
    if (!row) throw new Error("fixture");
    const endsAt = inDays(5);
    row.grant = { tier: "max", endsAt, grantedById: "admin", note: null };
    expect(await plan(as, "ada")).toEqual({
      tier: "max",
      grantedUntil: endsAt.toISOString(),
      ends: granted(endsAt),
    });
    row.billing = { status: "active", byokTier: "pro" };
    expect(await plan(as, "ada")).toEqual({
      tier: "max",
      grantedUntil: endsAt.toISOString(),
      ends: { ...granted(endsAt), fallsTo: { from: "Premium Plus", to: "Premium" } },
    });
    row.grant = { tier: "pro", endsAt, grantedById: "admin", note: null };
    row.billing = { status: "active", byokTier: "max" };
    expect(await plan(as, "ada")).toEqual({
      tier: "max",
      grantedUntil: endsAt.toISOString(),
      ends: null,
    });
  });

  it("drops a grant that has ended", async () => {
    const { as, organizations } = setup();
    const row = organizations.get("org-ada");
    if (!row) throw new Error("fixture");
    row.grant = { tier: "max", endsAt: inDays(-1), grantedById: "admin", note: null };
    expect(await plan(as, "ada")).toEqual({ tier: "standard", grantedUntil: null, ends: null });
  });
});

describe("giving a plan by hand", () => {
  const until = (days: number) => inDays(days).toISOString();

  it("sets, replaces and ends the grant of the account's own organization, with an audit record each time", async () => {
    const { as, organizations } = setup();
    const first = until(30);
    expect(
      await as("admin").setPlan({ userId: "ada", tier: "pro", endsAt: first, note: "press" }),
    ).toEqual({ plan: { tier: "pro", grantedUntil: first, ends: granted(first) } });
    expect(organizations.get("org-ada")?.grant).toEqual({
      tier: "pro",
      endsAt: new Date(first),
      grantedById: "admin",
      note: "press",
    });

    const second = until(60);
    expect(await as("admin").setPlan({ userId: "ada", tier: "max", endsAt: second })).toEqual({
      plan: { tier: "max", grantedUntil: second, ends: granted(second) },
    });
    expect(organizations.get("org-ada")?.grant).toMatchObject({
      tier: "max",
      endsAt: new Date(second),
      note: null,
    });

    expect(await as("admin").setPlan({ userId: "ada", tier: null })).toEqual({
      plan: { tier: "standard", grantedUntil: null, ends: null },
    });
    expect(organizations.get("org-ada")?.grant).toBeNull();
    // Nobody else's organization was touched.
    expect(organizations.get("org-admin")?.grant).toBeNull();

    // Tenant-visible: the admin only as an opaque id, never their email, nor the note.
    expect(JSON.stringify(audit.events)).not.toMatch(/press|owner@example/i);
    expect(audit.events).toEqual([
      {
        action: "plan.granted",
        actor: { type: "system", label: "Operator" },
        organizationId: "org-ada",
        target: { type: "user", id: "ada" },
        metadata: { adminId: "admin", tier: "pro", endsAt: first },
      },
      {
        action: "plan.granted",
        actor: { type: "system", label: "Operator" },
        organizationId: "org-ada",
        target: { type: "user", id: "ada" },
        metadata: { adminId: "admin", tier: "max", endsAt: second },
      },
      {
        action: "plan.grant_ended",
        actor: { type: "system", label: "Operator" },
        organizationId: "org-ada",
        target: { type: "user", id: "ada" },
        metadata: { adminId: "admin", tier: null, endsAt: null },
      },
    ]);
  });

  it("leaves a subscription alone and answers with the higher plan", async () => {
    const { as, organizations } = setup();
    const row = organizations.get("org-ada");
    if (!row) throw new Error("fixture");
    row.billing = { status: "active", byokTier: "max" };
    const endsAt = until(10);
    expect(await as("admin").setPlan({ userId: "ada", tier: "pro", endsAt })).toEqual({
      plan: { tier: "max", grantedUntil: endsAt, ends: null },
    });
    expect(row.billing).toEqual({ status: "active", byokTier: "max" });
  });

  it("answers, and writes no audit record, for an end of a grant that was not there", async () => {
    const { as, planChanged } = setup();
    expect(await as("admin").setPlan({ userId: "ada", tier: null })).toEqual({
      plan: { tier: "standard", grantedUntil: null, ends: null },
    });
    expect(audit.events).toEqual([]);
    expect(planChanged).not.toHaveBeenCalled();
  });

  it("queues the mail before the end after it changes the plan", async () => {
    const { as, planChanged } = setup();
    await as("admin").setPlan({ userId: "ada", tier: "pro", endsAt: until(30) });
    await as("admin").setPlan({ userId: "ada", tier: null });
    expect(planChanged.mock.calls).toEqual([["org-ada"], ["org-ada"]]);
  });

  it("lets an admin give themselves a plan", async () => {
    const { as, organizations } = setup();
    await as("admin").setPlan({ userId: "admin", tier: "pro", endsAt: until(2) });
    expect(organizations.get("org-admin")?.grant).toMatchObject({ tier: "pro" });
  });

  it("refuses an end date that is missing, past, or too far ahead, and writes nothing", async () => {
    const { as, prisma } = setup();
    const refused = { kind: "BAD_REQUEST" };
    await expect(as("admin").setPlan({ userId: "ada", tier: "pro" })).rejects.toMatchObject(
      refused,
    );
    for (const endsAt of [until(-1), new Date(Date.now() - 1000).toISOString(), until(5 * 366 + 1)])
      await expect(
        as("admin").setPlan({ userId: "ada", tier: "max", endsAt }),
      ).rejects.toMatchObject(refused);
    expect(prisma.dozoPlanGrant.upsert).not.toHaveBeenCalled();
    expect(audit.events).toEqual([]);
    // Five years ahead is allowed.
    await expect(
      as("admin").setPlan({ userId: "ada", tier: "max", endsAt: until(5 * 365) }),
    ).resolves.toMatchObject({ plan: { tier: "max" } });
  });

  it("refuses a tier that is not one an admin can give", async () => {
    const { as, prisma } = setup();
    await expect(
      as("admin").setPlan({ userId: "ada", tier: "standard" as never, endsAt: until(2) }),
    ).rejects.toThrow();
    expect(prisma.dozoPlanGrant.upsert).not.toHaveBeenCalled();
  });

  it("answers not found for an unknown account, a chat-app row, and an account without an organization", async () => {
    const { as, prisma } = setup();
    for (const userId of ["nobody", "chat", "bob"])
      await expect(
        as("admin").setPlan({ userId, tier: "pro", endsAt: until(2) }),
      ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    expect(prisma.dozoPlanGrant.upsert).not.toHaveBeenCalled();
    expect(audit.events).toEqual([]);
  });

  it("fails loudly, and writes no audit record, when the grant cannot be written", async () => {
    const { as, prisma } = setup();
    prisma.dozoPlanGrant.upsert.mockRejectedValueOnce(new Error("database down"));
    await expect(
      as("admin").setPlan({ userId: "ada", tier: "pro", endsAt: until(2) }),
    ).rejects.toThrow();
    expect(audit.events).toEqual([]);
  });

  it("passes on a failure that is not an account without an organization", async () => {
    const { as, prisma } = setup();
    prisma.member.findMany.mockRejectedValueOnce(new Error("database down"));
    await expect(
      as("admin").setPlan({ userId: "ada", tier: "pro", endsAt: until(2) }),
    ).rejects.toThrow("database down");
    prisma.member.findMany.mockRejectedValueOnce(new Error("database down"));
    await expect(as("admin").users({})).rejects.toThrow("database down");
  });
});

describe("what keeps a plan and when it ends", () => {
  const plan = async (as: ReturnType<typeof setup>["as"]) =>
    (await as("admin").users({ query: "ada" })).users[0]?.plan;
  const fixture = (organizations: ReturnType<typeof setup>["organizations"]) => {
    const row = organizations.get("org-ada");
    if (!row) throw new Error("fixture");
    return row;
  };

  it("is the subscription's period: renewing, or ending when it is cancelled", async () => {
    const { as, organizations } = setup();
    const row = fixture(organizations);
    const end = inDays(12);
    row.billing = { status: "active", byokTier: "pro", currentPeriodEndsAt: end };
    expect((await plan(as))?.ends).toEqual({
      source: "subscription",
      at: end.toISOString(),
      renews: true,
    });
    row.billing.cancelAtPeriodEnd = true;
    expect((await plan(as))?.ends).toMatchObject({ source: "subscription", renews: false });
  });

  it("is the trial's end while it is a trial, else its period's", async () => {
    const { as, organizations } = setup();
    const row = fixture(organizations);
    const trial = inDays(3);
    const period = inDays(30);
    row.billing = {
      status: "trialing",
      byokTier: "max",
      trialEndsAt: trial,
      currentPeriodEndsAt: period,
    };
    expect((await plan(as))?.ends).toEqual({
      source: "trial",
      at: trial.toISOString(),
      renews: true,
    });
    row.billing.trialEndsAt = null;
    expect((await plan(as))?.ends).toMatchObject({ source: "trial", at: period.toISOString() });
  });

  it("names the plan that follows a grant above the subscription", async () => {
    const { as, organizations } = setup();
    const row = fixture(organizations);
    const end = inDays(40);
    row.billing = { status: "active", byokTier: "pro", currentPeriodEndsAt: inDays(5) };
    row.grant = { tier: "max", endsAt: end, grantedById: "admin", note: null };
    expect((await plan(as))?.ends).toEqual({
      ...granted(end),
      fallsTo: { from: "Premium Plus", to: "Premium" },
    });
    // A subscription with no date left leaves an equal grant's end.
    row.billing = { status: "active", byokTier: "max" };
    expect((await plan(as))?.ends).toEqual(granted(end));
  });

  // Each as the member's own billing status tells it (statusPlanEnd): the admin sees the same end.
  it("is the later grant when a cancelled subscription of the same plan ends first", async () => {
    const { as, organizations } = setup();
    const row = fixture(organizations);
    const end = inDays(40);
    row.billing = {
      status: "active",
      byokTier: "pro",
      currentPeriodEndsAt: inDays(20),
      cancelAtPeriodEnd: true,
    };
    row.grant = { tier: "pro", endsAt: end, grantedById: "admin", note: null };
    expect((await plan(as))?.ends).toEqual(granted(end));
  });

  it("is a subscription on credits' period, though it raises no plan", async () => {
    const { as, organizations } = setup();
    const row = fixture(organizations);
    const end = inDays(10);
    row.billing = { status: "active", byokTier: null, currentPeriodEndsAt: end };
    expect(await plan(as)).toEqual({
      tier: "standard",
      grantedUntil: null,
      ends: { source: "subscription", at: end.toISOString(), renews: true },
    });
  });

  it("says a trial cancelled before it ends does not renew", async () => {
    const { as, organizations } = setup();
    const row = fixture(organizations);
    row.billing = {
      status: "trialing",
      byokTier: "pro",
      trialEndsAt: inDays(4),
      cancelAtPeriodEnd: true,
    };
    expect((await plan(as))?.ends).toMatchObject({ source: "trial", renews: false });
  });

  it("is a running free period on Free with nothing else ending", async () => {
    const { as, organizations } = setup();
    const row = fixture(organizations);
    const end = inDays(3);
    row.freeUntil = end;
    expect((await plan(as))?.ends).toEqual({
      source: "freeMonth",
      at: end.toISOString(),
      renews: false,
    });
    row.freeUntil = inDays(-1);
    expect((await plan(as))?.ends).toBeNull();
    // Paying, the free period is not what keeps the plan.
    row.freeUntil = inDays(9);
    row.billing = { status: "active", byokTier: "pro" };
    expect((await plan(as))?.ends).toBeNull();
  });
});
