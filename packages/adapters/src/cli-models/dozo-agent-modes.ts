import type { PrismaClient } from "@rakazo/db";
import { enabledAgentProviders } from "./dozo-agent.js";
import { AGENT_DRIVERS } from "./dozo-cli-providers.js";

// The agents the owner of this server turned on (migration 20270124120000_dozo_agent_modes), read
// and written with SQL: the table has no model in schema.prisma. One row per agent: on or off,
// never a path or a command line, so the setting cannot name a program to start.

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

/** The ids the setting may name: the agents Dozo knows, never anything the caller sends. */
const knownAgent = (provider: string) => AGENT_DRIVERS.some((driver) => driver.provider === provider);

/**
 * Whether the agent's mode is on for this server: the setting, or the line the file
 * `dozo-agent-tools` in the data folder still holds from before the setting (dozo-agent.ts).
 */
export async function agentModeEnabled(
  db: Db,
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!knownAgent(provider)) return false;
  if (enabledAgentProviders(env).has(provider)) return true;
  const rows = await db.$queryRaw<Array<{ provider: string }>>`
    SELECT provider FROM dozo_agent_modes WHERE provider = ${provider}`;
  return rows.length > 0;
}

/** Turns an agent's mode on or off. Only a boolean for a known agent: nothing else is stored. */
export async function setAgentMode(db: Db, provider: string, enabled: boolean): Promise<void> {
  if (typeof enabled !== "boolean") throw new TypeError("An agent's mode is on or off.");
  if (!knownAgent(provider)) throw new TypeError("This is not an agent Dozo knows.");
  if (enabled)
    await db.$executeRaw`
      INSERT INTO dozo_agent_modes (provider) VALUES (${provider})
      ON CONFLICT (provider) DO UPDATE SET "updatedAt" = CURRENT_TIMESTAMP`;
  else await db.$executeRaw`DELETE FROM dozo_agent_modes WHERE provider = ${provider}`;
}

/**
 * Called once a connection is saved: connecting an agent, which asks the person to agree first, is
 * what turns its mode on. Any other provider's connection leaves the setting alone.
 */
export async function recordAgentConnection(db: Db, provider: string): Promise<void> {
  if (knownAgent(provider)) await setAgentMode(db, provider, true);
}
