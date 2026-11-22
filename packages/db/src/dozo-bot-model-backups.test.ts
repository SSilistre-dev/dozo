import { describe, expect, it, vi } from "vitest";
import { readBotModelBackups, writeBotModelBackups } from "./dozo-bot-model-backups.js";

// The SQL itself runs in dozo-bot-model-backups.postgres.test.ts; this holds what each call sends
// and how it reads the answer, without a database.

function fakeDb(answers: { query?: unknown[]; execute?: number } = {}) {
  return {
    $queryRaw: vi.fn(
      async (_strings: TemplateStringsArray, ..._values: unknown[]) => answers.query ?? [],
    ),
    $executeRaw: vi.fn(
      async (_strings: TemplateStringsArray, ..._values: unknown[]) => answers.execute ?? 0,
    ),
  };
}

const bot = { botId: "bot-1", spaceId: "space-1" };
const backups = [
  { provider: "provider-a", modelId: "model-a" },
  { provider: "provider-b", modelId: "model-b", credentialId: "connection-b", thinkingLevel: null },
];

describe("readBotModelBackups", () => {
  it("is empty for a bot without a row", async () => {
    const db = fakeDb();
    expect(await readBotModelBackups(db as never, "bot-1")).toEqual([]);
    expect(db.$queryRaw.mock.calls[0]?.slice(1)).toEqual(["bot-1"]);
  });

  it("answers the stored list in order", async () => {
    expect(await readBotModelBackups(fakeDb({ query: [{ backups }] }) as never, "bot-1")).toEqual(
      backups,
    );
  });

  it("answers none for a list that no longer reads, as having none does", async () => {
    const db = fakeDb({ query: [{ backups: [{ provider: "" }] }] });
    expect(await readBotModelBackups(db as never, "bot-1")).toEqual([]);
  });
});

describe("writeBotModelBackups", () => {
  it("clears the bot's list with an empty one", async () => {
    const db = fakeDb();
    expect(await writeBotModelBackups(db as never, bot, [])).toBe(true);
    expect(db.$executeRaw.mock.calls[0]?.[0].join("?")).toContain("DELETE FROM");
    expect(db.$executeRaw.mock.calls[0]?.slice(1)).toEqual(["bot-1", "space-1"]);
  });

  it("saves the list as one row of the bot's Space", async () => {
    const db = fakeDb({ execute: 1 });
    expect(await writeBotModelBackups(db as never, bot, backups)).toBe(true);
    const [strings, ...values] = db.$executeRaw.mock.calls[0]!;
    expect(strings.join("?")).toContain("ON CONFLICT");
    expect(values).toEqual([JSON.stringify(backups), "bot-1", "space-1"]);
  });

  it("says when the bot is not in that Space", async () => {
    expect(await writeBotModelBackups(fakeDb({ execute: 0 }) as never, bot, backups)).toBe(false);
  });
});
