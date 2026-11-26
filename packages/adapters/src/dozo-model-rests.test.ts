import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  active: vi.fn(),
  record: vi.fn(),
  end: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  readActiveModelRests: db.active,
  recordModelRest: db.record,
  endModelRests: db.end,
}));
vi.mock("./models/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./models/model-selection.js")>()),
  findConnectedModelCredential: db.resolve,
}));
const model = vi.hoisted(() => ({ resolve: vi.fn(), billing: vi.fn() }));
vi.mock("./runs/turn/run-model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runs/turn/run-model.js")>()),
  resolveModelKey: model.resolve,
  modelCreditBillingEnabled: model.billing,
}));

import { POOL_COOLDOWN_DEFAULT_MS, POOL_REFUSED_COOLDOWN_MS } from "@rakazo/core";
import { backupsPastRests, modelPicked, recordRest, startPastRest } from "./dozo-model-rests.js";
import { startRunModel } from "./runs/turn/run-model-start.js";

const prisma = { marker: "prisma" } as never;
const deps = { prisma, secretStore: { load: vi.fn() } } as never;
const NOW = Date.UTC(2026, 10, 22, 10);
const HOUR = 60 * 60_000;
/** The person's rests that have not ended, as the store answers them. */
let stored: Array<{ credentialId: string; modelId: string; resetsAt: Date }> = [];
const newRun = (extra: object = {}) => ({ userId: "user-1", spaceId: "space-1", ...extra });

beforeEach(() => {
  stored = [];
  db.active.mockReset().mockImplementation(async () => stored);
  db.record.mockReset().mockResolvedValue(true);
  db.end.mockReset().mockResolvedValue(1);
  // As the run resolves it: a named connection, else the provider's: "<provider>-connection".
  db.resolve
    .mockReset()
    .mockImplementation(
      async (_db, _store, _actor, provider: string, _model, opts: { credentialId?: string }) => ({
        id: opts.credentialId ?? `${provider}-connection`,
      }),
    );
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
  const role = { primary: null, backups };

  it("keeps the list as it was and resolves nothing when nothing of the person's rests", async () => {
    expect(await backupsPastRests(deps, newRun(), role, NOW)).toBe(role);
    expect(db.resolve).not.toHaveBeenCalled();
    const empty = { backups: [] };
    expect(await backupsPastRests(deps, newRun(), empty, NOW)).toBe(empty);
  });

  it("moves resting ones to the end in their order, on the connection the run resolves", async () => {
    rest("c1", "one", NOW + HOUR);
    rest("q-connection", "two", NOW + HOUR);
    const run = newRun();
    expect((await backupsPastRests(deps, run, role, NOW)).backups).toEqual([
      backups[2],
      backups[0],
      backups[1],
    ]);
    expect(db.resolve).toHaveBeenCalledWith(prisma, expect.anything(), run, "q", "two", {
      credentialId: undefined,
    });
  });

  it("rests every model of a connection whose key was refused", async () => {
    rest("c1", "", NOW + HOUR);
    expect((await backupsPastRests(deps, newRun(), role, NOW)).backups).toEqual([
      backups[1],
      backups[0],
      backups[2],
    ]);
  });

  it("leaves the order as it was when the rests or a connection cannot be read", async () => {
    db.active.mockRejectedValue(new Error("database down"));
    expect(await backupsPastRests(deps, newRun(), role, NOW)).toBe(role);
    db.active.mockReset().mockImplementation(async () => stored);
    rest("c1", "one", NOW + HOUR);
    db.resolve.mockRejectedValue(new Error("database down"));
    expect(await backupsPastRests(deps, newRun(), role, NOW)).toBe(role);
  });

  it("ignores a backup the person has no connection for", async () => {
    rest("q-connection", "two", NOW + HOUR);
    db.resolve.mockResolvedValue(null);
    expect(await backupsPastRests(deps, newRun(), role, NOW)).toBe(role);
  });
});

describe("startPastRest", () => {
  const selected = { provider: "p", id: "main", credential: { id: "c1" } };
  const backup = { provider: "q", id: "backup" };

  it("starts on the next backup while the chosen model rests", async () => {
    rest("c1", "main", NOW + HOUR);
    expect(await startPastRest(deps, newRun(), selected, undefined, async () => backup, NOW)).toBe(
      backup,
    );
  });

  it("reads the person's rests once for a run's start and its backups", async () => {
    rest("c1", "main", NOW + HOUR);
    const run = newRun();
    await startPastRest(deps, run, selected, undefined, async () => backup, NOW);
    await backupsPastRests(deps, run, { backups: [{ provider: "p", modelId: "x" }] }, NOW);
    expect(db.active).toHaveBeenCalledTimes(1);
    expect(db.active).toHaveBeenCalledWith(prisma, "user-1", new Date(NOW));
    await startPastRest(deps, newRun(), selected, undefined, async () => backup, NOW);
    expect(db.active).toHaveBeenCalledTimes(2);
  });

  it("starts on the chosen model again once its rest has passed, or when no backup starts", async () => {
    rest("c1", "main", NOW - 1);
    const onBackup = vi.fn(async () => backup);
    expect(await startPastRest(deps, newRun(), selected, undefined, onBackup, NOW)).toBeUndefined();
    expect(onBackup).not.toHaveBeenCalled();
    stored = [];
    rest("c1", "main", NOW + HOUR);
    expect(
      await startPastRest(deps, newRun(), selected, undefined, async () => undefined, NOW),
    ).toBeUndefined();
  });

  it("keeps the rest for a run that keeps its model, whoever started it", async () => {
    rest("c1", "main", NOW + HOUR);
    const onBackup = vi.fn(async () => backup);
    for (const trigger of ["user", "routine", "spawn", "webhook", "resume"]) {
      const run = newRun({ modelPinned: true, trigger });
      expect(await startPastRest(deps, run, selected, undefined, onBackup, NOW)).toBeUndefined();
    }
    expect(onBackup).not.toHaveBeenCalled();
    expect(db.end).not.toHaveBeenCalled();
  });

  it("never skips the deployment's model or a computer's saved models", async () => {
    rest("c1", "main", NOW + HOUR);
    const onBackup = vi.fn(async () => backup);
    const noConnection = { ...selected, credential: null };
    expect(await startPastRest(deps, newRun(), noConnection, undefined, onBackup, NOW)).toBe(
      undefined,
    );
    expect(await startPastRest(deps, newRun(), selected, { saved: true }, onBackup, NOW)).toBe(
      undefined,
    );
    expect(onBackup).not.toHaveBeenCalled();
  });
});

describe("recordRest and modelPicked", () => {
  it("rests a model until the provider's reset, else the default; a refused key a few minutes", async () => {
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
    await recordRest(prisma, "user-1", { connectionId: "c1", modelId: "m" }, "rejected");
    const [, refused] = db.record.mock.calls[1]!;
    expect(refused).toMatchObject({ modelId: null, reason: "rejected" });
    expect(refused.resetsAt.getTime() - refused.observedAt.getTime()).toBe(
      POOL_REFUSED_COOLDOWN_MS,
    );
    const reset = Date.now() + 3 * HOUR;
    await recordRest(prisma, "user-1", { connectionId: "c1", modelId: "m" }, "exhausted", reset);
    expect(db.record.mock.calls[2]?.[1].resetsAt.getTime()).toBe(reset);
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

describe("a run's start (run-model-start.ts through its rules)", () => {
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
      newRun(),
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
      newRun(),
      selected,
      undefined,
      backups({ provider: "q", id: "backup" }),
      () => undefined,
    );
    expect(started.start).toMatchObject({ provider: "p", id: "main" });
    expect(model.resolve).toHaveBeenCalled();
  });
});
