import type { DozoCommandRuleView } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => ({ plan: "allow" as "allow" | "ask" | "deny" }));
const rules = vi.hoisted(() => ({ read: vi.fn(async (): Promise<DozoCommandRuleView[]> => []) }));

vi.mock("./run-tools-user-computer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-tools-user-computer.js")>()),
  userComputerGate: vi.fn(async () => upstream.plan),
}));
vi.mock("@rakazo/db", () => ({ readDozoCommandRules: rules.read }));

import { dozoCommandBlockRefusal } from "./dozo-command-gate.js";
import { buildApprovalAskBlock, userComputerGate } from "./dozo-user-computer-gate.js";
import type { RunContext } from "./run-context.js";

const SHELL = "user_computer_shell";
const KEY = { userId: "user-1", botId: "bot-1" };

const rule = (
  words: string[],
  effect: DozoCommandRuleView["effect"] = "allow",
  more: Partial<DozoCommandRuleView> = {},
): DozoCommandRuleView => ({ words, cwd: "", effect, computer: "user", ...more });

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
  rules.read.mockReset().mockResolvedValue([]);
});

describe("userComputerGate", () => {
  it("keeps upstream's answer before the Space allows the computer, and for screen tools", async () => {
    upstream.plan = "deny";
    expect((await gate("ls")).plan).toBe("deny");
    upstream.plan = "allow";
    expect(await userComputerGate(context(), false, "user_computer_act", { app: "Notes" })).toBe(
      "allow",
    );
    expect(rules.read).not.toHaveBeenCalled();
    upstream.plan = "ask";
    expect((await gate("rm -rf build")).plan).toBe("ask");
    expect(rules.read).toHaveBeenCalledWith({}, KEY);
  });

  it("refuses a blocked command in every mode, also before the Space allows the computer", async () => {
    rules.read.mockResolvedValue([rule(["git", "push"], "block", { cwd: "~/app", computer: "hosted" })]);
    for (const [plan, ctx] of [
      ["allow", context()],
      ["allow", context(true, true)],
      ["allow", context(false, true)],
      ["ask", context()],
    ] as const) {
      upstream.plan = plan;
      const { plan: decided, args } = await gate("bash -c 'git push --force'", {}, ctx);
      expect(decided).toBe("deny");
      expect(dozoCommandBlockRefusal(args)).toContain("blocked");
    }
    // A block wins over an allow rule, and over a command that only reads.
    upstream.plan = "allow";
    rules.read.mockResolvedValue([rule(["cat", ".env"], "block"), rule(["cat", ".env"])]);
    expect((await gate("cat .env")).plan).toBe("deny");
  });

  it("lets read-only commands joined by pipes go ahead, and asks about anything else", async () => {
    expect((await gate('ls /Applications | grep -iE "chrome|safari"')).plan).toBe("allow");
    expect((await gate("cat notes.txt | grep todo | wc -l")).plan).toBe("allow");
    expect(rules.read).toHaveBeenCalledWith({}, KEY);
    for (const command of [
      "ls | sh",
      "ls | tee f",
      "uname -a 2>/dev/null || ver",
      "ls; ls | grep a",
      "ls |& cat",
    ])
      expect((await gate(command)).plan, command).toBe("ask");
  });

  it("offers Always allow for a single command only, never for a pipeline", async () => {
    const piped = (await gate("ls | sh")).args;
    expect(actions(piped)).toEqual(["Allow once", "Deny"]);
  });

  it("lets a command that only reads go ahead", async () => {
    expect((await gate("ls -la")).plan).toBe("allow");
    expect((await gate("grep -rn TODO src", { cwd: "~/app" })).plan).toBe("allow");
    expect(rules.read).toHaveBeenCalledTimes(2);
  });

  it("asks before a command that changes something or reaches out", async () => {
    for (const command of ["rm -rf build", "curl https://example.com", "npm publish"])
      expect((await gate(command)).plan, command).toBe("ask");
  });

  it("asks before a command it cannot read, whatever rule allows its words", async () => {
    rules.read.mockResolvedValue([rule(["ls"], "allow_prefix"), rule(["ls"]), rule(["cat", "notes"])]);
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
  });

  it("lets a command the member always allows for this bot and folder go ahead", async () => {
    rules.read.mockResolvedValue([rule(["npm", "test"])]);
    expect((await gate("npm test", { cwd: " ~ " })).plan).toBe("allow");
    expect(rules.read).toHaveBeenCalledWith({}, KEY);
    expect((await gate("npm test", { cwd: "~/app" })).plan).toBe("ask");
    expect((await gate("npm test --watch")).plan).toBe("ask");
  });

  it("lets a prefix rule allow the same words with more words that are not options", async () => {
    rules.read.mockResolvedValue([rule(["npm", "run"], "allow_prefix", { cwd: "~/app" })]);
    expect((await gate("npm run build", { cwd: "~/app" })).plan).toBe("allow");
    for (const command of ["npm run build --if-present", "npm run build && rm x", "sudo npm run x"])
      expect((await gate(command, { cwd: "~/app" })).plan, command).toBe("ask");
  });

  it("never lets a rule saved on the bot's computer allow a command on the member's own", async () => {
    rules.read.mockResolvedValue([rule(["rm", "-rf", "build"], "allow", { computer: "hosted" })]);
    expect((await gate("rm -rf build")).plan).toBe("ask");
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

  it("asks about every command on the bot's computer with the command card", () => {
    const args = { command: "npm test", cwd: "/work" };
    const block = buildApprovalAskBlock("effect-3", "shell", args, []);
    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect-3",
      text: "Run on the bot's computer?",
      detail: "cd /work\nnpm test",
      detailFormat: "code",
    });
    expect(block.kind === "ask" && block.actions?.map((action) => action.label)).toEqual([
      "Allow once",
      "Always allow this command",
      "Deny",
    ]);
    const chained = buildApprovalAskBlock("effect-4", "shell", { command: "ls; rm x" }, []);
    expect(chained.kind === "ask" && chained.actions?.map((action) => action.label)).toEqual([
      "Allow once",
      "Deny",
    ]);
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
