import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createRepos, runAsTenant } from "@rakazo/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { DeclaredUserDevice } from "./dozo-device-capabilities.js";
import { recordConsent, userBrowserGate } from "./dozo-user-browser-gate.js";
import { UserDeviceHub, UserDevices } from "./dozo-user-device-gateway.js";
import type { RunContext } from "./run-context.js";
import { createUserDeviceToken, hashUserDeviceToken } from "./user-device-gateway.js";

// The real relay, end to end: a migrated database, the server's own device hub and gateway, and
// the desktop app's own runner connecting to it over its socket (dozo/desktop/tests/relay_e2e.sh
// runs both sides). Skipped anywhere else.
const RELAY = process.env.DOZO_RELAY_DIR;
const describeRelay = RELAY && process.env.DATABASE_URL ? describe : describe.skip;

function until<T>(what: string, check: () => Promise<T | undefined>, seconds = 120) {
  return vi.waitFor(
    async () => {
      const value = await check();
      if (value === undefined) throw new Error(`timed out waiting for ${what}`);
      return value;
    },
    { timeout: seconds * 1000, interval: 250 },
  );
}

describeRelay("the bot's browser over the real relay", () => {
  const db = createDb(process.env.DATABASE_URL ?? "");
  const system: PrismaClient = asSystem(db.prisma);
  const server = createServer();

  afterAll(async () => {
    server.close();
    await db.pool.end();
  });

  it("tells the computer it has forgotten, once and for two runs of the same bot", async () => {
    // A person with a bot, two threads and a paired computer.
    const id = `relay-${randomUUID()}`;
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
    const threads = [(await thread()).id, (await thread()).id];
    // Paired from a sign-in that is still live, as the app pairs.
    const session = await system.session.create({
      data: {
        id: randomUUID(),
        userId: id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const token = createUserDeviceToken();
    const device = await system.userDevice.create({
      data: {
        userId: id,
        name: "Laptop",
        platform: "linux",
        tokenHash: hashUserDeviceToken(token),
        sessionId: session.id,
      },
    });

    // The server's own hub and gateway, on a port the desktop app reaches.
    const hub = new UserDeviceHub({ prisma: db.prisma, address: "http://relay" });
    server.on("upgrade", hub.handleUpgrade);
    await new Promise<void>((resolve) =>
      server.listen(Number(process.env.DOZO_RELAY_PORT ?? 8790), resolve),
    );
    const devices = new UserDevices({ prisma: db.prisma, forwardSecret: "relay", hub });
    // What the runs asked the computer, with what it answered.
    const asked: Array<{ method: string; forgotten?: boolean; cleared?: unknown }> = [];
    const seen = {
      connected: (owner: string) => devices.connected(owner),
      pairedSince: async () => new Date(0),
      async *request(owner: string, request: never, signal: AbortSignal, deviceId?: string) {
        const entry = {
          ...(request as { method: string; forgotten?: boolean }),
        } as (typeof asked)[number];
        asked.push(entry);
        for await (const value of devices.request<{ cleared?: unknown }>(
          owner,
          request,
          signal,
          deviceId,
        )) {
          entry.cleared = value?.cleared;
          yield value;
        }
      },
    };
    await writeFile(join(RELAY!, "session.json"), JSON.stringify({ token, botId: bot.id }));
    const connected = await until("the computer to connect with its browser", async () => {
      const found = (await devices.connected(id)) as DeclaredUserDevice | null;
      return found?.capabilities?.includes("browser") ? found : undefined;
    });
    expect(connected.deviceId).toBe(device.id);

    const run = (threadId: string) =>
      ({
        source: { userComputerOwner: id },
        deps: { userDevices: seen, prisma: db.prisma },
        bot: { id: bot.id, name: "Scout" },
        thread: { id: threadId },
        run: { botId: bot.id, threadId, userId: id },
        runId: randomUUID(),
        context: { signal: new AbortController().signal },
        state: {},
        trust: { receivedOutsideMessage: async () => false },
        computer: { acceptsImages: false, stored: {}, graphical: false },
        tools: { disabled: new Set<string>() },
      }) as unknown as RunContext;
    const allow = async () => {
      for (const threadId of threads)
        for (const site of ["", "read:example.test"])
          await recordConsent(db.prisma, { botId: bot.id, deviceId: device.id, threadId }, site);
    };
    const consents = async () =>
      (
        await system.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM dozo_browser_consents WHERE "botId" = ${bot.id}`
      )[0]!.n;
    const cleared = async () => {
      let answer: { cleared?: unknown } | undefined;
      for await (const value of devices.request<{ cleared?: unknown }>(
        id,
        { method: "pageBrowserCleared", botId: bot.id } as never,
        new AbortController().signal,
      ))
        answer = value;
      return answer?.cleared === true;
    };

    // The person cleared the browser on the computer before it connected.
    await allow();
    expect(await cleared()).toBe(true);
    expect(await userBrowserGate(run(threads[0]!), false, "browser_snapshot", {})).toBe("ask");
    expect(await consents()).toBe(0n);
    expect(asked.filter((request) => request.forgotten)).toHaveLength(1);
    expect(await cleared()).toBe(false);
    process.stdout.write(
      "E2E: relay: the server forgot, told the computer, and its mark is gone\n",
    );

    // Cleared again, then two runs of the same bot ask at once.
    await allow();
    asked.length = 0;
    await writeFile(join(RELAY!, "clear-again"), "");
    await until("the computer to be cleared again", async () =>
      (await cleared()) ? true : undefined,
    );
    const plans = await Promise.all(
      threads.map((threadId) => userBrowserGate(run(threadId), false, "browser_snapshot", {})),
    );
    expect(plans).toEqual(["ask", "ask"]);
    expect(await consents()).toBe(0n);
    const questions = asked.filter((r) => r.method === "pageBrowserCleared" && !r.forgotten);
    const told = asked.filter((request) => request.forgotten);
    expect(questions).toHaveLength(2);
    // Each run that heard "cleared" told the computer once it had forgotten.
    expect(told).toHaveLength(questions.filter((r) => r.cleared === true).length);
    expect(told.length).toBeGreaterThan(0);
    expect(await cleared()).toBe(false);
    process.stdout.write(
      `E2E: relay: two runs asked, ${questions.filter((r) => r.cleared === true).length} heard "cleared", ${told.length} told the computer; the mark is gone\n`,
    );
    await writeFile(join(RELAY!, "done"), "");
    await until("the computer to finish", async () =>
      existsSync(join(RELAY!, "computer-done")) ? true : undefined,
    );
  }, 300_000);
});
