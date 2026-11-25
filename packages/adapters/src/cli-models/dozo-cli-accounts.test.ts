import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeCodeDriver } from "./claude-code/dozo-driver.js";
import type { CliAccountsDeps } from "./dozo-cli-accounts.js";
import {
  cancelCliLogin,
  cliHomeConnection,
  MAX_CLI_ACCOUNTS,
  readCliTools,
  sendCliLoginCode,
  startCliAccountLogin,
} from "./dozo-cli-accounts.js";
import { cliAccountRef } from "./dozo-cli-driver.js";
import { accountHomeIds, cliAccountsRoot, createAccountHome } from "./dozo-cli-homes.js";

const FAKE_CLI = fileURLToPath(new URL("./claude-code/fake-cli.test-support.mjs", import.meta.url));
const ACCOUNTS_CLI = fileURLToPath(new URL("./dozo-fake-cli.test-support.mjs", import.meta.url));
const PROVIDER = claudeCodeDriver.provider;
const HOME_REF = cliAccountRef({ kind: "home" });

/** The person's computer with the tool installed (or not) on their login PATH. */
function computer(scenario: string | null) {
  const home = mkdtempSync(join(tmpdir(), "dozo-person-home-"));
  const bin = mkdtempSync(join(tmpdir(), "dozo-person-bin-"));
  if (scenario)
    writeFileSync(
      join(bin, claudeCodeDriver.command),
      `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "${scenario}" "${join(bin, "record")}" "$@"\n`,
      { mode: 0o755 },
    );
  vi.stubEnv("HOST_USER_HOME", home);
  vi.stubEnv("HOST_USER_PATH", bin);
}

/** The person's computer with the accounts-aware fake tool, and the server's data folder. */
function accountsComputer(scenario: string) {
  const home = mkdtempSync(join(tmpdir(), "dozo-person-home-"));
  const bin = mkdtempSync(join(tmpdir(), "dozo-person-bin-"));
  const log = join(bin, "calls.log");
  writeFileSync(
    join(bin, claudeCodeDriver.command),
    `#!/bin/sh\nexec "${process.execPath}" "${ACCOUNTS_CLI}" "${scenario}" "${log}" "$@"\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("HOST_USER_HOME", home);
  vi.stubEnv("HOST_USER_PATH", bin);
  vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "dozo-server-data-")));
  return {
    signOuts: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { args: string[]; configDir: string | null })
            .filter((call) => call.args.join(" ") === "auth logout")
            .map((call) => call.configDir)
        : [],
  };
}

/** A server's connections and secrets: each secret's plaintext is its id's entry here. */
function deps(
  options: {
    people?: number;
    billing?: boolean;
    connections?: { provider: string; secretId: string }[];
    secrets?: Record<string, string>;
  } = {},
): CliAccountsDeps {
  const secrets = options.secrets ?? {};
  return {
    billingEnabled: options.billing ?? false,
    prisma: {
      // Every person counted, or (asked by id) whether the caller is that person.
      user: {
        count: async ({ where }: { where: { id?: string } }) =>
          where.id ? Number(where.id !== "stranger") : (options.people ?? 1),
      },
      // No computer of the person's is paired: a hosted server then lists no agent.
      userDevice: { findMany: async () => [] },
      userModelCredential: {
        // Each reader asks for the providers it means: the models', or the agents'.
        findMany: vi.fn(async ({ where }: { where?: { provider?: { in?: string[] } } } = {}) =>
          (options.connections ?? []).filter(
            (row) => !where?.provider?.in || where.provider.in.includes(row.provider),
          ),
        ),
      },
      $queryRaw: async () => [],
      secret: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          where.id in secrets ? { id: where.id, ciphertext: `c-${where.id}` } : null,
      },
    } as unknown as PrismaClient,
    secretStore: {
      load: async (_: string | null, id: string) => {
        if (id === "unreadable") throw new Error("bad ciphertext");
        return secrets[id]!;
      },
    },
  };
}

/** The tools that are models: the agents (dozo-agent-modes.test.ts) are listed beside them. */
const readModelTools = async (...args: Parameters<typeof readCliTools>) =>
  (await readCliTools(...args)).filter((tool) => tool.mode === "model");

const HOME_CONNECTION = {
  connections: [{ provider: PROVIDER, secretId: "s-home" }],
  secrets: { "s-home": HOME_REF },
};

describe.skipIf(process.platform === "win32")("the person's CLI accounts", () => {
  beforeEach(() => {
    vi.stubEnv("HOST_USER_HOME", undefined);
    vi.stubEnv("HOST_USER_PATH", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists nothing on a hosted server, a billing one, a shared one, or to anyone else", async () => {
    expect(await readModelTools(deps(), "ada")).toEqual([]);
    computer("reply");
    expect(await readModelTools(deps({ billing: true }), "ada")).toEqual([]);
    expect(await readModelTools(deps({ people: 2 }), "ada")).toEqual([]);
    expect(await readModelTools(deps(), "stranger")).toEqual([]);
    await expect(cliHomeConnection(deps(), "stranger", PROVIDER)).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });

  it("says the tool is not installed", async () => {
    computer(null);
    expect(await readModelTools(deps(), "ada")).toEqual([
      {
        provider: PROVIDER,
        name: claudeCodeDriver.name,
        mode: "model",
        found: false,
        signedIn: null,
        connected: false,
        canAdd: false,
      },
    ]);
  });

  it("reads whether the person is signed in and already connected", async () => {
    computer("reply");
    expect(await readModelTools(deps(HOME_CONNECTION), "ada")).toEqual([
      {
        provider: PROVIDER,
        name: claudeCodeDriver.name,
        mode: "model",
        found: true,
        signedIn: true,
        connected: true,
        canAdd: true,
      },
    ]);
    computer("signed-out");
    const other = deps({
      connections: [
        { provider: PROVIDER, secretId: "s-key" },
        { provider: PROVIDER, secretId: "unreadable" },
      ],
      secrets: { "s-key": "sk-not-an-account", unreadable: "" },
    });
    expect(await readModelTools(other, "ada")).toMatchObject([{ signedIn: false, connected: false }]);
  });

  it("connects the person's own sign-in with the tool's name and a catalog model", async () => {
    computer("reply");
    const connection = await cliHomeConnection(deps(), "ada", PROVIDER);
    expect(connection).toMatchObject({ provider: PROVIDER, label: claudeCodeDriver.name });
    expect(connection.plaintext).toBe(HOME_REF);
    expect(connection.modelId).toMatch(/^claude-/);
  });

  it.each([
    ["an unknown tool", "reply", "other-provider", deps(), "NOT_FOUND"],
    ["a missing tool", null, PROVIDER, deps(), "cli_account_unavailable"],
    ["a signed-out tool", "signed-out", PROVIDER, deps(), "cli_account_unavailable"],
    ["a second connection", "reply", PROVIDER, deps(HOME_CONNECTION), "cli_account_unavailable"],
  ])("refuses %s", async (_, scenario, provider, server, code) => {
    computer(scenario);
    const refused = await cliHomeConnection(server, "ada", provider).catch((error) => error);
    expect(refused).toBeInstanceOf(ClientError);
    expect(refused.code).toBe(code);
  });

  it("removes the homes no connection uses, signing each out first, and keeps the rest", async () => {
    const tool = accountsComputer("turn");
    const used = await createAccountHome(PROVIDER);
    const unused = await createAccountHome(PROVIDER);
    const server = deps({
      connections: [{ provider: PROVIDER, secretId: "s-used" }],
      secrets: { "s-used": cliAccountRef({ kind: "added", id: used.id }) },
    });
    expect(await readModelTools(server, "ada")).toMatchObject([{ connected: false, canAdd: true }]);
    expect(await accountHomeIds(PROVIDER)).toEqual([used.id]);
    expect(tool.signOuts()).toEqual([unused.path]);
  });

  it("adds an account through the tool's own sign-in, and saves only which home it uses", async () => {
    accountsComputer("login-code");
    const saved: unknown[] = [];
    const changed = vi.fn();
    expect(
      await startCliAccountLogin(deps(), "ada", PROVIDER, {
        save: async (connection) => {
          saved.push(connection);
        },
        changed,
      }),
    ).toEqual({ status: "waiting" });
    // A sign-in in progress keeps its home, whatever reads the tools meanwhile.
    expect(await readModelTools(deps(), "ada")).toMatchObject([{ login: { status: "waiting" } }]);
    const [id] = await accountHomeIds(PROVIDER);
    await vi.waitFor(() =>
      expect(readModelTools(deps(), "ada")).resolves.toMatchObject([
        { login: { url: expect.stringMatching(/^https:\/\/claude\.ai\//) } },
      ]),
    );
    sendCliLoginCode("ada", PROVIDER, "good-code");
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({
      provider: PROVIDER,
      label: claudeCodeDriver.name,
      plaintext: cliAccountRef({ kind: "added", id: id! }),
    });
    expect(changed).toHaveBeenCalled();
    await cancelCliLogin("ada", PROVIDER);
  });

  it("adds no account past the limit", async () => {
    accountsComputer("login-code");
    const ids = await Promise.all(
      Array.from({ length: MAX_CLI_ACCOUNTS }, () => createAccountHome(PROVIDER)),
    );
    const full = deps({
      connections: ids.map((home) => ({ provider: PROVIDER, secretId: home.id })),
      secrets: Object.fromEntries(
        ids.map((home) => [home.id, cliAccountRef({ kind: "added", id: home.id })]),
      ),
    });
    expect(await readModelTools(full, "ada")).toMatchObject([{ canAdd: false }]);
    const handlers = { save: vi.fn(), changed: vi.fn() };
    await expect(startCliAccountLogin(full, "ada", PROVIDER, handlers)).rejects.toMatchObject({
      code: "cli_account_unavailable",
    });
    expect(await accountHomeIds(PROVIDER)).toHaveLength(MAX_CLI_ACCOUNTS);
    expect(cliAccountsRoot()).toContain("dozo-server-data-");
  });

  it("refuses on a hosted server", async () => {
    await expect(cliHomeConnection(deps(), "ada", PROVIDER)).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });
});
