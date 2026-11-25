import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listPiCatalog } from "../pi-models.js";
import { scopedRuntimeModels } from "../pi-runtime-scope.js";
import { claudeCodeDriver } from "./claude-code/dozo-driver.js";
import {
  cliAccountEnv,
  cliAccountOverrides,
  cliAccountRef,
  localCliHost,
  parseCliAccountRef,
  probeCli,
  stopGroup,
  withCliAccount,
} from "./dozo-cli-driver.js";
import {
  AGENT_DRIVERS,
  CLI_ACCOUNT_RECONNECT_ERROR,
  CLI_CATALOG_ONLY_ERROR,
  registerLocalCliProviders,
  registerLocalProvider,
} from "./dozo-cli-providers.js";
import { cliModelRuntime } from "./dozo-cli-runtime.js";

const FAKE_CLI = fileURLToPath(new URL("./claude-code/fake-cli.test-support.mjs", import.meta.url));
const PROVIDER = claudeCodeDriver.provider;
const MODEL_ID = "claude-sonnet-5";
const HOME_REF = cliAccountRef({ kind: "home" });
const hello: Context = {
  systemPrompt: "You are a helpful bot.",
  messages: [{ role: "user", content: "Hi", timestamp: 1 }],
};

// Server secrets and settings that must never reach the person's tool. Fake values.
const SERVER_ENV = {
  DATABASE_URL: "postgres://user:fake-password@db.example.invalid/rakazo",
  BETTER_AUTH_SECRET: "fake-auth-secret",
  ENCRYPTION_KEY: "fake-encryption-key",
  ANTHROPIC_API_KEY: "sk-fake-anthropic-key",
  CLAUDE_CONFIG_DIR: "/server/claude-config",
  XDG_CONFIG_HOME: "/server/xdg",
};

/** A person's computer: their home and a login PATH holding a fake tool the server's PATH lacks. */
function personsComputer(scenario: string, options: { installed?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "dozo-person-home-"));
  const bin = mkdtempSync(join(tmpdir(), "dozo-person-bin-"));
  const record = join(bin, "record.json");
  if (options.installed !== false)
    writeFileSync(
      join(bin, claudeCodeDriver.command),
      `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "${scenario}" "${record}" "$@"\n`,
      { mode: 0o755 },
    );
  vi.stubEnv("HOST_USER_HOME", home);
  vi.stubEnv("HOST_USER_PATH", `${bin}:/usr/bin:/bin`);
  return {
    home,
    bin,
    spawned: () => existsSync(`${record}.spawned`),
    read: () =>
      JSON.parse(readFileSync(record, "utf8")) as { args: string[]; env: Record<string, string> },
  };
}

function localModels(access: () => Promise<string | undefined> = async () => undefined) {
  const models = registerLocalCliProviders(builtinModels() as MutableModels, access);
  return { models, model: models.getModel(PROVIDER, MODEL_ID)! };
}

describe.skipIf(process.platform === "win32")("CLI models on the person's own computer", () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(SERVER_ENV)) vi.stubEnv(name, value);
    vi.stubEnv("HOST_USER_HOME", undefined);
    vi.stubEnv("HOST_USER_PATH", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is local only where the desktop app passes an absolute home", () => {
    expect(localCliHost({})).toBeUndefined();
    expect(localCliHost({ HOST_USER_HOME: "relative/home" })).toBeUndefined();
    expect(localCliHost({ HOST_USER_HOME: " /home/ada " })).toEqual({ home: "/home/ada" });
    expect(localCliHost({ HOST_USER_HOME: "/home/ada", HOST_USER_PATH: ".:/opt/bin:bin" })).toEqual(
      {
        home: "/home/ada",
        path: "/opt/bin",
      },
    );
    expect(localCliHost({ HOST_USER_HOME: "/home/ada", HOST_USER_PATH: "." })).toEqual({
      home: "/home/ada",
    });
  });

  it("stores only which home or computer a connection uses, and reads nothing else as one", () => {
    expect(parseCliAccountRef(HOME_REF)).toEqual({ kind: "home" });
    const device = cliAccountRef({ kind: "device", deviceId: "dev_1-A" });
    expect(device).toBe("dozo-cli-account:device:dev_1-A");
    expect(parseCliAccountRef(device)).toEqual({ kind: "device", deviceId: "dev_1-A" });
    for (const value of [
      "dozo-cli-account:device:",
      "dozo-cli-account:device:a/b",
      `${device}x y`,
      `dozo-cli-account:device:${"a".repeat(65)}`,
    ])
      expect(parseCliAccountRef(value)).toBeUndefined();
    for (const value of [undefined, "", "sk-real-key", `${HOME_REF}x`, "dozo-cli-account:../x"])
      expect(parseCliAccountRef(value)).toBeUndefined();
  });

  it("offers no tool of its own on a hosted server, only the agents a paired computer runs", async () => {
    // Off until the server turns an agent on: it is not in the catalog.
    const shut = registerLocalProvider(builtinModels() as MutableModels);
    for (const driver of AGENT_DRIVERS) expect(shut.getProvider(driver.provider)).toBeUndefined();
    const dir = mkdtempSync(join(tmpdir(), "dozo-agents-"));
    writeFileSync(join(dir, "dozo-agent-tools"), `${AGENT_DRIVERS[0]!.provider}\n`);
    vi.stubEnv("DATA_DIR", dir);
    const models = registerLocalProvider(builtinModels() as MutableModels);
    expect(models.getProvider(PROVIDER)).toBeUndefined();
    expect(models.getProvider(AGENT_DRIVERS[0]!.provider)).toBeDefined();
    expect(models.getProvider(AGENT_DRIVERS[1]!.provider)).toBeUndefined();
    const runtime = { describe: vi.fn(), run: vi.fn(() => "model run") } as unknown as AgentRuntime;
    const deps = { prisma: {} as PrismaClient };
    const env = {
      defaultProvider: "openrouter",
      defaultModel: "x",
      deploymentModelConfigured: true,
    };
    // A run whose model is not an agent still goes straight to the model runtime.
    const hosted = cliModelRuntime(env, runtime, deps);
    expect(hosted.run({ model: { provider: "openrouter" } } as never, {})).toBe("model run");
    // A deployment that names a command-line tool as its model keeps the upstream runtime.
    expect(
      cliModelRuntime({ ...env, defaultProvider: claudeCodeDriver.provider }, runtime, deps),
    ).not.toBe(runtime);
  });

  it("lists the tool's models in the catalog on the person's computer", () => {
    personsComputer("reply");
    const entries = listPiCatalog().filter((entry) => entry.provider === PROVIDER);
    expect(entries.map((entry) => entry.id)).toContain(MODEL_ID);
    expect(entries[0]).toMatchObject({ providerName: claudeCodeDriver.name, auth: "api-key" });
  });

  it("runs a turn through the person's own tool, home and PATH, with no server secret", async () => {
    const computer = personsComputer("reply");
    const { models, model } = localModels();
    const message = await models.streamSimple(model, hello, { apiKey: HOME_REF }).result();

    expect(message.stopReason).toBe("stop");
    expect(message.content.at(-1)).toEqual({ type: "text", text: "Hello there" });
    const { env, args } = computer.read();
    expect(env.HOME).toBe(computer.home);
    expect(env.PATH?.split(":")[0]).toBe(computer.bin);
    // The person's own sign-in: no config location of the server's.
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.XDG_CONFIG_HOME).toBeUndefined();
    for (const name of [
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "ENCRYPTION_KEY",
      "ANTHROPIC_API_KEY",
    ])
      expect(env[name]).toBeUndefined();
    // Only the model: the tool's own tools, permissions and sessions stay off.
    expect(args).toEqual(
      expect.arrayContaining(["--tools", "", "--permission-mode", "dontAsk", "--max-turns", "1"]),
    );
  });

  it("refuses a tool that starts with its own tools on", async () => {
    personsComputer("built-in-tools");
    const { models, model } = localModels();
    const message = await models.streamSimple(model, hello, { apiKey: HOME_REF }).result();
    expect(message.errorMessage).toMatch(/its own tools enabled: Bash, Read/);
  });

  it.each([
    ["no account", undefined],
    ["a key that names no account", "sk-real-key"],
    // An agent on a paired computer is run there, never by this server's own tool.
    ["a connection that names a computer", "dozo-cli-account:device:dev-1"],
  ])("never runs another account in place of %s", async (_, apiKey) => {
    const computer = personsComputer("reply");
    const { models, model } = localModels();
    const message = await models.streamSimple(model, hello, { apiKey }).result();
    expect(message.errorMessage).toBe(CLI_ACCOUNT_RECONNECT_ERROR);
    expect(computer.spawned()).toBe(false);
  });

  it("refuses a turn the access check refuses, before the tool starts", async () => {
    const computer = personsComputer("reply");
    const { models, model } = localModels(async () => "Only one person.");
    const message = await models.streamSimple(model, hello, { apiKey: HOME_REF }).result();
    expect(message.errorMessage).toBe("Only one person.");
    expect(computer.spawned()).toBe(false);
  });

  it("never runs from the catalog's copy", async () => {
    const computer = personsComputer("reply");
    const models = registerLocalProvider(builtinModels() as MutableModels);
    const model = models.getModel(PROVIDER, MODEL_ID)!;
    const message = await models.streamSimple(model, hello, { apiKey: HOME_REF }).result();
    expect(message.errorMessage).toBe(CLI_CATALOG_ONLY_ERROR);
    expect(computer.spawned()).toBe(false);
  });

  it("says when the tool is not installed on the person's computer", async () => {
    personsComputer("reply", { installed: false });
    const { models, model } = localModels();
    const message = await models.streamSimple(model, hello, { apiKey: HOME_REF }).result();
    expect(message.errorMessage).toMatch(/not installed/);
  });

  it("stops the tool when the run is cancelled", async () => {
    personsComputer("hang");
    const { models, model } = localModels();
    const controller = new AbortController();
    const stream = models.streamSimple(model, hello, {
      apiKey: HOME_REF,
      signal: controller.signal,
    });
    for await (const event of stream) if (event.type === "text_delta") controller.abort();
    expect((await stream.result()).stopReason).toBe("aborted");
  });

  it("gives the runtime the person's tools there, and keeps a deployment's own CLI model", async () => {
    personsComputer("reply");
    let seen: unknown;
    const runtime: AgentRuntime = {
      describe: () => ({}) as ReturnType<AgentRuntime["describe"]>,
      abort: vi.fn(),
      run() {
        seen = scopedRuntimeModels()?.getProvider(PROVIDER);
        return (async function* () {})();
      },
    };
    const deps = { prisma: {} as PrismaClient };
    const local = cliModelRuntime(
      { defaultProvider: "openrouter", defaultModel: "x", deploymentModelConfigured: false },
      runtime,
      deps,
    );
    for await (const _ of local.run({ model: { provider: "openrouter" } } as never, {} as never));
    expect(seen).toBeDefined();
    const deployment = cliModelRuntime(
      { defaultProvider: PROVIDER, defaultModel: MODEL_ID, deploymentModelConfigured: true },
      runtime,
      deps,
    );
    seen = undefined;
    for await (const _ of deployment.run(
      { model: { provider: "openrouter" } } as never,
      {} as never,
    ));
    expect((seen as { getModels(): unknown[] } | undefined)?.getModels()).toHaveLength(1);
  });

  it("probes the tool's own subcommands without a shell, and knows a missing one", async () => {
    const computer = personsComputer("signed-out");
    const overrides = cliAccountOverrides(claudeCodeDriver, localCliHost()!, undefined);
    const status = await probeCli(claudeCodeDriver, claudeCodeDriver.args.status, overrides);
    expect(status).toMatchObject({ missing: false, exitCode: 1 });
    expect(claudeCodeDriver.signedIn((status as { stdout: string }).stdout)).toBe(false);
    expect(claudeCodeDriver.signedIn("not json")).toBeUndefined();
    expect(claudeCodeDriver.signedIn('{"loggedIn":"yes"}')).toBeUndefined();
    const missing = await probeCli(claudeCodeDriver, ["--version"], {
      ...overrides,
      PATH: computer.home,
    });
    expect(missing).toEqual({ missing: true, stdout: "", exitCode: null });
    const failed = await probeCli({ ...claudeCodeDriver, command: computer.home }, [], overrides);
    expect(failed).toMatchObject({ missing: false, exitCode: null });
  });

  it("stops a subcommand that hangs, with what it started", async () => {
    personsComputer("hang-version");
    const overrides = cliAccountOverrides(claudeCodeDriver, localCliHost()!, undefined);
    const hung = await probeCli(claudeCodeDriver, ["--version"], overrides, 300);
    expect(hung).toEqual({ missing: false, stdout: "", exitCode: null });
  });

  it("keeps the server's PATH when the person's is unknown", () => {
    const overrides = cliAccountOverrides(claudeCodeDriver, { home: "/home/ada" }, "/accounts/a");
    expect(overrides).toMatchObject({ HOME: "/home/ada", CLAUDE_CONFIG_DIR: "/accounts/a" });
    expect("PATH" in overrides).toBe(false);
  });

  it("swaps the account's values in only inside its scope", () => {
    expect(cliAccountEnv({ HOME: "/server" })).toEqual({ HOME: "/server" });
    const turn = { driver: claudeCodeDriver, overrides: { HOME: "/home/ada" } };
    expect(withCliAccount(turn, () => cliAccountEnv({ HOME: "/server" }))).toEqual({
      HOME: "/home/ada",
    });
    expect(() => stopGroup(undefined)).not.toThrow();
    expect(() => stopGroup(2 ** 22 + 12_345)).not.toThrow();
  });
});
