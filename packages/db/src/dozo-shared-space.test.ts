import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BYOK_TIERS } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import { holdSharedSpace, SharedSpaceFullError, withSharedSpace } from "./dozo-shared-space.js";

// Runs on the branded tree only: the limits exist once the brand rules are applied.

const MB = 1024 * 1024;
const GB = 1024 * MB;

type Billing = { status: string | null; byokTier: string | null } | null;

/** One organization: whether the server bills, its subscription, and the sizes of its files. */
function organization(init: { billingOn?: boolean; billing?: Billing; files?: number[] } = {}) {
  const state = { billingOn: true, billing: null as Billing, files: [] as number[], ...init, before: 0 };
  const queries: string[] = [];
  const tx = {
    deploymentSettings: {
      findUnique: async () => ({ modelCreditsEnabled: state.billingOn }),
    },
    space: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === "space-1"
          ? { organizationId: "org-1", organization: { billing: state.billing } }
          : null,
    },
    $queryRaw: async (query: TemplateStringsArray | Prisma.Sql) => {
      queries.push("sql" in query ? query.sql : query.join("?"));
      const used = String(state.files.reduce((sum, size) => sum + size, 0));
      return [{ used, added: state.files.length > state.before }];
    },
  } as unknown as Prisma.TransactionClient;
  // A transaction that fails leaves no file behind.
  const prisma = {
    $transaction: async (work: (client: Prisma.TransactionClient) => Promise<unknown>) => {
      const before = [...state.files];
      state.before = before.length;
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

  it("never refuses a write that added nothing, as a retried upload that had landed", async () => {
    const { state, tx } = organization({ files: [600 * MB] });
    state.before = 1;
    await expect(holdSharedSpace(tx, "space-1")).resolves.toBeUndefined();
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
    const terms: { sharedSpaceBytes?: number } = BYOK_TIERS.standard;
    const { sharedSpaceBytes } = terms;
    delete terms.sharedSpaceBytes;
    try {
      const { queries, add } = organization({ files: [50 * GB] });
      await expect(add(GB)).resolves.toBe("kept");
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
  const writes = (file: string) =>
    readFileSync(path.join(root, file), "utf8").match(
      /\bartifact\s*\.(create|createMany|createManyAndReturn|upsert)\(/g,
    )?.length ?? 0;

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
    const text = (file: string) => readFileSync(path.join(root, file), "utf8");
    expect(text("packages/db/src/artifact-versions.ts")).toContain("await holdSharedSpace(tx,");
    expect(text("packages/adapters/src/thread-artifacts.ts")).toMatch(
      /withSharedSpace\(deps\.prisma, owner\.spaceId, \(tx\) =>\s+tx\.artifact\.create\(/,
    );
    expect(text("apps/api/src/account-import.ts")).toMatch(
      /withSharedSpace\(this\.deps\.prisma, space\.spaceId, \(tx\) =>\s+tx\.artifact\.createMany\(/,
    );
  });
});
