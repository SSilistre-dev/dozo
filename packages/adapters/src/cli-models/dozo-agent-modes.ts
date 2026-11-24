import type { PrismaClient } from "@rakazo/db";
import { enabledAgentProviders } from "./dozo-agent.js";
import { AGENT_DRIVERS } from "./dozo-cli-providers.js";

// The agents the owner of this server turned on (migration 20270124120000_dozo_agent_modes), read
// and written with SQL: the table has no model in schema.prisma. One row per agent: on or off,
// never a path or a command line, so the setting cannot name a program to start.

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

/** The ids the setting may name: the agents Dozo knows, never anything the caller sends. */
const knownAgent = (provider: string) =>
  AGENT_DRIVERS.some((driver) => driver.provider === provider);

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

/** Turns an agent's mode off, or on for the connection the person made (which owns the row). */
export async function setAgentMode(
  db: Db,
  provider: string,
  enabled: boolean,
  credentialId?: string,
): Promise<void> {
  if (typeof enabled !== "boolean") throw new TypeError("An agent's mode is on or off.");
  if (!knownAgent(provider)) throw new TypeError("This is not an agent Dozo knows.");
  if (!enabled) {
    await db.$executeRaw`DELETE FROM dozo_agent_modes WHERE provider = ${provider}`;
    return;
  }
  if (typeof credentialId !== "string" || !credentialId)
    throw new TypeError("An agent's mode is turned on for a connection.");
  await db.$executeRaw`
    INSERT INTO dozo_agent_modes (provider, "credentialId") VALUES (${provider}, ${credentialId})
    ON CONFLICT (provider) DO UPDATE SET "credentialId" = EXCLUDED."credentialId",
      "updatedAt" = CURRENT_TIMESTAMP`;
}

/** The connections whose agent has its mode on by the setting. */
export async function agentModeConnections(db: Db): Promise<Set<string>> {
  const rows = await db.$queryRaw<Array<{ credentialId: string }>>`
    SELECT "credentialId" FROM dozo_agent_modes`;
  return new Set(rows.map((row) => row.credentialId));
}

/** Whether `provider` is an agent Dozo knows: the only connections this module makes. */
export const isAgentProvider = knownAgent;

/**
 * Saves an agent's connection and turns its mode on, once the person agreed and the agent passed
 * its check. The connection is saved first; if turning the mode on then fails, the next attempt
 * finds that connection with no mode, takes it over and finishes, so nothing is left hidden.
 * Removing the connection removes the mode (the table's foreign key).
 */
export async function saveAgentConnection(
  db: Db & Pick<PrismaClient, "userModelCredential">,
  userId: string,
  provider: string,
  save: () => Promise<{ id: string }>,
): Promise<void> {
  const existing = await db.userModelCredential.findFirst({
    where: { userId, provider },
    select: { id: true },
  });
  const id = existing?.id ?? (await save()).id;
  await setAgentMode(db, provider, true, id);
}
