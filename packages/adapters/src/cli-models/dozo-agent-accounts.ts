import { mkdir } from "node:fs/promises";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { defaultCatalogModelId } from "../models/model-selection.js";
import type { AgentDriver } from "./dozo-agent.js";
import { AGENT_OWN_MODEL, agentDataFolder, enabledAgentProviders } from "./dozo-agent.js";
import { agentModeConnections } from "./dozo-agent-modes.js";
import type { LocalCliHost } from "./dozo-cli-driver.js";
import { cliAccountRef } from "./dozo-cli-driver.js";
import { availableAgentDrivers } from "./dozo-cli-providers.js";

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
  /** The maker's page to get it from, only while it is not installed here. */
  downloadUrl?: string;
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

/**
 * Which of the agents the person has connected with its mode on (the setting, or the file kept
 * from before it). A connection with no mode is not one: connecting finishes it.
 */
export async function agentConnected(
  prisma: PrismaClient,
  userId: string,
  providers: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<Set<string>> {
  const rows = await prisma.userModelCredential.findMany({
    where: { userId, provider: { in: providers } },
    select: { provider: true, id: true },
  });
  if (!rows.length) return new Set();
  const byFile = enabledAgentProviders(env);
  const byMode = await agentModeConnections(prisma);
  return new Set(
    rows.filter((row) => byFile.has(row.provider) || byMode.has(row.id)).map((row) => row.provider),
  );
}

/** The agents this computer offers, each read fresh: installed, and connected or not. */
export async function readAgentTools(
  prisma: PrismaClient,
  userId: string,
  host: LocalCliHost,
): Promise<AgentToolView[]> {
  const drivers = availableAgentDrivers();
  if (!drivers.length) return [];
  const connected = await agentConnected(
    prisma,
    userId,
    drivers.map((driver) => driver.provider),
  );
  return Promise.all(
    drivers.map(async (driver) => {
      const found = await driver.installed(host);
      return {
        provider: driver.provider,
        name: driver.name,
        mode: "agent" as const,
        found,
        signedIn: null,
        connected: connected.has(driver.provider),
        canAdd: false as const,
        ...(driver.termsRisk ? { termsRisk: true as const } : {}),
        ...(!found && driver.downloadUrl ? { downloadUrl: driver.downloadUrl } : {}),
      };
    }),
  );
}

export function agentDriverFor(provider: string): AgentDriver | undefined {
  return availableAgentDrivers().find((driver) => driver.provider === provider);
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
