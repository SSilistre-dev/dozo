import type { AdapterContext, AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import type { Actor, Bot } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  move: vi.fn(),
  recover: vi.fn(),
  ensure: vi.fn(),
  held: new Set<string>(),
  lost: false,
  logged: vi.fn(),
}));
vi.mock("@rakazo/adapters", () => {
  class BotFilesNotMovedError extends Error {}
  return {
    BotFilesNotMovedError,
    moveBotComputerFiles: fake.move,
    recoverBotComputerSwitch: fake.recover,
    switchLeaseKey: (botId: string) => `dozo-computer-switch:${botId}`,
    switchDueKey: (botId: string) => `dozo-computer-switch-due:${botId}`,
  };
});
vi.mock("@rakazo/db", () => {
  class LeaseHeldError extends Error {}
  return {
    LeaseHeldError,
    assertLeaseHeld: async () => {
      if (fake.lost) throw new Error("Lost the lease");
    },
    ensureComputerRecord: fake.ensure,
    teamComputerUserId: async () => "space-owner",
    runAsSystem: (_reason: string, work: () => Promise<unknown>) => work(),
    withLease: async (
      _prisma: unknown,
      key: string,
      _options: unknown,
      work: (lease: { signal: AbortSignal }) => Promise<unknown>,
    ) => {
      if (fake.held.has(key)) throw new LeaseHeldError(key);
      return work({ signal: new AbortController().signal });
    },
  };
});
vi.mock("@rakazo/logging", () => ({ getLogger: () => ({ error: fake.logged }) }));

import { BotFilesNotMovedError } from "@rakazo/adapters";
import {
  startComputerSwitchSweep,
  sweepComputerSwitches,
  switchBotComputerWithFiles,
} from "./dozo-computer-switch.js";

const team = { id: "team", homeKey: "h-team", kind: "docker", providerRef: "c1", scope: "team" };
const own = { id: "own", homeKey: "h-own", kind: "docker", providerRef: null, scope: "dedicated" };
let lapsed: Array<{ key: string }>;
let executed: string[];
let flippedTo: string | undefined;
const firstWord = (sql: TemplateStringsArray) => sql.join("?").trim().split(/\s+/)[0] as string;
const executeRaw = async (sql: TemplateStringsArray) => {
  executed.push(firstWord(sql));
  return 1;
};
const prisma = {
  computer: { findUniqueOrThrow: async () => team },
  $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) =>
    sql.join("?").includes("LIKE")
      ? lapsed
      : lapsed.filter((row) => row.key === values[0]).map(() => ({ found: 1 })),
  $executeRaw: executeRaw,
  $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
    work({
      $executeRaw: executeRaw,
      bot: {
        update: async ({ data }: { data: { computerId: string } }) => {
          flippedTo = data.computerId;
        },
      },
    }),
} as unknown as PrismaClient;
const deps = { prisma, sandbox: {} as SandboxProvider, home: {} as AgentHomeStore };
const actor = { userId: "member", spaceId: "space" } as Actor;
const context = { signal: new AbortController().signal } as AdapterContext;
const onOwn = { id: "bot", computer: { id: "own" } } as unknown as Bot;
const bot = { id: "bot", userId: "maker" };

const switchTo = (mode: "dedicated" | "team", fromComputerId: string) =>
  switchBotComputerWithFiles(
    deps,
    { actor, bot, fromComputerId, mode, context },
    async () => onOwn,
  );

beforeEach(() => {
  fake.move.mockReset();
  fake.recover.mockReset();
  fake.ensure.mockReset();
  fake.logged.mockReset();
  fake.held.clear();
  fake.lost = false;
  lapsed = [];
  executed = [];
  flippedTo = undefined;
});

describe("switching a bot's computer", () => {
  it("moves the files from the computer it leaves to the one the switch would make", async () => {
    fake.ensure.mockResolvedValue(own);
    fake.move.mockImplementation(
      async (
        _deps,
        input: {
          flip: () => Promise<void>;
          stillHeld: () => Promise<void>;
          cleared: () => Promise<void>;
        },
      ) => {
        await input.flip();
        await input.stillHeld();
        await input.cleared();
      },
    );
    await expect(switchTo("dedicated", "team")).resolves.toBe(onOwn);
    // The bot's computer changed with the cleanup marked due, then the cleanup cleared it.
    expect(flippedTo).toBe("own");
    expect(executed).toEqual(["INSERT", "DELETE"]);
    expect(fake.ensure).toHaveBeenCalledWith(prisma, {
      mode: "dedicated",
      spaceId: "space",
      userId: "maker",
      botId: "bot",
      kind: "docker",
    });
    expect(fake.move).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({ botId: "bot", from: team, to: own }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("joins the Space owner's Team Computer, whoever made the bot", async () => {
    fake.ensure.mockResolvedValue(team);
    await switchTo("team", "own");
    expect(fake.ensure).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ userId: "space-owner" }),
    );
  });

  it("never changes the bot's computer once its lease is lost", async () => {
    fake.ensure.mockResolvedValue(own);
    fake.lost = true;
    fake.move.mockImplementation(async (_deps, input: { flip: () => Promise<void> }) =>
      input.flip(),
    );
    await expect(switchTo("dedicated", "team")).rejects.toThrow("Lost the lease");
    expect(flippedTo).toBeUndefined();
    expect(executed).toEqual([]);
  });

  it("refuses while another switch of the bot holds its lease", async () => {
    fake.held.add("dozo-computer-switch:bot");
    await expect(switchTo("dedicated", "team")).rejects.toBeInstanceOf(BotFilesNotMovedError);
    expect(fake.move).not.toHaveBeenCalled();
  });

  it("passes any other refusal on as it is", async () => {
    fake.ensure.mockRejectedValue(new Error("Computer limit reached"));
    await expect(switchTo("dedicated", "team")).rejects.toThrow("Computer limit reached");
  });
});

describe("the switch sweep", () => {
  it("finishes each bot a dead switch or an uncleared Team Computer left, once", async () => {
    lapsed = [
      { key: "dozo-computer-switch:a" },
      { key: "dozo-computer-switch-due:a" },
      { key: "dozo-computer-switch-due:b" },
    ];
    fake.recover.mockImplementation(async (_deps, botId: string) => botId === "a");
    await sweepComputerSwitches(deps, new AbortController().signal);
    expect(fake.recover.mock.calls.map((call) => [call[1], call[4]])).toEqual([
      ["a", true],
      ["b", true],
    ]);
    // Done for a: its rows go. Not yet for b: a retry row brings the sweep back.
    expect(executed).toEqual(["DELETE", "INSERT"]);
  });

  it("clears the computer a bot left only where its switch had changed the bot's computer", async () => {
    lapsed = [{ key: "dozo-computer-switch:a" }];
    fake.recover.mockResolvedValue(true);
    await sweepComputerSwitches(deps, new AbortController().signal);
    expect(fake.recover.mock.calls[0]?.[4]).toBe(false);
  });

  it("leaves a bot whose switch is under way, and logs any other failure", async () => {
    lapsed = [{ key: "dozo-computer-switch:a" }, { key: "dozo-computer-switch:b" }];
    fake.held.add("dozo-computer-switch:a");
    fake.recover.mockRejectedValue(new Error("database gone"));
    await sweepComputerSwitches(deps, new AbortController().signal);
    expect(fake.recover).toHaveBeenCalledTimes(1);
    expect(fake.logged).toHaveBeenCalledTimes(1);
  });

  it("stops between bots once asked to", async () => {
    lapsed = [{ key: "dozo-computer-switch:a" }];
    const stopped = new AbortController();
    stopped.abort();
    await sweepComputerSwitches(deps, stopped.signal);
    expect(fake.recover).not.toHaveBeenCalled();
  });

  it("runs at start, and stopping waits for the pass; a failed pass is logged", async () => {
    lapsed = [{ key: "dozo-computer-switch:a" }];
    fake.recover.mockResolvedValue(true);
    const stop = startComputerSwitchSweep(deps, 60_000);
    await vi.waitFor(() => expect(fake.recover).toHaveBeenCalledOnce());
    await stop();
    const down = { ...deps, prisma: { $queryRaw: async () => Promise.reject(new Error("down")) } };
    await startComputerSwitchSweep(down as unknown as typeof deps, 60_000)();
    expect(fake.logged).toHaveBeenCalledOnce();
  });
});
