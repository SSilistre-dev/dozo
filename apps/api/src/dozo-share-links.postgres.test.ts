import { randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, Prisma, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DozoShareKinds } from "./dozo-share-links.js";
import { createShareLink, readSharedLink } from "./dozo-share-links.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

/** A kind only this test has: production's map is empty. */
const kinds: DozoShareKinds = {
  note: {
    canShare: async (_prisma, _actor, targetId) => targetId !== "not-mine",
    load: async (_prisma, link) => ({ targetId: link.targetId, owner: link.userId }),
  },
};

describePostgres("share links (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  const users: string[] = [];

  async function person(): Promise<Actor> {
    const id = `share-${randomUUID()}`;
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
    return { userId: id, spaceId, email: `${id}@example.test`, isDeploymentOwner: false };
  }

  async function call(actor: Actor, path: string, input?: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    const body = (await response!.json()) as { json: unknown };
    return { status: response!.status, json: body.json as Record<string, unknown> };
  }

  const make = (actor: Actor, targetId = "target-1", days = 7) =>
    runAsTenant(actor, () =>
      createShareLink(prisma, actor, { kind: "note", targetId, days }, kinds),
    );

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    const deps = {
      prisma,
      env: {
        agentRuntime: "scripted",
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "https://app.example.test",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      jobs: { enqueue: async () => undefined },
      dataDir: "/tmp/rakazo-share-links-test",
    } as unknown as RouterDeps;
    handler = new RPCHandler(createRouter(deps), {
      clientInterceptors: [
        onError((error, { path, signal }) => handleRpcError(error, path, signal)),
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await system.organization.deleteMany({ where: { id: { in: users } } });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("keeps only the token's hash, and a live link opens to its kind's payload", async () => {
    const ada = await person();
    const { link, token } = await make(ada);
    const stored = await system.$queryRaw<{ tokenHash: string }[]>`
      SELECT "tokenHash" FROM dozo_share_links WHERE "id" = ${link.id}`;
    expect(stored[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]!.tokenHash).not.toContain(token);
    expect(await readSharedLink(prisma, token, kinds)).toEqual({
      kind: "note",
      payload: { targetId: "target-1", owner: ada.userId },
    });
  });

  it("reads expiry in UTC whatever the session's zone, and refuses a link past it", async () => {
    const ada = await person();
    const before = Date.now();
    const { link, token } = await make(ada, "target-1", 3);
    const expires = Date.parse(link.expiresAt);
    expect(expires - before).toBeGreaterThanOrEqual(3 * 86_400_000 - 1000);
    expect(expires - before).toBeLessThanOrEqual(3 * 86_400_000 + 60_000);
    const listed = (await call(ada, "dozoShareLinks/list")).json.links as { expiresAt: string }[];
    expect(listed.map((row) => row.expiresAt)).toEqual([link.expiresAt]);
    await system.$executeRaw(
      Prisma.sql`UPDATE dozo_share_links SET "expiresAt" = ${new Date(Date.now() - 1000).toISOString()}::timestamptz
        WHERE "id" = ${link.id}`,
    );
    expect(await readSharedLink(prisma, token, kinds)).toBeNull();
  });

  it("lists only the member's own links, and only they can revoke one", async () => {
    const ada = await person();
    const bob = await person();
    const { link, token } = await make(ada);
    await make(bob);
    const listed = (await call(ada, "dozoShareLinks/list")).json.links as { id: string }[];
    expect(listed.map((row) => row.id)).toEqual([link.id]);
    expect((await call(bob, "dozoShareLinks/revoke", { id: link.id })).status).toBe(404);
    expect(await readSharedLink(prisma, token, kinds)).not.toBeNull();
    expect((await call(ada, "dozoShareLinks/revoke", { id: link.id })).json).toEqual({
      revoked: true,
    });
    expect((await call(ada, "dozoShareLinks/revoke", { id: link.id })).status).toBe(200);
    expect(await readSharedLink(prisma, token, kinds)).toBeNull();
    const [revoked] = (await call(ada, "dozoShareLinks/list")).json.links as {
      revokedAt: string | null;
    }[];
    expect(revoked!.revokedAt).not.toBeNull();
  });

  it("refuses a kind the production map does not have", async () => {
    const ada = await person();
    const made = await call(ada, "dozoShareLinks/create", {
      kind: "note",
      targetId: "target-1",
      days: 1,
    });
    expect(made.status).toBe(404);
  });

  it("takes a member's links when they leave the Space", async () => {
    const ada = await person();
    const { token } = await make(ada);
    await system.spaceMember.deleteMany({ where: { userId: ada.userId, spaceId: ada.spaceId } });
    expect(await readSharedLink(prisma, token, kinds)).toBeNull();
  });
});
