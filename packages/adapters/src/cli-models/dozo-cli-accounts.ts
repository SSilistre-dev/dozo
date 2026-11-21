import type { SecretStore } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { defaultCatalogModelId, loadStoredModelSecret } from "../model-selection.js";
import { agentConnection, agentDriverFor, readAgentTools } from "./dozo-agent-accounts.js";
import type { CliAccount, CliModelDriver, LocalCliHost } from "./dozo-cli-driver.js";
import {
  cliAccountOverrides,
  cliAccountRef,
  localCliHost,
  parseCliAccountRef,
  probeCli,
} from "./dozo-cli-driver.js";
import { accountHome, accountHomeIds, removeAccountHome } from "./dozo-cli-homes.js";
import type { CliLoginView } from "./dozo-cli-login.js";
import { cliLoginView, liveCliLogins, startCliLogin } from "./dozo-cli-login.js";
import { CLI_MODEL_DRIVERS } from "./dozo-cli-providers.js";
import { personalCliAccessCheck } from "./personal-access.js";

export { cancelCliLogin, sendCliLoginCode } from "./dozo-cli-login.js";

export type CliAccountsDeps = {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  billingEnabled?: boolean;
};

/** How many accounts of one tool a person may connect, their own sign-in included. */
export const MAX_CLI_ACCOUNTS = 5;

/** A tool as settings show it: whether it is installed here, signed in, and already connected. */
export interface CliToolView {
  provider: string;
  name: string;
  /** A model the bot talks through, or an agent that runs the bot's whole turn. */
  mode: "model" | "agent";
  found: boolean;
  /** Whether the person's own sign-in is there; null when the tool would not say. */
  signedIn: boolean | null;
  /** A connection already uses the person's own sign-in. */
  connected: boolean;
  /** Another account may still be added. */
  canAdd: boolean;
  /** A sign-in of another account in progress, or one that did not finish. */
  login?: CliLoginView;
  /** An agent whose maker's terms put the person's account at risk (dozo-agent-accounts.ts). */
  termsRisk?: true;
}

/**
 * The tools that may run as models here: none on a server that is not on the person's own
 * computer, or that bills for models or serves more than one person, and none for anyone but
 * that person.
 */
async function usableHost(deps: CliAccountsDeps, userId: string) {
  const host = localCliHost();
  if (!host || (await personalCliAccessCheck(deps)())) return undefined;
  const thePerson = await runAsSystem("check that the CLI tools' person is asking", () =>
    deps.prisma.user.count({
      where: {
        id: userId,
        deactivatedAt: null,
        members: { some: { spaceMemberships: { some: {} } } },
      },
    }),
  );
  return thePerson ? host : undefined;
}

function driverFor(provider: string) {
  return CLI_MODEL_DRIVERS.find((entry) => entry.provider === provider);
}

/** The accounts each tool's connections use, by provider. */
async function connectedAccounts(
  deps: CliAccountsDeps,
  userId: string,
): Promise<Map<string, CliAccount[]>> {
  const rows = await deps.prisma.userModelCredential.findMany({
    where: { userId, provider: { in: CLI_MODEL_DRIVERS.map((driver) => driver.provider) } },
    select: { provider: true, secretId: true },
  });
  const accounts = new Map<string, CliAccount[]>();
  for (const row of rows) {
    const secret = await loadStoredModelSecret(deps.prisma, deps.secretStore, userId, row.secretId);
    const account = secret.status === "loaded" ? parseCliAccountRef(secret.plaintext) : undefined;
    if (account) accounts.set(row.provider, [...(accounts.get(row.provider) ?? []), account]);
  }
  return accounts;
}

async function toolState(driver: CliModelDriver, host: LocalCliHost) {
  const overrides = cliAccountOverrides(driver, host, undefined);
  const version = await probeCli(driver, driver.args.version, overrides);
  if (version.missing) return { found: false, signedIn: null };
  const status = await probeCli(driver, driver.args.status, overrides);
  return { found: true, signedIn: driver.signedIn(status.stdout) ?? null };
}

/** The added homes any connection on this server uses, whoever holds it. */
async function homesInUse(deps: CliAccountsDeps, provider: string): Promise<Set<string>> {
  return runAsSystem("find the CLI account homes connections use", async () => {
    const rows = await deps.prisma.userModelCredential.findMany({
      where: { provider },
      select: { userId: true, secretId: true },
    });
    const ids = new Set<string>();
    for (const row of rows) {
      const secret = await loadStoredModelSecret(
        deps.prisma,
        deps.secretStore,
        row.userId,
        row.secretId,
      );
      const account = secret.status === "loaded" ? parseCliAccountRef(secret.plaintext) : undefined;
      if (account?.kind === "added") ids.add(account.id);
    }
    return ids;
  });
}

/**
 * Removes the homes no connection uses any more (one disconnected in settings, or a sign-in the
 * server stopped in the middle of), except those still signing in: the tool signs each out first,
 * so it also forgets what it kept outside the folder. Sign-ins are read before connections, so one
 * that finishes in between is in one of the two.
 */
async function removeUnusedHomes(
  deps: CliAccountsDeps,
  driver: CliModelDriver,
  host: LocalCliHost,
) {
  const live = liveCliLogins(driver.provider);
  const kept = await homesInUse(deps, driver.provider);
  for (const id of await accountHomeIds(driver.provider)) {
    if (kept.has(id) || live.has(id)) continue;
    const folder = await accountHome(driver.provider, id);
    if (folder)
      await probeCli(driver, driver.args.logout, cliAccountOverrides(driver, host, folder));
    await removeAccountHome(driver.provider, id);
  }
}

/** Each tool, read fresh: what is on the person's PATH and signed in can change at any time. */
export async function readCliTools(deps: CliAccountsDeps, userId: string): Promise<CliToolView[]> {
  const host = await usableHost(deps, userId);
  if (!host) return [];
  const connected = await connectedAccounts(deps, userId);
  const agents = await readAgentTools(deps.prisma, userId, host);
  const models = await Promise.all(
    CLI_MODEL_DRIVERS.map(async (driver) => {
      const accounts = connected.get(driver.provider) ?? [];
      await removeUnusedHomes(deps, driver, host);
      const state = await toolState(driver, host);
      const login = cliLoginView(userId, driver.provider);
      return {
        provider: driver.provider,
        name: driver.name,
        mode: "model" as const,
        ...state,
        connected: accounts.some((account) => account.kind === "home"),
        canAdd: state.found && accounts.length < MAX_CLI_ACCOUNTS,
        ...(login ? { login } : {}),
      };
    }),
  );
  return [...models, ...agents];
}

export class CliAccountUnavailableError extends ClientError {
  constructor(message: string) {
    super("CONFLICT", message, "cli_account_unavailable");
  }
}

/** A tool the person may connect here, installed: else a refusal that says why not. */
async function usableTool(deps: CliAccountsDeps, userId: string, provider: string) {
  const driver = driverFor(provider);
  const host = await usableHost(deps, userId);
  if (!driver || !host)
    throw new ClientError("NOT_FOUND", "This tool cannot be used on this server.");
  const state = await toolState(driver, host);
  if (!state.found)
    throw new CliAccountUnavailableError(`${driver.name} is not installed on this computer.`);
  return { driver, host, state };
}

/** What a connection to one of the tool's accounts stores: only which home, never a sign-in. */
export function cliConnection(driver: CliModelDriver, account: CliAccount) {
  return {
    provider: driver.provider,
    label: driver.name,
    plaintext: cliAccountRef(account),
    modelId: defaultCatalogModelId(driver.modelSource) ?? undefined,
  };
}

/**
 * The connection to the person's own sign-in of `provider`, once the tool is there, signed in,
 * and not connected yet. The sign-in stays the tool's own.
 */
export async function cliHomeConnection(
  deps: CliAccountsDeps,
  userId: string,
  provider: string,
  options: { consent?: boolean; termsConsent?: boolean } = {},
): Promise<ReturnType<typeof cliConnection>> {
  const agent = agentDriverFor(provider);
  if (agent) {
    const host = await usableHost(deps, userId);
    if (!host) throw new ClientError("NOT_FOUND", "This tool cannot be used on this server.");
    const connected = await deps.prisma.userModelCredential.count({ where: { userId, provider } });
    if (connected) throw new CliAccountUnavailableError(`${agent.name} is already connected.`);
    return agentConnection(agent, host, {
      agent: options.consent === true,
      terms: options.termsConsent === true,
    });
  }
  const { driver, state } = await usableTool(deps, userId, provider);
  if (state.signedIn === false)
    throw new CliAccountUnavailableError(`Sign in to ${driver.name} on this computer first.`);
  const accounts = (await connectedAccounts(deps, userId)).get(provider) ?? [];
  if (accounts.some((account) => account.kind === "home"))
    throw new CliAccountUnavailableError(`${driver.name} is already connected.`);
  return cliConnection(driver, { kind: "home" });
}

/**
 * Starts the sign-in of another account of `provider` in a new home of its own (dozo-cli-login.ts),
 * up to the limit. `save` makes the signed-in account a connection; `changed` signals the person's
 * apps at each step.
 */
export async function startCliAccountLogin(
  deps: CliAccountsDeps,
  userId: string,
  provider: string,
  handlers: {
    save: (connection: ReturnType<typeof cliConnection>) => Promise<void>;
    changed: () => void;
  },
): Promise<CliLoginView> {
  const { driver, host } = await usableTool(deps, userId, provider);
  const accounts = (await connectedAccounts(deps, userId)).get(provider) ?? [];
  if (accounts.length >= MAX_CLI_ACCOUNTS)
    throw new CliAccountUnavailableError(
      `${driver.name} already has ${MAX_CLI_ACCOUNTS} accounts connected.`,
    );
  await removeUnusedHomes(deps, driver, host);
  return startCliLogin({
    driver,
    host,
    userId,
    onSignedIn: (account) => handlers.save(cliConnection(driver, account)),
    onChange: handlers.changed,
  });
}
