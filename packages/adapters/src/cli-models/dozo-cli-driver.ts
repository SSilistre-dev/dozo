import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute } from "node:path";
import type {
  Api,
  AssistantMessageEventStream,
  Model,
  Models,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";

/**
 * A provider's official command-line tool used as a model on the person's own computer. The tool
 * is theirs: installed and signed in by them, run unmodified, never downloaded by the server.
 * Everything that differs between tools is declared here, so shared code never names one.
 */
export interface CliModelDriver {
  /** The provider id its connections are stored under. */
  provider: string;
  /** What settings call it. */
  name: string;
  /** The executable, looked up on the person's own PATH. */
  command: string;
  /** The variable that points the tool at another home folder: one per account. */
  homeEnv: string;
  /** Arguments of the tool's own subcommands. */
  args: { version: readonly string[]; status: readonly string[] };
  /** The tool's whole environment from `source`, built from its own allowlist. */
  env(source: NodeJS.ProcessEnv): Record<string, string>;
  /** Whether the status command says it is signed in; undefined when its output is unclear. */
  signedIn(stdout: string): boolean | undefined;
  /** The catalog provider whose model ids the tool takes, for a new connection's default. */
  modelSource: string;
  /** The models a connection offers, described from the catalog. */
  models(models: Models): Model<Api>[];
  /** One model turn in headless mode; the tool is only the model. */
  stream(
    model: Model<Api>,
    context: TranscriptContext,
    options: SimpleStreamOptions & { assertAllowed: () => Promise<void> },
  ): Promise<AssistantMessageEventStream>;
}

/** The person's own home folder and login PATH, which the desktop app passes to its server. */
export interface LocalCliHost {
  home: string;
  path?: string;
}

/**
 * Set only on a server the desktop app runs on the person's own computer: a hosted server never
 * has it, so nothing here is registered or offered there.
 */
export function localCliHost(env: NodeJS.ProcessEnv = process.env): LocalCliHost | undefined {
  const home = env.HOST_USER_HOME?.trim();
  if (!home || !isAbsolute(home)) return undefined;
  const path = env.HOST_USER_PATH?.trim();
  return { home, ...(path ? { path } : {}) };
}

/** Which of the tool's homes a connection uses: the person's own. */
export type CliAccount = { kind: "home" };

const ACCOUNT_REF_PREFIX = "dozo-cli-account:";
const ACCOUNT_REF = /^dozo-cli-account:(home)$/;

/**
 * What a connection stores in place of a key: which home it uses. Not a credential: the tool keeps
 * its own sign-in, which the server never reads.
 */
export function cliAccountRef(account: CliAccount): string {
  return `${ACCOUNT_REF_PREFIX}${account.kind}`;
}

export function parseCliAccountRef(value: string | undefined): CliAccount | undefined {
  return value && ACCOUNT_REF.test(value) ? { kind: "home" } : undefined;
}

/**
 * What the tool's environment takes from the person instead of the server: their home and PATH,
 * the home folder of the account, and no config location of the server's own.
 */
export function cliAccountOverrides(
  driver: Pick<CliModelDriver, "homeEnv">,
  host: LocalCliHost,
  accountHome: string | undefined,
): Record<string, string | undefined> {
  const user = userInfo().username;
  return {
    HOME: host.home,
    USERPROFILE: host.home,
    ...(host.path ? { PATH: host.path, Path: host.path } : {}),
    USER: user,
    LOGNAME: user,
    XDG_CONFIG_HOME: undefined,
    XDG_DATA_HOME: undefined,
    XDG_STATE_HOME: undefined,
    XDG_CACHE_HOME: undefined,
    [driver.homeEnv]: accountHome,
  };
}

const accountScope = new AsyncLocalStorage<Record<string, string | undefined>>();

/** Runs `work` with every tool process it starts using the account's environment. */
export function withCliAccount<T>(overrides: Record<string, string | undefined>, work: () => T): T {
  return accountScope.run(overrides, work);
}

/**
 * The environment a tool process starts from: the server's own, with the account's values in place
 * inside `withCliAccount`. The driver's allowlist then keeps every server secret out.
 */
export function cliAccountEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const overrides = accountScope.getStore();
  return overrides ? { ...source, ...overrides } : source;
}

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_OUTPUT_LIMIT = 64 * 1024;

/** What one of the tool's subcommands printed; `missing` when it is not on the person's PATH. */
export type CliProbe = { missing: boolean; stdout: string; exitCode: number | null };

/**
 * Runs one of the tool's own subcommands, without a shell, and returns what it printed. Stopped
 * with what it started after `timeoutMs`. Unix only, as the desktop app's own server is for now.
 */
export function probeCli(
  driver: Pick<CliModelDriver, "command" | "env">,
  args: readonly string[],
  overrides: Record<string, string | undefined>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<CliProbe> {
  return new Promise((resolve) => {
    const child = spawn(driver.command, [...args], {
      cwd: tmpdir(),
      env: driver.env({ ...process.env, ...overrides }),
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    let stdout = "";
    const timer = setTimeout(() => stopGroup(child.pid), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(0, PROBE_OUTPUT_LIMIT);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ missing: error.code === "ENOENT", stdout, exitCode: null });
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ missing: false, stdout, exitCode });
    });
  });
}

/** Stops a tool process and whatever it started in its process group. */
export function stopGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}
