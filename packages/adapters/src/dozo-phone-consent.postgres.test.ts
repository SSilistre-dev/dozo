import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recordDeviceCapabilities } from "./dozo-device-capabilities.js";
import { phoneGate } from "./dozo-phone.js";
import {
  PHONE_CALENDAR_CREATE_TOOL,
  PHONE_CALENDAR_READ_TOOL,
  PHONE_CONTACTS_SEARCH_TOOL,
  PHONE_LOCATION_TOOL,
  PHONE_REMINDERS_READ_TOOL,
} from "./dozo-phone.tool-definition.js";
import {
  createUserDeviceToken,
  hashUserDeviceToken,
  UserDevices,
  userDeviceForwardSecret,
} from "./dozo-user-device-gateway.js";
import type { RunContext } from "./runs/assembly/run-context.js";

// Runs on the branded tree only, against a migrated database (dozo/docker/postgres-tests.sh), as
// the runtime login that row security applies to. The fork's unit gate has no database and skips
// it. The phone's consent is read with a JSON equality on the effect's request, which only a real
// jsonb column can prove.

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("the phone's consent (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  const users: string[] = [];
  const PAIRED = new Date(Date.now() - 60 * 60 * 1000);
  const RANGE = { from: "2026-11-22T00:00:00+03:00", to: "2026-11-29T00:00:00+03:00" };

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

  /** The owner alone in their Space, a bot's chat there and a run of it. */
  async function ownRun() {
    const userId = `phone-consent-${randomUUID()}`;
    users.push(userId);
    const createdAt = new Date();
    await system.user.create({
      data: { id: userId, name: "Ada", email: `${userId}@example.test`, emailVerified: true },
    });
    await system.organization.create({
      data: { id: userId, name: "Personal", slug: userId, createdAt },
    });
    await system.member.create({
      data: { id: `m-${userId}`, organizationId: userId, userId, role: "owner", createdAt },
    });
    const spaceId = randomUUID();
    await system.space.create({
      data: { id: spaceId, organizationId: userId, name: "Home", createdByUserId: userId },
    });
    await system.spaceMember.create({
      data: { id: randomUUID(), spaceId, organizationId: userId, userId, role: "owner", createdAt },
    });
    const bot = await system.bot.create({
      data: { spaceId, userId, name: "Chef", color: "slate" },
    });
    const thread = await system.thread.create({ data: { spaceId, userId, botId: bot.id } });
    const newRun = async () => {
      const task = await system.task.create({
        data: {
          spaceId,
          userId,
          botId: bot.id,
          threadId: thread.id,
          prompt: "Work",
          status: "running",
        },
      });
      return system.run.create({
        data: {
          spaceId,
          userId,
          botId: bot.id,
          threadId: thread.id,
          taskId: task.id,
          status: "running",
          trigger: "user",
        },
      });
    };
    return { userId, spaceId, bot, thread, newRun };
  }

  type Owner = Awaited<ReturnType<typeof ownRun>>;

  /** An effect of the tool as run-tool-gate records it: its request is the call's arguments. */
  const effect = (
    owner: Owner,
    runId: string,
    status: string,
    request: object,
    kind = PHONE_CALENDAR_READ_TOOL,
    createdAt?: Date,
  ) =>
    system.externalEffect.create({
      data: {
        spaceId: owner.spaceId,
        runId,
        kind,
        ...(createdAt ? { createdAt } : {}),
        idempotencyKey: randomUUID(),
        status,
        request: request as never,
      },
    });

  /** The real gate on a run of the owner's, with their phone connected. */
  const gate = (
    owner: Owner,
    runId: string,
    args: Record<string, unknown>,
    tool = PHONE_CALENDAR_READ_TOOL,
    userDevices: unknown = {
      connectedPhone: async () => ({ deviceId: "phone-1", pairedAt: PAIRED, onSince: PAIRED }),
    },
  ) => {
    const ctx = {
      source: { userComputerOwner: owner.userId },
      deps: { prisma, userDevices },
      bot: { id: owner.bot.id },
      run: { id: runId, botId: owner.bot.id, threadId: owner.thread.id, spaceId: owner.spaceId },
      runId,
      thread: owner.thread,
      state: {},
      secrets: [],
      trust: { receivedOutsideMessage: async () => false },
    } as unknown as RunContext;
    return runAsTenant(owner, () => phoneGate(ctx, false, tool, args));
  };

  it("lets the call whose own card was allowed run, whatever the order of its keys", async () => {
    const owner = await ownRun();
    const run = await owner.newRun();
    await effect(owner, run.id, "approved", { ...RANGE, query: "dentist" });
    expect(await gate(owner, run.id, { query: "dentist", to: RANGE.to, from: RANGE.from })).toBe(
      "allow",
    );
    // Without a query the call is another one, which its own card must allow.
    expect(await gate(owner, run.id, { ...RANGE })).toBe("ask");
    await effect(owner, run.id, "approved", { ...RANGE });
    expect(await gate(owner, run.id, { to: RANGE.to, from: RANGE.from })).toBe("allow");
  });

  it("does not let another range in the same run ride on that card", async () => {
    const owner = await ownRun();
    const run = await owner.newRun();
    await effect(owner, run.id, "approved", { ...RANGE });
    const other = { from: "2026-12-01T00:00:00+03:00", to: "2026-12-02T00:00:00+03:00" };
    expect(await gate(owner, run.id, other)).toBe("ask");
    // Nor a later run.
    const later = await owner.newRun();
    expect(await gate(owner, later.id, { ...RANGE })).toBe("ask");
  });

  it("counts a completed read of this bot and person in a clean run, and nothing a crash left", async () => {
    const owner = await ownRun();
    const earlier = await owner.newRun();
    const run = await owner.newRun();
    for (const status of ["executing", "uncertain", "intended", "denied"])
      await effect(owner, earlier.id, status, { ...RANGE });
    expect(await gate(owner, run.id, { ...RANGE })).toBe("ask");
    await effect(owner, earlier.id, "completed", { ...RANGE });
    const other = { from: "2026-12-01T00:00:00+03:00", to: "2026-12-02T00:00:00+03:00" };
    expect(await gate(owner, run.id, other)).toBe("allow");
  });

  it("holds each tool's consent apart: a calendar read lets no contacts search through", async () => {
    const owner = await ownRun();
    const earlier = await owner.newRun();
    const run = await owner.newRun();
    const search = { query: "Ada", field: "phone" };
    await effect(owner, earlier.id, "completed", { ...RANGE });
    expect(await gate(owner, run.id, search, PHONE_CONTACTS_SEARCH_TOOL)).toBe("ask");
    await effect(
      owner,
      run.id,
      "approved",
      { field: "phone", query: "Ada" },
      PHONE_CONTACTS_SEARCH_TOOL,
    );
    expect(await gate(owner, run.id, search, PHONE_CONTACTS_SEARCH_TOOL)).toBe("allow");
    expect(await gate(owner, run.id, { ...search, query: "Bob" }, PHONE_CONTACTS_SEARCH_TOOL)).toBe(
      "ask",
    );
    await effect(owner, earlier.id, "completed", search, PHONE_CONTACTS_SEARCH_TOOL);
    const later = await owner.newRun();
    expect(
      await gate(owner, later.id, { ...search, query: "Bob" }, PHONE_CONTACTS_SEARCH_TOOL),
    ).toBe("allow");
  });

  it("asks for every location read, approximate too: only the call's own card lets it run", async () => {
    const owner = await ownRun();
    const earlier = await owner.newRun();
    const run = await owner.newRun();
    for (const precision of ["approximate", "precise"]) {
      const args = { precision };
      await effect(owner, earlier.id, "completed", args, PHONE_LOCATION_TOOL);
      expect(await gate(owner, run.id, args, PHONE_LOCATION_TOOL)).toBe("ask");
      await effect(owner, run.id, "approved", args, PHONE_LOCATION_TOOL);
      expect(await gate(owner, run.id, { precision }, PHONE_LOCATION_TOOL)).toBe("allow");
      const later = await owner.newRun();
      expect(await gate(owner, later.id, args, PHONE_LOCATION_TOOL)).toBe("ask");
    }
  });

  it("asks again once a kind's switch was turned off and on, and keeps the other kinds' consent", async () => {
    const owner = await ownRun();
    const phone = await system.userDevice.create({
      data: {
        userId: owner.userId,
        name: "Phone",
        platform: "ios",
        tokenHash: hashUserDeviceToken(createUserDeviceToken()),
        createdAt: PAIRED,
      },
    });
    await system.userDeviceConnection.create({
      data: { deviceId: phone.id, connectionId: randomUUID(), address: "http://api-1" },
    });
    const devices = new UserDevices({ prisma, forwardSecret: userDeviceForwardSecret("test") });
    await recordDeviceCapabilities(prisma, phone.id, ["calendar", "contacts"]);
    const turnedOn = (await devices.connectedPhone(owner.userId, "contacts"))!.onSince;
    expect(turnedOn.getTime()).toBeGreaterThan(PAIRED.getTime());
    // A read of each kind since they were turned on: the owner's consent.
    const read = new Date(turnedOn.getTime() + 1);
    const search = { query: "Ada", field: "phone" };
    const earlier = await owner.newRun();
    await effect(owner, earlier.id, "completed", search, PHONE_CONTACTS_SEARCH_TOOL, read);
    await effect(owner, earlier.id, "completed", { ...RANGE }, PHONE_CALENDAR_READ_TOOL, read);
    const allowed = async () => {
      const run = await owner.newRun();
      return [
        await gate(owner, run.id, { ...search }, PHONE_CONTACTS_SEARCH_TOOL, devices),
        await gate(owner, run.id, { ...RANGE }, PHONE_CALENDAR_READ_TOOL, devices),
      ];
    };
    expect(await allowed()).toEqual(["allow", "allow"]);
    // The same declaration again (a reconnect) keeps the moment.
    await recordDeviceCapabilities(prisma, phone.id, ["calendar", "contacts"]);
    expect((await devices.connectedPhone(owner.userId, "contacts"))!.onSince).toEqual(turnedOn);
    await vi.waitUntil(() => Date.now() > read.getTime() + 5);
    // Contacts off, then on again: its consent is gone; the calendar's stays.
    await recordDeviceCapabilities(prisma, phone.id, ["calendar"]);
    await recordDeviceCapabilities(prisma, phone.id, ["calendar", "contacts"]);
    expect(await allowed()).toEqual(["ask", "allow"]);
    // A device that stops declaring (null) forgets every kind.
    await recordDeviceCapabilities(prisma, phone.id, null);
    const left = await system.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM dozo_device_capability_since WHERE "deviceId" = ${phone.id}`;
    expect(left[0]?.count).toBe(0);
  });
  /** The owner's phone, paired an hour ago and connected, declaring `capabilities`. */
  async function connectedPhone(
    owner: Owner,
    capabilities: Parameters<typeof recordDeviceCapabilities>[2],
  ) {
    const phone = await system.userDevice.create({
      data: {
        userId: owner.userId,
        name: "Phone",
        platform: "ios",
        tokenHash: hashUserDeviceToken(createUserDeviceToken()),
        createdAt: PAIRED,
      },
    });
    await system.userDeviceConnection.create({
      data: { deviceId: phone.id, connectionId: randomUUID(), address: "http://api-1" },
    });
    await recordDeviceCapabilities(prisma, phone.id, capabilities);
    const devices = new UserDevices({ prisma, forwardSecret: userDeviceForwardSecret("test") });
    return { phone, devices };
  }

  it("asks for reminders again once their switch was turned off and on, in this time zone too", async () => {
    const owner = await ownRun();
    const { phone, devices } = await connectedPhone(owner, ["reminders", "calendar"]);
    const turnedOn = (await devices.connectedPhone(owner.userId, "reminders"))!.onSince;
    expect(turnedOn.getTime()).toBeGreaterThan(PAIRED.getTime());
    expect(Math.abs(turnedOn.getTime() - Date.now())).toBeLessThan(60_000);
    const args = { include_done: false };
    const first = await owner.newRun();
    expect(await gate(owner, first.id, { ...args }, PHONE_REMINDERS_READ_TOOL, devices)).toBe(
      "ask",
    );
    await effect(owner, first.id, "approved", { include_done: false }, PHONE_REMINDERS_READ_TOOL);
    expect(await gate(owner, first.id, { ...args }, PHONE_REMINDERS_READ_TOOL, devices)).toBe(
      "allow",
    );
    // A completed read since the switch went on: the bot's later reads go without a card.
    const read = new Date(turnedOn.getTime() + 1);
    await effect(owner, first.id, "completed", { ...args }, PHONE_REMINDERS_READ_TOOL, read);
    const later = await owner.newRun();
    expect(await gate(owner, later.id, { list: "Home" }, PHONE_REMINDERS_READ_TOOL, devices)).toBe(
      "allow",
    );
    // A calendar read is no consent to reminders.
    const other = await ownRun();
    const { devices: hers } = await connectedPhone(other, ["reminders", "calendar"]);
    const hersRun = await other.newRun();
    await effect(other, hersRun.id, "completed", { ...RANGE }, PHONE_CALENDAR_READ_TOOL);
    expect(await gate(other, hersRun.id, { ...args }, PHONE_REMINDERS_READ_TOOL, hers)).toBe("ask");
    await vi.waitUntil(() => Date.now() > read.getTime() + 5);
    await recordDeviceCapabilities(prisma, phone.id, ["calendar"]);
    expect(await devices.connectedPhone(owner.userId, "reminders")).toBeNull();
    await recordDeviceCapabilities(prisma, phone.id, ["calendar", "reminders"]);
    const again = await owner.newRun();
    expect(await gate(owner, again.id, { list: "Home" }, PHONE_REMINDERS_READ_TOOL, devices)).toBe(
      "ask",
    );
  });

  it("asks every write: a completed one is no consent, only the call's own card", async () => {
    const owner = await ownRun();
    const { devices } = await connectedPhone(owner, ["calendar-write"]);
    const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(Date.parse(start) + 60 * 60 * 1000).toISOString();
    const event = {
      title: "Lunch",
      start,
      end,
      recurrence: { frequency: "weekly", interval: 1, count: 4 },
    };
    const earlier = await owner.newRun();
    await effect(owner, earlier.id, "completed", event, PHONE_CALENDAR_CREATE_TOOL);
    const run = await owner.newRun();
    expect(await gate(owner, run.id, { ...event }, PHONE_CALENDAR_CREATE_TOOL, devices)).toBe(
      "ask",
    );
    await effect(owner, run.id, "approved", event, PHONE_CALENDAR_CREATE_TOOL);
    // The same keys in another order, nested ones too.
    const reordered = {
      recurrence: { count: 4, interval: 1, frequency: "weekly" },
      end,
      start,
      title: "Lunch",
    };
    expect(await gate(owner, run.id, reordered, PHONE_CALENDAR_CREATE_TOOL, devices)).toBe("allow");
    expect(
      await gate(owner, run.id, { ...event, title: "Dinner" }, PHONE_CALENDAR_CREATE_TOOL, devices),
    ).toBe("ask");
  });
});
