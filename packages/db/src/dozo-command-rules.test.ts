import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import {
  dozoCommandRuleExists,
  listDozoCommandRules,
  removeDozoCommandRule,
  saveDozoCommandRule,
} from "./dozo-command-rules.js";

function fakeDb(rows: unknown[] = []) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const record = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join("?"), values });
    return Promise.resolve(rows);
  };
  const db = { $queryRaw: vi.fn(record), $executeRaw: vi.fn(record) };
  return { db: db as unknown as Prisma.TransactionClient, calls };
}

const owner = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };

describe("saveDozoCommandRule", () => {
  it("saves the command's words and folder for the bot", async () => {
    const { db, calls } = fakeDb();
    await saveDozoCommandRule(
      db,
      { id: "effect-1", request: { command: "npm run 'build all'", cwd: " ~/app " } },
      owner,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("INSERT INTO dozo_command_rules");
    expect(calls[0]!.sql).toContain("ON CONFLICT");
    expect(calls[0]!.values).toEqual([
      "user-1",
      "space-1",
      "bot-1",
      ["npm", "run", "build all"],
      "~/app",
    ]);
  });

  it("keeps the home folder as ''", async () => {
    const { db, calls } = fakeDb();
    await saveDozoCommandRule(
      db,
      { id: "effect-1", request: { command: "make", cwd: "~" } },
      owner,
    );
    expect(calls[0]!.values.at(-1)).toBe("");
  });

  it("saves nothing for a command it cannot read or a request of another shape", async () => {
    const { db, calls } = fakeDb();
    await saveDozoCommandRule(db, { id: "e", request: { command: "ls; rm -rf ~" } }, owner);
    await saveDozoCommandRule(db, { id: "e", request: { command: "npm test > out" } }, owner);
    await saveDozoCommandRule(db, { id: "e", request: { cmd: "npm test" } }, owner);
    await saveDozoCommandRule(db, { id: "e", request: null }, owner);
    expect(calls).toEqual([]);
  });
});

describe("dozoCommandRuleExists", () => {
  it("looks for the exact words and folder of this member's bot", async () => {
    const found = fakeDb([{ id: "rule-1" }]);
    const key = { userId: "user-1", botId: "bot-1", words: ["npm", "test"], cwd: "" };
    expect(await dozoCommandRuleExists(found.db, key)).toBe(true);
    expect(found.calls[0]!.values).toEqual(["user-1", "bot-1", ["npm", "test"], ""]);
    expect(await dozoCommandRuleExists(fakeDb([]).db, key)).toBe(false);
  });
});

describe("listDozoCommandRules and removeDozoCommandRule", () => {
  it("reads and removes only the member's rules in the Space", async () => {
    const row = { id: "rule-1", botId: "bot-1", botName: "Chef", words: ["make"], cwd: "" };
    const { db, calls } = fakeDb([row]);
    const member = { userId: "user-1", spaceId: "space-1" };
    expect(await listDozoCommandRules(db, member)).toEqual([row]);
    await removeDozoCommandRule(db, member, "rule-1");
    expect(calls.map((call) => call.values)).toEqual([
      ["user-1", "space-1"],
      ["rule-1", "user-1", "space-1"],
    ]);
    expect(calls[1]!.sql).toContain("DELETE FROM dozo_command_rules");
  });
});
