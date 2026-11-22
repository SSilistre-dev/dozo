import { deferred } from "@rakazo/core/test-async";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  recordBackupReply: db.record,
}));

import { runStartedOn, runSwitchedTo } from "./dozo-backup-replies.js";

const prisma = { marker: "prisma" } as never;
const run = { id: "run-1" };

beforeEach(() => {
  db.record.mockReset().mockResolvedValue(undefined);
});

describe("runStartedOn", () => {
  it("records a run that starts on a backup, and clears one that starts on its chosen model", async () => {
    await runStartedOn(prisma, run, { provider: "p", id: "main" }, { provider: "q", id: "backup" });
    expect(db.record).toHaveBeenLastCalledWith(prisma, run, { provider: "q", modelId: "backup" });
    await runStartedOn(prisma, run, { provider: "p", id: "main" }, { provider: "p", id: "main" });
    expect(db.record).toHaveBeenLastCalledWith(prisma, run, null);
  });

  it("does not hold up a run that starts on its chosen model while it clears the mark", async () => {
    const clearing = deferred<undefined>();
    db.record.mockReturnValue(clearing.promise);
    await runStartedOn(prisma, run, { provider: "p", id: "main" }, { provider: "p", id: "main" });
    expect(db.record).toHaveBeenCalledWith(prisma, run, null);
    clearing.resolve(undefined);
  });

  it("records nothing for a run that chose no model", async () => {
    await runStartedOn(prisma, run, { provider: null, id: null }, { provider: "q", id: "x" });
    expect(db.record).not.toHaveBeenCalled();
  });

  it("never fails the run", async () => {
    db.record.mockRejectedValue(new Error("database down"));
    await expect(
      runStartedOn(prisma, run, { provider: "p", id: "main" }, { provider: "q", id: "b" }),
    ).resolves.toBeUndefined();
  });
});

describe("runSwitchedTo", () => {
  it("records a switch to another model during the run, and nothing for its own", async () => {
    await runSwitchedTo(prisma, run, { provider: "p", id: "main" }, { provider: "p", id: "main" });
    expect(db.record).not.toHaveBeenCalled();
    await runSwitchedTo(prisma, run, { provider: "p", id: "main" }, { provider: "q", id: "b" });
    expect(db.record).toHaveBeenCalledWith(prisma, run, { provider: "q", modelId: "b" });
  });
});
