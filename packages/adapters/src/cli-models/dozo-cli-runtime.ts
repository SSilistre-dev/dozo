import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { createRuntimeModels } from "../pi-runtime-models.js";
import { withRuntimeModels } from "../pi-runtime-scope.js";
import type { RunRuntimeEnv } from "../run-runtime.js";
import { localCliHost } from "./dozo-cli-driver.js";
import { CLI_MODEL_DRIVERS, registerLocalCliProviders } from "./dozo-cli-providers.js";
import { personalCliAccessCheck } from "./personal-access.js";
import { cliModelRuntime as deploymentCliRuntime } from "./runtime.js";

/**
 * The runtime's command-line models. On the person's own computer every tool they installed runs
 * their own connections, checked on each turn like the deployment's CLI model. A deployment that
 * names one as its model keeps it as before, here too: its turns carry no connection.
 */
export function cliModelRuntime(
  env: Pick<RunRuntimeEnv, "defaultProvider" | "defaultModel" | "deploymentModelConfigured">,
  runtime: AgentRuntime,
  deps: { prisma: PrismaClient; billingEnabled?: boolean },
): AgentRuntime {
  const deploymentTool =
    env.deploymentModelConfigured &&
    CLI_MODEL_DRIVERS.some((driver) => driver.provider === env.defaultProvider);
  if (!localCliHost() || deploymentTool) return deploymentCliRuntime(env, runtime, deps);
  const models = registerLocalCliProviders(createRuntimeModels(), personalCliAccessCheck(deps));
  return withRuntimeModels(runtime, models);
}
