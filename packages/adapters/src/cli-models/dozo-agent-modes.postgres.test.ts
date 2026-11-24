import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentModeConnections, agentModeEnabled, setAgentMode } from "./dozo-agent-modes.js";
import { AGENT_DRIVERS } from "./dozo-cli-providers.js";

// Runs against a migrated database only (dozo/docker/postgres-tests.sh). The fork's unit gate has
// no database and skips it.
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("agent modes (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const provider = AGENT_DRIVERS[0]!.provider;
  const userId = `agent-modes-${randomUUID()}`;
  const env = { DATA_DIR: "/nonexistent-dozo-data" };

  const connect = async () => {
    const id = randomUUID();
    await system.secret.create({
      data: { id, userId, kind: "model", ciphertext: "fake-ciphertext" },
    });
    await system.userModelCredential.create({
      data: { id, userId, provider, label: provider, secretId: id },
    });
    return id;
  };

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
    await system.user.create({
      data: { id: userId, name: "Ada", email: `${userId}@example.test`, emailVerified: true },
    });
  });

  afterAll(async () => {
    await system.$executeRaw`DELETE FROM dozo_agent_modes`;
    await system.user.deleteMany({ where: { id: userId } });
    await db.pool.end();
  });

  it("is off without a row, on for a connection, and off again once it is turned off", async () => {
    const id = await connect();
    await setAgentMode(system, provider, false);
    expect(await agentModeEnabled(system, provider, env)).toBe(false);
    await setAgentMode(system, provider, true, id);
    // Turning it on twice leaves one row.
    await setAgentMode(system, provider, true, id);
    expect(await agentModeEnabled(system, provider, env)).toBe(true);
    expect([...(await agentModeConnections(system))]).toEqual([id]);
    await setAgentMode(system, provider, false);
    expect(await agentModeEnabled(system, provider, env)).toBe(false);
  });

  it("goes with the connection that owns it", async () => {
    const id = await connect();
    await setAgentMode(system, provider, true, id);
    await system.userModelCredential.delete({ where: { id } });
    expect(await agentModeEnabled(system, provider, env)).toBe(false);
  });

  it("refuses a connection that does not exist", async () => {
    await expect(setAgentMode(system, provider, true, randomUUID())).rejects.toThrow();
  });
});
