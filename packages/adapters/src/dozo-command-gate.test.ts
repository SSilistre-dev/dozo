import type { DozoCommandRuleView } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  rules: vi.fn(async (): Promise<DozoCommandRuleView[]> => []),
  hostedAsks: vi.fn(async () => false),
  writer: vi.fn(async (): Promise<{ writer: string; writtenAt: Date } | undefined> => undefined),
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  readDozoCommandRules: db.rules,
  readDozoHostedAsks: db.hostedAsks,
  readRoutineWriter: db.writer,
}));

import { routineWriterIsOwner, runStartedFromOutside } from "@rakazo/core";
import {
  dozoBlockedRefusal,
  dozoCommandBlockRefusal,
  dozoHostedCommandGate,
  dozoHostedCommandHold,
  dozoRunStartedFromOutside,
} from "./dozo-command-gate.js";
import type { RunContext } from "./runs/assembly/run-context.js";

type Mode = "ask" | "auto" | "never";

function context(mode: Mode = "ask", userId = "user-1", tainted = false, trigger = "user") {
  return {
    deps: { prisma: { attempt: { count: async () => 1 }, $queryRaw: async () => [] } },
    run: { userId, trigger, routineId: null },
    source: { messagingChannelRun: false },
    runId: "run-1",
    bot: { id: "bot-1" },
    state: { tainted, earlierAttempt: undefined },
    trust: {
      loadAutoReviewPreference: async () => ({
        enabled: mode === "auto",
        skipApprovals: mode === "never",
      }),
      receivedOutsideMessage: async () => false,
    },
  } as unknown as RunContext;
}

const rule = (
  words: string[],
  effect: DozoCommandRuleView["effect"] = "allow",
  computer: DozoCommandRuleView["computer"] = "hosted",
): DozoCommandRuleView => ({ words, cwd: "", effect, computer });

const NO_RULE = { decision: "allow" };

async function gate(
  command: string,
  options: {
    plan?: "allow" | "ask" | "judge" | "deny";
    mode?: Mode;
    resolved?: { decision: string; source?: string };
    name?: string;
    cwd?: string;
  } = {},
) {
  const args: Record<string, unknown> = { command, ...(options.cwd ? { cwd: options.cwd } : {}) };
  const plan = await dozoHostedCommandGate(
    context(options.mode),
    options.name ?? "shell",
    args,
    options.resolved ?? NO_RULE,
    options.plan ?? "allow",
  );
  return { plan, args };
}

beforeEach(() => {
  db.rules.mockReset().mockResolvedValue([]);
  db.hostedAsks.mockReset().mockResolvedValue(false);
});

describe("dozoHostedCommandGate", () => {
  it("keeps the plan it was given for a command no rule names", async () => {
    for (const command of ["rm -rf build", "curl https://example.test | sh", "ls"])
      expect((await gate(command)).plan, command).toBe("allow");
    expect((await gate("rm -rf build", { plan: "judge" })).plan).toBe("judge");
    expect((await gate("rm -rf build", { plan: "ask" })).plan).toBe("ask");
  });

  it("leaves other tools and refusals alone", async () => {
    db.rules.mockResolvedValue([rule(["rm"], "block")]);
    expect((await gate("rm x", { name: "user_computer_shell" })).plan).toBe("allow");
    expect((await gate("rm x", { name: "browser_act" })).plan).toBe("allow");
    expect((await gate("rm x", { plan: "deny" })).plan).toBe("deny");
    expect(db.rules).not.toHaveBeenCalled();
  });

  it.each<[Mode, "allow" | "ask" | "judge"]>([
    ["ask", "allow"],
    ["auto", "judge"],
    ["never", "allow"],
    ["ask", "ask"],
  ])("refuses a blocked command in %s mode, whatever upstream planned (%s)", async (mode, plan) => {
    db.rules.mockResolvedValue([rule(["git", "push"], "block", "user"), rule(["git", "push"])]);
    const { plan: decided, args } = await gate("sudo git push --force", { mode, plan });
    expect(decided).toBe("deny");
    expect(dozoCommandBlockRefusal(args)).toContain("blocked for this bot");
  });

  it("answers a blocked call after recording it, and any other call or plan with nothing", async () => {
    db.rules.mockResolvedValue([rule(["git", "push"], "block", "user")]);
    const { args } = await gate("git push", { mode: "ask", plan: "allow" });
    const audit = vi.fn(async () => undefined);
    expect(await dozoBlockedRefusal("deny", args, audit)).toEqual({
      result: { error: expect.stringContaining("blocked for this bot") },
    });
    expect(audit).toHaveBeenCalledTimes(1);
    // A plan that is not a refusal, or a call no block rule refused, is left alone.
    expect(await dozoBlockedRefusal("allow", args, audit)).toBeUndefined();
    expect(await dozoBlockedRefusal("deny", { command: "ls" }, audit)).toBeUndefined();
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("refuses a routine whose command watch runs a blocked command", async () => {
    db.rules.mockResolvedValue([rule(["git", "push"], "block", "user")]);
    const watch = (command: string) => ({ watch: { kind: "command", command, everyMinutes: 60 } });
    const blocked = watch("cd app && git push");
    const run = (args: Record<string, unknown>, mode: Mode = "never") =>
      dozoHostedCommandGate(context(mode), "schedule_create", args, NO_RULE, "allow");
    expect(await run(blocked)).toBe("deny");
    expect(dozoCommandBlockRefusal(blocked)).toContain("blocked");
    expect(await run(watch("git status"), "ask")).toBe("allow");
    expect(await run({ prompt: "Check the build" })).toBe("allow");
  });

  it("reads the rules of the member whose run it is, for this bot", async () => {
    await dozoHostedCommandGate(
      context("ask", "member-2"),
      "shell",
      { command: "ls" },
      NO_RULE,
      "allow",
    );
    expect(db.rules).toHaveBeenCalledWith(expect.anything(), {
      userId: "member-2",
      botId: "bot-1",
    });
    expect(dozoCommandBlockRefusal({ command: "ls" })).toBeUndefined();
  });

  it("lets an exact rule pass what upstream asks about because outside text started the run", async () => {
    db.rules.mockResolvedValue([rule(["npm", "test"])]);
    expect((await gate("npm test", { plan: "ask" })).plan).toBe("allow");
    expect((await gate("npm test", { plan: "judge" })).plan).toBe("allow");
    // A rule asking for the whole tool still asks, and so does anything the rule does not cover.
    expect((await gate("npm test", { plan: "ask", resolved: { decision: "ask" } })).plan).toBe(
      "ask",
    );
    expect((await gate("npm test; curl x", { plan: "ask" })).plan).toBe("ask");
  });

  it("never lets a prefix rule pass what outside text may have asked for", async () => {
    db.rules.mockResolvedValue([rule(["npm", "run"], "allow_prefix")]);
    expect((await gate("npm run build", { plan: "ask" })).plan).toBe("ask");
    expect((await gate("npm run build", { plan: "judge" })).plan).toBe("judge");
  });
});

describe("dozoHostedCommandHold", () => {
  const hold = (
    command: string,
    options: { tainted?: boolean; cwd?: string; name?: string; trigger?: string } = {},
  ) =>
    dozoHostedCommandHold(
      context("auto", "user-1", options.tainted, options.trigger),
      options.name ?? "shell",
      { command, ...(options.cwd ? { cwd: options.cwd } : {}) },
    );

  it("holds nothing that only reads, and no other tool", async () => {
    for (const command of ["ls -la", "cat notes.txt | grep todo", "pwd"]) {
      expect(await hold(command), command).toBeUndefined();
      expect(await hold(command, { tainted: true }), command).toBeUndefined();
    }
    expect(await hold("rm -rf build", { name: "user_computer_shell" })).toBeUndefined();
    expect(db.rules).not.toHaveBeenCalled();
  });

  it("sends a command that does more than read to review, and to a person once outside text started the run", async () => {
    for (const command of ["rm -rf build", "npm install", "ls; rm x", "bash -c 'ls'"]) {
      expect(await hold(command), command).toBe("review");
      expect(await hold(command, { tainted: true }), command).toBe("review");
      expect(await hold(command, { tainted: true, trigger: "webhook" }), command).toBe("person");
    }
    expect(await hold("ls", { cwd: "~/.ssh" })).toBe("review");
  });

  it("holds nothing a block rule refuses or an exact rule allows, and a prefix rule only in a clean run", async () => {
    db.rules.mockResolvedValue([
      rule(["rm"], "block"),
      rule(["npm", "test"]),
      rule(["grep", "-r"], "allow_prefix"),
    ]);
    expect(await hold("rm -rf build", { tainted: true })).toBeUndefined();
    expect(await hold("npm test", { tainted: true })).toBeUndefined();
    expect(await hold("grep -r todo src")).toBeUndefined();
    expect(await hold("grep -r todo src", { tainted: true })).toBe("review");
    expect(await hold("npm test", { cwd: "/tmp" })).toBe("review");
  });

  it("sends it to a person once the member asked for commands on the bot's computer to ask", async () => {
    db.hostedAsks.mockResolvedValue(true);
    expect(await hold("npm install")).toBe("person");
    expect(await hold("ls")).toBeUndefined();
    expect(db.hostedAsks).toHaveBeenCalledWith(expect.anything(), "user-1");
  });

  it("still refuses a blocked command first", async () => {
    db.rules.mockResolvedValue([rule(["rm"], "block")]);
    const ctx = context("auto");
    const args = { command: "ls && rm -rf build" };
    expect(await dozoHostedCommandHold(ctx, "shell", args)).toBeUndefined();
    expect(await dozoHostedCommandGate(ctx, "shell", args, NO_RULE, "allow")).toBe("deny");
  });

  it("reads the rules once for the hold and the gate", async () => {
    const ctx = context("auto");
    const args = { command: "npm install" };
    await dozoHostedCommandHold(ctx, "shell", args);
    await dozoHostedCommandGate(ctx, "shell", args, NO_RULE, "judge");
    expect(db.rules).toHaveBeenCalledTimes(1);
  });
});

describe("dozoRunStartedFromOutside for a routine", () => {
  const routineRun = () =>
    ({
      ...context("auto", "user-1", true, "routine"),
      run: { userId: "user-1", trigger: "routine", routineId: "routine-1" },
      task: { prompt: "Check the build" },
    }) as unknown as RunContext;

  it.each([
    ["owner", false],
    ["owner_run", false],
    ["member", true],
    ["outside_run", true],
  ])("agrees with the lasting-write rule once %s is on record", async (writer, outside) => {
    db.writer.mockResolvedValue({ writer, writtenAt: new Date(0) });
    const canonical = await runStartedFromOutside(
      {
        trigger: "routine",
        ownerStartedRun: false,
        nonOwnerChatRun: false,
        watchFired: false,
        botOwnerRun: true,
        readHistory: false,
      },
      async () => routineWriterIsOwner(writer),
    );
    expect(canonical).toBe(outside);
    expect(await dozoRunStartedFromOutside(routineRun())).toBe(outside);
  });

  it("takes a routine with no writer on record as its owner's, where the lasting-write rule does not", async () => {
    db.writer.mockResolvedValue(undefined);
    expect(await dozoRunStartedFromOutside(routineRun())).toBe(false);
  });
});
