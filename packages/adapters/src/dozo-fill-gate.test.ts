import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./run-tool-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-tool-gate.js")>()),
  // Reaching the approval gate is what "allowed" means here; the gate has its own tests.
  gateToolCall: vi.fn(async () => ({ result: { reachedGate: true } })),
}));
vi.mock("./run-tool-request.js", () => ({
  resolveToolRequest: async (_ctx: unknown, name: string, args: unknown) => ({ name, args }),
  prepareToolRequest: async () => undefined,
}));

import { FILL_GATE_MESSAGE } from "./dozo-fill-gate.js";
import { gateToolCall } from "./run-tool-gate.js";
import { applyTool } from "./run-tools.js";
import { refusalCode } from "./tool-refusal.js";

const ALLOWED = { reachedGate: true };

function attempt(savedTurn?: unknown[]) {
  const findMany = vi.fn(async () =>
    savedTurn ? [{ result: JSON.stringify({ version: 1, messages: savedTurn }) }] : [],
  );
  const ctx = {
    deps: { prisma: { externalEffect: { findMany } } },
    run: { id: "run-1", spaceId: "space-1", userId: "user-1", trigger: "user" },
    runId: "run-1",
    bot: { id: "bot-1" },
    thread: { id: "thread-1" },
    state: { handedOff: false, reply: {} },
    tools: { offered: [], disabled: new Set<string>() },
    computer: { pageBrowserAllowed: true, acceptsImages: true },
    context: { signal: new AbortController().signal },
    secrets: [],
  };
  return {
    findMany,
    call: (name: string, args: Record<string, unknown> = {}) =>
      applyTool(ctx as never, name, args, `call-${name}`),
  };
}

const fill = (kind: string) => ({ actions: [{ kind, ref: "@e1", secret: "site", field: "x" }] });

beforeEach(() => vi.mocked(gateToolCall).mockClear());

describe("commands after a page fill", () => {
  it.each(["fill_secret", "fill_card", "fill_pay_token", "fill_code"])(
    "refuse shell, launch_app and open_path for the rest of a run that asked for %s",
    async (kind) => {
      const run = attempt();
      expect(await run.call("browser_act", fill(kind))).toEqual(ALLOWED);
      for (const name of ["shell", "launch_app", "open_path"]) {
        const result = await run.call(name, { command: "true" });
        expect(result).toEqual({ error: FILL_GATE_MESSAGE });
        expect(refusalCode(result)).toBe("page_fill_blocks_commands");
      }
      expect(gateToolCall).toHaveBeenCalledTimes(1);
    },
  );

  it("leave a run without a fill unchanged", async () => {
    const run = attempt();
    expect(await run.call("shell", { command: "ls" })).toEqual(ALLOWED);
    expect(
      await run.call("browser_act", { actions: [{ kind: "fill", ref: "@e1", text: "hello" }] }),
    ).toEqual(ALLOWED);
    expect(await run.call("shell", { command: "ls" })).toEqual(ALLOWED);
    expect(await run.call("launch_app", { application: "xterm" })).toEqual(ALLOWED);
    // The saved turn is read once per attempt, and only for a command.
    expect(run.findMany).toHaveBeenCalledTimes(1);
  });

  it("keep the page browser and the screen after a fill", async () => {
    const run = attempt();
    await run.call("browser_act", fill("fill_secret"));
    expect(await run.call("browser_act", { actions: [{ kind: "click", ref: "@e2" }] })).toEqual(
      ALLOWED,
    );
    expect(await run.call("computer_act", { actions: [] })).toEqual(ALLOWED);
    expect(await run.call("browser_snapshot")).toEqual(ALLOWED);
  });

  it("hold in a later attempt that resumes a saved turn which asked for a fill", async () => {
    const run = attempt([
      { role: "user", content: "sign in" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Signing in." },
          { type: "toolCall", id: "t1", name: "browser_act", arguments: fill("fill_card") },
        ],
      },
      { role: "toolResult", toolCallId: "t1", content: [] },
    ]);
    expect(await run.call("shell", { command: "ls" })).toEqual({ error: FILL_GATE_MESSAGE });
  });

  it("allow commands when the resumed saved turn filled nothing", async () => {
    const run = attempt([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "t1", name: "browser_act", arguments: { actions: [] } }],
      },
    ]);
    expect(await run.call("shell", { command: "ls" })).toEqual(ALLOWED);
  });
});
