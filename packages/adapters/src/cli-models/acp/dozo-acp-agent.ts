import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { pollUntil } from "@rakazo/core";
import type {
  AgentDecision,
  AgentDriver,
  AgentSession,
  AgentSessionEvent,
  AgentStart,
} from "../dozo-agent.js";
import { startAgentBridge } from "../dozo-agent-bridge.js";
import type { RpcMessage } from "../dozo-agent-rpc.js";
import { AgentProcess, EXITED, RpcError } from "../dozo-agent-rpc.js";
import type { LocalCliHost } from "../dozo-cli-driver.js";

/**
 * An agent driven through the Agent Client Protocol (agentclientprotocol.com, protocol version 1):
 * JSON-RPC, a message per line on the agent's stdio. Dozo offers the agent no file or terminal
 * methods of its own: the agent uses its own tools and asks before what it asks about, and Dozo's
 * tools reach it as an MCP server. A version is driven only once checked (`versions`).
 */
export interface AcpAgentEntry {
  provider: string;
  name: string;
  command: string;
  args: readonly string[];
  /** The agent versions (its `agentInfo.version`) this was checked with; none yet: refused. */
  versions?: { min: readonly number[]; below: readonly number[] };
  /** The sign-in step the agent documents for a client without a terminal, if it needs one. */
  authenticate?: (methods: readonly { id?: unknown }[]) => Record<string, unknown> | undefined;
  termsRisk?: true;
  /** The maker's own page to get the agent from: fixed and https. */
  downloadUrl: string;
}

const PROTOCOL_VERSION = 1;
const MCP_SERVER = "dozo";
const BRIDGE_WAIT_MS = 15_000;
const BRIDGE_POLL_MS = 100;

export const ACP_SIGNED_OUT = (name: string) =>
  `${name} on this computer is not signed in. Sign in to it once in a terminal, then try again.`;
export const ACP_UNCHECKED = (name: string) =>
  `This ${name} version has not been checked with Dozo yet.`;

function inRange(version: unknown, range: AcpAgentEntry["versions"]): boolean {
  if (!range || typeof version !== "string") return false;
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
  if (!found) return false;
  const compare = (limit: readonly number[]) => {
    for (let index = 0; index < 3; index += 1)
      if (found[index] !== limit[index]) return found[index]! - (limit[index] ?? 0);
    return 0;
  };
  return compare(range.min) >= 0 && compare(range.below) < 0;
}

/** Whether `command` is an executable file on the person's PATH, found without running it. */
async function onPath(command: string, host: LocalCliHost): Promise<boolean> {
  for (const folder of (host.path ?? "").split(delimiter).filter(Boolean)) {
    try {
      await access(join(folder, command), constants.X_OK);
      return true;
    } catch {
      // Not in this folder.
    }
  }
  return false;
}

/** What `initialize` tells: whether this is a version and protocol Dozo can drive. */
async function initialize(agent: AgentProcess, entry: AcpAgentEntry) {
  const answer = await agent.request<{
    protocolVersion?: unknown;
    agentInfo?: { version?: unknown };
    authMethods?: { id?: unknown }[];
  }>("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "dozo", title: "Dozo", version: "1" },
  });
  if (
    answer.protocolVersion !== PROTOCOL_VERSION ||
    !inRange(answer.agentInfo?.version, entry.versions)
  )
    throw new UncheckedAgent(ACP_UNCHECKED(entry.name));
  const step = entry.authenticate?.(answer.authMethods ?? []);
  if (step) await agent.request("authenticate", step);
}

class UncheckedAgent extends Error {}

/** A session with Dozo's tools as an MCP server; a refused sign-in reads as signed out. */
async function newSession(
  agent: AgentProcess,
  entry: AcpAgentEntry,
  options: Omit<AgentStart, "host" | "model" | "instructions">,
) {
  try {
    const answer = await agent.request<{ sessionId: string }>("session/new", {
      cwd: options.cwd,
      mcpServers: [
        {
          name: MCP_SERVER,
          command: options.bridge.command,
          args: options.bridge.args,
          env: Object.entries(options.bridge.env).map(([name, value]) => ({ name, value })),
        },
      ],
    });
    return answer.sessionId;
  } catch (error) {
    if (error instanceof RpcError && /auth/i.test(`${error.message} ${error.code ?? ""}`))
      throw new Error(ACP_SIGNED_OUT(entry.name));
    throw error;
  }
}

/** The tool kinds ACP names; anything else is shown as "other". */
const TOOL_KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

/** A permission request as the card shows it: what the agent says it will do, and on what. */
export function acpApproval(
  name: string,
  params: Record<string, unknown>,
): { summary: string; detail?: string } {
  const call = (params.toolCall ?? {}) as {
    title?: unknown;
    kind?: unknown;
    locations?: { path?: unknown }[];
    rawInput?: unknown;
  };
  const paths = (call.locations ?? []).flatMap((place) =>
    typeof place.path === "string" ? [place.path] : [],
  );
  const input = call.rawInput === undefined ? undefined : JSON.stringify(call.rawInput);
  const detail = [typeof call.title === "string" ? call.title : undefined, ...paths, input]
    .filter(Boolean)
    .join("\n");
  const kind = typeof call.kind === "string" && TOOL_KINDS.has(call.kind) ? call.kind : "other";
  return { summary: `${name} asks before it goes on (${kind}).`, ...(detail ? { detail } : {}) };
}

/**
 * The option the person's answer selects: the one that allows only this time, or the one that
 * declines only this time. An option that allows or declines for good is never chosen; with no
 * one-time option the request is cancelled.
 */
export function acpOutcome(params: Record<string, unknown>, decision: AgentDecision) {
  const options = Array.isArray(params.options)
    ? (params.options as { optionId?: unknown; kind?: unknown }[])
    : [];
  const kind = decision === "accept" ? "allow_once" : "reject_once";
  const option = options.find((entry) => entry.kind === kind && typeof entry.optionId === "string");
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

const STOP_TEXT: Record<string, string | undefined> = {
  end_turn: undefined,
  max_tokens: undefined,
  max_turn_requests: undefined,
  refusal: "refused to go on.",
  cancelled: "stopped the turn.",
};

function acpSession(
  { agent, requests }: Started,
  entry: AcpAgentEntry,
  sessionId: string,
  instructions: string,
): AgentSession {
  /** The protocol has no place for the bot's instructions: the first turn carries them. */
  let lead = instructions.trim() ? `Instructions:\n${instructions.trim()}\n\n` : "";
  /** Permission requests the agent waits on, by the id the card's answer names. */
  const waiting = new Map<string, { id: number | string; params: Record<string, unknown> }>();
  const session: AgentSession = {
    turn(input) {
      const queue: AgentSessionEvent[] = [];
      let wake: (() => void) | undefined;
      const push = (event: AgentSessionEvent) => {
        queue.push(event);
        wake?.();
      };
      const sent = lead;
      lead = "";
      // A permission of this session, asked during this turn and not asked already, reaches the card.
      requests.permission = (id, params) => {
        if (params.sessionId !== sessionId || waiting.has(String(id))) return false;
        waiting.set(String(id), { id, params });
        push({ type: "approval", id: String(id), ...acpApproval(entry.name, params) });
        return true;
      };
      const stop = agent.on((message: RpcMessage) => {
        const params = message.params ?? {};
        if (message.method === EXITED)
          return push({ type: "failed", message: `${entry.name} stopped.` });
        if (message.method !== "session/update" || params.sessionId !== sessionId) return;
        const update = (params.update ?? {}) as {
          sessionUpdate?: unknown;
          content?: { type?: unknown; text?: unknown };
          title?: unknown;
        };
        if (
          update.sessionUpdate === "agent_message_chunk" &&
          typeof update.content?.text === "string"
        )
          return push({ type: "text", text: update.content.text });
        if (update.sessionUpdate === "tool_call" && typeof update.title === "string")
          return push({ type: "activity", text: update.title });
      });
      agent
        .request<{ stopReason?: unknown }>(
          "session/prompt",
          {
            sessionId,
            prompt: [{ type: "text", text: `${sent}${input}` }],
          },
          null,
        )
        .then((answer) => {
          const reason = typeof answer.stopReason === "string" ? answer.stopReason : "";
          const said =
            reason in STOP_TEXT ? STOP_TEXT[reason] : `ended the turn (${reason || "unknown"}).`;
          push(said ? { type: "failed", message: `${entry.name} ${said}` } : { type: "done" });
        })
        .catch((error: Error) => push({ type: "failed", message: error.message }));
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (;;) {
              const event = queue.shift();
              if (!event) {
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
                wake = undefined;
                continue;
              }
              yield event;
              if (event.type === "done" || event.type === "failed") return;
            }
          } finally {
            stop();
            requests.permission = undefined;
          }
        },
      };
    },
    async answer(id, decision) {
      const request = waiting.get(id);
      waiting.delete(id);
      if (request) agent.respond(request.id, { result: acpOutcome(request.params, decision) });
    },
    async interrupt() {
      agent.notify("session/cancel", { sessionId });
      // Every permission still waiting is answered as cancelled, as the protocol asks.
      for (const [id, request] of waiting) {
        waiting.delete(id);
        agent.respond(request.id, { result: { outcome: { outcome: "cancelled" } } });
      }
    },
    close: () => agent.close(),
  };
  return session;
}

/** An agent process, with where its permission requests go while a turn waits for them. */
interface Started {
  agent: AgentProcess;
  requests: { permission?: (id: number | string, params: Record<string, unknown>) => boolean };
}

/**
 * Answers every request the agent sends, from its start: a file, terminal or other client method
 * was not offered, and a permission request outside a turn, of another session or asked twice is
 * cancelled. Only one the turn takes reaches the person.
 */
function answeringRequests(agent: AgentProcess): Started {
  const requests: Started["requests"] = {};
  agent.on((message: RpcMessage) => {
    if (message.id === undefined || !message.method) return;
    if (message.method !== "session/request_permission")
      return agent.respond(message.id, {
        error: { code: -32601, message: "Dozo does not offer this." },
      });
    if (requests.permission?.(message.id, message.params ?? {})) return;
    agent.respond(message.id, { result: { outcome: { outcome: "cancelled" } } });
  });
  return { agent, requests };
}

/** Waits until the agent has listed Dozo's tools through the bridge. */
function bridgeListed(listed: () => boolean, timeoutMs: number): Promise<boolean> {
  return pollUntil(listed, {
    intervalMs: BRIDGE_POLL_MS,
    timeoutMs,
    onTimeout: () => false,
  });
}

export function acpAgentDriver(
  entry: AcpAgentEntry,
  options: { bridgeWaitMs?: number } = {},
): AgentDriver {
  const begin = (host: LocalCliHost, cwd: string) =>
    answeringRequests(AgentProcess.start(entry.name, entry.command, entry.args, host, cwd));
  return {
    provider: entry.provider,
    name: entry.name,
    command: entry.command,
    ...(entry.termsRisk ? { termsRisk: true as const } : {}),
    downloadUrl: entry.downloadUrl,
    installed: (host) => onPath(entry.command, host),
    async selfTest(host, workDir) {
      if (!(await onPath(entry.command, host)))
        return `${entry.name} is not installed on this computer.`;
      const bridge = await startAgentBridge();
      const { agent } = begin(host, workDir);
      try {
        await initialize(agent, entry);
        await newSession(agent, entry, { cwd: workDir, bridge: bridge.launch });
        if (!(await bridgeListed(bridge.listed, options.bridgeWaitMs ?? BRIDGE_WAIT_MS)))
          return `${entry.name} could not reach Dozo's tools.`;
        return undefined;
      } catch (error) {
        if (
          error instanceof UncheckedAgent ||
          (error as Error).message === ACP_SIGNED_OUT(entry.name)
        )
          return (error as Error).message;
        return `${entry.name} did not start as an ACP agent as expected.`;
      } finally {
        agent.close();
        await bridge.close();
      }
    },
    async start(options) {
      const started = begin(options.host, options.cwd);
      try {
        await initialize(started.agent, entry);
        const sessionId = await newSession(started.agent, entry, options);
        return acpSession(started, entry, sessionId, options.instructions);
      } catch (error) {
        started.agent.close();
        throw error;
      }
    },
  };
}
