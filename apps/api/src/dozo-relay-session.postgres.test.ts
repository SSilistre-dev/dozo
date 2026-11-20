import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createAuth, forgetRelayAgentKey } from "@rakazo/auth";
import {
  RELAY_AGENT_PROOF_HEADER,
  RELAY_CHANNEL_HEADER,
  RELAY_SESSION_PATH,
} from "@rakazo/contracts";
import { relayAgentProof, revokePhoneSession } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, bootstrapUserSpace, createDb } from "@rakazo/db";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mountDozoRelaySessions } from "./dozo-relay-session.js";

/**
 * The whole server side against a migrated database: the agent's proof and revocation (core's own
 * code), the route on a real Node server, the real `createAuth`, and Postgres with its advisory
 * lock. Needs `VERIFY_DATABASE=1` and `DATABASE_URL`; the unit gate has none and skips it.
 */

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

const KEY = "e".repeat(64);
const BASE = "http://127.0.0.1:5173";

describePostgres("a phone's sign-in (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let pool: ReturnType<typeof createDb>["pool"];
  let close: () => Promise<void>;
  let origin: string;
  let auth: ReturnType<typeof createAuth>;
  const userId = randomUUID();

  beforeAll(async () => {
    const db = createDb(String(process.env.DATABASE_URL));
    prisma = db.prisma;
    pool = db.pool;
    forgetRelayAgentKey();
    vi.stubEnv("DOZO_RELAY_AGENT_KEY", KEY);
    auth = createAuth(prisma, {
      secret: "offline-auth-secret-at-least-32-characters",
      baseURL: BASE,
      webOrigin: BASE,
      signupsEnabled: "true",
      signupAllowlist: "",
    });
    vi.unstubAllEnvs();
    // The computer's one account, signed in there just now.
    await prisma.user.create({
      data: {
        id: userId,
        email: `owner-${userId}@example.com`,
        name: "Owner",
        emailVerified: true,
      },
    });
    // A local account has its space from its first sign-in on the computer.
    await bootstrapUserSpace(asSystem(prisma), { id: userId });
    await prisma.session.create({
      data: {
        id: randomUUID(),
        userId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const app = new Hono();
    mountDozoRelaySessions(app, { auth, prisma });
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await prisma.session.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await db.pool.end();
    };
  });

  afterAll(async () => {
    await close?.();
    forgetRelayAgentKey();
  });

  /** The agent's sign-in request for `channel`, as `run` sends it once the user approved. */
  async function ask(channel: string) {
    const proof = await relayAgentProof(
      KEY,
      { method: "POST", path: RELAY_SESSION_PATH, channel },
      Date.now(),
    );
    return fetch(`${origin}${RELAY_SESSION_PATH}`, {
      method: "POST",
      headers: { [RELAY_AGENT_PROOF_HEADER]: proof, [RELAY_CHANNEL_HEADER]: channel },
    });
  }

  it("gives one session per channel even when asked many times at once, until the phone is removed", async () => {
    const channel = randomUUID().replaceAll("-", "").slice(0, 22);
    const answers = await Promise.all(Array.from({ length: 8 }, () => ask(channel)));
    const statuses = answers.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 410, 410, 410, 410, 410, 410, 410]);
    const ok = answers.find((response) => response.status === 200) as Response;
    const { token } = (await ok.json()) as { token: string };
    const session = await auth.api.getSession({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    expect(session?.user.id).toBe(userId);

    expect(await revokePhoneSession({ origin, sessionKey: KEY, channel })).toBe(true);
    expect(
      await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) }),
    ).toBeNull();
    expect((await ask(channel)).status).toBe(410);
  });

  it("claims a channel under its lock, so two servers never give it twice", async () => {
    const channel = randomUUID().replaceAll("-", "").slice(0, 22);
    // Another holder of the channel's lock: the request waits for it.
    const holder = await pool.connect();
    await holder.query("SELECT pg_advisory_lock(hashtext($1))", [`dozo-relay-session:${channel}`]);
    let settled = false;
    const asked = ask(channel).then((response) => {
      settled = true;
      return response;
    });
    // The request is in Postgres, waiting for that lock, and has not answered.
    await vi.waitFor(async () => {
      const waiting = await holder.query(
        "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
      );
      expect(waiting.rows[0]?.n).toBe(1);
    });
    expect(settled).toBe(false);
    await holder.query("SELECT pg_advisory_unlock(hashtext($1))", [
      `dozo-relay-session:${channel}`,
    ]);
    holder.release();
    expect((await asked).status).toBe(200);
  });

  it("refuses a proof under another key", async () => {
    const channel = randomUUID().replaceAll("-", "").slice(0, 22);
    const proof = await relayAgentProof(
      "f".repeat(64),
      { method: "POST", path: RELAY_SESSION_PATH, channel },
      Date.now(),
    );
    const response = await fetch(`${origin}${RELAY_SESSION_PATH}`, {
      method: "POST",
      headers: { [RELAY_AGENT_PROOF_HEADER]: proof, [RELAY_CHANNEL_HEADER]: channel },
    });
    expect(response.status).toBe(404);
  });
});
