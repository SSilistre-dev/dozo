import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BYOK_TIERS } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import {
  holdSharedSpace,
  isReplayedUpload,
  SharedSpaceFullError,
  sharedSpaceFull,
  sharedSpaceUsage,
  withSharedSpace,
} from "./dozo-shared-space.js";

// Runs on the branded tree only: the limits exist once the brand rules are applied.

const MB = 1024 * 1024;
const GB = 1024 * MB;

type Billing = { status: string | null; byokTier: string | null } | null;

/** One organization: whether the server bills, its subscription, and the sizes of its files. */
function organization(
  init: {
    billingOn?: boolean;
    billing?: Billing;
    /** A plan an admin granted. */
    grant?: { tier: string; endsAt: Date } | null;
    files?: number[];
    /** What an admin set on the plans page, as `dozo_plan_quotas` rows. */
    quotas?: { tier: string; sharedSpaceMb: number | null; computerHours: number | null }[];
  } = {},
) {
  const state = {
    billingOn: true,
    billing: null as Billing,
    grant: null as { tier: string; endsAt: Date } | null,
    files: [] as number[],
    quotas: [] as { tier: string; sharedSpaceMb: number | null; computerHours: number | null }[],
    ...init,
  };
  const queries: string[] = [];
  const tx = {
    deploymentSettings: {
      findUnique: async () => ({ modelCreditsEnabled: state.billingOn }),
    },
    space: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === "space-1"
          ? {
              organizationId: "org-1",
              organization: { billing: state.billing, dozoPlanGrant: state.grant },
            }
          : null,
    },
    dozoPlanQuota: { findMany: async () => state.quotas },
    $queryRaw: async (query: TemplateStringsArray | Prisma.Sql) => {
      queries.push("sql" in query ? query.sql : query.join("?"));
      return [{ used: String(state.files.reduce((sum, size) => sum + size, 0)) }];
    },
  } as unknown as Prisma.TransactionClient;
  // A transaction that fails leaves no file behind.
  const prisma = {
    $transaction: async (work: (client: Prisma.TransactionClient) => Promise<unknown>) => {
      const before = [...state.files];
      try {
        return await work(tx);
      } catch (error) {
        state.files = before;
        throw error;
      }
    },
  } as unknown as Pick<PrismaClient, "$transaction">;
  const add = (bytes: number, spaceId = "space-1") =>
    withSharedSpace(prisma, spaceId, async () => {
      state.files.push(bytes);
      return "kept";
    });
  return { state, queries, tx, add };
}

const paid = (byokTier: string, status = "active") => ({ status, byokTier });

describe("shared space", () => {
  it("lets Free add files up to 500 MB and refuses the one that goes over", async () => {
    const { state, add } = organization();
    await expect(add(499 * MB)).resolves.toBe("kept");
    await expect(add(MB)).resolves.toBe("kept");
    await expect(add(1)).rejects.toBeInstanceOf(SharedSpaceFullError);
    expect(state.files).toEqual([499 * MB, MB]);
  });

  it("refuses with a stable code the caller can act on", async () => {
    const error = await organization({ files: [500 * MB] })
      .add(1)
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ClientError);
    expect(error).toMatchObject({ kind: "BAD_REQUEST", code: "shared_space_full" });
  });

  it.each([
    ["pro", 2 * GB],
    ["max", 5 * GB],
  ])("gives a %s subscription its own limit", async (tier, limit) => {
    const { add } = organization({ billing: paid(tier), files: [limit - MB] });
    await expect(add(MB)).resolves.toBe("kept");
    await expect(add(1)).rejects.toBeInstanceOf(SharedSpaceFullError);
  });

  it("keeps a subscription in its grace period on its plan", async () => {
    const { add } = organization({ billing: paid("pro", "past_due"), files: [GB] });
    await expect(add(MB)).resolves.toBe("kept");
  });

  it("keeps the files of a plan that ended, refuses new ones, and lets room be made", async () => {
    const { state, add } = organization({
      billing: paid("pro", "canceled"),
      files: [400 * MB, 400 * MB, 200 * MB],
    });
    await expect(add(1)).rejects.toBeInstanceOf(SharedSpaceFullError);
    // Nothing was removed: reading has no check to pass, and the rows are all still there.
    expect(state.files).toEqual([400 * MB, 400 * MB, 200 * MB]);
    // Deleting has no check either; once enough is gone, writing works again.
    state.files.splice(0, 2);
    await expect(add(MB)).resolves.toBe("kept");
  });

  describe("a plan an admin granted", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const grant = (tier: string, days: number) => ({
      tier,
      endsAt: new Date(Date.now() + days * DAY),
    });

    it("gives Free the granted plan's limit until it ends", async () => {
      const files = [GB];
      const { add, state } = organization({ files, grant: grant("pro", 3) });
      await expect(add(MB)).resolves.toBe("kept");
      state.grant = grant("pro", -1);
      await expect(add(MB)).rejects.toBeInstanceOf(SharedSpaceFullError);
      state.grant = null;
      await expect(add(MB)).rejects.toBeInstanceOf(SharedSpaceFullError);
    });

    it("keeps the files and refuses new ones when it ends, as for a plan that ended", async () => {
      const { state, add } = organization({ grant: grant("max", 1), files: [4 * GB] });
      await expect(add(MB)).resolves.toBe("kept");
      state.grant = grant("max", -1);
      await expect(add(1)).rejects.toBeInstanceOf(SharedSpaceFullError);
      expect(state.files).toEqual([4 * GB, MB]);
    });

    it("takes the higher of the subscription's limit and the grant's", async () => {
      const lower = organization({ billing: paid("max"), grant: grant("pro", 3), files: [3 * GB] });
      await expect(lower.add(MB)).resolves.toBe("kept");
      const higher = organization({
        billing: paid("pro"),
        grant: grant("max", 3),
        files: [3 * GB],
      });
      await expect(higher.add(MB)).resolves.toBe("kept");
    });

    it("counts a grant over a subscription that ended, and not one of a tier nobody can grant", async () => {
      const ended = organization({
        billing: paid("max", "canceled"),
        grant: grant("pro", 3),
        files: [GB],
      });
      await expect(ended.add(MB)).resolves.toBe("kept");
      const odd = organization({ grant: grant("standard", 3), files: [500 * MB] });
      await expect(odd.add(1)).rejects.toBeInstanceOf(SharedSpaceFullError);
    });

    it("is read by the look that runs before costly work too", async () => {
      const { tx, state } = organization({ files: [600 * MB], grant: grant("pro", 3) });
      await expect(sharedSpaceFull(tx as never, "space-1")).resolves.toBeNull();
      state.grant = null;
      await expect(sharedSpaceFull(tx as never, "space-1")).resolves.toBeInstanceOf(
        SharedSpaceFullError,
      );
    });
  });

  describe("a quota an admin set on the plans page", () => {
    const free = (sharedSpaceMb: number | null) => [
      { tier: "standard", sharedSpaceMb, computerHours: null },
    ];

    it("replaces the plan's shared space, and only that plan's", async () => {
      const raised = organization({ files: [500 * MB], quotas: free(600) });
      await expect(raised.add(50 * MB)).resolves.toBe("kept");
      await expect(raised.add(51 * MB)).rejects.toBeInstanceOf(SharedSpaceFullError);
      const premium = organization({ billing: paid("pro"), files: [2 * GB], quotas: free(600) });
      await expect(premium.add(1)).rejects.toBeInstanceOf(SharedSpaceFullError);
    });

    it("follows the plan's terms when it is cleared", async () => {
      const { add } = organization({ files: [500 * MB - 1], quotas: free(null) });
      await expect(add(1)).resolves.toBe("kept");
      await expect(add(1)).rejects.toBeInstanceOf(SharedSpaceFullError);
    });

    it("deletes nothing when lowered below what the files take: only new files are refused", async () => {
      const { state, add, tx } = organization({ files: [300 * MB, 100 * MB], quotas: free(200) });
      await expect(add(1)).rejects.toBeInstanceOf(SharedSpaceFullError);
      expect(state.files).toEqual([300 * MB, 100 * MB]);
      expect(await sharedSpaceFull(tx as unknown as PrismaClient, "space-1")).toBeInstanceOf(
        SharedSpaceFullError,
      );
      await expect(
        sharedSpaceUsage(tx as unknown as PrismaClient, "org-1", null, null),
      ).resolves.toEqual({ plan: "Free", usedBytes: 400 * MB, limitBytes: 200 * MB });
      // Room made by deleting files is room again.
      state.files = [100 * MB];
      await expect(add(MB)).resolves.toBe("kept");
    });
  });

  it("knows a retried upload that had landed only by the caller's own word", () => {
    expect(isReplayedUpload({ row: {}, replay: true })).toBe(true);
    for (const other of [{ row: {}, replay: false }, { row: {} }, "kept", null, undefined])
      expect(isReplayedUpload(other)).toBe(false);
  });

  it("reads a subscription without a known tier as the first plan", async () => {
    const { add } = organization({ billing: paid("unknown"), files: [500 * MB] });
    await expect(add(1)).rejects.toBeInstanceOf(SharedSpaceFullError);
  });

  it("has no limit on a server that does not bill", async () => {
    const { queries, add } = organization({ billingOn: false, files: [50 * GB] });
    await expect(add(GB)).resolves.toBe("kept");
    expect(queries).toEqual([]);
  });

  it("has nothing to hold a Space that is gone to", async () => {
    const { queries, add } = organization({ files: [50 * GB] });
    await expect(add(GB, "space-gone")).resolves.toBe("kept");
    expect(queries).toEqual([]);
  });

  it("has no limit on a plan that names none, as upstream's do not", async () => {
    // Read as planTerms reads it: upstream's tier type has no shared-space field.
    const terms: { name: string; sharedSpaceBytes?: number } = BYOK_TIERS.standard;
    const { sharedSpaceBytes } = terms;
    delete terms.sharedSpaceBytes;
    try {
      const { queries, add, tx } = organization({ files: [50 * GB] });
      await expect(add(GB)).resolves.toBe("kept");
      await expect(
        sharedSpaceUsage(tx as unknown as PrismaClient, "org-1", null, null),
      ).resolves.toBeNull();
      expect(queries).toEqual([]);
    } finally {
      terms.sharedSpaceBytes = sharedSpaceBytes;
    }
  });

  it("waits for the organization's other writes before it counts", async () => {
    const { queries, tx } = organization();
    await holdSharedSpace(tx, "space-1");
    const lock = queries.findIndex((sql) => sql.includes("pg_advisory_xact_lock"));
    const count = queries.findIndex((sql) => sql.includes("SUM("));
    expect(lock).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(lock);
  });

  it("says ahead of a write whether there is any room left", async () => {
    const full = organization({ files: [500 * MB] });
    const error = await sharedSpaceFull(full.tx as unknown as PrismaClient, "space-1");
    expect(error).toBeInstanceOf(SharedSpaceFullError);
    const room = organization({ files: [500 * MB - 1] });
    expect(await sharedSpaceFull(room.tx as unknown as PrismaClient, "space-1")).toBeNull();
    // No lock is taken to look.
    expect(room.queries.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(false);
    const free = organization({ billingOn: false, files: [50 * GB] });
    expect(await sharedSpaceFull(free.tx as unknown as PrismaClient, "space-1")).toBeNull();
    expect(free.queries).toEqual([]);
  });

  it("names the plan and counts what its files take, for showing", async () => {
    const usage = (init: Parameters<typeof organization>[0]) => {
      const { state, tx } = organization(init);
      return sharedSpaceUsage(tx as unknown as PrismaClient, "org-1", state.billing, state.grant);
    };
    await expect(usage({ files: [100 * MB, 20 * MB] })).resolves.toEqual({
      plan: "Free",
      usedBytes: 120 * MB,
      limitBytes: 500 * MB,
    });
    await expect(usage({ billing: paid("pro"), files: [GB] })).resolves.toEqual({
      plan: "Premium",
      usedBytes: GB,
      limitBytes: 2 * GB,
    });
    await expect(usage({ billing: paid("max") })).resolves.toEqual({
      plan: "Premium Plus",
      usedBytes: 0,
      limitBytes: 5 * GB,
    });
    // A plan that ended is Free again, with everything it kept still counted.
    await expect(usage({ billing: paid("pro", "canceled"), files: [GB] })).resolves.toEqual({
      plan: "Free",
      usedBytes: GB,
      limitBytes: 500 * MB,
    });
  });

  it("names a granted plan and its limit for showing, and Free again once it ends", async () => {
    const day = 24 * 60 * 60 * 1000;
    const { state, tx } = organization({
      files: [GB],
      grant: { tier: "max", endsAt: new Date(Date.now() + day) },
    });
    const usage = () =>
      sharedSpaceUsage(tx as unknown as PrismaClient, "org-1", state.billing, state.grant);
    await expect(usage()).resolves.toEqual({
      plan: "Premium Plus",
      usedBytes: GB,
      limitBytes: 5 * GB,
    });
    state.grant = { tier: "max", endsAt: new Date(Date.now() - day) };
    await expect(usage()).resolves.toEqual({ plan: "Free", usedBytes: GB, limitBytes: 500 * MB });
  });

  it("has no usage to show on a server that does not bill, and counts nothing for it", async () => {
    const { queries, tx } = organization({ billingOn: false, files: [50 * GB] });
    await expect(
      sharedSpaceUsage(tx as unknown as PrismaClient, "org-1", null, null),
    ).resolves.toBeNull();
    expect(queries).toEqual([]);
  });

  it("carries the limits on the plans", () => {
    expect(BYOK_TIERS).toMatchObject({
      standard: { sharedSpaceBytes: 500 * MB },
      pro: { sharedSpaceBytes: 2 * GB },
      max: { sharedSpaceBytes: 5 * GB },
    });
  });
});

/**
 * The limit holds only if every write of a file row passes the check. The writers are upstream's,
 * so a new one would pass unseen: this lists them, and a writer the list does not know fails here.
 */
describe("writers of file rows", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  // Shipped code only: not tests, the test kit, or the generated database client.
  const shipped = (file: string) =>
    file.endsWith(".ts") && !/\.test\.|test-support|^packages\/testkit\/|\/generated\//.test(file);
  const sources = ["apps", "packages"].flatMap((top) =>
    readdirSync(path.join(root, top)).flatMap((name) => {
      const src = path.join(top, name, "src");
      try {
        return readdirSync(path.join(root, src), { recursive: true, encoding: "utf8" })
          .map((file) => path.join(src, file))
          .filter(shipped);
      } catch {
        return [];
      }
    }),
  );
  const text = (file: string) => readFileSync(path.join(root, file), "utf8");
  // A model write, a write nested in another model's, or SQL of our own.
  const WRITES = [
    /\bartifact\s*\.(create|createMany|createManyAndReturn|upsert)\(/g,
    /\bartifacts\s*:\s*\{\s*(create|createMany|connectOrCreate|upsert)\b/g,
    /\bINSERT\s+INTO\s+"?artifacts\b/gi,
  ];
  const writes = (file: string) =>
    WRITES.reduce((count, write) => count + (text(file).match(write)?.length ?? 0), 0);

  it("are the known ones, each held to the shared space", () => {
    const writers = Object.fromEntries(
      sources.map((file) => [file, writes(file)] as const).filter(([, count]) => count > 0),
    );
    expect(writers).toEqual({
      // Both through withResolvedArtifactVersion, which holds the check.
      "apps/api/src/artifacts.ts": 1,
      "packages/adapters/src/thread-artifacts.ts": 2,
      "apps/api/src/account-import.ts": 1,
    });
    expect(text("packages/db/src/artifact-versions.ts")).toContain(
      "if (!isReplayedUpload(result)) await holdSharedSpace(tx,",
    );
    // The one answer that skips the check is still the upload route's.
    expect(text("apps/api/src/artifacts.ts")).toContain("return { row: raced, replay: true };");
    expect(text("packages/adapters/src/thread-artifacts.ts")).toMatch(
      /withSharedSpace\(deps\.prisma, owner\.spaceId, \(tx\) =>\s+tx\.artifact\.create\(/,
    );
    expect(text("apps/api/src/account-import.ts")).toMatch(
      /withSharedSpace\(this\.deps\.prisma, space\.spaceId, \(tx\) =>\s+tx\.artifact\.createMany\(/,
    );
  });
});
