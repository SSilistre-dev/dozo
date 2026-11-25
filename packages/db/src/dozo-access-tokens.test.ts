import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./database/client.js";
import {
  createDozoAccessToken,
  DOZO_ACCESS_TOKEN_LIMIT,
  DOZO_ACCESS_TOKEN_PREFIX,
  dozoAccessTokenHash,
  dozoAccessTokenStillValid,
  findDozoAccessToken,
  listDozoAccessTokens,
  looksLikeDozoAccessToken,
  revokeDozoAccessToken,
  takeDozoApiMinute,
  touchDozoAccessToken,
  trustDozoBot,
} from "./dozo-access-tokens.js";

/** The text of a nested SQL fragment among a call's values. */
const fragment = (values: unknown[]) =>
  values.map((value) => (value as { sql?: string })?.sql ?? "").join("");

function fakeDb(answer: unknown = []) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const record = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join("?"), values });
    return Promise.resolve(answer);
  };
  const db = { $queryRaw: vi.fn(record), $executeRaw: vi.fn(record) };
  return { db: db as unknown as Prisma.TransactionClient, calls };
}

const member = { userId: "user-1", spaceId: "space-1" };

describe("createDozoAccessToken", () => {
  it("stores only the hash and the last four characters, under the member's limit", async () => {
    const createdAt = new Date("2026-11-21T10:00:00Z");
    const { db, calls } = fakeDb([{ id: "token-1", createdAt }]);
    const expiresAt = new Date("2027-02-19T10:00:00Z");
    const created = await createDozoAccessToken(db, member, {
      name: "CI",
      botId: "bot-1",
      expiresAt,
    });

    expect(created).not.toBeNull();
    const { token, row } = created!;
    expect(token.startsWith(DOZO_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(looksLikeDozoAccessToken(token)).toBe(true);
    expect(row).toEqual({
      id: "token-1",
      name: "CI",
      botId: "bot-1",
      botName: null,
      hint: token.slice(-4),
      createdAt,
      lastUsedAt: null,
      expiresAt,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("INSERT INTO dozo_access_tokens");
    expect(calls[0]!.sql).toContain("count(*)");
    expect(calls[0]!.values).toContain(dozoAccessTokenHash(token));
    expect(calls[0]!.values).not.toContain(token);
    expect(calls[0]!.values).toContain(DOZO_ACCESS_TOKEN_LIMIT);
    expect(calls[0]!.values).toContain(expiresAt.toISOString());
  });

  it("makes a different token every time", async () => {
    const { db } = fakeDb([{ id: "token-1", createdAt: new Date() }]);
    const first = await createDozoAccessToken(db, member, {
      name: "a",
      botId: null,
      expiresAt: null,
    });
    const second = await createDozoAccessToken(db, member, {
      name: "b",
      botId: null,
      expiresAt: null,
    });
    expect(first!.token).not.toBe(second!.token);
  });

  it("answers null when the member holds the most tokens allowed", async () => {
    const { db } = fakeDb([]);
    expect(
      await createDozoAccessToken(db, member, { name: "CI", botId: null, expiresAt: null }),
    ).toBeNull();
  });
});

describe("tokens by member", () => {
  it("lists only the member's tokens in the Space", async () => {
    const { db, calls } = fakeDb([{ id: "token-1" }]);
    expect(await listDozoAccessTokens(db, member)).toEqual([{ id: "token-1" }]);
    expect(calls[0]!.sql).toContain('t."userId" = ? AND t."spaceId" = ?');
    expect(calls[0]!.values.slice(0, 2)).toEqual(["user-1", "space-1"]);
    // Expired tokens and those older than a password change are not listed.
    expect(fragment(calls[0]!.values)).toContain('"expiresAt" > now()');
    expect(fragment(calls[0]!.values)).toContain("'auth.password.changed'");
  });

  it("revokes only the member's own token and says whether one went", async () => {
    const gone = fakeDb(1);
    expect(await revokeDozoAccessToken(gone.db, member, "token-1")).toBe(true);
    expect(gone.calls[0]!.sql).toContain("DELETE FROM dozo_access_tokens");
    expect(gone.calls[0]!.values).toEqual(["token-1", "user-1", "space-1"]);
    expect(await revokeDozoAccessToken(fakeDb(0).db, member, "token-2")).toBe(false);
  });
});

describe("finding a token", () => {
  it("looks a token up by its hash, never by the token", async () => {
    const owner = { id: "token-1", userId: "user-1" };
    const { db, calls } = fakeDb([owner]);
    const token = `${DOZO_ACCESS_TOKEN_PREFIX}${"a".repeat(43)}`;
    expect(await findDozoAccessToken(db, token)).toEqual(owner);
    expect(calls[0]!.values[0]).toBe(dozoAccessTokenHash(token));
    expect(fragment(calls[0]!.values)).toContain("'auth.password.changed'");
    expect(await findDozoAccessToken(fakeDb([]).db, token)).toBeNull();
  });

  it("asks whether the member's token still holds as finding it does", () => {
    const condition = dozoAccessTokenStillValid("token-1", member);
    expect(condition.values.slice(0, 3)).toEqual(["token-1", "user-1", "space-1"]);
    expect(condition.sql).toContain("'auth.password.changed'");
    expect(condition.sql).toContain('"expiresAt" IS NULL');
  });

  it("tells a token's shape from anything else", () => {
    expect(looksLikeDozoAccessToken(`${DOZO_ACCESS_TOKEN_PREFIX}${"A_-9".repeat(10)}abc`)).toBe(
      true,
    );
    expect(looksLikeDozoAccessToken(`${DOZO_ACCESS_TOKEN_PREFIX}short`)).toBe(false);
    expect(looksLikeDozoAccessToken(`other_${"a".repeat(43)}`)).toBe(false);
    expect(looksLikeDozoAccessToken(`${DOZO_ACCESS_TOKEN_PREFIX}${"a".repeat(42)}!`)).toBe(false);
  });

  it("marks a token used at most once a minute", async () => {
    const { db, calls } = fakeDb(1);
    const now = new Date("2026-11-21T10:00:00Z");
    await touchDozoAccessToken(db, "token-1", now);
    expect(calls[0]!.sql).toContain('"lastUsedAt" IS NULL OR "lastUsedAt" < ?');
    expect(calls[0]!.values).toEqual([now.toISOString(), "token-1", "2026-11-21T09:59:00.000Z"]);
    await touchDozoAccessToken(db, "token-1");
    expect(calls).toHaveLength(2);
  });
});

describe("takeDozoApiMinute", () => {
  it("counts in the current minute and drops older ones", async () => {
    const { db, calls } = fakeDb([{ count: 3 }]);
    const now = new Date("2026-11-21T10:00:42.500Z");
    expect(await takeDozoApiMinute(db, "token:t-1", 60, now)).toBe(true);
    const minute = new Date("2026-11-21T10:00:00.000Z");
    expect(calls[0]!.sql).toContain("DELETE FROM dozo_api_minutes");
    expect(calls[0]!.values).toEqual(["token:t-1", minute.toISOString()]);
    expect(calls[1]!.sql).toContain("ON CONFLICT (key, minute)");
    expect(calls[1]!.values).toEqual(["token:t-1", minute.toISOString(), 60]);
    expect(await takeDozoApiMinute(fakeDb([]).db, "token:t-1", 60)).toBe(false);
  });
});

describe("trustDozoBot", () => {
  it("records when the owner trusted the bot again, in the bot's own Space, once per bot", async () => {
    const { db, calls } = fakeDb(1);
    const now = new Date("2026-11-21T10:00:00.000Z");
    await trustDozoBot(db, { spaceId: "space-1", botId: "bot-1", userId: "user-1" }, now);
    expect(calls[0]!.sql).toContain("INSERT INTO dozo_token_trust");
    expect(calls[0]!.sql).toContain('ON CONFLICT ("botId") DO UPDATE');
    expect(calls[0]!.values).toEqual([now.toISOString(), "user-1", "bot-1", "space-1"]);
    await trustDozoBot(db, { spaceId: "space-1", botId: "bot-1", userId: "user-1" });
    expect(calls).toHaveLength(2);
  });
});
