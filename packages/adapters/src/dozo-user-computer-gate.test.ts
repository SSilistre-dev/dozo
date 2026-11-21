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

  it("lets read-only commands joined by pipes go ahead, and asks about anything else", async () => {
    expect((await gate('ls /Applications | grep -iE "chrome|safari"')).plan).toBe("allow");
    expect((await gate("cat notes.txt | grep todo | wc -l")).plan).toBe("allow");
    expect(rules.exists).not.toHaveBeenCalled();
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
    expect((await gate("grep -n TODO src/app.ts", { cwd: "~/app" })).plan).toBe("allow");
    expect(rules.exists).not.toHaveBeenCalled();
  });

  it("asks before a read-only command that touches a secret location", async () => {
    for (const command of [
      "cat .ssh/id_rsa",
      "cat .aws/credentials | grep -i key",
      "ls Library/Keychains",
      "cat /proc/self/environ",
      "cat Env:SECRET",
      "ls Env: | grep -i key",
      "find / -name .env | head",
      "grep -r key .",
      "tail -f log.txt",
    ])
      expect((await gate(command)).plan, command).toBe("ask");
    for (const command of [
      "uname -a",
      "ls",
      "pwd",
      "cat notes.txt",
      "ls Documents",
      "ls /Applications | grep -i brave",
    ])
      expect((await gate(command)).plan, command).toBe("allow");
  });

  it("asks before a read-only command run inside a secret folder", async () => {
    for (const [command, cwd] of [
      ["cat credentials", ".aws"],
      ["cat config", ".ssh"],
      ["cat known_hosts", "~/.ssh"],
      ["cat config", ".kube"],
      ["cat 'Local State'", "AppData/Local/Google/Chrome/User Data"],
      ["cat logins.json", "Library/Application Support/Firefox/Profiles/x"],
      ["ls", ".."],
      ["ls", "/etc"],
      ["ls", "C:\\Users"],
      ["ls", "AppData\\Local"],
      ["ls", "Env:"],
    ] as const)
      expect((await gate(command, { cwd })).plan, `${command} in ${cwd}`).toBe("ask");
    for (const cwd of ["Documents", "", "~", " ~ ", "~/app", "src/app"])
      expect((await gate("ls", { cwd })).plan, cwd).toBe("allow");
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
