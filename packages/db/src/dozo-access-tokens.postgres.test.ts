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
  const make = (owner: Member, botId: string | null = null) =>
    runAsTenant(owner, () => createDozoAccessToken(prisma, owner, { name: "CI", botId }));
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
});
