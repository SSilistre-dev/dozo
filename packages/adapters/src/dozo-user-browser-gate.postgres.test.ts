import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createRepos, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forgetConsents, recordConsent } from "./dozo-user-browser-gate.js";
import { createUserDeviceToken, hashUserDeviceToken } from "./computers/host/user-device-gateway.js";

// Runs against a migrated database only (dozo/docker/postgres-tests.sh). The fork's unit gate has no
// database and skips it.
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("browser consents (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const users: string[] = [];

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
  });

  afterAll(async () => {
    if (users.length) {
      await system.organization.deleteMany({ where: { id: { in: users } } });
      await system.user.deleteMany({ where: { id: { in: users } } });
    }
    await db?.pool.end();
  });

  /** A person with a Space, a bot, two threads and a paired computer. */
  async function owner() {
    const id = `browser-consents-${randomUUID()}`;
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
    const actor: Actor = {
      userId: id,
      spaceId,
      email: `${id}@example.test`,
      isDeploymentOwner: false,
    };
    const bot = await runAsTenant(actor, () =>
      createRepos(db.prisma).createBot(actor, {
        name: "Scout",
        description: "",
        instructions: "",
        notifyOnFinish: false,
      }),
    );
    const thread = () =>
      system.thread.create({ data: { spaceId, userId: id, helperBotId: bot.id } });
    const [first, second] = [await thread(), await thread()];
    const device = await system.userDevice.create({
      data: {
        userId: id,
        name: "Laptop",
        platform: "darwin",
        tokenHash: hashUserDeviceToken(createUserDeviceToken()),
      },
    });
    return { botId: bot.id, deviceId: device.id, first: first.id, second: second.id };
  }

  async function sites(botId: string, deviceId: string, threadId: string) {
    const rows = await system.$queryRaw<{ site: string }[]>`
      SELECT site FROM dozo_browser_consents
      WHERE "botId" = ${botId} AND "deviceId" = ${deviceId} AND "threadId" = ${threadId}
      ORDER BY site`;
    return rows.map((row) => row.site);
  }

  it("keeps a consent in its thread once, and lets it go with the thread", async () => {
    const { botId, deviceId, first, second } = await owner();
    const key = { botId, deviceId, threadId: first };
    await recordConsent(db.prisma, key, "");
    await recordConsent(db.prisma, key, "example.test");
    await recordConsent(db.prisma, key, "example.test");
    expect(await sites(botId, deviceId, first)).toEqual(["", "example.test"]);
    expect(await sites(botId, deviceId, second)).toEqual([]);
    await system.thread.delete({ where: { id: first } });
    expect(await sites(botId, deviceId, first)).toEqual([]);
  });

  it("forgets every thread's consents for that bot on that computer, and only those", async () => {
    const { botId, deviceId, first, second } = await owner();
    const other = await owner();
    await recordConsent(db.prisma, { botId, deviceId, threadId: first }, "");
    await recordConsent(db.prisma, { botId, deviceId, threadId: second }, "read:example.test");
    const kept = { botId: other.botId, deviceId: other.deviceId, threadId: other.first };
    await recordConsent(db.prisma, kept, "");
    await forgetConsents(db.prisma, botId, deviceId);
    expect(await sites(botId, deviceId, first)).toEqual([]);
    expect(await sites(botId, deviceId, second)).toEqual([]);
    expect(await sites(other.botId, other.deviceId, other.first)).toEqual([""]);
  });
});
