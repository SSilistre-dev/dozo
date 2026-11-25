import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeCodeDriver } from "../providers/cli-model/claude-code/dozo-driver.js";
import type { CliAccount, LocalCliHost } from "./dozo-cli-driver.js";
import { accountHomeIds, cliAccountsRoot } from "./dozo-cli-homes.js";
import {
  CLI_LOGIN_NOT_FINISHED,
  CLI_LOGIN_TIMED_OUT,
  CliLoginCodeError,
  cancelCliLogin,
  cliLoginView,
  liveCliLogins,
  sendCliLoginCode,
  startCliLogin,
} from "./dozo-cli-login.js";

const FAKE_CLI = fileURLToPath(new URL("./dozo-fake-cli.test-support.mjs", import.meta.url));
const PROVIDER = claudeCodeDriver.provider;
const SIGN_IN_URL = "https://claude.ai/oauth/authorize?code=true&state=abc";

let host: LocalCliHost;
let log: string;

/** The person's computer with the fake tool on their login PATH, and the server's data folder. */
function computer(scenario: string, options: { installed?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "dozo-person-home-"));
  const bin = mkdtempSync(join(tmpdir(), "dozo-person-bin-"));
  log = join(bin, "calls.log");
  if (options.installed !== false)
    writeFileSync(
      join(bin, claudeCodeDriver.command),
      `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "${scenario}" "${log}" "$@"\n`,
      { mode: 0o755 },
    );
  vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "dozo-server-data-")));
  host = { home, path: `${bin}:/usr/bin:/bin` };
}

const calls = () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: string[]; configDir: string | null })
    : [];

function start(
  options: { onSignedIn?: (account: CliAccount) => Promise<void>; timeoutMs?: number } = {},
) {
  const saved: CliAccount[] = [];
  const onChange = vi.fn();
  const view = startCliLogin({
    driver: claudeCodeDriver,
    host,
    userId: "ada",
    onSignedIn:
      options.onSignedIn ??
      (async (account) => {
        saved.push(account);
      }),
    onChange,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { view, saved, onChange };
}

const loginView = () => cliLoginView("ada", PROVIDER);

describe.skipIf(process.platform === "win32")("signing in another account", () => {
  beforeEach(() => {
    vi.stubEnv("HOST_USER_HOME", undefined);
  });
  afterEach(async () => {
    await cancelCliLogin("ada", PROVIDER);
    vi.unstubAllEnvs();
  });

  it("shows the address the tool prints on its own host, and no other", async () => {
    computer("login-hangs");
    expect(await start().view).toEqual({ status: "waiting" });
    await vi.waitFor(() => expect(loginView()).toEqual({ status: "waiting", url: SIGN_IN_URL }));
  });

  it("signs in with the code the person pastes, in a home of its own, and saves it", async () => {
    computer("login-code");
    const { view, saved, onChange } = start();
    await view;
    const [id] = await accountHomeIds(PROVIDER);
    const folder = join(cliAccountsRoot(), PROVIDER, id!);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(liveCliLogins(PROVIDER)).toEqual(new Set([id]));
    await vi.waitFor(() => expect(loginView()?.url).toBe(SIGN_IN_URL));
    sendCliLoginCode("ada", PROVIDER, " good-code ");

    await vi.waitFor(() => expect(saved).toEqual([{ kind: "added", id }]));
    await vi.waitFor(() => expect(loginView()).toBeUndefined());
    expect(onChange).toHaveBeenCalled();
    // The tool kept its sign-in in that home; the person's own was never used.
    expect(existsSync(join(folder, "signed-in"))).toBe(true);
    const login = calls().find((call) => call.args.join(" ") === "auth login");
    expect(login?.configDir).toBe(folder);
    expect(existsSync(join(host.home, ".claude"))).toBe(false);
  });

  it("refuses a code with more than one answer in it, or with no sign-in waiting", async () => {
    computer("login-hangs");
    await start().view;
    for (const code of ["a b", "good-code\nmore", ""])
      expect(() => sendCliLoginCode("ada", PROVIDER, code)).toThrow(CliLoginCodeError);
    expect(() => sendCliLoginCode("bob", PROVIDER, "good-code")).toThrow(CliLoginCodeError);
  });

  it("starts one sign-in at a time per person and tool, even two at the same moment", async () => {
    computer("login-hangs");
    await Promise.all([start().view, start().view]);
    await start().view;
    expect(await accountHomeIds(PROVIDER)).toHaveLength(1);
  });

  it("says a sign-in that ends without signing in did not finish, and removes its home", async () => {
    computer("login-gives-up");
    const { view, saved } = start();
    await view;
    await vi.waitFor(() =>
      expect(loginView()).toEqual({ status: "failed", error: CLI_LOGIN_NOT_FINISHED }),
    );
    expect(saved).toEqual([]);
    expect(await accountHomeIds(PROVIDER)).toEqual([]);
    expect(liveCliLogins(PROVIDER).size).toBe(0);
  });

  it("ends a sign-in nobody finishes", async () => {
    computer("login-hangs");
    await start({ timeoutMs: 300 }).view;
    await vi.waitFor(() =>
      expect(loginView()).toEqual({ status: "failed", error: CLI_LOGIN_TIMED_OUT }),
    );
    expect(await accountHomeIds(PROVIDER)).toEqual([]);
  });

  it("removes the home when the account cannot be saved", async () => {
    computer("login-code");
    const { view } = start({ onSignedIn: async () => Promise.reject(new Error("db down")) });
    await view;
    await vi.waitFor(() => expect(loginView()?.url).toBe(SIGN_IN_URL));
    sendCliLoginCode("ada", PROVIDER, "good-code");
    await vi.waitFor(() => expect(loginView()?.status).toBe("failed"));
    expect(await accountHomeIds(PROVIDER)).toEqual([]);
  });

  it("starts nothing when it cannot make the account's home", async () => {
    computer("login-hangs");
    const notAFolder = join(mkdtempSync(join(tmpdir(), "dozo-server-data-")), "file");
    writeFileSync(notAFolder, "");
    vi.stubEnv("DATA_DIR", notAFolder);
    await expect(start().view).rejects.toThrow();
    expect(loginView()).toBeUndefined();
  });

  it("says so when the tool is not installed", async () => {
    computer("login-code", { installed: false });
    await start().view;
    await vi.waitFor(() => expect(loginView()?.status).toBe("failed"));
    expect(await accountHomeIds(PROVIDER)).toEqual([]);
  });

  it("saves nothing when cancelled while the tool's sign-in is being checked", async () => {
    computer("login-slow-status");
    const { view, saved } = start();
    await view;
    await vi.waitFor(() => expect(loginView()?.url).toBe(SIGN_IN_URL));
    sendCliLoginCode("ada", PROVIDER, "good-code");
    await vi.waitFor(() =>
      expect(calls().some((call) => call.args.join(" ") === "auth status --json")).toBe(true),
    );
    await cancelCliLogin("ada", PROVIDER);
    await vi.waitFor(async () => expect(await accountHomeIds(PROVIDER)).toEqual([]));
    expect(saved).toEqual([]);
    expect(loginView()).toBeUndefined();
  });

  it("cancels a sign-in in progress, with its home", async () => {
    computer("login-hangs");
    const { saved } = start();
    await vi.waitFor(() => expect(loginView()?.url).toBe(SIGN_IN_URL));
    await cancelCliLogin("ada", PROVIDER);
    expect(loginView()).toBeUndefined();
    expect(await accountHomeIds(PROVIDER)).toEqual([]);
    expect(saved).toEqual([]);
    await cancelCliLogin("ada", PROVIDER);
  });
});
