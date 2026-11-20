import type { SecretStore } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { defaultCatalogModelId, loadStoredModelSecret } from "../model-selection.js";
import type { CliModelDriver } from "./dozo-cli-driver.js";
import {
  cliAccountOverrides,
  cliAccountRef,
  localCliHost,
  parseCliAccountRef,
  probeCli,
} from "./dozo-cli-driver.js";
import { CLI_MODEL_DRIVERS } from "./dozo-cli-providers.js";
import { personalCliAccessCheck } from "./personal-access.js";

export type CliAccountsDeps = {
  prisma: PrismaClient;
  secretStore: Pick<SecretStore, "load">;
  billingEnabled?: boolean;
};

/** A tool as settings show it: whether it is installed here, signed in, and already connected. */
export interface CliToolView {
  provider: string;
  name: string;
  found: boolean;
  /** Whether the person's own sign-in is there; null when the tool would not say. */
  signedIn: boolean | null;
  /** A connection already uses the person's own sign-in. */
  connected: boolean;
}

/**
 * The tools that may run as models here: none on a server that is not on the person's own
 * computer, or that bills for models or serves more than one person.
 */
async function usableHost(deps: CliAccountsDeps) {
  const host = localCliHost();
  if (!host || (await personalCliAccessCheck(deps)())) return undefined;
  return host;
}

/** The providers whose connection uses the person's own sign-in. */
async function connectedHomes(deps: CliAccountsDeps, userId: string): Promise<Set<string>> {
  const rows = await deps.prisma.userModelCredential.findMany({
    where: { userId, provider: { in: CLI_MODEL_DRIVERS.map((driver) => driver.provider) } },
    select: { provider: true, secretId: true },
  });
  const connected = new Set<string>();
  for (const row of rows) {
    const secret = await loadStoredModelSecret(deps.prisma, deps.secretStore, userId, row.secretId);
    if (secret.status === "loaded" && parseCliAccountRef(secret.plaintext))
      connected.add(row.provider);
  }
  return connected;
}

async function toolState(
  driver: CliModelDriver,
  host: NonNullable<ReturnType<typeof localCliHost>>,
) {
  const overrides = cliAccountOverrides(driver, host, undefined);
  const version = await probeCli(driver, driver.args.version, overrides);
  if (version.missing) return { found: false, signedIn: null };
  const status = await probeCli(driver, driver.args.status, overrides);
  return { found: true, signedIn: driver.signedIn(status.stdout) ?? null };
}

/** Each tool, read fresh: what is on the person's PATH and signed in can change at any time. */
export async function readCliTools(deps: CliAccountsDeps, userId: string): Promise<CliToolView[]> {
  const host = await usableHost(deps);
  if (!host) return [];
  const connected = await connectedHomes(deps, userId);
  return Promise.all(
    CLI_MODEL_DRIVERS.map(async (driver) => ({
      provider: driver.provider,
      name: driver.name,
      ...(await toolState(driver, host)),
      connected: connected.has(driver.provider),
    })),
  );
}

export class CliAccountUnavailableError extends ClientError {
  constructor(message: string) {
    super("CONFLICT", message, "cli_account_unavailable");
  }
}

/**
 * What a connection to the person's own sign-in of `provider` stores, once the tool is there,
 * signed in, and not connected yet. The sign-in stays the tool's own; only its name is saved.
 */
export async function cliHomeConnection(
  deps: CliAccountsDeps,
  userId: string,
  provider: string,
): Promise<{ provider: string; label: string; plaintext: string; modelId?: string }> {
  const driver = CLI_MODEL_DRIVERS.find((entry) => entry.provider === provider);
  const host = await usableHost(deps);
  if (!driver || !host)
    throw new ClientError("NOT_FOUND", "This tool cannot be used on this server.");
  const state = await toolState(driver, host);
  if (!state.found)
    throw new CliAccountUnavailableError(`${driver.name} is not installed on this computer.`);
  if (state.signedIn === false)
    throw new CliAccountUnavailableError(`Sign in to ${driver.name} on this computer first.`);
  if ((await connectedHomes(deps, userId)).has(provider))
    throw new CliAccountUnavailableError(`${driver.name} is already connected.`);
  return {
    provider,
    label: driver.name,
    plaintext: cliAccountRef({ kind: "home" }),
    modelId: defaultCatalogModelId(driver.modelSource) ?? undefined,
  };
}
