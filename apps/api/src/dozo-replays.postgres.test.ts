import { randomUUID } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { DOZO_SHARE_LINK_API_PREFIX, stepScreenshotMimeType } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountDozoReplayFrames } from "./dozo-replays.js";
import { readSharedLink } from "./dozo-share-links.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";
import { handleRpcError } from "./rpc-errors.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

const PICTURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const artifacts = {
  get: async (id: string) => {
    if (id !== "stored-shot") throw new Error(`unexpected read of ${id}`);
    return PICTURE;
  },
};

describePostgres("replays (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let handler: RPCHandler<Record<string, unknown>>;
  let frames: Hono;
  const users: string[] = [];

  async function person(): Promise<Actor> {
    const id = `replay-${randomUUID()}`;
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

  /** Another person who joins `owner`'s Space as a member. */
  async function memberOf(owner: Actor): Promise<Actor> {
    const guest = await person();
    const space = await system.space.findUniqueOrThrow({ where: { id: owner.spaceId } });
    await system.member.create({
      data: {
        id: `m2-${guest.userId}`,
        organizationId: space.organizationId,
        userId: guest.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: owner.spaceId,
        organizationId: space.organizationId,
        userId: guest.userId,
        role: "member",
        createdAt: new Date(),
      },
    });
    return { ...guest, spaceId: owner.spaceId };
  }

  /** A finished reply in the actor's own chat with their bot: a sign-in, then a search. */
  async function reply(actor: Actor, status = "completed") {
    const owner = { spaceId: actor.spaceId, userId: actor.userId };
    const bot = await system.bot.create({ data: { ...owner, name: "Scout", color: "test" } });
    const thread = await system.thread.create({ data: { ...owner, botId: bot.id } });
    const task = await system.task.create({
      data: { ...owner, botId: bot.id, threadId: thread.id, prompt: "find it", status },
    });
    const run = await system.run.create({
      data: {
        ...owner,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        trigger: "user",
        status,
      },
    });
    const shot = await system.artifact.create({
      data: {
        ...owner,
        botId: bot.id,
        runId: run.id,
        name: "screenshot",
        mimeType: stepScreenshotMimeType("image/png"),
        size: PICTURE.byteLength,
        hash: "hash",
        storageKey: "stored-shot",
      },
    });
    const message = await system.message.create({
      data: {
        threadId: thread.id,
        seq: 1,
        role: "bot",
        botId: bot.id,
        runId: run.id,
        blocks: [
          {
            kind: "steps",
            steps: [
              { label: "Browser navigate", count: 1 },
              { label: "Web search", count: 1 },
            ],
          },
          { kind: "text", text: "Found it." },
        ],
        toolHistory: JSON.stringify({
          steps: [
            {
              tool: "browser_navigate",
              calls: [{ arguments: '{"url":"https://shop.example.com/item?ref=private"}' }],
            },
            {
              tool: "web_search",
              calls: [{ arguments: '{"query":"private words"}', image: { artifactId: shot.id } }],
            },
          ],
        }),
      },
    });
    return { botId: bot.id, messageId: message.id };
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

  const tokenOf = (url: unknown) => String(url).split("/s/")[1]!;

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
    const deps = {
      prisma,
      artifacts,
      env: {
        agentRuntime: "scripted",
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "https://app.example.test",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      jobs: { enqueue: async () => undefined },
      dataDir: "/tmp/rakazo-replays-test",
    } as unknown as RouterDeps;
    handler = new RPCHandler(createRouter(deps), {
      clientInterceptors: [
        onError((error, { path, signal }) => handleRpcError(error, path, signal)),
      ],
    });
    frames = new Hono();
    mountDozoReplayFrames(frames, prisma, () => "203.0.113.7", artifacts as never);
  });

  afterAll(async () => {
    if (!prisma) return;
    await system.organization.deleteMany({ where: { id: { in: users } } });
    await system.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    await db.pool.end();
  });

  it("previews each step by kind and host only, with its screenshot", async () => {
    const ada = await person();
    const { messageId } = await reply(ada);
    const preview = await call(ada, "dozoReplays/preview", { messageId });
    expect(preview.status).toBe(200);
    expect(preview.json.steps).toEqual([
      // The bot has no computer, so its signed-in sites are unknown: the screenshot starts out.
      { line: "Browser navigate · shop.example.com", frame: null, sensitive: true },
      {
        line: "Web search",
        frame: `data:image/png;base64,${Buffer.from(PICTURE).toString("base64")}`,
        sensitive: true,
      },
    ]);
    expect(JSON.stringify(preview.json)).not.toContain("private");
  });

  it("publishes only what the owner kept, and serves its one screenshot under the link", async () => {
    const ada = await person();
    const { messageId } = await reply(ada);
    const published = await call(ada, "dozoReplays/publish", { messageId, omit: [0], frames: [1] });
    expect(published.status).toBe(200);
    const token = tokenOf(published.json.url);
    expect(await readSharedLink(prisma, token)).toEqual({
      kind: "replay",
      payload: { steps: [{ line: "Web search", frame: 0 }] },
    });
    const frame = await frames.request(`${DOZO_SHARE_LINK_API_PREFIX}${token}/frames/0`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await frame.arrayBuffer())).toEqual(PICTURE);
    expect((await frames.request(`${DOZO_SHARE_LINK_API_PREFIX}${token}/frames/1`)).status).toBe(
      404,
    );
  });

  it("publishes no screenshot the owner did not choose, even one asked for on a step without one", async () => {
    const ada = await person();
    const { messageId } = await reply(ada);
    const published = await call(ada, "dozoReplays/publish", { messageId, frames: [0] });
    const token = tokenOf(published.json.url);
    expect((await readSharedLink(prisma, token))?.payload).toEqual({
      steps: [
        { line: "Browser navigate · shop.example.com", frame: null },
        { line: "Web search", frame: null },
      ],
    });
    expect((await frames.request(`${DOZO_SHARE_LINK_API_PREFIX}${token}/frames/0`)).status).toBe(
      404,
    );
  });

  it("refuses another person's reply, a reply whose run has not finished, and leaving out every step", async () => {
    const ada = await person();
    const bob = await person();
    const { messageId } = await reply(ada);
    expect((await call(bob, "dozoReplays/preview", { messageId })).status).toBe(404);
    expect((await call(bob, "dozoReplays/publish", { messageId })).status).toBe(404);
    expect((await call(ada, "dozoReplays/publish", { messageId, omit: [0, 1] })).status).toBe(404);
    const running = await reply(ada, "running");
    expect((await call(ada, "dozoReplays/preview", { messageId: running.messageId })).status).toBe(
      404,
    );
  });

  it("lists the reply's live links in its preview until revoked", async () => {
    const ada = await person();
    const { messageId } = await reply(ada);
    const published = await call(ada, "dozoReplays/publish", { messageId });
    const link = published.json.link as { id: string };
    const listed = (await call(ada, "dozoReplays/preview", { messageId })).json.links as {
      id: string;
    }[];
    expect(listed.map((row) => row.id)).toEqual([link.id]);
    await call(ada, "dozoShareLinks/revoke", { id: link.id });
    expect((await call(ada, "dozoReplays/preview", { messageId })).json.links).toEqual([]);
  });

  it("closes the link once the reply or the bot is deleted", async () => {
    const ada = await person();
    const first = await reply(ada);
    const second = await reply(ada);
    const publish = async (messageId: string) =>
      tokenOf((await call(ada, "dozoReplays/publish", { messageId })).json.url);
    const byMessage = await publish(first.messageId);
    const byBot = await publish(second.messageId);
    await system.message.delete({ where: { id: first.messageId } });
    await system.bot.delete({ where: { id: second.botId } });
    expect(await readSharedLink(prisma, byMessage)).toBeNull();
    expect(await readSharedLink(prisma, byBot)).toBeNull();
    const left = await system.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM dozo_replays
      WHERE "messageId" IN (${first.messageId}, ${second.messageId})`;
    expect(left[0]!.n).toBe(0);
  });

  it("refuses a member of the same Space the owner's reply and their replay link's target", async () => {
    const ada = await person();
    const { messageId } = await reply(ada);
    const published = await call(ada, "dozoReplays/publish", { messageId });
    const link = published.json.link as { targetId: string };
    const bob = await memberOf(ada);
    expect((await call(bob, "dozoReplays/preview", { messageId })).status).toBe(404);
    expect((await call(bob, "dozoReplays/publish", { messageId })).status).toBe(404);
    expect(
      (
        await call(bob, "dozoShareLinks/create", {
          kind: "replay",
          targetId: link.targetId,
          days: 1,
        })
      ).status,
    ).toBe(404);
  });

  it("keeps another member's replay out of their reads and writes by row-level security alone", async () => {
    const ada = await person();
    const { messageId } = await reply(ada);
    await call(ada, "dozoReplays/publish", { messageId });
    const bob = await memberOf(ada);
    const seen = await runAsTenant(
      bob,
      () =>
        prisma.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM dozo_replays WHERE "messageId" = ${messageId}`,
    );
    expect(seen).toEqual([]);
    const changed = await runAsTenant(
      bob,
      () =>
        prisma.$executeRaw`UPDATE dozo_replays SET "steps" = '[]'::jsonb WHERE "messageId" = ${messageId}`,
    );
    expect(changed).toBe(0);
  });

  it("closes the link when the reply is rewritten after the owner reviewed it", async () => {
    const ada = await person();
    const { messageId } = await reply(ada);
    const token = tokenOf((await call(ada, "dozoReplays/publish", { messageId })).json.url);
    expect(await readSharedLink(prisma, token)).not.toBeNull();
    await system.message.update({
      where: { id: messageId },
      data: {
        blocks: [
          {
            kind: "steps",
            steps: [
              { label: "Send email", count: 1 },
              { label: "Browser navigate", count: 1 },
              { label: "Web search", count: 1 },
            ],
          },
        ],
      },
    });
    expect(await readSharedLink(prisma, token)).toBeNull();
  });
});
