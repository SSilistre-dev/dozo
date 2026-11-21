import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionOutReason, poolResetAt } from "../dozo-model-pool.js";
import { claudeCodeDriver } from "./claude-code/dozo-driver.js";
import { cliAccountRef, parseCliAccountRef } from "./dozo-cli-driver.js";
import {
  accountHome,
  accountHomeIds,
  cliAccountsRoot,
  createAccountHome,
  removeAccountHome,
} from "./dozo-cli-homes.js";
import { CLI_ACCOUNT_RECONNECT_ERROR, registerLocalCliProviders } from "./dozo-cli-providers.js";

const FAKE_CLI = fileURLToPath(new URL("./dozo-fake-cli.test-support.mjs", import.meta.url));
const PROVIDER = claudeCodeDriver.provider;
const MODEL_ID = "claude-sonnet-5";
const hello: Context = { messages: [{ role: "user", content: "Hi", timestamp: 1 }] };
let log: string;

/** The person's computer with the fake tool on their login PATH, and the server's data folder. */
function computer() {
  const home = mkdtempSync(join(tmpdir(), "dozo-person-home-"));
  const bin = mkdtempSync(join(tmpdir(), "dozo-person-bin-"));
  log = join(bin, "calls.log");
  writeFileSync(
    join(bin, claudeCodeDriver.command),
    `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" turn "${log}" "$@"\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("HOST_USER_HOME", home);
  vi.stubEnv("HOST_USER_PATH", `${bin}:/usr/bin:/bin`);
  vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "dozo-server-data-")));
  return { home };
}

/** An account the server added, signed in (or not), and maybe out of its usage. */
async function account(options: { signedIn?: boolean; limited?: boolean } = {}) {
  const made = await createAccountHome(PROVIDER);
  if (options.signedIn !== false) writeFileSync(join(made.path, "signed-in"), "");
  if (options.limited) writeFileSync(join(made.path, "limited"), "");
  return { ...made, ref: cliAccountRef({ kind: "added", id: made.id }) };
}

async function turn(apiKey: string) {
  const models = registerLocalCliProviders(builtinModels() as MutableModels, async () => undefined);
  return models.streamSimple(models.getModel(PROVIDER, MODEL_ID)!, hello, { apiKey }).result();
}

const turnCalls = () =>
  readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; configDir: string | null; home: string })
    .filter((call) => call.args[0] === "-p");

describe.skipIf(process.platform === "win32")("accounts the server added", () => {
  beforeEach(() => {
    vi.stubEnv("DATA_DIR", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps each account's home under the server's data folder, closed to others", async () => {
    expect(cliAccountsRoot({})).toBe(join(process.cwd(), "data", "cli-accounts"));
    computer();
    const added = await account();
    expect(added.path).toBe(join(cliAccountsRoot(), PROVIDER, added.id));
    expect(await accountHome(PROVIDER, added.id)).toBe(added.path);
    expect(await accountHomeIds(PROVIDER)).toEqual([added.id]);
    expect(parseCliAccountRef(added.ref)).toEqual({ kind: "added", id: added.id });
    await removeAccountHome(PROVIDER, added.id);
    await removeAccountHome(PROVIDER, "../escape");
    expect(await accountHomeIds(PROVIDER)).toEqual([]);
    expect(await accountHomeIds("other-provider")).toEqual([]);
  });

  it("uses no folder it did not make the way it makes them", async () => {
    computer();
    const open = await account();
    chmodSync(open.path, 0o755);
    const target = mkdtempSync(join(tmpdir(), "dozo-elsewhere-"));
    const linked = "0".repeat(32);
    symlinkSync(target, join(cliAccountsRoot(), PROVIDER, linked));
    writeFileSync(join(cliAccountsRoot(), PROVIDER, "1".repeat(32)), "a file");
    for (const id of [open.id, linked, "1".repeat(32), "2".repeat(32), "../../etc"])
      expect(await accountHome(PROVIDER, id)).toBeUndefined();
  });

  it("removes nothing through a link put in place of the provider's folder", async () => {
    computer();
    const elsewhere = mkdtempSync(join(tmpdir(), "dozo-elsewhere-"));
    const id = "3".repeat(32);
    mkdirSync(join(elsewhere, id));
    mkdirSync(cliAccountsRoot(), { recursive: true });
    symlinkSync(elsewhere, join(cliAccountsRoot(), PROVIDER));
    await removeAccountHome(PROVIDER, id);
    expect(existsSync(join(elsewhere, id))).toBe(true);
    await removeAccountHome("never-added", id);
  });

  it("refuses to list homes it cannot read", async () => {
    computer();
    mkdirSync(cliAccountsRoot(), { recursive: true });
    writeFileSync(join(cliAccountsRoot(), PROVIDER), "not a folder");
    await expect(accountHomeIds(PROVIDER)).rejects.toThrow();
  });

  it("runs each account's turn in its own home, the person's own in theirs", async () => {
    const { home } = computer();
    const added = await account();
    expect((await turn(added.ref)).content).toEqual([
      { type: "text", text: "answered from an added account" },
    ]);
    const [call] = turnCalls();
    expect(call).toMatchObject({ configDir: added.path, home });
  });

  it("refuses a turn whose home is gone, without starting the tool in another", async () => {
    computer();
    const added = await account();
    await removeAccountHome(PROVIDER, added.id);
    expect((await turn(added.ref)).errorMessage).toBe(CLI_ACCOUNT_RECONNECT_ERROR);
  });

  it("says an account that is signed out is this one, in the words the pool reads", async () => {
    computer();
    const message = await turn((await account({ signedIn: false })).ref);
    expect(message.errorMessage).toBe(
      `${claudeCodeDriver.name} API error (401): this account is signed out. Sign it in again in Settings.`,
    );
    expect(connectionOutReason(message)).toBe("rejected");
  });

  it("says an account out of its usage is, and when the tool says it opens again", async () => {
    computer();
    const before = Date.now();
    const message = await turn((await account({ limited: true })).ref);
    expect(message.errorMessage).toMatch(
      /usage limit.*Usage limit reached; try again in ~180 min\.$/,
    );
    // The pool rests this account until then and hands the call to the next one.
    expect(connectionOutReason(message)).toBe("exhausted");
    const resetAt = poolResetAt(message.errorMessage ?? "")!;
    expect(resetAt - before).toBeGreaterThan(179 * 60_000);
    expect(resetAt - before).toBeLessThanOrEqual(181 * 60_000);
  });

  it("rests an account out of its usage for the default time when the tool gives no reset", async () => {
    computer();
    const limited = await account({ limited: true });
    writeFileSync(join(limited.path, "no-reset"), "");
    const message = await turn(limited.ref);
    expect(message.errorMessage).toMatch(/plan\. Usage limit reached\.$/);
    expect(connectionOutReason(message)).toBe("exhausted");
    expect(poolResetAt(message.errorMessage ?? "")).toBeUndefined();
  });

  it("reads only a refused limit, and a reset only when it is a plausible time", () => {
    const now = Math.floor(Date.now() / 1000);
    const limit = (info: unknown) =>
      claudeCodeDriver.usageLimit({ type: "rate_limit_event", rate_limit_info: info });
    expect(claudeCodeDriver.usageLimit({ type: "assistant" })).toBeUndefined();
    expect(limit({ status: "allowed_warning", resetsAt: now + 60 })).toBeUndefined();
    expect(limit(undefined)).toBeUndefined();
    expect(limit({ status: "rejected", resetsAt: now + 60 })).toEqual({
      resetsAt: (now + 60) * 1000,
    });
    expect(limit({ status: "rejected" })).toEqual({});
    expect(limit({ status: "rejected", resetsAt: now - 60 })).toEqual({});
    expect(limit({ status: "rejected", resetsAt: now + 90 * 24 * 3600 })).toEqual({});
  });
});
