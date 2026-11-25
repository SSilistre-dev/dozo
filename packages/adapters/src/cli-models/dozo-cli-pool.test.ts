import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Models, MutableModels } from "@earendil-works/pi-ai";
import type * as AllProviders from "@earendil-works/pi-ai/providers/all";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Runs on the branded tree only: the brand rules hand a failed call to the pool
// (dozo-model-pool.ts) and note the CLI's limit event (stream.ts). Two accounts of a fake CLI
// answer every call; nothing leaves the process.

const state = vi.hoisted(() => ({ models: undefined as Models | undefined }));

vi.mock("@earendil-works/pi-ai/providers/all", async (importOriginal) => {
  const actual = await importOriginal<typeof AllProviders>();
  return {
    ...actual,
    builtinModels: () => ({
      getModel: (provider: string, id: string) => state.models?.getModel(provider, id),
      streamSimple: (...args: Parameters<Models["streamSimple"]>) =>
        state.models!.streamSimple(...args),
    }),
  };
});
vi.mock("../runtime/pi/models/pi-local-provider.js", () => ({ registerLocalProvider: (models: unknown) => models }));
vi.mock("../runtime/pi/models/pi-openai-compatible-provider.js", () => ({
  OPENAI_COMPATIBLE_PROVIDER_ID: "openai-compatible",
  registerOpenAiCompatibleCatalog: (models: unknown) => models,
  registerOpenAiCompatibleRuntime: (models: unknown) => models,
}));

import type { RunModelPool } from "../dozo-model-pool.js";
import { withRunModelPool } from "../dozo-model-pool.js";
import { PiAgentRuntime } from "../runtime/pi/pi-runtime.js";
import { claudeCodeDriver } from "../providers/cli-model/claude-code/dozo-driver.js";
import { cliAccountRef } from "./dozo-cli-driver.js";
import { createAccountHome } from "./dozo-cli-homes.js";
import { registerLocalCliProviders } from "./dozo-cli-providers.js";

const FAKE_CLI = fileURLToPath(new URL("./dozo-fake-cli.test-support.mjs", import.meta.url));
const PROVIDER = claudeCodeDriver.provider;
const MODEL_ID = "claude-sonnet-5";
let log: string;

beforeAll(async () => {
  const actual = await vi.importActual<typeof AllProviders>("@earendil-works/pi-ai/providers/all");
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
  state.models = registerLocalCliProviders(
    actual.builtinModels() as MutableModels,
    async () => undefined,
  );
});
afterEach(() => {
  writeFileSync(log, "");
});

/** An account the server added and signed in, maybe out of its usage. */
async function account(limited = false) {
  const made = await createAccountHome(PROVIDER);
  writeFileSync(join(made.path, "signed-in"), "");
  if (limited) writeFileSync(join(made.path, "limited"), "");
  return { ...made, ref: cliAccountRef({ kind: "added", id: made.id }) };
}

function request(first: string, second: string): AgentRunRequest {
  return {
    botId: "bot",
    threadId: "thread",
    runId: "run",
    prompt: "Say hello",
    instructions: "",
    history: [],
    tools: [],
    model: { provider: PROVIDER, id: MODEL_ID, apiKey: first, connectionId: "a" },
    fallbackModels: [{ provider: PROVIDER, id: MODEL_ID, apiKey: second, connectionId: "b" }],
    executeTool: vi.fn(async () => ({ ok: true })),
  } as unknown as AgentRunRequest;
}

function pool(): RunModelPool {
  return {
    provider: PROVIDER,
    modelId: MODEL_ID,
    credential: { id: "a" } as RunModelPool["credential"],
    members: ["b"],
    recordOut: vi.fn(async () => true),
  };
}

async function run(input: AgentRunRequest) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of new PiAgentRuntime().run(input, {
    operationId: "operation",
    traceId: "trace",
    spaceId: "space",
    userId: "user",
    signal: new AbortController().signal,
  }))
    events.push(event);
  return events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");
}

const homesUsed = () =>
  readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { args: string[]; configDir: string })
    .filter((call) => call.args[0] === "-p")
    .map((call) => call.configDir);

describe.skipIf(process.platform === "win32")("CLI accounts in a model pool", () => {
  it("rests the account out of its usage until the CLI's reset, and the next one answers", async () => {
    const out = await account(true);
    const next = await account();
    const runPool = pool();
    const before = Date.now();

    expect(await run(withRunModelPool(request(out.ref, next.ref), runPool))).toBe(
      "answered from an added account",
    );
    expect(homesUsed()).toEqual([out.path, next.path]);
    const [connection, model, reason, resetAt] = vi.mocked(runPool.recordOut).mock.calls[0]!;
    expect([connection, model, reason]).toEqual(["a", MODEL_ID, "exhausted"]);
    expect(resetAt! - before).toBeGreaterThan(179 * 60_000);
    expect(resetAt! - before).toBeLessThanOrEqual(181 * 60_000);
  });

  it("keeps a turn on its own account while it has usage left", async () => {
    const first = await account();
    const second = await account();
    const runPool = pool();
    expect(await run(withRunModelPool(request(first.ref, second.ref), runPool))).toBe(
      "answered from an added account",
    );
    expect(homesUsed()).toEqual([first.path]);
    expect(runPool.recordOut).not.toHaveBeenCalled();
  });
});
