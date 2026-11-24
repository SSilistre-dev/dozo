import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { dozoBotTokenTainted } from "../dozo-token-marks.js";
import { createRuntimeModels } from "../pi-runtime-models.js";
import { withRuntimeModels } from "../pi-runtime-scope.js";
import type { RunRuntimeEnv } from "../run-runtime.js";
import { AGENT_OWN_RUNS_ONLY, AGENT_TOKEN_TEXT, withAgentRuntime } from "./dozo-agent.js";
import { agentModeEnabled } from "./dozo-agent-modes.js";
import { localCliHost } from "./dozo-cli-driver.js";
import {
  AGENT_DRIVERS,
  CLI_MODEL_DRIVERS,
  registerLocalCliProviders,
} from "./dozo-cli-providers.js";
import type { DeviceAgentGateway } from "./dozo-device-agent.js";
import { withDeviceAgentRuntime } from "./dozo-device-agent.js";
import { personalCliAccessCheck } from "./personal-access.js";
import { cliModelRuntime as deploymentCliRuntime } from "./runtime.js";

/**
 * The runtime's command-line models. On the person's own computer every tool they installed runs
 * their own connections, checked on each turn like the deployment's CLI model. A deployment that
 * names one as its model keeps it as before, here too: its turns carry no connection. An agent
 * connection's turns go to that agent (dozo-agent.ts).
 */
export function cliModelRuntime(
  env: Pick<RunRuntimeEnv, "defaultProvider" | "defaultModel" | "deploymentModelConfigured">,
  runtime: AgentRuntime,
  deps: { prisma: PrismaClient; billingEnabled?: boolean; userDevices?: DeviceAgentGateway },
): AgentRuntime {
  const deploymentTool =
    env.deploymentModelConfigured &&
    CLI_MODEL_DRIVERS.some((driver) => driver.provider === env.defaultProvider);
  if (deploymentTool) return deploymentCliRuntime(env, runtime, deps);
  // A hosted server runs no agent itself: a bot's agent connection names one of the person's
  // paired computers, which runs the turn there (dozo-device-agent.ts).
  if (!localCliHost())
    return withDeviceAgentRuntime(deploymentCliRuntime(env, runtime, deps), {
      prisma: deps.prisma,
      userDevices: deps.userDevices,
      runAllowed: (runId) => ownRun(deps.prisma, runId),
    });
  const accessCheck = personalCliAccessCheck(deps);
  const models = registerLocalCliProviders(createRuntimeModels(), accessCheck);
  // A bot whose model is an agent's runs its turn in agent mode, every other through the models.
  return withAgentRuntime(withRuntimeModels(runtime, models), AGENT_DRIVERS, {
    accessCheck,
    runAllowed: (runId) => ownRun(deps.prisma, runId),
    enabled: (provider) => agentModeEnabled(deps.prisma, provider),
  });
}

/** How a run the person started in Dozo begins, or goes on after their own answer. */
const OWN_TRIGGERS = new Set(["user", "resume", "follow_up"]);

/**
 * Whether the person started this run themselves, by a message of their own: never a chat app,
 * another bot, a webhook or a schedule, whose words would reach an agent that reads their files.
 */
export async function ownRun(prisma: PrismaClient, runId: string): Promise<string | undefined> {
  const run = await runAsSystem("check who started an agent run", () =>
    prisma.run.findUnique({
      where: { id: runId },
      select: {
        trigger: true,
        userId: true,
        botId: true,
        threadId: true,
        sourceMessage: { select: { authorUserId: true } },
      },
    }),
  );
  const own =
    run !== null &&
    OWN_TRIGGERS.has(run.trigger) &&
    (!run.sourceMessage || run.sourceMessage.authorUserId === run.userId);
  if (!own) return AGENT_OWN_RUNS_ONLY;
  // Text sent with an access token is not the person's own (dozo-token-marks.ts): an agent reads
  // without asking, so none of it may reach one.
  const tainted = await runAsSystem("check an agent run for token text", () =>
    dozoBotTokenTainted(prisma, run),
  );
  return tainted ? AGENT_TOKEN_TEXT : undefined;
}
