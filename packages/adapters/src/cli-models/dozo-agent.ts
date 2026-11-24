import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import type { AgentBridge, BridgeCall } from "./dozo-agent-bridge.js";
import { startAgentBridge } from "./dozo-agent-bridge.js";
import type { LocalCliHost } from "./dozo-cli-driver.js";
import { localCliHost, parseCliAccountRef } from "./dozo-cli-driver.js";

/**
 * Agent mode: a provider's own agent CLI on the person's computer runs a bot's whole turn, as the
 * person, with what they can reach. Dozo shows and stops what the agent asks about or runs through
 * Dozo; its own tools reach the agent through a bridge that runs them in the run's tool executor.
 * Everything that differs between agents is a driver; shared code never names one.
 */

/** What an agent session reports during one turn. */
export type AgentSessionEvent =
  | { type: "text"; text: string }
  /** Something the agent did on its own, for the run's progress line. */
  | { type: "activity"; text: string }
  /** The agent waits for the person before it goes on. */
  | { type: "approval"; id: string; summary: string; detail?: string }
  /** The account's usage ran out, with when it opens again (epoch ms) when the agent said. */
  | { type: "limit"; resetsAt?: number }
  | { type: "done" }
  | { type: "failed"; message: string };

export type AgentDecision = "accept" | "decline";

/** One agent process for one run: its turns, in order, and the answers to what it asked. */
export interface AgentSession {
  /** Starts a turn; its events end with `done` or `failed`, and pause at each `approval`. */
  turn(input: string): AsyncIterable<AgentSessionEvent>;
  /** Answers the approval the turn waits on: once, or not at all. Never for the session. */
  answer(id: string, decision: AgentDecision): Promise<void>;
  /** Stops the turn in progress. */
  interrupt(): Promise<void>;
  /** Ends the process and what it started. */
  close(): void;
}

export interface AgentStart {
  host: LocalCliHost;
  /** An empty folder of the bot's own the agent works in. */
  cwd: string;
  model: string;
  instructions: string;
  /** How the agent starts the bridge to Dozo's tools: a stdio MCP server. */
  bridge: { command: string; args: string[]; env: Record<string, string> };
}

export interface AgentDriver {
  /** The provider id its connections are stored under. */
  provider: string;
  name: string;
  command: string;
  /**
   * The catalog provider whose model ids the agent takes; none for an agent that chooses its own
   * model, which the catalog then lists as one model, the agent's own choice.
   */
  modelSource?: string;
  /** Its maker's terms put the person's account at risk when it is used outside their products. */
  termsRisk?: true;
  /** The maker's own page to get the agent from: fixed, https, shown when it is not installed. */
  downloadUrl?: string;
  /** Whether the agent is on the person's PATH. */
  installed(host: LocalCliHost): Promise<boolean>;
  /** Checks, when connecting, that this agent can be driven here; the reason when it cannot. */
  selfTest(host: LocalCliHost, workDir: string): Promise<string | undefined>;
  start(options: AgentStart): Promise<AgentSession>;
}

/** The model id of an agent that chooses its own model. */
export const AGENT_OWN_MODEL = "default";

/** The one action the person may take on an agent's request besides declining it. */
export const ALLOW_ONCE = "Allow once";
export const DECLINE = "Decline";

export const AGENT_INTERRUPTED_ERROR =
  "The agent was interrupted: its process ended before this turn finished. Send the message again.";
export const AGENT_OWN_RUNS_ONLY =
  "Agent mode runs only for your own messages in Dozo, never for chat apps, other bots or webhooks.";
export const AGENT_RECONNECT_ERROR =
  "This agent connection was not made in Settings. Connect the agent again there.";
export const AGENT_TOKEN_TEXT =
  "Agent mode does not run in a chat that text sent with an access token reached. Trust the bot again first.";
export const AGENT_BRIDGE_PAUSED =
  "Waiting for the person's approval in Dozo. Stop here; you will be told when it is answered.";

/**
 * Agent tools turned on by the file `<data>/dozo-agent-tools`, one provider id per line, which
 * servers set up before the setting (dozo-agent-modes.ts) still have: a line there stays on.
 */
export function enabledAgentProviders(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const file = agentDataFolder(env, "dozo-agent-tools");
  try {
    return new Set(
      readFileSync(file, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set<string>();
    throw error;
  }
}

/** A place in the server's own data folder. */
export function agentDataFolder(env: NodeJS.ProcessEnv, ...parts: string[]): string {
  return join(resolve(env.DATA_DIR?.trim() || "./data"), ...parts);
}

const dataFolder = (...parts: string[]) => agentDataFolder(process.env, ...parts);

/**
 * A run an agent started stays marked on disk until it ends. An attempt that finds the mark and
 * no live process of its own is a handover after a restart or another process: the agent's work
 * may have half happened, so the run ends as interrupted and is never started again.
 */
const runMark = (runId: string) => dataFolder("agent-runs", runId.replace(/[^\w-]/g, "_"));

async function markRun(runId: string) {
  await mkdir(dataFolder("agent-runs"), { recursive: true, mode: 0o700 });
  await writeFile(runMark(runId), "", { mode: 0o600 });
}

async function runMarked(runId: string) {
  try {
    await readFile(runMark(runId));
    return true;
  } catch {
    return false;
  }
}

async function unmarkRun(runId: string) {
  await rm(runMark(runId), { force: true });
}

/** A run's live agent: what it waits for, and the bridge its tools use. */
interface LiveRun {
  session: AgentSession;
  bridge: AgentBridge;
  /** An empty folder of this run's own, removed with it. */
  cwd: string;
  events?: AsyncIterator<AgentSessionEvent>;
  /** The approval the turn waits on, or a tool approval that ended the turn. */
  waiting?: { kind: "agent"; id: string } | { kind: "tool" };
  idle?: NodeJS.Timeout;
}

/** A run left waiting for the person is ended after this long. */
export const AGENT_WAIT_LIMIT_MS = 30 * 60_000;

const live = new Map<string, LiveRun>();

/**
 * Ends a run's live agent: its process, its bridge and its folder. The mark that it ran goes only
 * when the run itself ended; a run stopped from outside keeps it, so it is never started again.
 */
async function endRun(runId: string, ended: boolean) {
  const run = live.get(runId)!;
  live.delete(runId);
  clearTimeout(run.idle);
  run.session.close();
  await run.bridge.close();
  await rm(run.cwd, { recursive: true, force: true });
  if (ended) await unmarkRun(runId);
}

function toolsFor(request: AgentRunRequest): ConnectorTool[] {
  return request.executeTool ? request.tools : [];
}

/** The conversation so far, for the turn of a run that starts a new agent process. */
export function agentInput(request: AgentRunRequest): string {
  const earlier = request.history
    .filter((entry) => entry.role !== "system" && entry.content.trim())
    .map(
      (entry) => `${entry.role === "user" ? (entry.speaker ?? "User") : "You"}: ${entry.content}`,
    );
  if (!earlier.length) return request.prompt;
  return `Earlier in this conversation:\n${earlier.join("\n\n")}\n\nNow:\n${request.prompt}`;
}

/** The person's answer to an approval card, read only from the card's own offered actions. */
function decisionFrom(request: AgentRunRequest): AgentDecision {
  const answer = request.resumeToolResult?.content.map((part) => part.text).join("");
  return answer === ALLOW_ONCE ? "accept" : "decline";
}

/**
 * The runtime of agent connections, in front of the model runtime: a run whose model is an agent
 * tool's goes to that agent, every other to `next`. One process per run, kept by the process that
 * started it while the run waits for the person; a later attempt anywhere else ends the run as
 * interrupted instead of starting the agent again.
 */
export interface AgentRuntimeOptions {
  /** Refuses a turn on a server that bills for models or serves more than one person. */
  accessCheck: () => Promise<string | undefined>;
  /**
   * Refuses a run the person did not start themselves: the agent reads what they can read, so a
   * message from a chat app, another bot or a webhook must never reach it.
   */
  runAllowed: (runId: string) => Promise<string | undefined>;
  waitLimitMs?: number;
  /** Whether the agent's mode was turned on in settings (dozo-agent-modes.ts); the file counts too. */
  enabled?: (provider: string) => Promise<boolean>;
}

export function withAgentRuntime(
  next: AgentRuntime,
  drivers: readonly AgentDriver[],
  options: AgentRuntimeOptions,
): AgentRuntime {
  return {
    describe: () => next.describe(),
    async abort(runId) {
      if (live.has(runId)) await endRun(runId, false);
      await next.abort(runId);
    },
    run(request, context) {
      const driver = drivers.find((entry) => entry.provider === request.model.provider);
      if (!driver) return next.run(request, context);
      return runAgent(driver, request, context?.signal, options);
    },
  };
}

async function* runAgent(
  driver: AgentDriver,
  request: AgentRunRequest,
  signal: AbortSignal | undefined,
  options: AgentRuntimeOptions,
): AsyncGenerator<AgentRuntimeEvent> {
  const host = localCliHost();
  const on =
    enabledAgentProviders().has(driver.provider) || (await options.enabled?.(driver.provider));
  if (!host || !on) throw new Error(`${driver.name} agent mode is not turned on on this server.`);
  const refusal = (await options.accessCheck()) ?? (await options.runAllowed(request.runId));
  if (refusal) throw new Error(refusal);
  // Only a connection made in settings, after the person's agreement and the check, names this.
  if (parseCliAccountRef(request.model.apiKey)?.kind !== "home")
    throw new Error(AGENT_RECONNECT_ERROR);
  const { runId } = request;
  // Each attempt runs Dozo's tools with its own executor, approvals and limits.
  let paused = false;
  const callTool: BridgeCall = async (name, args, callId) => {
    const result = await request.executeTool!(name, args, `${runId}:${callId}`);
    if (!isPause(result)) return { text: toolResultText(result), isError: false };
    // Nothing more of this turn reaches the run: the pause ends its attempt.
    paused = true;
    void live.get(runId)?.session.interrupt();
    return { text: AGENT_BRIDGE_PAUSED, isError: false };
  };
  let run = live.get(runId);
  if (run) {
    clearTimeout(run.idle);
    run.bridge.serve(toolsFor(request), callTool);
  } else {
    if (await runMarked(runId)) {
      await unmarkRun(runId);
      throw new Error(AGENT_INTERRUPTED_ERROR);
    }
    // A new folder for each run: nothing one run leaves there instructs the next.
    const cwd = dataFolder("agent-work", runId.replace(/[^\w-]/g, "_"));
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const bridge = await startAgentBridge();
    // The agent lists Dozo's tools as it starts.
    bridge.serve(toolsFor(request), callTool);
    try {
      const session = await driver.start({
        host,
        cwd,
        model: request.model.id,
        instructions: request.instructions,
        bridge: bridge.launch,
      });
      run = { session, bridge, cwd };
    } catch (error) {
      await bridge.close();
      await rm(cwd, { recursive: true, force: true });
      throw error;
    }
    live.set(runId, run);
    await markRun(runId);
  }
  const current = run;
  const onAbort = () => current.session.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  let failure: string | undefined;
  try {
    if (current.waiting?.kind === "agent") {
      await current.session.answer(current.waiting.id, decisionFrom(request));
    } else {
      const input = current.waiting?.kind === "tool" ? request.prompt : agentInput(request);
      current.events = current.session.turn(input)[Symbol.asyncIterator]();
    }
    current.waiting = undefined;
    for (;;) {
      const next = await current.events!.next();
      if (signal?.aborted) {
        await endRun(runId, false);
        return;
      }
      if (next.done) break;
      const event = next.value;
      if (paused) continue;
      if (event.type === "text") yield { type: "text", text: event.text };
      else if (event.type === "activity") yield { type: "progress", text: event.text };
      else if (event.type === "failed") failure = event.message;
      else if (event.type === "approval") {
        current.waiting = { kind: "agent", id: event.id };
        keepWaiting(runId, current, options.waitLimitMs);
        yield {
          type: "ask",
          text: event.summary,
          ...(event.detail ? { detail: event.detail } : {}),
          actions: [
            { id: "allow-once", label: ALLOW_ONCE },
            { id: "decline", label: DECLINE },
          ],
        };
        return;
      }
    }
    if (paused) {
      // A Dozo tool waits for approval: the agent's next turn follows the answer.
      current.waiting = { kind: "tool" };
      keepWaiting(runId, current, options.waitLimitMs);
      return;
    }
    await endRun(runId, true);
    if (failure) throw new Error(failure);
    yield { type: "done" };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // A later call of an earlier attempt's executor would act for a run that moved on.
    current.bridge.serve([], undefined);
  }
}

function keepWaiting(runId: string, run: LiveRun, waitLimitMs = AGENT_WAIT_LIMIT_MS) {
  run.idle = setTimeout(() => void endRun(runId, true), waitLimitMs);
  run.idle.unref?.();
}

export function isPause(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const details = (result as { kind?: unknown; details?: { approval?: unknown; secret?: unknown } })
    .details;
  return (
    (result as { kind?: unknown }).kind === "agent_tool_result" &&
    (details?.approval === "paused" || details?.secret === "paused")
  );
}

/** A tool result as the text the agent reads. */
export function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  return typeof result === "string" ? result : JSON.stringify(result ?? null);
}

/** The runs whose agent process is live in this process, for tests. */
export function liveAgentRuns(): ReadonlyMap<string, unknown> {
  return live;
}
