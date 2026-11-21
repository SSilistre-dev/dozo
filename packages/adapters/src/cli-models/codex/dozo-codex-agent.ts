import { bestEffort } from "@rakazo/logging";
import type {
  AgentDecision,
  AgentDriver,
  AgentSession,
  AgentSessionEvent,
  AgentStart,
} from "../dozo-agent.js";
import { startAgentBridge } from "../dozo-agent-bridge.js";
import type { RpcMessage } from "../dozo-agent-rpc.js";
import { AgentProcess, agentEnv, EXITED } from "../dozo-agent-rpc.js";
import type { LocalCliHost } from "../dozo-cli-driver.js";
import { probeCli } from "../dozo-cli-driver.js";

/**
 * Codex's own app-server (`codex app-server`, JSON-RPC as JSON lines on stdio), written against
 * the schema of Codex 0.171.0 (`codex app-server generate-json-schema`). Only that release line is
 * driven: a newer one may change what this reads, so it is refused until checked again.
 */
export const CODEX_AGENT_PROVIDER_ID = "codex-agent";
const COMMAND = "codex";
const VERSIONS = { min: [0, 171, 0], below: [0, 172, 0] } as const;
const MCP_SERVER = "dozo";
const STARTUP_MS = 15_000;

function versionInRange(text: string): boolean {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1).map(Number);
  if (!found) return false;
  const compare = (limit: readonly number[]) => {
    for (let index = 0; index < 3; index += 1)
      if (found[index] !== limit[index]) return found[index]! - limit[index]!;
    return 0;
  };
  return compare(VERSIONS.min) >= 0 && compare(VERSIONS.below) < 0;
}

async function initialize(server: AgentProcess) {
  await server.request("initialize", {
    clientInfo: { name: "dozo", title: "Dozo", version: "1" },
    capabilities: { experimentalApi: false },
  });
  server.notify("initialized");
}

/** Whether Codex has the person's own sign-in; asked before any turn so none starts without. */
async function signedIn(server: AgentProcess): Promise<boolean> {
  const answer = await server.request<{ account?: unknown }>("account/read", {});
  return Boolean(answer.account);
}

/** Starts a thread that asks the person, and only the person, before it acts beyond reading. */
async function startThread(server: AgentProcess, options: Omit<AgentStart, "host">) {
  const started = await server.request<{ thread: { id: string } }>("thread/start", {
    cwd: options.cwd,
    ...(options.model ? { model: options.model } : {}),
    developerInstructions: options.instructions,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
    ephemeral: true,
    config: { mcp_servers: { [MCP_SERVER]: options.bridge } },
  });
  return started.thread.id;
}

/** Waits until Codex says the bridge to Dozo's tools is ready; false when it failed or never did. */
function bridgeReady(server: AgentProcess): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), STARTUP_MS);
    const stop = server.on((message) => {
      if (message.method === EXITED) return finish(false);
      if (message.method !== "mcpServer/startupStatus/updated") return;
      if (message.params?.name !== MCP_SERVER) return;
      if (message.params.status === "ready") finish(true);
      else if (message.params.status === "failed" || message.params.status === "cancelled")
        finish(false);
    });
    function finish(ready: boolean) {
      clearTimeout(timer);
      stop();
      resolve(ready);
    }
  });
}

/** The approval a server request asks for, as the card shows it; undefined for anything else. */
export function codexApproval(
  message: RpcMessage,
  files: readonly string[] = [],
): { summary: string; detail?: string } | undefined {
  const params = message.params ?? {};
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const lines = (...parts: (string | undefined)[]) => {
    const detail = parts.filter(Boolean).join("\n");
    return detail ? { detail } : {};
  };
  // What Codex asked for goes in the detail, shown as plain text, never as formatted prose.
  if (message.method === "item/commandExecution/requestApproval")
    return {
      summary: "Codex wants to run a command.",
      ...lines(text(params.command), text(params.cwd) && `in ${params.cwd}`, text(params.reason)),
    };
  if (message.method === "item/fileChange/requestApproval")
    return {
      summary: "Codex wants to change files.",
      ...lines(
        ...files,
        text(params.grantRoot) && `and anything under ${params.grantRoot}`,
        text(params.reason),
      ),
    };
  if (message.method === "item/permissions/requestApproval")
    return {
      summary: "Codex asks for more access.",
      ...lines(text(params.reason), JSON.stringify(params.permissions ?? {})),
    };
  if (message.method === "mcpServer/elicitation/request")
    return { summary: "Codex asks to go on with a tool.", ...lines(text(params.message)) };
  return undefined;
}

/** The answer Codex takes for a request: allowed once, or declined. Never for the session. */
export function codexAnswer(
  method: string,
  params: Record<string, unknown>,
  decision: AgentDecision,
) {
  if (method === "item/permissions/requestApproval")
    return {
      permissions: decision === "accept" ? (params.permissions ?? {}) : {},
      scope: "turn",
    };
  if (method === "mcpServer/elicitation/request") return { action: decision };
  return { decision };
}

const codexVersion = (host: LocalCliHost) =>
  probeCli({ command: COMMAND, env: () => agentEnv(host) }, ["--version"], {});

const MINUTE = 60_000;

/** Usage ran out: the error Codex sent, with when it opens again when Codex said. */
function limitMessage(resetsAt: number | undefined): string {
  if (!resetsAt) return "Codex usage limit reached.";
  const minutes = Math.max(1, Math.ceil((resetsAt - Date.now()) / MINUTE));
  return `Codex usage limit reached; try again in ~${minutes} min.`;
}

export const CODEX_SIGNED_OUT_ERROR =
  "Codex on this computer is not signed in. Run `codex login`, then try again.";

function codexSession(server: AgentProcess, threadId: string): AgentSession {
  /** Requests Codex waits on, by the id the card's answer names. */
  const waiting = new Map<
    string,
    { id: number | string; method: string; params: Record<string, unknown> }
  >();
  let turnId: Promise<string | undefined> = Promise.resolve(undefined);
  let resetsAt: number | undefined;
  /** The files each file change names, for its approval card. */
  const changedFiles = new Map<string, string[]>();
  const session: AgentSession = {
    turn(input) {
      const queue: AgentSessionEvent[] = [];
      let wake: (() => void) | undefined;
      const push = (event: AgentSessionEvent) => {
        queue.push(event);
        wake?.();
      };
      const stop = server.on((message) => {
        const params = message.params ?? {};
        if (message.method === EXITED) return push({ type: "failed", message: "Codex stopped." });
        if (message.id !== undefined && message.method) {
          const itemId = typeof params.itemId === "string" ? params.itemId : "";
          const approval = codexApproval(message, changedFiles.get(itemId));
          if (!approval) {
            server.respond(message.id, {
              error: { code: -32601, message: "Dozo does not answer this." },
            });
            return;
          }
          waiting.set(String(message.id), { id: message.id, method: message.method, params });
          return push({ type: "approval", id: String(message.id), ...approval });
        }
        if (message.method === "item/agentMessage/delta" && typeof params.delta === "string")
          return push({ type: "text", text: params.delta });
        if (message.method === "item/started") {
          const item = params.item as
            | { type?: string; id?: string; command?: string; changes?: { path?: unknown }[] }
            | undefined;
          if (item?.type === "commandExecution" && item.command)
            return push({ type: "activity", text: `Running ${item.command}` });
          if (item?.type !== "fileChange") return;
          const paths = (item.changes ?? []).flatMap((change) =>
            typeof change.path === "string" ? [change.path] : [],
          );
          changedFiles.set(String(item.id), paths);
          return push({ type: "activity", text: "Changing files" });
        }
        if (message.method === "account/rateLimits/updated") {
          const limits = params.rateLimits as
            | {
                rateLimitReachedType?: unknown;
                primary?: { resetsAt?: number | null } | null;
                secondary?: { resetsAt?: number | null } | null;
              }
            | undefined;
          if (limits?.rateLimitReachedType) {
            const times = [limits.primary?.resetsAt, limits.secondary?.resetsAt].filter(
              (value): value is number => typeof value === "number",
            );
            if (times.length) resetsAt = Math.max(...times) * 1000;
          }
          return;
        }
        if (message.method === "error") {
          const error = params.error as { message?: string; codexErrorInfo?: unknown } | undefined;
          const info = JSON.stringify(error?.codexErrorInfo ?? "");
          // A refused sign-in is retried by Codex again and again; it never gets better.
          if (info.includes("unauthorized") || info.includes(":401")) {
            void session.interrupt();
            return push({ type: "failed", message: CODEX_SIGNED_OUT_ERROR });
          }
          if (params.willRetry) return;
          if (info.includes("usageLimitExceeded")) {
            push({ type: "limit", ...(resetsAt ? { resetsAt } : {}) });
            return push({ type: "failed", message: limitMessage(resetsAt) });
          }
          return push({ type: "failed", message: error?.message ?? "Codex failed." });
        }
        if (message.method === "turn/completed") {
          const turn = params.turn as { status?: string; error?: { message?: string } } | undefined;
          if (turn?.status === "completed") return push({ type: "done" });
          return push({
            type: "failed",
            message: turn?.error?.message ?? `Codex ended the turn (${turn?.status ?? "unknown"}).`,
          });
        }
      });
      const started = server
        .request<{ turn: { id: string } }>("turn/start", {
          threadId,
          input: [{ type: "text", text: input }],
        })
        .then((answer) => answer.turn.id)
        .catch((error: Error) => {
          push({ type: "failed", message: error.message });
          return undefined;
        });
      turnId = started;
      return {
        async *[Symbol.asyncIterator]() {
          try {
            await started;
            for (;;) {
              const event = queue.shift();
              if (event) {
                yield event;
                if (event.type === "done" || event.type === "failed") return;
                continue;
              }
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = undefined;
            }
          } finally {
            stop();
          }
        },
      };
    },
    async answer(id, decision) {
      const request = waiting.get(id);
      waiting.delete(id);
      if (request)
        server.respond(request.id, {
          result: codexAnswer(request.method, request.params, decision),
        });
    },
    async interrupt() {
      await bestEffort(
        "agent turn interrupt",
        turnId.then((id) => server.request("turn/interrupt", { threadId, turnId: id })),
      );
    },
    close: () => server.close(),
  };
  return session;
}

export const codexAgentDriver: AgentDriver = {
  provider: CODEX_AGENT_PROVIDER_ID,
  name: "Codex",
  command: COMMAND,
  modelSource: "openai-codex",
  async installed(host) {
    return !(await codexVersion(host)).missing;
  },
  async selfTest(host, workDir) {
    const version = await codexVersion(host);
    if (version.missing) return "Codex is not installed on this computer.";
    if (!versionInRange(version.stdout))
      return "This Codex version has not been checked with Dozo yet; use Codex 0.171.";
    const bridge = await startAgentBridge();
    const server = AgentProcess.start("Codex", COMMAND, ["app-server"], host, workDir);
    try {
      await initialize(server);
      if (!(await signedIn(server))) return CODEX_SIGNED_OUT_ERROR;
      const ready = bridgeReady(server);
      await startThread(server, {
        cwd: workDir,
        model: "",
        instructions: "",
        bridge: bridge.launch,
      });
      if (!(await ready) || !bridge.listed()) return "Codex could not reach Dozo's tools.";
      return undefined;
    } catch {
      return "Codex did not start its app server as expected.";
    } finally {
      server.close();
      await bridge.close();
    }
  },
  async start(options) {
    const server = AgentProcess.start("Codex", COMMAND, ["app-server"], options.host, options.cwd);
    try {
      await initialize(server);
      // Codex accepts a turn without a sign-in and then retries it again and again.
      if (!(await signedIn(server))) throw new Error(CODEX_SIGNED_OUT_ERROR);
      const ready = bridgeReady(server);
      const threadId = await startThread(server, options);
      if (!(await ready)) throw new Error("Codex could not reach Dozo's tools.");
      return codexSession(server, threadId);
    } catch (error) {
      server.close();
      throw error;
    }
  },
};
