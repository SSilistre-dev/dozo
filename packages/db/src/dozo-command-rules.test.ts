import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import {
  dozoCommandComputer,
  dozoSpaceHasComputer,
  findDozoCommandRuleWords,
  listDozoCommandRules,
  readDozoCommandRules,
  readDozoHostedAsks,
  removeDozoCommandRule,
  saveDozoCommandRule,
  saveDozoHostedAsks,
  updateDozoCommandRule,
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

const owner = { userId: "user-1", spaceId: "space-1", botId: "bot-1", computer: "user" as const };
const member = { userId: "user-1", spaceId: "space-1" };

describe("dozoCommandComputer", () => {
  it("names the computer of each tool whose approvals save command rules", () => {
    expect(dozoCommandComputer("user_computer_shell")).toBe("user");
    expect(dozoCommandComputer("shell")).toBe("hosted");
    expect(dozoCommandComputer("browser_act")).toBeUndefined();
    expect(dozoCommandComputer("toString")).toBeUndefined();
  });
});

describe("saveDozoCommandRule", () => {
  it("saves the command's words and folder for the bot, on the card's computer", async () => {
    const { db, calls } = fakeDb();
    await saveDozoCommandRule(
      db,
      { id: "effect-1", request: { command: "npm run 'build all'", cwd: " ~/app " } },
      { ...owner, computer: "hosted" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("INSERT INTO dozo_command_policies");
    expect(calls[0]!.sql).toContain("DO NOTHING");
    expect(calls[0]!.values).toEqual([
      "user-1",
      "space-1",
      "bot-1",
      "hosted",
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

describe("readDozoCommandRules", () => {
  it("reads every rule of this member's bot", async () => {
    const rule = { words: ["make"], cwd: "", effect: "block", computer: "user" };
    const { db, calls } = fakeDb([rule]);
    expect(await readDozoCommandRules(db, { userId: "user-1", botId: "bot-1" })).toEqual([rule]);
    expect(calls[0]!.values).toEqual(["user-1", "bot-1"]);
  });
});

describe("the member's rules in the Space", () => {
  it("lists, finds, changes and removes only the member's rules in the Space", async () => {
    const row = { id: "rule-1", botId: "bot-1", botName: "Chef", words: ["make"], cwd: "" };
    const { db, calls } = fakeDb([row]);
    expect(await listDozoCommandRules(db, member)).toEqual([row]);
    expect(await findDozoCommandRuleWords(db, member, "rule-1")).toEqual(["make"]);
    await updateDozoCommandRule(db, member, "rule-1", "block");
    await removeDozoCommandRule(db, member, "rule-1");
    expect(calls.map((call) => call.values)).toEqual([
      ["user-1", "space-1"],
      ["rule-1", "user-1", "space-1"],
      ["block", "rule-1", "user-1", "space-1"],
      ["rule-1", "user-1", "space-1"],
    ]);
    expect(calls[2]!.sql).toContain("UPDATE dozo_command_policies");
    expect(calls[3]!.sql).toContain("DELETE FROM dozo_command_policies");
    expect(await findDozoCommandRuleWords(fakeDb([]).db, member, "rule-2")).toBeUndefined();
  });
});

describe("the bot's computer setting", () => {
  it("reads false until the member turns it on, and saves it", async () => {
    expect(await readDozoHostedAsks(fakeDb([]).db, "user-1")).toBe(false);
    expect(await readDozoHostedAsks(fakeDb([{ hostedAsks: true }]).db, "user-1")).toBe(true);
    const { db, calls } = fakeDb();
    await saveDozoHostedAsks(db, "user-1", true);
    expect(calls[0]!.values).toEqual(["user-1", true]);
  });

  it("tells whether the Space has a computer", async () => {
    expect(await dozoSpaceHasComputer(fakeDb([{ id: "c" }]).db, "space-1")).toBe(true);
    expect(await dozoSpaceHasComputer(fakeDb([]).db, "space-1")).toBe(false);
  });
});
