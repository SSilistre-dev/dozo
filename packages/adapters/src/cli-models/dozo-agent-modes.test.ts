import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAgentRuntime } from "./dozo-agent.js";
import {
  agentModeConnections,
  agentModeEnabled,
  isAgentProvider,
  saveAgentConnection,
  setAgentMode,
} from "./dozo-agent-modes.js";
import { cliHomeConnection, readCliTools } from "./dozo-cli-accounts.js";
import { AGENT_DRIVERS, registerLocalCliProviders } from "./dozo-cli-providers.js";

const PROVIDERS = AGENT_DRIVERS.map((driver) => driver.provider);

/**
 * The settings table (provider to the connection that owns it) and the connections, answering the
 * SQL and queries the module sends. Removing a connection removes its row, as the foreign key does.
 */
function table(initial: string[] = [], credentials: Record<string, string> = {}) {
  const rows = new Map(
    initial.map((provider) => [provider, credentials[provider] ?? `c-${provider}`]),
  );
  const connections = new Map<string, string>(Object.entries(credentials));
  const sql = (strings: TemplateStringsArray) => strings.join("?");
  const prisma = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, provider?: string) => {
      const text = sql(strings);
      if (text.includes("WHERE provider")) return rows.has(provider!) ? [{ provider }] : [];
      return [...rows.values()].map((credentialId) => ({ credentialId }));
    }),
    $executeRaw: vi.fn(
      async (strings: TemplateStringsArray, provider: string, credentialId?: string) => {
        if (sql(strings).includes("INSERT")) rows.set(provider, credentialId!);
        else if (sql(strings).includes("DELETE")) rows.delete(provider);
        return 1;
      },
    ),
    user: { count: async () => 1 },
    userDevice: { findMany: async () => [] },
    deploymentSettings: { findUnique: async () => null },
    userModelCredential: {
      findMany: async ({ where }: { where: { provider: string | { in: string[] } } }) =>
        [...connections]
          .filter(([provider]) =>
            typeof where.provider === "string"
              ? provider === where.provider
              : where.provider.in.includes(provider),
          )
          .map(([provider, id]) => ({ provider, id, secretId: "s", userId: "ada" })),
      findFirst: async ({ where }: { where: { provider: string } }) => {
        const id = connections.get(where.provider);
        return id ? { id } : null;
      },
      count: async () => 0,
    },
    secret: { findFirst: async () => null },
  };
  return { rows, connections, prisma: prisma as unknown as PrismaClient, raw: prisma };
}

/** A computer with the named agents installed (a script that answers a version), a data folder. */
function computer(installed: string[], options: { file?: string[]; local?: boolean } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "dozo-modes-bin-"));
  const data = mkdtempSync(join(tmpdir(), "dozo-modes-data-"));
  const commands = new Map(AGENT_DRIVERS.map((driver) => [driver.provider, driver.command]));
  for (const provider of installed)
    writeFileSync(join(bin, commands.get(provider)!), "#!/bin/sh\necho 0.171.0\n", { mode: 0o755 });
  if (options.file?.length)
    writeFileSync(join(data, "dozo-agent-tools"), `${options.file.join("\n")}\n`);
  if (options.local === false) vi.stubEnv("HOST_USER_HOME", undefined);
  else vi.stubEnv("HOST_USER_HOME", mkdtempSync(join(tmpdir(), "dozo-modes-home-")));
  vi.stubEnv("HOST_USER_PATH", bin);
  vi.stubEnv("DATA_DIR", data);
}

const agents = async (db: PrismaClient) =>
  (
    await readCliTools(
      { prisma: db, secretStore: { load: async () => "" }, billingEnabled: false },
      "ada",
    )
  ).filter((tool) => tool.mode === "agent");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")("the agents a local server lists", () => {
  // Every combination of CLI, setting and file: the rows are always there and say only what is true.
  const cases = [false, true].flatMap((cli) =>
    [false, true].flatMap((setting) => [false, true].map((file) => ({ cli, setting, file }))),
  );
  it.each(cases)("cli $cli, setting $setting, file $file", async ({ cli, setting, file }) => {
    computer(cli ? PROVIDERS : [], { file: file ? PROVIDERS : [] });
    const { prisma } = table(setting ? PROVIDERS : []);
    const rows = await agents(prisma);
    expect(rows.map((row) => row.provider)).toEqual(PROVIDERS);
    for (const row of rows) {
      const driver = AGENT_DRIVERS.find((entry) => entry.provider === row.provider)!;
      expect(row).toMatchObject({ name: driver.name, found: cli, connected: false });
      // The page to get it from only while it is missing, and always the descriptor's own.
      expect(row.downloadUrl).toBe(cli ? undefined : driver.downloadUrl);
      expect(row.canAdd).toBe(false);
    }
  });

  it("lists nothing on Windows, whatever else is set", async () => {
    computer(PROVIDERS, { file: PROVIDERS });
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(await agents(table(PROVIDERS).prisma)).toEqual([]);
    const models = registerLocalCliProviders(builtinModels() as MutableModels);
    for (const provider of PROVIDERS) expect(models.getProvider(provider)).toBeUndefined();
  });

  it("puts every agent in the catalog, so connecting needs no restart", () => {
    computer([]);
    const models = registerLocalCliProviders(builtinModels() as MutableModels);
    for (const provider of PROVIDERS) expect(models.getProvider(provider)).toBeDefined();
  });

  it("names a fixed https page for each agent, never one made of anything the person sends", () => {
    const pages = AGENT_DRIVERS.map((driver) => driver.downloadUrl!);
    expect(new Set(pages).size).toBe(AGENT_DRIVERS.length);
    for (const page of pages) {
      const url = new URL(page);
      expect([url.protocol, url.username, url.password, url.search, url.hash]).toEqual([
        "https:",
        "",
        "",
        "",
        "",
      ]);
    }
  });
});

describe("a hosted server", () => {
  it.each([
    { setting: false, file: false },
    { setting: true, file: true },
  ])("answers the same with setting $setting and file $file", async ({ setting, file }) => {
    computer(PROVIDERS, { file: file ? PROVIDERS : [], local: false });
    const { prisma } = table(setting ? PROVIDERS : []);
    // It runs no agent itself, whatever the setting or the file: no row without a computer of the
    // person's that runs one.
    expect(await agents(prisma)).toEqual([]);
    // Its catalog adds only the agents', which a paired computer runs, and no tool of its own.
    const before = builtinModels() as MutableModels;
    const names = new Set(before.getProviders().map((provider) => provider.id));
    const after = registerLocalCliProviders(builtinModels() as MutableModels);
    expect(new Set(after.getProviders().map((provider) => provider.id))).toEqual(
      new Set([...names, ...PROVIDERS]),
    );
  });
});

describe("the setting", () => {
  it("is on by a row, or by a line in the file kept from before, and off otherwise", async () => {
    computer([], { file: [PROVIDERS[1]!] });
    const { prisma } = table([PROVIDERS[2]!]);
    expect(await agentModeEnabled(prisma, PROVIDERS[0]!)).toBe(false);
    expect(await agentModeEnabled(prisma, PROVIDERS[1]!)).toBe(true);
    expect(await agentModeEnabled(prisma, PROVIDERS[2]!)).toBe(true);
    // Neither a file line nor a row makes a provider Dozo does not know an agent.
    expect(await agentModeEnabled(table(["claude-code"]).prisma, "claude-code")).toBe(false);
  });

  it("is turned on for a connection and off by a boolean for a known agent, and takes nothing else", async () => {
    computer([]);
    const { prisma, rows, raw } = table();
    await setAgentMode(prisma, PROVIDERS[0]!, true, "cred-1");
    await setAgentMode(prisma, PROVIDERS[0]!, true, "cred-1");
    expect([...rows]).toEqual([[PROVIDERS[0], "cred-1"]]);
    expect([...(await agentModeConnections(prisma))]).toEqual(["cred-1"]);
    await setAgentMode(prisma, PROVIDERS[0]!, false);
    expect(rows.size).toBe(0);
    const calls = raw.$executeRaw.mock.calls.length;
    for (const bad of ["yes", 1, null, undefined, { path: "/bin/sh" }, ["/bin/sh"]])
      await expect(setAgentMode(prisma, PROVIDERS[0]!, bad as never, "c")).rejects.toThrow(
        TypeError,
      );
    for (const provider of ["/bin/sh", "agy acp", "claude-code", ""])
      await expect(setAgentMode(prisma, provider, true, "c")).rejects.toThrow(TypeError);
    // Turning it on names the connection that owns it.
    for (const id of [undefined, "", 7])
      await expect(setAgentMode(prisma, PROVIDERS[0]!, true, id as never)).rejects.toThrow(
        TypeError,
      );
    expect(raw.$executeRaw.mock.calls).toHaveLength(calls);
    expect(isAgentProvider(PROVIDERS[0]!)).toBe(true);
    expect(isAgentProvider("claude-code")).toBe(false);
  });

  it("is turned on by saving an agent's connection and goes when the connection does", async () => {
    computer(PROVIDERS);
    const { prisma, rows, connections } = table();
    const save = vi.fn(async () => {
      connections.set(PROVIDERS[1]!, "cred-9");
      return { id: "cred-9" };
    });
    await saveAgentConnection(prisma, "ada", PROVIDERS[1]!, save);
    expect([...rows]).toEqual([[PROVIDERS[1], "cred-9"]]);
    const [row] = await agents(prisma).then((all) =>
      all.filter((tool) => tool.provider === PROVIDERS[1]),
    );
    expect(row).toMatchObject({ connected: true });
    // The connection is removed in settings: the row goes with it (the foreign key), and the row
    // offers Connect again.
    connections.delete(PROVIDERS[1]!);
    rows.delete(PROVIDERS[1]!);
    expect(await agentModeEnabled(prisma, PROVIDERS[1]!)).toBe(false);
  });

  it("finishes a connection whose mode could not be written, instead of hiding it", async () => {
    computer(PROVIDERS);
    const { prisma, rows, connections, raw } = table();
    const save = vi.fn(async () => {
      connections.set(PROVIDERS[0]!, "cred-1");
      return { id: "cred-1" };
    });
    raw.$executeRaw.mockRejectedValueOnce(new Error("database went away"));
    await expect(saveAgentConnection(prisma, "ada", PROVIDERS[0]!, save)).rejects.toThrow(
      "went away",
    );
    // Saved but with no mode: it shows as not connected, so the person can connect again.
    const half = (await agents(prisma)).find((tool) => tool.provider === PROVIDERS[0]);
    expect(half).toMatchObject({ connected: false });
    const deps = { prisma, secretStore: { load: async () => "" } };
    // Connecting again is not refused as "already connected": it goes on to the agent's own check.
    await expect(
      cliHomeConnection(deps, "ada", PROVIDERS[0]!, { consent: true }),
    ).rejects.toMatchObject({ code: "agent_unavailable" });
    // The retry finds the saved connection, saves nothing again, and writes the mode.
    await saveAgentConnection(prisma, "ada", PROVIDERS[0]!, save);
    expect(save).toHaveBeenCalledTimes(1);
    expect([...rows]).toEqual([[PROVIDERS[0], "cred-1"]]);
    expect((await agents(prisma)).find((tool) => tool.provider === PROVIDERS[0])).toMatchObject({
      connected: true,
    });
  });
});

describe.skipIf(process.platform === "win32")("the person's agreement", () => {
  it("is asked for before an agent connects, whether the mode is on or not", async () => {
    for (const on of [false, true]) {
      computer(PROVIDERS, { file: on ? PROVIDERS : [] });
      const { prisma } = table(on ? PROVIDERS : []);
      const deps = { prisma, secretStore: { load: async () => "" } };
      for (const provider of PROVIDERS)
        await expect(cliHomeConnection(deps, "ada", provider)).rejects.toMatchObject({
          code: "agent_consent",
        });
      // Its maker's terms: the risk is accepted separately, so consent alone does not connect it.
      const risky = AGENT_DRIVERS.filter((driver) => driver.termsRisk);
      expect(risky.length).toBeGreaterThan(0);
      for (const driver of risky)
        await expect(
          cliHomeConnection(deps, "ada", driver.provider, { consent: true }),
        ).rejects.toMatchObject({ code: "agent_terms_consent" });
    }
  });
});

describe("a run", () => {
  const next: AgentRuntime = {
    describe: () => ({}) as ReturnType<AgentRuntime["describe"]>,
    abort: vi.fn(),
    async *run() {},
  };
  const request = (provider: string) =>
    ({
      botId: "b",
      threadId: "t",
      runId: "r",
      prompt: "hi",
      instructions: "",
      history: [],
      tools: [],
      model: { provider, id: "default", apiKey: "dozo-cli-account:home" },
    }) as unknown as AgentRunRequest;
  const refusal = "Personal CLI access is turned off on servers that bill for model usage.";
  const run = (provider: string, enabled?: (provider: string) => Promise<boolean>) =>
    withAgentRuntime(next, AGENT_DRIVERS, {
      accessCheck: async () => refusal,
      runAllowed: async () => undefined,
      ...(enabled ? { enabled } : {}),
    })
      .run(request(provider), {})
      [Symbol.asyncIterator]()
      .next();

  it("stays refused while the agent's mode is off, from the file, the setting or neither", async () => {
    computer([]);
    await expect(run(PROVIDERS[0]!, async () => false)).rejects.toThrow(/not turned on/);
    await expect(run(PROVIDERS[0]!)).rejects.toThrow(/not turned on/);
  });

  it("goes on to the billing and sharing refusal once the mode is on, which the setting never lifts", async () => {
    computer([]);
    await expect(run(PROVIDERS[0]!, async () => true)).rejects.toThrow(refusal);
    computer([], { file: [PROVIDERS[1]!] });
    await expect(run(PROVIDERS[1]!)).rejects.toThrow(refusal);
  });
});
