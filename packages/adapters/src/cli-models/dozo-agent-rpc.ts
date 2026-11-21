import type { ChildProcessByStdio } from "node:child_process";
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { LocalCliHost } from "./dozo-cli-driver.js";
import { stopGroup } from "./dozo-cli-driver.js";

/** What an agent's process may see: what it needs to find its own sign-in and reach the network. */
const PASSTHROUGH = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/** An environment from `source`, built from the allowlist: no server secret goes in. */
export function allowlistedEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source))
    if (value !== undefined && PASSTHROUGH.has(key)) env[key] = value;
  return env;
}

/** An agent's environment: the person's own home and login PATH, and nothing of the server's. */
export function agentEnv(host: LocalCliHost): Record<string, string> {
  const user = userInfo().username;
  return allowlistedEnv({
    ...process.env,
    HOME: host.home,
    ...(host.path ? { PATH: host.path } : {}),
    USER: user,
    LOGNAME: user,
  });
}

export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

/** A JSON-RPC error with the code the agent sent. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

const REQUEST_MS = 30_000;
const STOP_GRACE_MS = 2_000;
/** The message every listener gets once the process is gone. */
export const EXITED = "dozo/exited";

/**
 * One agent process and the JSON-RPC conversation with it, a message per line on stdio, started
 * without a shell in its own process group.
 */
export class AgentProcess {
  private next = 0;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private listeners = new Set<(message: RpcMessage) => void>();
  private exited = false;
  private closed = false;

  constructor(
    private child: ChildProcessByStdio<Writable, Readable, null>,
    private name: string,
  ) {
    child.stdin.on("error", () => this.close());
    createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on(
      "line",
      (line) => {
        let message: RpcMessage;
        try {
          message = JSON.parse(line) as RpcMessage;
        } catch {
          return;
        }
        if (message.method === undefined && typeof message.id === "number") {
          const waiter = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error)
            waiter?.reject(
              new RpcError(message.error.message ?? `${name} refused.`, message.error.code),
            );
          else waiter?.resolve(message.result);
          return;
        }
        for (const listener of this.listeners) listener(message);
      },
    );
    const gone = () => {
      this.exited = true;
      for (const waiter of this.pending.values()) waiter.reject(new Error(`${name} stopped.`));
      this.pending.clear();
      for (const listener of this.listeners) listener({ method: EXITED });
    };
    child.once("close", gone);
    child.once("error", gone);
  }

  static start(
    name: string,
    command: string,
    args: readonly string[],
    host: LocalCliHost,
    cwd: string,
  ): AgentProcess {
    return new AgentProcess(
      spawn(command, [...args], {
        cwd,
        env: agentEnv(host),
        stdio: ["pipe", "pipe", "ignore"],
        detached: true,
      }),
      name,
    );
  }

  /** A request; `timeoutMs: null` for one that lasts a whole turn. */
  request<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number | null = REQUEST_MS,
  ): Promise<T> {
    if (this.exited) return Promise.reject(new Error(`${this.name} stopped.`));
    const id = ++this.next;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`${this.name} did not answer ${method}.`));
            }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: Record<string, unknown>) {
    this.send({ method, ...(params ? { params } : {}) });
  }

  respond(
    id: number | string,
    body: { result: unknown } | { error: { code: number; message: string } },
  ) {
    this.send({ id, ...body });
  }

  on(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private send(message: Record<string, unknown>) {
    // After the agent exits a write fails on its own; the stdin error handler takes it.
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  /**
   * Asks the agent and what it started to stop, and ends them if they have not soon after; also
   * once the agent itself has exited, so nothing it left in its group keeps running.
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.exited = true;
    const pid = this.child.pid;
    try {
      if (pid) process.kill(-pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    setTimeout(() => stopGroup(pid), STOP_GRACE_MS).unref();
  }
}
