import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  members: new Map<string, Date | null>(),
  readModelPoolMembers: vi.fn(),
  setModelPoolMember: vi.fn(),
}));

vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  readModelPoolMembers: db.readModelPoolMembers,
  setModelPoolMember: db.setModelPoolMember,
}));

import { readDozoModelPool, setDozoModelPool } from "./dozo-model-pool-settings.js";
import { serializeModelSecret } from "./models/model-secret.js";

const now = Date.UTC(2026, 10, 20, 12);
const HOUR = 60 * 60_000;
const USER = "user-1";

const key = (id: string) => serializeModelSecret({ kind: "api_key", key: `fake-key-${id}` });
const signInAs = (accountId: string) =>
  serializeModelSecret({
    kind: "oauth",
    credential: {
      type: "oauth",
      access: "fake-access",
      refresh: "fake-refresh",
      expires: 1,
      accountId,
    },
  });
const signIn = signInAs("account-1");
const signedOut = JSON.stringify({ kind: "oauth", reconnectRequired: true });

/** Connections in the order added: provider-a's a, b, s (a subscription sign-in), then others. */
function deps(
  connections: { id: string; provider: string; secret?: string }[] = [
    { id: "a", provider: "provider-a" },
    { id: "b", provider: "provider-a" },
    { id: "s", provider: "provider-a", secret: signIn },
    { id: "z", provider: "provider-z" },
  ],
) {
  const secrets = Object.fromEntries(
    connections.map((connection) => [
      `secret-${connection.id}`,
      connection.secret ?? key(connection.id),
    ]),
  );
  const tx = { tx: true };
  return {
    tx,
    deps: {
      prisma: {
        userModelCredential: {
          findMany: vi.fn(async () =>
            connections.map(({ id, provider }) => ({ id, provider, secretId: `secret-${id}` })),
          ),
        },
        secret: {
          findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
            secrets[where.id] ? { id: where.id, ciphertext: `sealed-${where.id}` } : null,
          ),
        },
        $transaction: vi.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx)),
      },
      secretStore: { load: vi.fn(async (_ciphertext: string, id: string) => secrets[id]) },
    } as never,
  };
}

beforeEach(() => {
  db.members = new Map();
  db.readModelPoolMembers
    .mockReset()
    .mockImplementation(async (_prisma, scope) =>
      scope.credentialIds
        .filter((id: string) => db.members.has(id))
        .map((id: string) => ({ credentialId: id, resetsAt: db.members.get(id) })),
    );
  db.setModelPoolMember
    .mockReset()
    .mockImplementation(async (_tx, owner: { credentialId: string }, pooled: boolean) => {
      if (pooled) db.members.set(owner.credentialId, db.members.get(owner.credentialId) ?? null);
      else db.members.delete(owner.credentialId);
      return true;
    });
});

describe("readDozoModelPool", () => {
  it("offers a pool where two connections of one provider may join one, sign-ins included", async () => {
    expect(await readDozoModelPool(deps().deps, USER, now)).toEqual({
      connections: [
        { credentialId: "a", pooled: false },
        { credentialId: "b", pooled: false },
        { credentialId: "s", pooled: false },
      ],
    });
    expect(db.readModelPoolMembers).toHaveBeenCalledWith(expect.anything(), {
      userId: USER,
      credentialIds: ["a", "b", "s"],
      accounts: new Map([["s", expect.stringMatching(/^account:[0-9a-f]{32}$/)]]),
    });
  });

  it("offers one sign-in per account, and none that must be made again", async () => {
    const twice = deps([
      { id: "a", provider: "provider-a" },
      { id: "s", provider: "provider-a", secret: signIn },
      { id: "t", provider: "provider-a", secret: signIn },
      { id: "u", provider: "provider-a", secret: signedOut },
      { id: "v", provider: "provider-a", secret: signInAs("account-2") },
    ]);
    expect(
      (await readDozoModelPool(twice.deps, USER, now)).connections.map(
        (entry) => entry.credentialId,
      ),
    ).toEqual(["a", "s", "v"]);
    await expect(
      setDozoModelPool(twice.deps, USER, { credentialId: "t", pooled: true }, now),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
  });

  it("shows when a resting member opens, and nothing for a rest that ended", async () => {
    db.members = new Map([
      ["a", new Date(now + 2 * HOUR)],
      ["b", new Date(now - HOUR)],
    ]);
    expect(await readDozoModelPool(deps().deps, USER, now)).toEqual({
      connections: [
        { credentialId: "a", pooled: true, opensAt: new Date(now + 2 * HOUR).toISOString() },
        { credentialId: "b", pooled: true },
        { credentialId: "s", pooled: false },
      ],
    });
  });

  it("calls a lone member not pooled, since it has no one to hand over to", async () => {
    db.members = new Map([["a", new Date(now + HOUR)]]);
    expect(await readDozoModelPool(deps().deps, USER, now)).toEqual({
      connections: [
        { credentialId: "a", pooled: false },
        { credentialId: "b", pooled: false },
        { credentialId: "s", pooled: false },
      ],
    });
  });

  it("offers the first five connections added, and groups a renamed provider id with its own", async () => {
    const many = deps([
      ...["1", "2", "3", "4", "5", "6"].map((id) => ({ id, provider: "provider-a" })),
      { id: "x", provider: "azure" },
      { id: "y", provider: "azure-openai-responses" },
    ]);
    const pool = await readDozoModelPool(many.deps, USER, now);
    expect(pool.connections.map((entry) => entry.credentialId)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "x",
      "y",
    ]);
  });
});

describe("setDozoModelPool", () => {
  it("pools every offered connection of the provider in one transaction", async () => {
    const { deps: poolDeps, tx } = deps([
      { id: "a", provider: "provider-a" },
      { id: "b", provider: "provider-a" },
      { id: "s", provider: "provider-a", secret: signedOut },
      { id: "z", provider: "provider-z" },
    ]);
    const result = await setDozoModelPool(poolDeps, USER, { credentialId: "b", pooled: true }, now);
    expect(result).toEqual({
      provider: "provider-a",
      pool: {
        connections: [
          { credentialId: "a", pooled: true },
          { credentialId: "b", pooled: true },
        ],
      },
    });
    expect(db.setModelPoolMember.mock.calls).toEqual([
      [tx, { userId: USER, credentialId: "a" }, true],
      [tx, { userId: USER, credentialId: "b" }, true],
      [tx, { userId: USER, credentialId: "s" }, false],
    ]);
  });

  it("takes every connection of the provider out", async () => {
    db.members = new Map([
      ["a", null],
      ["b", null],
    ]);
    const result = await setDozoModelPool(
      deps().deps,
      USER,
      { credentialId: "a", pooled: false },
      now,
    );
    expect(result.pool.connections.every((entry) => !entry.pooled)).toBe(true);
    expect(db.members.size).toBe(0);
  });

  it("refuses a connection that may not join, and one that is not the person's", async () => {
    await expect(
      setDozoModelPool(deps().deps, USER, { credentialId: "z", pooled: true }, now),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
    await expect(
      setDozoModelPool(deps().deps, USER, { credentialId: "theirs", pooled: true }, now),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
    expect(db.setModelPoolMember).not.toHaveBeenCalled();
  });
});
