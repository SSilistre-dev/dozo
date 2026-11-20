import type {
  Api,
  Model,
  MutableModels,
  Provider,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { createProvider, lazyStream } from "@earendil-works/pi-ai";
import { registerLocalProvider as registerServerModels } from "../pi-local-provider.js";
import { claudeCodeDriver } from "./claude-code/dozo-driver.js";
import type { CliModelDriver } from "./dozo-cli-driver.js";
import {
  cliAccountOverrides,
  localCliHost,
  parseCliAccountRef,
  withCliAccount,
} from "./dozo-cli-driver.js";
import type { PersonalCliAccessCheck } from "./personal-access.js";

export { LOCAL_PROVIDER_ID } from "../pi-local-provider.js";

/** The tools a person may use as models on their own computer. */
export const CLI_MODEL_DRIVERS: readonly CliModelDriver[] = [claudeCodeDriver];

export const CLI_ACCOUNT_RECONNECT_ERROR =
  "This connection no longer names an account on this computer. Connect it again in Settings.";
export const CLI_CATALOG_ONLY_ERROR = "This tool runs only inside the server's API and worker.";

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
      // Never another account in its place: the pool keeps each account's limits apart.
      if (!host || !account) throw new Error(CLI_ACCOUNT_RECONNECT_ERROR);
      return withCliAccount(cliAccountOverrides(driver, host, undefined), () =>
        driver.stream(model, context, { ...options, assertAllowed }),
      );
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
  return models;
}

/**
 * The catalog's providers that run on this computer: the server's own local model server, and on
 * the person's own computer their command-line tools, listed so a connection can pick a model.
 */
export function registerLocalProvider(models: MutableModels): MutableModels {
  return registerLocalCliProviders(registerServerModels(models));
}
