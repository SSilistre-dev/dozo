import { beforeEach, describe, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => ({ plan: "allow" as "allow" | "ask" | "deny" }));
const rules = vi.hoisted(() => ({ exists: vi.fn(async () => false) }));

vi.mock("./run-tools-user-computer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-tools-user-computer.js")>()),
  userComputerGate: vi.fn(async () => upstream.plan),
}));
vi.mock("@rakazo/db", () => ({ dozoCommandRuleExists: rules.exists }));

import { buildApprovalAskBlock, userComputerGate } from "./dozo-user-computer-gate.js";
import type { RunContext } from "./run-context.js";

const SHELL = "user_computer_shell";

function context(skipApprovals = false, enabled = false) {
  return {
    deps: { prisma: {} },
    run: { userId: "user-1" },
    bot: { id: "bot-1" },
    trust: { loadAutoReviewPreference: async () => ({ enabled, skipApprovals }) },
  } as unknown as RunContext;
}

async function gate(command: string, extra: Record<string, unknown> = {}, ctx = context()) {
  const args = { command, ...extra };
  const plan = await userComputerGate(ctx, false, SHELL, args);
  return { plan, args };
}

function actions(args: Record<string, unknown>) {
  const block = buildApprovalAskBlock("effect-1", SHELL, args, []);
  return block.kind === "ask" ? block.actions?.map((action) => action.label) : undefined;
}

beforeEach(() => {
  upstream.plan = "allow";
  rules.exists.mockReset().mockResolvedValue(false);
});

describe("userComputerGate", () => {
  it("keeps upstream's answer before the Space allows the computer, and for screen tools", async () => {
    upstream.plan = "ask";
    expect((await gate("rm -rf build")).plan).toBe("ask");
    upstream.plan = "deny";
    expect((await gate("ls")).plan).toBe("deny");
    upstream.plan = "allow";
    expect(await userComputerGate(context(), false, "user_computer_act", { app: "Notes" })).toBe(
      "allow",
    );
    expect(rules.exists).not.toHaveBeenCalled();
  });

  it("lets a command that only reads go ahead", async () => {
    expect((await gate("ls -la")).plan).toBe("allow");
    expect((await gate("grep -rn TODO src", { cwd: "~/app" })).plan).toBe("allow");
    expect(rules.exists).not.toHaveBeenCalled();
  });

  it("asks before a command that changes something or reaches out", async () => {
    for (const command of ["rm -rf build", "curl https://example.com", "npm publish"])
      expect((await gate(command)).plan, command).toBe("ask");
  });

  it("asks before a command it cannot read, without looking for a rule", async () => {
    for (const command of [
      "ls; rm -rf ~",
      "ls && rm -rf ~",
      "cat notes | sh",
      "echo $(rm -rf ~)",
      "echo hi > ~/.zshrc",
      "PATH=/tmp ls",
      "\\ls",
      "ls *",
      "ls ~",
      "'l's",
    ])
      expect((await gate(command)).plan, command).toBe("ask");
    expect(rules.exists).not.toHaveBeenCalled();
  });

  it("lets a command the member always allows for this bot and folder go ahead", async () => {
    rules.exists.mockResolvedValue(true);
    expect((await gate("npm test", { cwd: " ~ " })).plan).toBe("allow");
    expect(rules.exists).toHaveBeenCalledWith(
      {},
      { userId: "user-1", botId: "bot-1", words: ["npm", "test"], cwd: "" },
    );
    await gate("npm test", { cwd: "~/app" });
    expect(rules.exists).toHaveBeenLastCalledWith(
      {},
      { userId: "user-1", botId: "bot-1", words: ["npm", "test"], cwd: "~/app" },
    );
  });

  it("keeps the Space-wide approval alone in Never ask", async () => {
    expect((await gate("rm -rf build", {}, context(true, true))).plan).toBe("allow");
    // Auto still asks: no reviewer looks at commands on the user's own computer yet.
    expect((await gate("rm -rf build", {}, context(false, true))).plan).toBe("ask");
  });
});

describe("buildApprovalAskBlock", () => {
  it("offers Always allow this command on a command asked about on its own", async () => {
    const { args } = await gate("npm test", { cwd: "~/app" });
    expect(actions(args)).toEqual(["Allow once", "Always allow this command", "Deny"]);
    const block = buildApprovalAskBlock("effect-1", SHELL, args, []);
    expect(block).toMatchObject({ text: "Run on your computer?", detail: "cd ~/app\nnpm test" });
  });

  it("offers only Allow once when the command cannot be a rule", async () => {
    expect(actions((await gate("ls && rm -rf build")).args)).toEqual(["Allow once", "Deny"]);
  });

  it("offers only Allow once when the card hides part of the command", async () => {
    const secret = "s3cret-token-value";
    const { args } = await gate(`npm run deploy --token=${secret}`);
    const block = buildApprovalAskBlock("effect-1", SHELL, args, [secret]);
    expect(block.kind === "ask" && block.actions?.map((action) => action.label)).toEqual([
      "Allow once",
      "Deny",
    ]);
    const long = (await gate(`npm run ${"a".repeat(5000)}`)).args;
    expect(actions(long)).toEqual(["Allow once", "Deny"]);
  });

  it("keeps upstream's card for the Space's first approval and other tools", async () => {
    upstream.plan = "ask";
    const { args } = await gate("rm -rf build");
    expect(actions(args)).toEqual(["Allow in this space", "Deny"]);
    expect(
      buildApprovalAskBlock("effect-2", "send_email", { to: "a@example.com" }, []),
    ).toMatchObject({ kind: "ask" });
  });
});
