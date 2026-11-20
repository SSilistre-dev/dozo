import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "./client.js";
import {
  createDozoAccessToken,
  DOZO_ACCESS_TOKEN_LIMIT,
  DOZO_ACCESS_TOKEN_PREFIX,
  dozoAccessTokenHash,
  findDozoAccessToken,
  listDozoAccessTokens,
  looksLikeDozoAccessToken,
  revokeDozoAccessToken,
  touchDozoAccessToken,
} from "./dozo-access-tokens.js";

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
    const created = await createDozoAccessToken(db, member, { name: "CI", botId: "bot-1" });

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
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("INSERT INTO dozo_access_tokens");
    expect(calls[0]!.sql).toContain("count(*)");
    expect(calls[0]!.values).toContain(dozoAccessTokenHash(token));
    expect(calls[0]!.values).not.toContain(token);
    expect(calls[0]!.values).toContain(DOZO_ACCESS_TOKEN_LIMIT);
  });

  it("makes a different token every time", async () => {
    const { db } = fakeDb([{ id: "token-1", createdAt: new Date() }]);
    const first = await createDozoAccessToken(db, member, { name: "a", botId: null });
    const second = await createDozoAccessToken(db, member, { name: "b", botId: null });
    expect(first!.token).not.toBe(second!.token);
  });

  it("answers null when the member holds the most tokens allowed", async () => {
    const { db } = fakeDb([]);
    expect(await createDozoAccessToken(db, member, { name: "CI", botId: null })).toBeNull();
  });
});

describe("tokens by member", () => {
  it("lists only the member's tokens in the Space", async () => {
    const { db, calls } = fakeDb([{ id: "token-1" }]);
    expect(await listDozoAccessTokens(db, member)).toEqual([{ id: "token-1" }]);
    expect(calls[0]!.sql).toContain('t."userId" = ? AND t."spaceId" = ?');
    expect(calls[0]!.values).toEqual(["user-1", "space-1"]);
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
    expect(calls[0]!.values).toEqual([dozoAccessTokenHash(token)]);
    expect(await findDozoAccessToken(fakeDb([]).db, token)).toBeNull();
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
    expect(calls[0]!.values).toEqual([now, "token-1", new Date("2026-11-21T09:59:00Z")]);
    await touchDozoAccessToken(db, "token-1");
    expect(calls).toHaveLength(2);
  });
});
