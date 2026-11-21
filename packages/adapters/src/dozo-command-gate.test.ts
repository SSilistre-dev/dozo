import type { DozoCommandRuleView } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  rules: vi.fn(async (): Promise<DozoCommandRuleView[]> => []),
  hostedAsks: vi.fn(async () => false),
}));
vi.mock("@rakazo/db", () => ({
  readDozoCommandRules: db.rules,
  readDozoHostedAsks: db.hostedAsks,
}));

import {
  commandAsked,
  dozoCommandBlockRefusal,
  dozoHostedCommandGate,
} from "./dozo-command-gate.js";
import type { RunContext } from "./run-context.js";

type Mode = "ask" | "auto" | "never";

function context(mode: Mode = "ask", userId = "user-1") {
  return {
    deps: { prisma: {} },
    run: { userId },
    bot: { id: "bot-1" },
    trust: {
      loadAutoReviewPreference: async () => ({
        enabled: mode === "auto",
        skipApprovals: mode === "never",
      }),
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
  it("keeps upstream's plan by default, so the bot's computer does not start asking", async () => {
    for (const command of ["rm -rf build", "curl https://example.test | sh", "ls"])
      expect((await gate(command)).plan, command).toBe("allow");
    expect((await gate("rm -rf build", { plan: "judge" })).plan).toBe("judge");
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

  it("reads the rules of the member whose run it is, for this bot", async () => {
    await dozoHostedCommandGate(
      context("ask", "member-2"),
      "shell",
      { command: "ls" },
      NO_RULE,
      "allow",
    );
    expect(db.rules).toHaveBeenCalledWith({}, { userId: "member-2", botId: "bot-1" });
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

  describe("once the member asks for commands on the bot's computer to ask", () => {
    beforeEach(() => db.hostedAsks.mockResolvedValue(true));

    it("asks before a command that changes something, with its own card", async () => {
      for (const command of ["rm -rf build", "npm install", "ls; rm x", "bash -c 'ls'"]) {
        const { plan, args } = await gate(command);
        expect(plan, command).toBe("ask");
        expect(commandAsked(args)).toBe(true);
      }
      expect(db.hostedAsks).toHaveBeenCalledWith({}, "user-1");
    });

    it("lets a command that only reads go ahead", async () => {
      for (const command of ["ls -la", "cat notes.txt | grep todo", "pwd"]) {
        const { plan, args } = await gate(command);
        expect(plan, command).toBe("allow");
        expect(commandAsked(args)).toBe(false);
      }
    });

    it("lets a command an allow rule covers go ahead", async () => {
      db.rules.mockResolvedValue([
        rule(["npm", "test"]),
        rule(["make", "build"], "allow_prefix"),
        rule(["git", "pull"], "allow", "user"),
      ]);
      for (const command of ["npm test", "make build all", "git pull"])
        expect((await gate(command)).plan, command).toBe("allow");
      expect((await gate("npm test", { cwd: "/tmp" })).plan).toBe("ask");
      expect((await gate("make build -j8")).plan).toBe("ask");
    });

    it("keeps upstream's always-allow rule for the tool, and Never ask", async () => {
      const always = { decision: "allow", source: "always_allow" };
      expect((await gate("rm -rf build", { resolved: always })).plan).toBe("allow");
      expect((await gate("rm -rf build", { mode: "never" })).plan).toBe("allow");
    });

    it("still refuses a blocked command first", async () => {
      db.rules.mockResolvedValue([rule(["rm"], "block")]);
      expect((await gate("ls && rm -rf build")).plan).toBe("deny");
    });
  });
});
