import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentModeEnabled, setAgentMode } from "./dozo-agent-modes.js";
import { AGENT_DRIVERS } from "./dozo-cli-providers.js";

// Runs against a migrated database only (dozo/docker/postgres-tests.sh). The fork's unit gate has
// no database and skips it.
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("agent modes (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  const provider = AGENT_DRIVERS[0]!.provider;

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await db.prisma.$executeRaw`DELETE FROM dozo_agent_modes`;
    await db.pool.end();
  });

  it("is off without a row, on with one, and off again once it is turned off", async () => {
    const env = { DATA_DIR: "/nonexistent-dozo-data" };
    await setAgentMode(db.prisma, provider, false);
    expect(await agentModeEnabled(db.prisma, provider, env)).toBe(false);
    await setAgentMode(db.prisma, provider, true);
    // Turning it on twice leaves one row.
    await setAgentMode(db.prisma, provider, true);
    expect(await agentModeEnabled(db.prisma, provider, env)).toBe(true);
    const rows = await db.prisma.$queryRaw<
      Array<{ count: number }>
    >`SELECT count(*)::int AS count FROM dozo_agent_modes`;
    expect(rows[0]?.count).toBe(1);
    await setAgentMode(db.prisma, provider, false);
    expect(await agentModeEnabled(db.prisma, provider, env)).toBe(false);
  });
});
