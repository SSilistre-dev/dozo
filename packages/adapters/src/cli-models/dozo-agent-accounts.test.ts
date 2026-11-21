import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODEX_AGENT_PROVIDER_ID, CODEX_SIGNED_OUT_ERROR } from "./codex/dozo-codex-agent.js";
import { agentConnection } from "./dozo-agent-accounts.js";
import { cliHomeConnection, readCliTools } from "./dozo-cli-accounts.js";
import { cliAccountRef } from "./dozo-cli-driver.js";

const FAKE = fileURLToPath(
  new URL("./codex/dozo-fake-app-server.test-support.mjs", import.meta.url),
);

/** The person's computer with a fake `codex`, maybe turned on for agent mode. */
function computer(scenario: string | null, enabled = true) {
  const bin = mkdtempSync(join(tmpdir(), "dozo-person-bin-"));
  const data = mkdtempSync(join(tmpdir(), "dozo-server-data-"));
  if (scenario)
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "${scenario}" "${join(bin, "log")}" "$@"\n`,
      { mode: 0o755 },
    );
  if (enabled) writeFileSync(join(data, "dozo-agent-tools"), `${CODEX_AGENT_PROVIDER_ID}\n`);
  vi.stubEnv("HOST_USER_HOME", mkdtempSync(join(tmpdir(), "dozo-person-home-")));
  vi.stubEnv("HOST_USER_PATH", bin);
  vi.stubEnv("DATA_DIR", data);
}

function deps(connected: string[] = []) {
  return {
    billingEnabled: false,
    prisma: {
      user: { count: async () => 1 },
      userModelCredential: {
        findMany: async ({ where }: { where: { provider?: { in?: string[] } } }) =>
          connected
            .filter((provider) => !where.provider?.in || where.provider.in.includes(provider))
            .map((provider) => ({ provider, secretId: "s", userId: "ada" })),
        count: async ({ where }: { where: { provider: string } }) =>
          connected.filter((provider) => provider === where.provider).length,
      },
      secret: { findFirst: async () => null },
    } as unknown as PrismaClient,
    secretStore: { load: async () => "" },
  };
}

const agentView = (tools: Awaited<ReturnType<typeof readCliTools>>) =>
  tools.find((tool) => tool.provider === CODEX_AGENT_PROVIDER_ID);

describe.skipIf(process.platform === "win32")("connecting an agent", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists an agent only once it is turned on for this server", async () => {
    computer("reply", false);
    expect(agentView(await readCliTools(deps(), "ada"))).toBeUndefined();
    computer("reply");
    expect(agentView(await readCliTools(deps(), "ada"))).toEqual({
      provider: CODEX_AGENT_PROVIDER_ID,
      name: "Codex",
      mode: "agent",
      found: true,
      signedIn: null,
      connected: false,
      canAdd: false,
    });
    computer(null);
    expect(agentView(await readCliTools(deps([CODEX_AGENT_PROVIDER_ID]), "ada"))).toMatchObject({
      found: false,
      connected: true,
    });
  });

  it("connects only after the person agreed and the agent passed its check", async () => {
    computer("reply");
    await expect(cliHomeConnection(deps(), "ada", CODEX_AGENT_PROVIDER_ID)).rejects.toMatchObject({
      code: "agent_consent",
    });
    expect(
      await cliHomeConnection(deps(), "ada", CODEX_AGENT_PROVIDER_ID, { consent: true }),
    ).toMatchObject({
      provider: CODEX_AGENT_PROVIDER_ID,
      label: "Codex agent",
      plaintext: cliAccountRef({ kind: "home" }),
    });
  });

  it("says why an agent that fails its check cannot be connected", async () => {
    computer("signed-out");
    await expect(
      cliHomeConnection(deps(), "ada", CODEX_AGENT_PROVIDER_ID, { consent: true }),
    ).rejects.toMatchObject({ code: "agent_unavailable", message: CODEX_SIGNED_OUT_ERROR });
  });

  it("connects one agent once, and none on a hosted server", async () => {
    computer("reply");
    await expect(
      cliHomeConnection(deps([CODEX_AGENT_PROVIDER_ID]), "ada", CODEX_AGENT_PROVIDER_ID, {
        consent: true,
      }),
    ).rejects.toMatchObject({ code: "cli_account_unavailable" });
    vi.stubEnv("HOST_USER_HOME", undefined);
    await expect(
      cliHomeConnection(deps(), "ada", CODEX_AGENT_PROVIDER_ID, { consent: true }),
    ).rejects.toMatchObject({ kind: "NOT_FOUND" });
  });

  it("leaves the model to the agent when the catalog has none of its models", async () => {
    computer("reply");
    const driver = {
      provider: "agent-x",
      name: "X",
      command: "x",
      modelSource: "no-such-provider",
      installed: async () => true,
      selfTest: async () => undefined,
      start: async () => {
        throw new Error("unused");
      },
    };
    const connection = await agentConnection(driver, { home: "/h" }, true);
    expect(connection.modelId).toBeUndefined();
  });
});
