import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientError } from "@rakazo/core";
import { bestEffort } from "@rakazo/logging";
import type { CliAccount, CliModelDriver, LocalCliHost } from "./dozo-cli-driver.js";
import { cliAccountOverrides, probeCli, stopGroup } from "./dozo-cli-driver.js";
import { createAccountHome, removeAccountHome } from "./dozo-cli-homes.js";

/** What settings show of a sign-in in progress, or of one that did not finish. */
export interface CliLoginView {
  status: "waiting" | "failed";
  /** The address the tool printed for the person to open, on one of its own hosts. */
  url?: string;
  error?: string;
}

interface Session extends CliLoginView {
  id: string;
  child?: ChildProcessWithoutNullStreams;
  timer?: NodeJS.Timeout;
}

/** A sign-in nobody finishes ends on its own. */
export const CLI_LOGIN_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_LIMIT = 64 * 1024;
/** What a pasted code may hold: no spaces or line breaks, so it is one answer to one prompt. */
const CODE = /^[A-Za-z0-9#_\-.~+/=]{1,512}$/;
const URL_IN_TEXT = /https:\/\/[^\s"'<>`]+/g;

export const CLI_LOGIN_NOT_FINISHED = "Sign-in did not finish.";
export const CLI_LOGIN_TIMED_OUT = "Sign-in took too long.";

/** Sign-ins in progress or failed, one per person and tool, in this server process. */
const sessions = new Map<string, Session>();
const key = (userId: string, provider: string) => `${userId}\u0000${provider}`;

/** The first address the tool printed on one of its own hosts; any other is never shown. */
function signInUrl(driver: Pick<CliModelDriver, "loginHosts">, text: string): string | undefined {
  for (const [match] of text.matchAll(URL_IN_TEXT)) {
    let url: URL;
    try {
      // Sentence punctuation after an address is not part of it.
      url = new URL(match.replace(/[).,;:!?]+$/, ""));
    } catch {
      continue;
    }
    const host = url.hostname;
    if (driver.loginHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)))
      return url.href;
  }
  return undefined;
}

export function cliLoginView(userId: string, provider: string): CliLoginView | undefined {
  const session = sessions.get(key(userId, provider));
  if (!session) return undefined;
  return {
    status: session.status,
    ...(session.url ? { url: session.url } : {}),
    ...(session.error ? { error: session.error } : {}),
  };
}

/** The account ids whose sign-in is still in progress, which nothing may clean up. */
export function liveCliLogins(provider: string): Set<string> {
  const ids = new Set<string>();
  for (const [name, session] of sessions)
    if (name.endsWith(`\u0000${provider}`) && session.status === "waiting") ids.add(session.id);
  return ids;
}

export interface CliLoginStart {
  driver: CliModelDriver;
  host: LocalCliHost;
  userId: string;
  /** Saves the signed-in account as the person's connection. */
  onSignedIn: (account: CliAccount) => Promise<void>;
  /** Tells the person's apps that what settings show changed. */
  onChange: () => void;
  timeoutMs?: number;
}

/**
 * Starts the tool's own sign-in in a new home folder of its own. The person finishes it in their
 * browser, on the address the tool prints; the tool keeps what it gets. When the tool exits and
 * says it is signed in there, the account becomes a connection; otherwise its folder goes.
 */
export async function startCliLogin(start: CliLoginStart): Promise<CliLoginView> {
  const { driver, host, userId, onChange } = start;
  const name = key(userId, driver.provider);
  if (sessions.get(name)?.status === "waiting") return cliLoginView(userId, driver.provider)!;
  // Held before the first wait, so a second start at the same moment finds it.
  const session: Session = { id: "", status: "waiting" };
  sessions.set(name, session);
  let home: Awaited<ReturnType<typeof createAccountHome>>;
  let cwd: string;
  try {
    home = await createAccountHome(driver.provider);
    cwd = await mkdtemp(join(tmpdir(), "dozo-cli-login-"));
  } catch (error) {
    sessions.delete(name);
    throw error;
  }
  session.id = home.id;
  const overrides = cliAccountOverrides(driver, host, home.path);
  const current = () => sessions.get(name) === session;
  const finish = async (error?: string) => {
    if (error) await removeAccountHome(driver.provider, home.id);
    await rm(cwd, { recursive: true, force: true });
    // Cancelled meanwhile: nothing is left to show.
    if (!current()) return;
    if (error) Object.assign(session, { status: "failed", error, url: undefined });
    else sessions.delete(name);
    onChange();
  };
  /** Once the tool has exited: saves the account if it says it is signed in in that home. */
  const settle = async () => {
    try {
      const status = await probeCli(driver, driver.args.status, overrides);
      if (!current()) return await finish(CLI_LOGIN_NOT_FINISHED);
      if (driver.signedIn(status.stdout) !== true) return await finish(CLI_LOGIN_NOT_FINISHED);
      await start.onSignedIn({ kind: "added", id: home.id });
      await finish();
    } catch (error) {
      await finish(CLI_LOGIN_NOT_FINISHED);
      throw error;
    }
  };
  const child = spawn(driver.command, [...driver.args.login], {
    cwd,
    env: driver.env({ ...process.env, ...overrides }),
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  session.child = child;
  /** The tool is gone: nothing may signal its process group any more. */
  const ended = () => {
    clearTimeout(session.timer);
    const running = session.child === child;
    session.child = undefined;
    return running;
  };
  let output = "";
  const read = (chunk: string) => {
    output = (output + chunk).slice(-OUTPUT_LIMIT);
    const url = session.url ? undefined : signInUrl(driver, output);
    if (!url) return;
    session.url = url;
    onChange();
  };
  child.stdout.setEncoding("utf8").on("data", read);
  child.stderr.setEncoding("utf8").on("data", read);
  child.stdin.on("error", () => {});
  session.timer = setTimeout(() => {
    // Still running: its exit or a cancel clears this timer.
    stopGroup(child.pid);
    ended();
    void bestEffort("CLI sign-in timeout", finish(CLI_LOGIN_TIMED_OUT));
  }, start.timeoutMs ?? CLI_LOGIN_TIMEOUT_MS);
  child.once("error", () => {
    if (ended()) void bestEffort("CLI sign-in start", finish(CLI_LOGIN_NOT_FINISHED));
  });
  child.once("close", () => {
    if (ended()) void bestEffort("CLI sign-in result", settle());
    // Cancelled: the rest went with the session.
    else if (!current())
      void bestEffort("CLI sign-in folder", rm(cwd, { recursive: true, force: true }));
  });
  return cliLoginView(userId, driver.provider)!;
}

export class CliLoginCodeError extends ClientError {
  constructor(message: string) {
    super("BAD_REQUEST", message, "cli_login_code");
  }
}

/** Hands a code the person pasted to the tool's sign-in prompt, as one line. */
export function sendCliLoginCode(userId: string, provider: string, code: string): void {
  const session = sessions.get(key(userId, provider));
  const trimmed = code.trim();
  if (!session?.child || session.status !== "waiting")
    throw new CliLoginCodeError("No sign-in is waiting for a code.");
  if (!CODE.test(trimmed)) throw new CliLoginCodeError("That code is not valid.");
  session.child.stdin.write(`${trimmed}\n`);
}

/** Ends a sign-in in progress, or forgets one that failed. Its folder goes with it. */
export async function cancelCliLogin(userId: string, provider: string): Promise<void> {
  const name = key(userId, provider);
  const session = sessions.get(name);
  if (!session) return;
  sessions.delete(name);
  clearTimeout(session.timer);
  const child = session.child;
  // After the tool exited, its sign-in is being checked: that check removes the folder itself.
  if (!child) return;
  session.child = undefined;
  stopGroup(child.pid);
  await removeAccountHome(provider, session.id);
}
