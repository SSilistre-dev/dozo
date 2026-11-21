import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  createDozoAccessToken,
  DOZO_ACCESS_TOKEN_LIMIT,
  findDozoAccessToken,
  listDozoAccessTokens,
  revokeDozoAccessToken,
  takeDozoApiMinute,
  touchDozoAccessToken,
} from "./dozo-access-tokens.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";

// Runs on the branded tree only, against a migrated database: DATABASE_URL is the runtime login,
// which row security applies to. The fork's unit gate has no database and skips it.

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("access tokens (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  const users: string[] = [];

  async function member() {
    const id = `access-tokens-${randomUUID()}`;
    users.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name: "Ada", email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({ data: { id, name: "Personal", slug: id, createdAt } });
    await system.member.create({
      data: { id: `m-${id}`, organizationId: id, userId: id, role: "owner", createdAt },
    });
    const spaceId = randomUUID();
    await system.space.create({
      data: { id: spaceId, organizationId: id, name: "Home", createdByUserId: id },
    });
    await system.spaceMember.create({
      data: { id: randomUUID(), spaceId, organizationId: id, userId: id, role: "owner", createdAt },
    });
    const bot = await system.bot.create({
      data: { spaceId, userId: id, name: "Chef", color: "slate" },
    });
    return { userId: id, spaceId, botId: bot.id };
  }

  type Member = Awaited<ReturnType<typeof member>>;
  const make = (owner: Member, botId: string | null = null, expiresAt: Date | null = null) =>
    runAsTenant(owner, () =>
      createDozoAccessToken(prisma, owner, { name: "CI", botId, expiresAt }),
    );
  const find = (token: string) =>
    runAsSystem("test: find a token", () => findDozoAccessToken(prisma, token));

  beforeAll(() => {
    const db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = () => db.pool.end();
  });

  afterAll(async () => {
    await system.organization.deleteMany({ where: { id: { in: users } } });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await close();
  });

  it("makes a token that is found by itself, lists it with its bot, and marks it used", async () => {
    const owner = await member();
    const created = await make(owner, owner.botId);
    expect(await find(created!.token)).toEqual({
      id: created!.row.id,
      userId: owner.userId,
      spaceId: owner.spaceId,
      botId: owner.botId,
      email: `${owner.userId}@example.test`,
      deactivated: false,
    });
    expect(await find(`${created!.token.slice(0, -1)}x`)).toBeNull();
    await runAsSystem("test: touch", () => touchDozoAccessToken(prisma, created!.row.id));
    const [listed] = await runAsTenant(owner, () => listDozoAccessTokens(prisma, owner));
    expect(listed).toMatchObject({ id: created!.row.id, botName: "Chef", hint: created!.row.hint });
    expect(listed!.lastUsedAt).toBeInstanceOf(Date);
    // Nothing in the table can give the token back.
    const raw = await system.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM dozo_access_tokens WHERE id = ${created!.row.id}`;
    expect(JSON.stringify(raw)).not.toContain(created!.token);
  });

  it("keeps each member's tokens to them, and revokes only their own", async () => {
    const owner = await member();
    const other = await member();
    const created = await make(owner);
    // Row security hides another member's tokens, even when the query names them.
    expect(await runAsTenant(other, () => listDozoAccessTokens(prisma, owner))).toEqual([]);
    expect(
      await runAsTenant(other, () => revokeDozoAccessToken(prisma, other, created!.row.id)),
    ).toBe(false);
    expect(await find(created!.token)).not.toBeNull();
    expect(
      await runAsTenant(owner, () => revokeDozoAccessToken(prisma, owner, created!.row.id)),
    ).toBe(true);
    expect(await find(created!.token)).toBeNull();
  });

  it("stops at the limit", async () => {
    const owner = await member();
    for (let index = 0; index < DOZO_ACCESS_TOKEN_LIMIT; index++)
      expect(await make(owner)).not.toBeNull();
    expect(await make(owner)).toBeNull();
  });

  it("goes with the bot it is for and with the member's place in the Space", async () => {
    const owner = await member();
    const forBot = await make(owner, owner.botId);
    const forAll = await make(owner);
    await system.bot.delete({ where: { id: owner.botId } });
    expect(await find(forBot!.token)).toBeNull();
    expect(await find(forAll!.token)).not.toBeNull();
    await system.spaceMember.deleteMany({
      where: { spaceId: owner.spaceId, userId: owner.userId },
    });
    expect(await find(forAll!.token)).toBeNull();
  });

  it("says when the account is deactivated", async () => {
    const owner = await member();
    const created = await make(owner);
    await system.user.update({ where: { id: owner.userId }, data: { deactivatedAt: new Date() } });
    expect(await find(created!.token)).toMatchObject({ deactivated: true });
  });

  it("stops a token when it expires, and every token after a password change", async () => {
    const owner = await member();
    const expired = await make(owner, null, new Date(Date.now() - 1000));
    const lasting = await make(owner, null, new Date(Date.now() + 86_400_000));
    const forever = await make(owner);
    expect(await find(expired!.token)).toBeNull();
    expect(await find(lasting!.token)).not.toBeNull();
    expect(await find(forever!.token)).not.toBeNull();
    await system.securityEvent.create({
      data: { type: "auth.password.changed", userId: owner.userId, metadata: {} },
    });
    expect(await find(lasting!.token)).toBeNull();
    expect(await find(forever!.token)).toBeNull();
    // The settings list reads as the system (apps/api/src/dozo-access-tokens.ts).
    expect(await runAsSystem("test: list", () => listDozoAccessTokens(prisma, owner))).toEqual([]);
    // A token made after the change works.
    expect(await find((await make(owner))!.token)).not.toBeNull();
  });

  it("stops every token when the owner or an operator signs out everywhere, not for one session", async () => {
    const owner = await member();
    const token = await make(owner);
    const revoked = (metadata: Record<string, string>) =>
      system.securityEvent.create({
        data: { type: "auth.session.revoked", userId: owner.userId, metadata },
      });
    await revoked({ via: "/revoke-session" });
    expect(await find(token!.token)).not.toBeNull();
    await revoked({ via: "/revoke-other-sessions" });
    expect(await find(token!.token)).toBeNull();
    const later = await make(owner);
    await revoked({ by: "operator" });
    expect(await find(later!.token)).toBeNull();
    const last = await make(owner);
    await revoked({ via: "/revoke-sessions" });
    expect(await find(last!.token)).toBeNull();
  });

  it("counts a key's minute for every instance together, never past its limit", async () => {
    const key = `token:${randomUUID()}`;
    const take = () => runAsSystem("test: count", () => takeDozoApiMinute(prisma, key, 5));
    const answers = await Promise.all(Array.from({ length: 12 }, take));
    expect(answers.filter(Boolean)).toHaveLength(5);
    const rows = await system.$queryRaw<{ count: number }[]>`
      SELECT count FROM dozo_api_minutes WHERE key = ${key}`;
    expect(rows).toEqual([{ count: 5 }]);
    await system.$executeRaw`DELETE FROM dozo_api_minutes WHERE key = ${key}`;
  });
});
