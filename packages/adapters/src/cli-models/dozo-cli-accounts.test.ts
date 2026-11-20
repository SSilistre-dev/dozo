import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeCodeDriver } from "./claude-code/dozo-driver.js";
import type { CliAccountsDeps } from "./dozo-cli-accounts.js";
import { cliHomeConnection, readCliTools } from "./dozo-cli-accounts.js";
import { cliAccountRef } from "./dozo-cli-driver.js";

const FAKE_CLI = fileURLToPath(new URL("./claude-code/fake-cli.test-support.mjs", import.meta.url));
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
      user: { count: async () => options.people ?? 1 },
      userModelCredential: { findMany: vi.fn(async () => options.connections ?? []) },
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

  it("lists nothing on a hosted server, a billing one or a shared one", async () => {
    expect(await readCliTools(deps(), "ada")).toEqual([]);
    computer("reply");
    expect(await readCliTools(deps({ billing: true }), "ada")).toEqual([]);
    expect(await readCliTools(deps({ people: 2 }), "ada")).toEqual([]);
  });

  it("says the tool is not installed", async () => {
    computer(null);
    expect(await readCliTools(deps(), "ada")).toEqual([
      {
        provider: PROVIDER,
        name: claudeCodeDriver.name,
        found: false,
        signedIn: null,
        connected: false,
      },
    ]);
  });

  it("reads whether the person is signed in and already connected", async () => {
    computer("reply");
    expect(await readCliTools(deps(HOME_CONNECTION), "ada")).toEqual([
      {
        provider: PROVIDER,
        name: claudeCodeDriver.name,
        found: true,
        signedIn: true,
        connected: true,
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
    expect(await readCliTools(other, "ada")).toMatchObject([{ signedIn: false, connected: false }]);
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

  it("refuses on a hosted server", async () => {
    await expect(cliHomeConnection(deps(), "ada", PROVIDER)).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });
});
