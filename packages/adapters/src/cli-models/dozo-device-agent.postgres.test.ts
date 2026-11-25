import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dozoTokenNonce } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  createThreadMessage,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readDeviceAgents, recordDeviceCapabilities } from "../dozo-device-capabilities.js";
import { createUserDeviceToken, hashUserDeviceToken } from "../dozo-user-device-gateway.js";
import { handoffToGroupBot } from "../bots/group-handoff.js";
import { startRunModel } from "../runs/turn/run-model-start.js";
import { AGENT_OWN_RUNS_ONLY, AGENT_RECONNECT_ERROR, AGENT_TOKEN_TEXT } from "./dozo-agent.js";
import { cliHomeConnection } from "./dozo-cli-accounts.js";
import { ownRun } from "./dozo-cli-runtime.js";
import {
  DEVICE_OFFLINE_ERROR,
  deviceAgentAccessCheck,
  readDeviceAgentRows,
} from "./dozo-device-agent.js";

// Runs against a migrated database only (dozo/docker/postgres-tests.sh). The fork's unit gate has no
// database and skips it. It runs in UTC and in two other database time zones: a computer counts as
// connected by its heartbeat, read as a time.
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

const AGENT = "antigravity-agent";

describePostgres("an agent on the person's own computer (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const users: string[] = [];

  async function person(name: string) {
    const id = `device-agent-${randomUUID()}`;
    users.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name, email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({ data: { id, name, slug: id, createdAt } });
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
    return { userId: id, spaceId };
  }
  type Person = Awaited<ReturnType<typeof person>>;

  async function computer(
    owner: Person,
    over: { declares?: string[]; connected?: boolean; platform?: string } = {},
  ) {
    const device = await system.userDevice.create({
      data: {
        userId: owner.userId,
        name: "Laptop",
        platform: over.platform ?? "darwin",
        tokenHash: hashUserDeviceToken(createUserDeviceToken()),
      },
    });
    if (over.connected !== false)
      await system.userDeviceConnection.create({
        data: { deviceId: device.id, connectionId: randomUUID(), address: "http://api-1" },
      });
    await recordDeviceCapabilities(
      db.prisma,
      device.id,
      (over.declares ?? [`agent:${AGENT}`]) as never,
    );
    return device.id;
  }

  async function connection(owner: Person, plaintext: string) {
    const id = randomUUID();
    await system.secret.create({
      data: { id, userId: owner.userId, kind: "model", ciphertext: "fake-ciphertext" },
    });
    await system.userModelCredential.create({
      data: { id, userId: owner.userId, provider: AGENT, label: AGENT, secretId: id },
    });
    return { id, secretId: id, plaintext };
  }

  /** The person's own run of a bot, working, as a send leaves it. */
  async function run(owner: Person, trigger = "user") {
    const bot = await system.bot.create({
      data: { spaceId: owner.spaceId, userId: owner.userId, name: "Chef", color: "slate" },
    });
    const thread = await system.thread.create({
      data: { spaceId: owner.spaceId, userId: owner.userId, botId: bot.id },
    });
    const task = await system.task.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Work",
        status: "running",
      },
    });
    return system.run.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger,
      },
    });
  }

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
    // The server turned the agent on (the file in its data folder).
    const dataDir = mkdtempSync(join(tmpdir(), "dozo-agents-"));
    writeFileSync(join(dataDir, "dozo-agent-tools"), `${AGENT}\n`);
    vi.stubEnv("DATA_DIR", dataDir);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await system?.organization.deleteMany({ where: { id: { in: users } } });
    await system?.user.deleteMany({ where: { id: { in: users } } });
    await db?.pool.end();
  });

  it("reads the agents a computer declared, only ones this server knows", async () => {
    const owner = await person("Ada");
    const id = await computer(owner, {
      declares: [`agent:${AGENT}`, "agent:made-up", "shell"] as never,
    });
    expect(await readDeviceAgents(db.prisma, id)).toEqual([AGENT]);
    // Declared, but not turned on on this server: not there.
    const shut = { DATA_DIR: mkdtempSync(join(tmpdir(), "dozo-agents-")) };
    expect(await readDeviceAgents(db.prisma, id, shut)).toEqual([]);
    await recordDeviceCapabilities(db.prisma, id, ["shell"]);
    expect(await readDeviceAgents(db.prisma, id)).toEqual([]);
    await recordDeviceCapabilities(db.prisma, id, null);
    expect(await readDeviceAgents(db.prisma, id)).toEqual([]);
  });

  it("lets a run use its owner's connected computer that runs the agent, and no other", async () => {
    const ada = await person("Ada");
    const bob = await person("Bob");
    const laptop = await computer(ada);
    const off = await computer(ada, { connected: false });
    const flagOff = await computer(ada, { declares: ["shell"] });
    const phone = await computer(ada, { platform: "ios" });
    const bobs = await computer(bob);
    const adaRun = await run(ada);
    const check = deviceAgentAccessCheck({
      prisma: db.prisma,
      runAllowed: async () => undefined,
    });
    const target = (deviceId: string, runId = adaRun.id) => ({
      runId,
      provider: AGENT,
      deviceId,
    });
    await connection(ada, `dozo-cli-account:device:${laptop}`);
    expect(await check(target(laptop))).toEqual({ ok: true, userId: ada.userId });
    // Offline, or not running the agent now: the computer is offline, which a backup may answer.
    for (const id of [off, flagOff])
      expect(await check(target(id))).toEqual({
        ok: false,
        refusal: DEVICE_OFFLINE_ERROR,
        offline: true,
        userId: ada.userId,
      });
    // Another person's computer and a phone are never this run's.
    for (const id of [bobs, phone])
      expect(await check(target(id))).toEqual({ ok: false, refusal: AGENT_RECONNECT_ERROR });
    // Bob's own run, on Ada's connection or Ada's computer: refused for good.
    const bobRun = await run(bob);
    expect(await check(target(laptop, bobRun.id))).toEqual({
      ok: false,
      refusal: AGENT_RECONNECT_ERROR,
    });
  });

  it("lists the computers that are paired, connected now and not removed, and no phone", async () => {
    const ada = await person("Ada");
    const bob = await person("Bob");
    const live = await computer(ada);
    const stale = await computer(ada);
    await system.userDeviceConnection.update({
      where: { deviceId: stale },
      data: { heartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });
    const removed = await computer(ada);
    await system.userDevice.update({ where: { id: removed }, data: { revokedAt: new Date() } });
    await computer(ada, { platform: "ios" });
    await computer(ada, { declares: ["shell"] });
    await computer(bob);
    const rows = await readDeviceAgentRows({ prisma: db.prisma }, ada.userId);
    expect(rows.map((row) => [row.provider, row.deviceId, row.deviceName])).toEqual([
      [AGENT, live, "Laptop"],
    ]);
    expect(stale).not.toBe(live);
  });

  it("connects an agent on the caller's own computer, and refuses another person's", async () => {
    const ada = await person("Ada");
    const bob = await person("Bob");
    const mine = await computer(ada);
    const hers = await computer(bob);
    const deps = { prisma: db.prisma, secretStore: { load: async () => "" } };
    const connect = (who: Person, deviceId: string) =>
      runAsTenant(who, () => cliHomeConnection(deps, who.userId, AGENT, { deviceId }));
    expect(await connect(ada, mine)).toMatchObject({
      provider: AGENT,
      plaintext: `dozo-cli-account:device:${mine}`,
    });
    // Bob's computer, named by Ada: the same answer as a computer that does not exist.
    await expect(connect(ada, hers)).rejects.toThrow(DEVICE_OFFLINE_ERROR);
    await expect(connect(ada, randomUUID())).rejects.toThrow(DEVICE_OFFLINE_ERROR);
  });

  /** A run of the person's bot; `message` is what started it, as the person or as another. */
  async function started(
    owner: Person,
    over: { by?: Person; nonce?: string; role?: "user" | "bot"; trigger?: string } = {},
  ) {
    const bot = await system.bot.create({
      data: { spaceId: owner.spaceId, userId: owner.userId, name: "Chef", color: "slate" },
    });
    const thread = await system.thread.create({
      data: { spaceId: owner.spaceId, userId: owner.userId, botId: bot.id },
    });
    const by = over.by ?? owner;
    const message = await createThreadMessage(system, {
      threadId: thread.id,
      role: over.role ?? "user",
      authorUserId: by.userId,
      blocks: [{ kind: "text", text: "Remember this" }],
      ...(over.nonce ? { clientNonce: over.nonce } : {}),
    });
    const task = await system.task.create({
      data: {
        spaceId: owner.spaceId,
        userId: by.userId,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Work",
        status: "running",
      },
    });
    return system.run.create({
      data: {
        spaceId: owner.spaceId,
        userId: by.userId,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger: over.trigger ?? "user",
        sourceMessageId: message.id,
      },
    });
  }

  it("serves the bot owner's own message, and refuses another member's in a shared Space", async () => {
    const ada = await person("Ada");
    const bob = await person("Bob");
    const createdAt = new Date();
    await system.member.create({
      data: {
        id: `m-bob-${bob.userId}`,
        organizationId: ada.userId,
        userId: bob.userId,
        role: "member",
        createdAt,
      },
    });
    await system.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId: ada.spaceId,
        organizationId: ada.userId,
        userId: bob.userId,
        role: "member",
        createdAt,
      },
    });
    expect(await ownRun(db.prisma, (await started(ada)).id)).toBeUndefined();
    // Bob's own message to Ada's bot, in the Space they share.
    expect(await ownRun(db.prisma, (await started(ada, { by: bob })).id)).toBe(AGENT_OWN_RUNS_ONLY);
    // A run with no message behind it.
    const bare = await started(ada);
    await system.run.update({ where: { id: bare.id }, data: { sourceMessageId: null } });
    expect(await ownRun(db.prisma, bare.id)).toBe(AGENT_OWN_RUNS_ONLY);
  });

  it("refuses a run that text sent with an access token reached, by the real check", async () => {
    const ada = await person("Ada");
    const run = await started(ada, { nonce: dozoTokenNonce(randomUUID()) });
    expect(await ownRun(db.prisma, run.id)).toBe(AGENT_TOKEN_TEXT);
  });

  it("refuses the run a group handoff starts for another bot", async () => {
    const ada = await person("Ada");
    const chefRun = await started(ada);
    const scout = await system.bot.create({
      data: { spaceId: ada.spaceId, userId: ada.userId, name: "Scout", color: "slate" },
    });
    await system.thread.create({
      data: { spaceId: ada.spaceId, userId: ada.userId, botId: scout.id },
    });
    const group = await system.chatGroup.create({
      data: {
        spaceId: ada.spaceId,
        userId: ada.userId,
        name: "Team",
        members: { create: [{ botId: chefRun.botId }, { botId: scout.id }] },
        thread: { create: { spaceId: ada.spaceId, userId: ada.userId } },
      },
      include: { thread: true },
    });
    // The run of the first bot in the group's own chat, as a send there leaves it.
    const task = await system.task.create({
      data: {
        spaceId: ada.spaceId,
        userId: ada.userId,
        botId: chefRun.botId,
        threadId: group.thread!.id,
        prompt: "Work",
        status: "running",
      },
    });
    const inGroup = await system.run.create({
      data: {
        spaceId: ada.spaceId,
        userId: ada.userId,
        botId: chefRun.botId,
        threadId: group.thread!.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
      },
    });
    const handed = await runAsTenant(ada, async () =>
      handoffToGroupBot(
        {
          prisma: db.prisma,
          events: createThreadEvents(db.prisma),
          jobs: { enqueue: vi.fn(async () => undefined) },
        } as never,
        inGroup,
        group.id,
        { bot_id: scout.id, message: "Read my files" },
      ),
    );
    expect(handed).not.toHaveProperty("error");
    const theirs = await system.run.findFirstOrThrow({
      where: { botId: scout.id },
      orderBy: { createdAt: "desc" },
    });
    expect(theirs.id).not.toBe(chefRun.id);
    expect(await ownRun(db.prisma, theirs.id)).toBe(AGENT_OWN_RUNS_ONLY);
  });

  it("does not stop a person with no model credits from running an agent on their own computer", async () => {
    const ada = await person("Ada");
    const laptop = await computer(ada);
    const saved = await connection(ada, `dozo-cli-account:device:${laptop}`);
    // Billing is on, and Ada has no credits, no subscription and no key of their own.
    const deps = {
      prisma: db.prisma,
      billingEnabled: true,
      secretStore: { load: async () => saved.plaintext },
    } as never;
    // As a run starts it: under the run's own member.
    const started = await runAsTenant(ada, () =>
      startRunModel(
        deps,
        ada,
        {
          provider: AGENT,
          id: "default",
          credential: { id: saved.id, secretId: saved.secretId, provider: AGENT } as never,
          thinkingLevel: null,
        },
        undefined,
        {
          load: async () => [],
          unavailable: new Set(),
          startOnBackup: async () => undefined,
        } as never,
        () => undefined,
      ),
    );
    expect(started.failure).toBeUndefined();
    // The turn is the person's own subscription's: no credit is spent for it.
    expect(started.start).toMatchObject({
      provider: AGENT,
      resolved: { apiKey: saved.plaintext, callObserver: undefined },
    });
  });
});
