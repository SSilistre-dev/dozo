import type {
  AgentRunModel,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import type { UserDeviceSummary } from "@rakazo/contracts";
import { retry, withAbort } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import type { AgentTurnFrame } from "../dozo-agent-device-protocol.js";
import {
  AGENT_DEVICE_LIMITS,
  agentStopRequest,
  agentToolResultRequest,
  agentTurnFrame,
  agentTurnRequest,
} from "../dozo-agent-device-protocol.js";
import { deviceAgentIds, readDeviceAgents } from "../dozo-device-capabilities.js";
import { PHONE_PLATFORMS } from "../dozo-phone-protocol.js";
import type { HostComputerRequest } from "../host-computer-protocol.js";
import { defaultCatalogModelId } from "../model-selection.js";
import { UserDeviceOfflineError } from "../user-device-gateway.js";
import type { UserDeviceGateway } from "../user-device-protocol.js";
import type { AgentDriver } from "./dozo-agent.js";
import {
  AGENT_BRIDGE_PAUSED,
  AGENT_INTERRUPTED_ERROR,
  AGENT_OWN_MODEL,
  AGENT_RECONNECT_ERROR,
  agentInput,
  isPause,
  toolResultText,
} from "./dozo-agent.js";
import { cliAccountRef, parseCliAccountRef } from "./dozo-cli-driver.js";
import { AGENT_DRIVERS, accountError } from "./dozo-cli-providers.js";

/**
 * Agent mode on the person's own computer, for a bot on a hosted server: the desktop app there
 * runs the agent and its sign-in (`dozo-agent-device-protocol.ts`); this server runs the bot's
 * tools, approvals and the conversation, and sends the app only what a turn needs. Nothing here
 * queues, waits for a slot or polls: the turn starts in the process that holds the run.
 */

export const DEVICE_OFFLINE_ERROR = "Your computer is offline.";
export const DEVICE_TOO_LARGE_ERROR = "This conversation is too large to send to your computer.";
/** Shown in the chat when the person did not answer on the computer in time. */
export const DEVICE_APPROVAL_EXPIRED_TEXT = "Approval was pending on your computer.";
const STOP_WAIT_MS = 10_000;

/** What a run needs of the user's devices: the request stream to one of them. */
export type DeviceAgentGateway = Pick<UserDeviceGateway, "request">;

export interface DeviceAgentDeps {
  prisma: PrismaClient;
  userDevices?: DeviceAgentGateway;
}

/** What a run needs too: the refusal of a run the person did not start (`ownRun`), else undefined. */
export interface DeviceAgentRunDeps extends DeviceAgentDeps {
  runAllowed: (runId: string) => Promise<string | undefined>;
}

const isAgentProvider = (provider: string) => deviceAgentIds().includes(provider);
/** The driver of a provider `isAgentProvider` accepted: the two lists are one. */
const driverFor = (provider: string): AgentDriver =>
  AGENT_DRIVERS.find((driver) => driver.provider === provider)!;

/** A connection row whose heartbeat is older lost its holding process (as the gateway counts it). */
const COMPUTER_STALE_MS = 75_000;
const PHONES = [...PHONE_PLATFORMS];

/**
 * The person's paired computers with whether each is connected now, as the user-device gateway's
 * `list` reads them, straight from the database and without a gateway: not revoked, a phone is not
 * a computer, and a connection counts while its heartbeat is recent.
 */
async function pairedComputers(prisma: PrismaClient, userId: string): Promise<UserDeviceSummary[]> {
  const devices = await runAsSystem("list a user's computers", () =>
    prisma.userDevice.findMany({
      where: { userId, revokedAt: null, platform: { notIn: PHONES } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        connections: {
          where: { heartbeatAt: { gt: new Date(Date.now() - COMPUTER_STALE_MS) } },
          select: { deviceId: true },
        },
      },
    }),
  );
  return devices.map((device) => ({
    deviceId: device.id,
    name: device.name,
    connected: device.connections.length > 0,
  }));
}

export type DeviceAgentAccess =
  | { ok: true; userId: string; trigger: string }
  | { ok: false; refusal: string; offline?: true };

/**
 * Who may run an agent turn on a computer: the run is the person's own (`ownRun`), the connection
 * is theirs, and the computer is theirs, connected and says it runs this agent now. The first
 * two refuse for good; the last says the computer is offline, which a backup model may answer.
 * Not the billing and two-people refusals of `personalCliAccessCheck`: the sign-in and the
 * subscription are on the person's computer, not on this server.
 */
export function deviceAgentAccessCheck(deps: DeviceAgentRunDeps) {
  return async (target: {
    runId: string;
    provider: string;
    deviceId: string;
    connectionId?: string;
  }): Promise<DeviceAgentAccess> => {
    const own = await deps.runAllowed(target.runId);
    if (own) return { ok: false, refusal: own };
    const run = await runAsSystem("find who runs an agent turn on a computer", () =>
      deps.prisma.run.findUnique({
        where: { id: target.runId },
        select: { userId: true, trigger: true },
      }),
    );
    if (!run) return { ok: false, refusal: AGENT_RECONNECT_ERROR };
    const connection = await runAsSystem("check the owner of an agent connection", () =>
      deps.prisma.userModelCredential.findFirst({
        where: {
          userId: run.userId,
          ...(target.connectionId ? { id: target.connectionId } : { provider: target.provider }),
        },
        select: { id: true },
      }),
    );
    if (!connection) return { ok: false, refusal: AGENT_RECONNECT_ERROR };
    const computer = (await pairedComputers(deps.prisma, run.userId)).find(
      (device) => device.deviceId === target.deviceId,
    );
    // Someone else's computer, or one removed since: not this connection's to use.
    if (!computer) return { ok: false, refusal: AGENT_RECONNECT_ERROR };
    if (
      !computer.connected ||
      !(await readDeviceAgents(deps.prisma, target.deviceId)).includes(target.provider)
    )
      return { ok: false, refusal: DEVICE_OFFLINE_ERROR, offline: true };
    return { ok: true, userId: run.userId, trigger: run.trigger };
  };
}

/** A tool result as the computer takes it: cut, with a note, when it is longer than it reads. */
function boundedResult(text: string): string {
  const limit = AGENT_DEVICE_LIMITS.toolResult;
  return text.length <= limit ? text : `${text.slice(0, limit - 40)}\n[result cut: too long]`;
}

/** The request a turn sends, as the schema reads it: what the computer gets is the parse output. */
function turnRequest(request: AgentRunRequest, agent: string, resumed: boolean) {
  const tools = request.executeTool
    ? request.tools.map(({ name, description, inputSchema }) => ({
        name,
        description: description.slice(0, 16 * 1024),
        inputSchema,
      }))
    : [];
  const parsed = agentTurnRequest.safeParse({
    method: "agentTurn",
    runId: request.runId,
    botId: request.botId,
    agent,
    ...(request.model.id === AGENT_OWN_MODEL ? {} : { model: request.model.id }),
    instructions: request.instructions,
    input: resumed ? request.prompt : agentInput(request),
    // A tool whose name the agent could not call back is left out.
    tools: tools.filter((tool) => /^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)),
  });
  if (!parsed.success) {
    // A size the computer would not take is the person's to cut down; anything else is a fault here.
    const size = parsed.error.issues.some((issue) =>
      ["instructions", "input", "tools"].includes(String(issue.path[0])),
    );
    if (size) throw new Error(DEVICE_TOO_LARGE_ERROR);
    throw new Error(
      `Agent turn request refused: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  }
  return parsed.data;
}

/**
 * One short request to the computer, drained to its end. Only a stop may be tried again, on a lost
 * connection: it is safe to repeat, where the app answers a tool result it already has with an
 * error.
 */
async function sendShort(
  gateway: DeviceAgentGateway,
  userId: string,
  deviceId: string,
  request: HostComputerRequest,
  signal: AbortSignal,
) {
  await retry(
    async () => {
      for await (const _ of gateway.request<unknown>(userId, request, signal, deviceId)) {
        // Its answer is only `done`.
      }
    },
    {
      attempts: request.method === "agentStop" ? 3 : 1,
      delayMs: 250,
      signal,
      retryable: (error) => error instanceof UserDeviceOfflineError || isDisconnect(error),
    },
  );
}

/** The turns being served here, so a stop from outside reaches the computer. */
const active = new Map<string, () => Promise<void>>();

/**
 * The runtime of agent connections that name one of the person's computers, in front of `next`: a
 * run whose model is an agent goes to that computer, every other to `next`. A computer that is
 * offline before the turn starts is answered by the first backup model the bot or the person chose
 * that is not an agent, when there is one; once the agent said it started, a lost computer ends
 * the run as interrupted and never falls back.
 */
export function withDeviceAgentRuntime(next: AgentRuntime, deps: DeviceAgentRunDeps): AgentRuntime {
  return {
    describe: () => next.describe(),
    async abort(runId) {
      await bestEffort("stop an agent on a computer", active.get(runId)?.());
      await next.abort(runId);
    },
    run(request, context) {
      if (!isAgentProvider(request.model.provider)) return next.run(request, context);
      return runOnDevice(next, deps, request, context);
    },
  };
}

/** The first backup that is not an agent, with the ones after it. */
function backupsAfterAgent(request: AgentRunRequest) {
  const list = request.fallbackModels ?? [];
  const index = list.findIndex((choice) => !isAgentProvider(choice.provider));
  return index < 0
    ? undefined
    : {
        first: list[index]!,
        rest: list.slice(index + 1).filter((choice) => !isAgentProvider(choice.provider)),
      };
}

async function* runOnDevice(
  next: AgentRuntime,
  deps: DeviceAgentRunDeps,
  request: AgentRunRequest,
  context: Parameters<AgentRuntime["run"]>[1],
): AsyncGenerator<AgentRuntimeEvent> {
  const account = parseCliAccountRef(request.model.apiKey);
  if (account?.kind !== "device" || !deps.userDevices) throw new Error(AGENT_RECONNECT_ERROR);
  const access = await deviceAgentAccessCheck(deps)({
    runId: request.runId,
    provider: request.model.provider,
    deviceId: account.deviceId,
    connectionId: request.model.connectionId,
  });
  if (!access.ok && !access.offline) throw new Error(access.refusal);
  if (!access.ok) {
    yield* answerOnBackup(next, request, context);
    return;
  }
  const outcome = yield* turnOnDevice(
    deps.userDevices,
    access.userId,
    account.deviceId,
    access.trigger === "resume",
    request,
    context?.signal,
  );
  // The computer went away before the agent said it started: a backup may answer instead.
  if (outcome === "offline") yield* answerOnBackup(next, request, context);
}

/** The first backup that is not an agent answers; with none, the computer's being offline is the error. */
async function* answerOnBackup(
  next: AgentRuntime,
  request: AgentRunRequest,
  context: Parameters<AgentRuntime["run"]>[1],
): AsyncGenerator<AgentRuntimeEvent> {
  const backup = backupsAfterAgent(request);
  if (!backup) throw new Error(DEVICE_OFFLINE_ERROR);
  const { first, rest } = backup;
  const model: AgentRunModel = request.resolveFallbackModel
    ? await request.resolveFallbackModel(first.provider, first.id, first.connectionId)
    : { ...first };
  // The run is answered by this model from now on, and a reply says so (dozo-backup-replies.ts).
  await request.onModelChange?.(model.provider, model.id);
  yield* next.run({ ...request, model, fallbackModels: rest }, context);
}

async function* turnOnDevice(
  gateway: DeviceAgentGateway,
  userId: string,
  deviceId: string,
  resumed: boolean,
  request: AgentRunRequest,
  signal: AbortSignal | undefined,
): AsyncGenerator<AgentRuntimeEvent, "done" | "paused" | "offline"> {
  const driver = driverFor(request.model.provider);
  const turn = turnRequest(request, request.model.provider, resumed);
  const sent = new Set(turn.tools.map((tool) => tool.name));
  const ids = { runId: request.runId, botId: request.botId };
  const stream = new AbortController();
  const stopSignal = () => AbortSignal.timeout(STOP_WAIT_MS);
  const stop = () =>
    sendShort(
      gateway,
      userId,
      deviceId,
      agentStopRequest.parse({ ...ids, method: "agentStop" }),
      stopSignal(),
    );
  // Stopped from outside (the runtime told to abort the run): the computer is told once, the
  // stream is let go, and this attempt ends quietly, as a cancelled run does.
  let stoppedFromOutside = false;
  active.set(request.runId, async () => {
    stoppedFromOutside = true;
    stream.abort();
    await stop();
  });
  const abort = () => stream.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let started = false;
  const calls = new Set<string>();
  let stopAtEnd = true;
  let anyText = false;
  try {
    const frames = gateway
      .request<unknown>(userId, turn, stream.signal, deviceId)
      [Symbol.asyncIterator]();
    for (;;) {
      // No time limit of its own: a lost connection ends the stream with an error (the gateway
      // pings the computer), and the protocol's own limit ends a whole turn (AGENT_TURN_DEADLINE_MS).
      let step: IteratorResult<unknown>;
      try {
        step = await withAbort(frames.next(), stream.signal);
      } catch (error) {
        if (signal?.aborted || stoppedFromOutside) return "done";
        if (error instanceof UserDeviceOfflineError && !started) {
          stopAtEnd = false;
          return "offline";
        }
        // A lost connection never falls back: the agent may have done part of its work.
        if (isDisconnect(error) || isTimeout(error)) {
          stopAtEnd = false;
          throw new Error(AGENT_INTERRUPTED_ERROR);
        }
        throw error;
      }
      if (step.done) throw new Error(AGENT_INTERRUPTED_ERROR);
      const parsed = agentTurnFrame.safeParse(step.value);
      if (!parsed.success) throw new Error("Your computer sent an invalid response");
      const frame: AgentTurnFrame = parsed.data;
      if (frame.type === "started") started = true;
      else if (frame.type === "text") {
        anyText = true;
        yield { type: "text", text: frame.text };
      } else if (frame.type === "activity") yield { type: "progress", text: frame.text };
      else if (frame.type === "approvalWaiting") yield { type: "progress", text: frame.summary };
      else if (frame.type === "approvalExpired") {
        yield { type: "text", text: `${anyText ? "\n\n" : ""}${DEVICE_APPROVAL_EXPIRED_TEXT}` };
        anyText = true;
      } else if (frame.type === "limit")
        throw new Error(
          accountError(
            { name: driver.name },
            { limit: { resetsAt: frame.resetsAt } },
            `${driver.name} on your computer stopped.`,
          ),
        );
      else if (frame.type === "failed") throw new Error(frame.message);
      else if (frame.type === "done") {
        yield { type: "done" };
        return "done";
      } else {
        // The agent calls one of the bot's tools: once for each call id, and only a listed one.
        const repeated = calls.has(frame.callId);
        calls.add(frame.callId);
        const result =
          !repeated && sent.has(frame.name) && request.executeTool
            ? await runTool(request, frame, signal)
            : {
                text: repeated
                  ? "This call was already made."
                  : `${frame.name} is not one of this bot's tools.`,
                isError: true,
                pause: false,
              };
        try {
          await sendShort(
            gateway,
            userId,
            deviceId,
            agentToolResultRequest.parse({
              ...ids,
              method: "agentToolResult",
              callId: frame.callId,
              text: boundedResult(result.text),
              isError: result.isError,
            }),
            stream.signal,
          );
        } catch (error) {
          if (signal?.aborted || stoppedFromOutside) return "done";
          // The result may or may not have arrived and is not sent twice: the turn is lost.
          if (isDisconnect(error) || isTimeout(error) || error instanceof UserDeviceOfflineError) {
            stopAtEnd = false;
            throw new Error(AGENT_INTERRUPTED_ERROR);
          }
          throw error;
        }
        if (result.pause) {
          // The person must answer in Dozo: this attempt ends, and the agent's next turn follows.
          stopAtEnd = false;
          return "paused";
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    active.delete(request.runId);
    stream.abort();
    if (stopAtEnd && !stoppedFromOutside) await bestEffort("stop an agent on a computer", stop());
  }
}

/** Runs one of the bot's tools in the run's own executor, as the local agent's bridge does. */
async function runTool(
  request: AgentRunRequest,
  frame: Extract<AgentTurnFrame, { type: "toolCall" }>,
  signal: AbortSignal | undefined,
) {
  try {
    const result = await request.executeTool!(
      frame.name,
      frame.args,
      `${request.runId}:${frame.callId}`,
    );
    if (isPause(result)) return { text: AGENT_BRIDGE_PAUSED, isError: false, pause: true };
    return { text: toolResultText(result), isError: false, pause: false };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      text: error instanceof Error ? error.message : "The tool failed.",
      isError: true,
      pause: false,
    };
  }
}

const isTimeout = (error: unknown) =>
  error instanceof DOMException && error.name === "TimeoutError";

const isDisconnect = (error: unknown) =>
  error instanceof Error && /disconnected/i.test(error.message);

/** The settings row of an agent on one of the person's computers. */
export interface DeviceAgentRow {
  provider: string;
  name: string;
  deviceId: string;
  deviceName: string;
}

/**
 * The agents the person's connected computers run now, one per computer: what Settings offers to
 * connect on a hosted server, which has no agent of its own.
 */
export async function readDeviceAgentRows(
  deps: DeviceAgentDeps,
  userId: string,
): Promise<DeviceAgentRow[]> {
  const rows: DeviceAgentRow[] = [];
  for (const device of await pairedComputers(deps.prisma, userId)) {
    if (!device.connected) continue;
    for (const provider of await readDeviceAgents(deps.prisma, device.deviceId)) {
      rows.push({
        provider,
        name: driverFor(provider).name,
        deviceId: device.deviceId,
        deviceName: device.name,
      });
    }
  }
  return rows;
}

/**
 * The connection that makes an agent on one of the person's computers a bot's agent: its name is
 * the agent's and the computer's, and what it stores only names the computer. Refused unless that
 * computer is the person's, connected, and runs the agent now.
 */
export async function deviceAgentConnection(
  deps: DeviceAgentDeps,
  userId: string,
  provider: string,
  deviceId: string,
) {
  const row = (await readDeviceAgentRows(deps, userId)).find(
    (entry) => entry.provider === provider && entry.deviceId === deviceId,
  );
  if (!row) return undefined;
  const driver = driverFor(provider);
  return {
    provider,
    label: `${row.name} · ${row.deviceName}`,
    plaintext: cliAccountRef({ kind: "device", deviceId }),
    modelId: driver.modelSource
      ? (defaultCatalogModelId(driver.modelSource) ?? undefined)
      : AGENT_OWN_MODEL,
  };
}
