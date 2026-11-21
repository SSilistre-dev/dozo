import { mkdir } from "node:fs/promises";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { defaultCatalogModelId } from "../model-selection.js";
import type { AgentDriver } from "./dozo-agent.js";
import { AGENT_OWN_MODEL, agentDataFolder } from "./dozo-agent.js";
import type { LocalCliHost } from "./dozo-cli-driver.js";
import { cliAccountRef } from "./dozo-cli-driver.js";
import { enabledAgentDrivers } from "./dozo-cli-providers.js";

/** An agent as settings show it: installed or not, and whether it is connected. */
export interface AgentToolView {
  provider: string;
  name: string;
  mode: "agent";
  found: boolean;
  signedIn: null;
  connected: boolean;
  canAdd: false;
  /** Its maker's terms put the person's account at risk; connecting asks them to accept that. */
  termsRisk?: true;
}

export class AgentConsentError extends ClientError {
  constructor() {
    super("BAD_REQUEST", "Agent mode needs your agreement first.", "agent_consent");
  }
}

export class AgentTermsConsentError extends ClientError {
  constructor() {
    super("BAD_REQUEST", "Accept the risk to your account first.", "agent_terms_consent");
  }
}

export class AgentUnavailableError extends ClientError {
  constructor(message: string) {
    super("CONFLICT", message, "agent_unavailable");
  }
}

/** The agents turned on for this server, each read fresh: installed, and connected or not. */
export async function readAgentTools(
  prisma: PrismaClient,
  userId: string,
  host: LocalCliHost,
): Promise<AgentToolView[]> {
  const drivers = enabledAgentDrivers();
  if (!drivers.length) return [];
  const connected = new Set(
    (
      await prisma.userModelCredential.findMany({
        where: { userId, provider: { in: drivers.map((driver) => driver.provider) } },
        select: { provider: true },
      })
    ).map((row) => row.provider),
  );
  return Promise.all(
    drivers.map(async (driver) => ({
      provider: driver.provider,
      name: driver.name,
      mode: "agent" as const,
      found: await driver.installed(host),
      signedIn: null,
      connected: connected.has(driver.provider),
      canAdd: false as const,
      ...(driver.termsRisk ? { termsRisk: true as const } : {}),
    })),
  );
}

export function agentDriverFor(provider: string): AgentDriver | undefined {
  return enabledAgentDrivers().find((driver) => driver.provider === provider);
}

/**
 * The connection that makes `driver` a bot's agent, once the person agreed to what agent mode
 * means and the agent passed its check here: the version Dozo was checked with, its own sign-in,
 * and a working bridge to Dozo's tools. A failed check says why, and nothing is saved.
 */
export async function agentConnection(
  driver: AgentDriver,
  host: LocalCliHost,
  consent: { agent: boolean; terms?: boolean },
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!consent.agent) throw new AgentConsentError();
  // The person accepted, separately, that the agent's maker may close their account for it.
  if (driver.termsRisk && !consent.terms) throw new AgentTermsConsentError();
  const workDir = agentDataFolder(env, "agent-work", "check");
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const reason = await driver.selfTest(host, workDir);
  if (reason) throw new AgentUnavailableError(reason);
  return {
    provider: driver.provider,
    label: `${driver.name} agent`,
    plaintext: cliAccountRef({ kind: "home" }),
    modelId: driver.modelSource
      ? (defaultCatalogModelId(driver.modelSource) ?? undefined)
      : AGENT_OWN_MODEL,
  };
}
