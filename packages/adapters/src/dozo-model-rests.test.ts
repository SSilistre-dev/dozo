import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  has: vi.fn(),
  read: vi.fn(),
  record: vi.fn(),
  end: vi.fn(),
  find: vi.fn(),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  hasModelRests: db.has,
  readModelRests: db.read,
  recordModelRest: db.record,
  endModelRests: db.end,
  findModelCredential: db.find,
}));
const model = vi.hoisted(() => ({ resolve: vi.fn(), billing: vi.fn() }));
vi.mock("./run-model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-model.js")>()),
  resolveModelKey: model.resolve,
  modelCreditBillingEnabled: model.billing,
}));

import { POOL_COOLDOWN_DEFAULT_MS } from "@rakazo/core";
import { backupsPastRests, modelPicked, recordRest, startPastRest } from "./dozo-model-rests.js";
import { startRunModel } from "./run-model-start.js";

const prisma = { marker: "prisma" } as never;
const NOW = Date.UTC(2026, 10, 22, 10);
const HOUR = 60 * 60_000;
/** Rests on connection and model, ending at the given epoch milliseconds. */
let stored: Array<{ credentialId: string; modelId: string; resetsAt: Date }> = [];

beforeEach(() => {
  stored = [];
  db.has.mockReset().mockImplementation(async () => stored.length > 0);
  db.read
    .mockReset()
    .mockImplementation(
      async (_db, scope: { models: { credentialId: string; modelId: string }[] }) =>
        stored.filter((rest) =>
          scope.models.some(
            (item) => item.credentialId === rest.credentialId && item.modelId === rest.modelId,
          ),
        ),
    );
  db.record.mockReset().mockResolvedValue(true);
  db.end.mockReset().mockResolvedValue(1);
  // A backup that names no connection runs on the provider's own choice: "<provider>-connection".
  db.find.mockReset().mockImplementation(async (_db, _scope, provider: string) => ({
    id: `${provider}-connection`,
  }));
  model.resolve.mockReset().mockResolvedValue({ apiKey: "key", redact: [] });
  model.billing.mockReset().mockResolvedValue(false);
});

const rest = (credentialId: string, modelId: string, resetsAt: number) =>
  stored.push({ credentialId, modelId, resetsAt: new Date(resetsAt) });

describe("backupsPastRests", () => {
  const backups = [
    { provider: "p", modelId: "one", credentialId: "c1" },
    { provider: "q", modelId: "two" },
    { provider: "p", modelId: "three", credentialId: "c1" },
  ];

  it("keeps the order and reads nothing more when nothing of the person's rests", async () => {
    expect(await backupsPastRests(prisma, "user-1", backups, NOW)).toBe(backups);
    expect(db.read).not.toHaveBeenCalled();
    expect(db.find).not.toHaveBeenCalled();
    expect(await backupsPastRests(prisma, "user-1", [], NOW)).toEqual([]);
  });

  it("moves resting ones to the end in their order, on the connection each runs on", async () => {
    rest("c1", "one", NOW + HOUR);
    rest("q-connection", "two", NOW + HOUR);
    rest("c1", "three", NOW - 1);
    expect(await backupsPastRests(prisma, "user-1", backups, NOW)).toEqual([
      backups[2],
      backups[0],
      backups[1],
    ]);
    expect(db.find).toHaveBeenCalledWith(prisma, { userId: "user-1" }, "q", "two");
  });

  it("leaves the order as it was when the rests cannot be read", async () => {
    db.has.mockRejectedValue(new Error("database down"));
    expect(await backupsPastRests(prisma, "user-1", backups, NOW)).toBe(backups);
  });

  it("ignores a backup with no connection of the person's", async () => {
    rest("c1", "one", NOW + HOUR);
    db.find.mockResolvedValue(null);
    expect(await backupsPastRests(prisma, "user-1", backups, NOW)).toEqual([
      backups[1],
      backups[2],
      backups[0],
    ]);
  });
});

describe("startPastRest", () => {
  const selected = { provider: "p", id: "main", credential: { id: "c1" } };
  const backup = { provider: "q", id: "backup" };

  it("starts on the next backup while the chosen model rests", async () => {
    rest("c1", "main", NOW + HOUR);
    const onBackup = vi.fn(async () => backup);
    expect(
      await startPastRest(prisma, { userId: "user-1" }, selected, undefined, onBackup, NOW),
    ).toBe(backup);
  });

  it("starts on the chosen model again once its rest has passed", async () => {
    rest("c1", "main", NOW - 1);
    const onBackup = vi.fn(async () => backup);
    expect(
      await startPastRest(prisma, { userId: "user-1" }, selected, undefined, onBackup, NOW),
    ).toBeUndefined();
    expect(onBackup).not.toHaveBeenCalled();
  });

  it("starts on the chosen model when no backup starts", async () => {
    rest("c1", "main", NOW + HOUR);
    expect(
      await startPastRest(
        prisma,
        { userId: "user-1" },
        selected,
        undefined,
        async () => undefined,
        NOW,
      ),
    ).toBeUndefined();
  });

  it("ends the rest instead for a run asked for that model, and starts on it", async () => {
    rest("c1", "main", NOW + HOUR);
    const onBackup = vi.fn(async () => backup);
    expect(
      await startPastRest(
        prisma,
        { userId: "user-1", modelPinned: true },
        selected,
        undefined,
        onBackup,
        NOW,
      ),
    ).toBeUndefined();
    expect(onBackup).not.toHaveBeenCalled();
    expect(db.end).toHaveBeenCalledWith(prisma, {
      userId: "user-1",
      providers: ["p"],
      modelId: "main",
    });
  });

  it("never skips the deployment's model or a computer's saved models", async () => {
    rest("c1", "main", NOW + HOUR);
    const onBackup = vi.fn(async () => backup);
    const user = { userId: "user-1" };
    expect(
      await startPastRest(
        prisma,
        user,
        { ...selected, credential: null },
        undefined,
        onBackup,
        NOW,
      ),
    ).toBeUndefined();
    expect(
      await startPastRest(prisma, user, selected, { saved: true }, onBackup, NOW),
    ).toBeUndefined();
    expect(onBackup).not.toHaveBeenCalled();
  });

  it("starts on the chosen model when its rest cannot be read", async () => {
    db.has.mockRejectedValue(new Error("database down"));
    expect(
      await startPastRest(
        prisma,
        { userId: "user-1" },
        selected,
        undefined,
        async () => backup,
        NOW,
      ),
    ).toBeUndefined();
  });
});

describe("recordRest and modelPicked", () => {
  it("rests a model until the provider's reset, else the pool's default rest", async () => {
    const before = Date.now();
    await recordRest(prisma, "user-1", { connectionId: "c1", modelId: "m" }, "exhausted");
    const [, first] = db.record.mock.calls[0]!;
    expect(first).toMatchObject({
      userId: "user-1",
      credentialId: "c1",
      modelId: "m",
      reason: "exhausted",
    });
    expect(first.resetsAt.getTime() - before).toBeGreaterThanOrEqual(POOL_COOLDOWN_DEFAULT_MS);
    const reset = Date.now() + 3 * HOUR;
    await recordRest(prisma, "user-1", { connectionId: "c1", modelId: "m" }, "rejected", reset);
    expect(db.record.mock.calls[1]?.[1]).toMatchObject({ modelId: null, reason: "rejected" });
    expect(db.record.mock.calls[1]?.[1].resetsAt.getTime()).toBe(reset);
  });

  it("never fails the run when a rest cannot be written or ended", async () => {
    db.record.mockRejectedValue(new Error("database down"));
    db.end.mockRejectedValue(new Error("database down"));
    await expect(
      recordRest(prisma, "user-1", { connectionId: "c1", modelId: "m" }, "exhausted"),
    ).resolves.toBeUndefined();
    await expect(
      modelPicked(prisma, "user-1", { provider: "p", modelId: "m" }),
    ).resolves.toBeUndefined();
  });

  it("ends nothing for no pick", async () => {
    await modelPicked(prisma, "user-1", null);
    await modelPicked(prisma, "user-1", { provider: "", modelId: "m" });
    expect(db.end).not.toHaveBeenCalled();
  });
});

describe("a run's start (run-model-start.ts through its rule)", () => {
  const deps = { prisma } as never;
  const selected = {
    provider: "p",
    id: "main",
    credential: { id: "c1" } as never,
    thinkingLevel: null,
  };
  const backups = (start?: object) =>
    ({
      load: async () => [],
      unavailable: new Set(),
      startOnBackup: vi.fn(async () => start),
    }) as never;

  it("starts a run whose model rests on its next backup", async () => {
    rest("c1", "main", Date.now() + HOUR);
    const onBackup = { provider: "q", id: "backup" };
    const started = await startRunModel(
      deps,
      { userId: "user-1", spaceId: "space-1" },
      selected,
      undefined,
      backups(onBackup),
      () => undefined,
    );
    expect(started).toEqual({ start: onBackup });
    expect(model.resolve).not.toHaveBeenCalled();
  });

  it("starts on the chosen model as before when it does not rest", async () => {
    const started = await startRunModel(
      deps,
      { userId: "user-1", spaceId: "space-1" },
      selected,
      undefined,
      backups({ provider: "q", id: "backup" }),
      () => undefined,
    );
    expect(started.start).toMatchObject({ provider: "p", id: "main" });
    expect(model.resolve).toHaveBeenCalled();
  });
});
