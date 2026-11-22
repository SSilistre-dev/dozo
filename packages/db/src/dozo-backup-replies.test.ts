import { describe, expect, it, vi } from "vitest";
import { readBackupReplies, recordBackupReply } from "./dozo-backup-replies.js";

// The SQL itself runs in dozo-backup-replies.postgres.test.ts; this holds what each call sends.

function fakeDb(rows: unknown[] = []) {
  return {
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => rows),
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => 1),
  };
}

describe("recordBackupReply", () => {
  it("records the backup a run is answered by, on its chat and Space", async () => {
    const db = fakeDb();
    await recordBackupReply(db as never, { id: "run-1" }, { provider: "p", modelId: "m" });
    const [strings, ...values] = db.$executeRaw.mock.calls[0]!;
    expect(strings.join("?")).toContain('FROM "runs" r');
    expect(strings.join("?")).toContain("ON CONFLICT");
    expect(values).toEqual(["p", "m", "run-1"]);
  });

  it("clears it when the run is on the model it chose", async () => {
    const db = fakeDb();
    await recordBackupReply(db as never, { id: "run-1" }, null);
    expect(db.$executeRaw.mock.calls[0]?.[0].join("?")).toContain("DELETE FROM");
    expect(db.$executeRaw.mock.calls[0]?.slice(1)).toEqual(["run-1"]);
  });
});

describe("readBackupReplies", () => {
  it("reads the chat's latest replies a backup wrote for the caller's own runs", async () => {
    const rows = [{ messageId: "message-1", provider: "p", modelId: "m" }];
    const db = fakeDb(rows);
    expect(await readBackupReplies(db as never, "thread-1", "user-1")).toEqual(rows);
    const [strings, ...values] = db.$queryRaw.mock.calls[0]!;
    expect(strings.join("?")).toContain('r."userId" =');
    expect(values).toEqual(["user-1", "thread-1", 200]);
  });
});
