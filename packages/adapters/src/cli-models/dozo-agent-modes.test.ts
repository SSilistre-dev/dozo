import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutableModels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAgentRuntime } from "./dozo-agent.js";
import { agentModeEnabled, recordAgentConnection, setAgentMode } from "./dozo-agent-modes.js";
import { cliHomeConnection, readCliTools } from "./dozo-cli-accounts.js";
import { AGENT_DRIVERS, registerLocalCliProviders } from "./dozo-cli-providers.js";

const PROVIDERS = AGENT_DRIVERS.map((driver) => driver.provider);

/** The settings table as a map of provider ids, answering the SQL the module sends. */
function table(initial: string[] = []) {
  const rows = new Set(initial);
  const sql = (strings: TemplateStringsArray) => strings.join("?");
  const prisma = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, provider: string) =>
      sql(strings).includes("FROM dozo_agent_modes") && rows.has(provider) ? [{ provider }] : [],
    ),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, provider: string) => {
      if (sql(strings).includes("INSERT")) rows.add(provider);
      else if (sql(strings).includes("DELETE")) rows.delete(provider);
      return 1;
    }),
    user: { count: async () => 1 },
    deploymentSettings: { findUnique: async () => null },
    userModelCredential: { findMany: async () => [], count: async () => 0 },
    secret: { findFirst: async () => null },
  };
  return { rows, prisma: prisma as unknown as PrismaClient, raw: prisma };
}

/** A computer with the named agents installed (a script that answers a version), a data folder. */
function computer(installed: string[], options: { file?: string[]; local?: boolean } = {}) {
  const bin = mkdtempSync(join(tmpdir(), "dozo-modes-bin-"));
  const data = mkdtempSync(join(tmpdir(), "dozo-modes-data-"));
  const commands = new Map(AGENT_DRIVERS.map((driver) => [driver.provider, driver.command]));
  for (const provider of installed)
    writeFileSync(join(bin, commands.get(provider)!), "#!/bin/sh\necho 0.171.0\n", { mode: 0o755 });
  if (options.file?.length) writeFileSync(join(data, "dozo-agent-tools"), `${options.file.join("\n")}\n`);
  if (options.local === false) vi.stubEnv("HOST_USER_HOME", undefined);
  else vi.stubEnv("HOST_USER_HOME", mkdtempSync(join(tmpdir(), "dozo-modes-home-")));
  vi.stubEnv("HOST_USER_PATH", bin);
  vi.stubEnv("DATA_DIR", data);
}

const agents = async (db: PrismaClient) =>
  (await readCliTools({ prisma: db, secretStore: { load: async () => "" }, billingEnabled: false }, "ada")).filter(
    (tool) => tool.mode === "agent",
  );

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
    expect(await agents(prisma)).toEqual([]);
    const before = builtinModels() as MutableModels;
    const names = new Set(before.getProviders().map((provider) => provider.id));
    const after = registerLocalCliProviders(builtinModels() as MutableModels);
    expect(new Set(after.getProviders().map((provider) => provider.id))).toEqual(names);
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

  it("is turned on and off by a boolean for a known agent, and takes nothing else", async () => {
    computer([]);
    const { prisma, rows, raw } = table();
    await setAgentMode(prisma, PROVIDERS[0]!, true);
    await setAgentMode(prisma, PROVIDERS[0]!, true);
    expect([...rows]).toEqual([PROVIDERS[0]]);
    await setAgentMode(prisma, PROVIDERS[0]!, false);
    expect(rows.size).toBe(0);
    const calls = raw.$executeRaw.mock.calls.length;
    for (const bad of ["yes", 1, null, undefined, { path: "/bin/sh" }, ["/bin/sh"]])
      await expect(setAgentMode(prisma, PROVIDERS[0]!, bad as never)).rejects.toThrow(TypeError);
    for (const provider of ["/bin/sh", "agy acp", "claude-code", ""])
      await expect(setAgentMode(prisma, provider, true)).rejects.toThrow(TypeError);
    expect(raw.$executeRaw.mock.calls).toHaveLength(calls);
  });

  it("is turned on by connecting an agent and by nothing else", async () => {
    const { prisma, rows } = table();
    await recordAgentConnection(prisma, "claude-code");
    expect(rows.size).toBe(0);
    await recordAgentConnection(prisma, PROVIDERS[1]!);
    expect([...rows]).toEqual([PROVIDERS[1]]);
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
