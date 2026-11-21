import type {
  Api,
  AssistantMessageEventStream,
  Model,
  MutableModels,
  Provider,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  createProvider,
  lazyStream,
} from "@earendil-works/pi-ai";
import { registerLocalProvider as registerServerModels } from "../pi-local-provider.js";
import { claudeCodeDriver } from "./claude-code/dozo-driver.js";
import { codexAgentDriver } from "./codex/dozo-codex-agent.js";
import type { AgentDriver } from "./dozo-agent.js";
import { enabledAgentProviders } from "./dozo-agent.js";
import type { CliAccount, CliModelDriver, CliTurn } from "./dozo-cli-driver.js";
import {
  cliAccountOverrides,
  localCliHost,
  parseCliAccountRef,
  withCliAccount,
} from "./dozo-cli-driver.js";
import { accountHome } from "./dozo-cli-homes.js";
import type { PersonalCliAccessCheck } from "./personal-access.js";

export { LOCAL_PROVIDER_ID } from "../pi-local-provider.js";

/** The tools a person may use as models on their own computer. */
export const CLI_MODEL_DRIVERS: readonly CliModelDriver[] = [claudeCodeDriver];

/** The agents that can run a bot's whole turn on the person's own computer (dozo-agent.ts). */
export const AGENT_DRIVERS: readonly AgentDriver[] = [codexAgentDriver];

/** The agents turned on for this server (dozo-agent.ts): only those are listed or run. */
export function enabledAgentDrivers(): AgentDriver[] {
  // Process groups and the bridge's socket are Unix only, as the desktop app's own server is.
  if (process.platform === "win32") return [];
  const enabled = enabledAgentProviders();
  return AGENT_DRIVERS.filter((driver) => enabled.has(driver.provider));
}

export const AGENT_CATALOG_ERROR = "An agent's turn runs in agent mode, not as a model.";

/**
 * An agent's connections in the catalog, so a bot can choose it: named as an agent, with the
 * models the agent takes. Agent mode runs the turn (dozo-agent.ts); this copy never streams.
 */
function agentCatalogProvider(driver: AgentDriver, models: MutableModels): Provider {
  const stream = (model: Model<Api>) =>
    lazyStream(model, async () => {
      throw new Error(AGENT_CATALOG_ERROR);
    });
  return createProvider({
    id: driver.provider,
    name: `${driver.name} agent`,
    auth: {
      apiKey: {
        name: `${driver.name} on this computer`,
        resolve: async () => ({ auth: {}, source: driver.command }),
      },
    },
    models: models.getModels(driver.modelSource).map((model) => ({
      ...model,
      provider: driver.provider,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    api: { stream, streamSimple: stream },
  });
}

export const CLI_ACCOUNT_RECONNECT_ERROR =
  "This connection no longer names an account on this computer. Connect it again in Settings.";
export const CLI_CATALOG_ONLY_ERROR = "This tool runs only inside the server's API and worker.";

/** The account's home folder for the tool's home variable: none for the person's own. */
async function homeFolder(driver: CliModelDriver, account: CliAccount) {
  if (account.kind === "home") return { folder: undefined };
  const folder = await accountHome(driver.provider, account.id);
  return folder ? { folder } : undefined;
}

/**
 * The turn's error in the words the model pool reads (dozo-model-pool.ts): a refused sign-in names
 * this account, not the server's, and a usage limit the tool reported says it is one and when it
 * opens again, so the pool rests this account until then and the next one takes the call.
 */
function accountError(driver: CliModelDriver, turn: CliTurn, message: string): string {
  if (/\(401\)/.test(message))
    return `${driver.name} API error (401): this account is signed out. Sign it in again in Settings.`;
  if (!turn.limit) return message;
  const resetsAt = turn.limit.resetsAt;
  const minutes = resetsAt ? Math.max(1, Math.ceil((resetsAt - Date.now()) / 60_000)) : undefined;
  return `${message} Usage limit reached${minutes ? `; try again in ~${minutes} min` : ""}.`;
}

function withAccountErrors(
  driver: CliModelDriver,
  turn: CliTurn,
  inner: AssistantMessageEventStream,
): AssistantMessageEventStream {
  const outer = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of inner) {
      if (event.type === "error" && event.error.stopReason === "error")
        event.error.errorMessage = accountError(driver, turn, event.error.errorMessage ?? "");
      outer.push(event);
    }
    outer.end();
  })();
  return outer;
}

/**
 * A tool's connections as a provider. The stored "key" names the account's home; the tool signs
 * its own requests, so there is nothing to resolve. A turn runs only on the person's computer and
 * only after `accessCheck` allows it.
 */
export function cliModelProvider(
  driver: CliModelDriver,
  models: MutableModels,
  accessCheck?: PersonalCliAccessCheck,
): Provider {
  const assertAllowed = async () => {
    const refusal = accessCheck ? await accessCheck() : CLI_CATALOG_ONLY_ERROR;
    if (refusal) throw new Error(refusal);
  };
  const stream = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) =>
    lazyStream(model, async () => {
      const host = localCliHost();
      const account = parseCliAccountRef(options?.apiKey);
      const home = account && (await homeFolder(driver, account));
      // Never another account in its place: the pool keeps each account's limits apart.
      if (!host || !home) throw new Error(CLI_ACCOUNT_RECONNECT_ERROR);
      const turn: CliTurn = { driver, overrides: cliAccountOverrides(driver, host, home.folder) };
      const inner = await withCliAccount(turn, () =>
        driver.stream(model, context, { ...options, assertAllowed }),
      );
      return withAccountErrors(driver, turn, inner);
    });
  return createProvider({
    id: driver.provider,
    name: driver.name,
    auth: {
      apiKey: {
        name: `${driver.name} on this computer`,
        resolve: async () => ({ auth: {}, source: driver.command }),
      },
    },
    models: driver.models(models),
    api: { stream, streamSimple: stream },
  });
}

/** Adds each tool's provider, only on a server running on the person's own computer. */
export function registerLocalCliProviders(
  models: MutableModels,
  accessCheck?: PersonalCliAccessCheck,
): MutableModels {
  if (!localCliHost()) return models;
  for (const driver of CLI_MODEL_DRIVERS)
    models.setProvider(cliModelProvider(driver, models, accessCheck));
  for (const driver of enabledAgentDrivers())
    models.setProvider(agentCatalogProvider(driver, models));
  return models;
}

/**
 * The catalog's providers that run on this computer: the server's own local model server, and on
 * the person's own computer their command-line tools, listed so a connection can pick a model.
 */
export function registerLocalProvider(models: MutableModels): MutableModels {
  return registerLocalCliProviders(registerServerModels(models));
}
