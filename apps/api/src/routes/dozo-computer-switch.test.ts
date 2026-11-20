import type { AdapterContext, AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import type { Bot } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const moved = vi.hoisted(() => ({ move: vi.fn() }));
vi.mock("@rakazo/adapters", () => ({ moveBotComputerFiles: moved.move }));

import { switchBotComputerWithFiles } from "./dozo-computer-switch.js";

const computers: Record<string, object> = {
  team: { id: "team", homeKey: "h-team", kind: "docker", providerRef: "c1", scope: "team" },
  own: { id: "own", homeKey: "h-own", kind: "docker", providerRef: null, scope: "dedicated" },
};
const deps = {
  prisma: {
    computer: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => computers[where.id],
      // The bot is on its own computer once switched.
      findFirstOrThrow: async () => computers.own,
    },
  } as unknown as PrismaClient,
  sandbox: {} as SandboxProvider,
  home: {} as AgentHomeStore,
};
const context = {} as AdapterContext;
const onOwn = { id: "bot", computer: { id: "own" } } as unknown as Bot;

beforeEach(() => {
  moved.move.mockReset();
});

describe("switching a bot's computer", () => {
  it("moves the files from the computer it leaves to the one it joins", async () => {
    const back = vi.fn();
    const bot = await switchBotComputerWithFiles(
      deps,
      { botId: "bot", fromComputerId: "team", context },
      async () => onOwn,
      back,
    );
    expect(bot).toBe(onOwn);
    expect(moved.move).toHaveBeenCalledWith(
      deps,
      { botId: "bot", from: computers.team, to: computers.own },
      context,
    );
    expect(back).not.toHaveBeenCalled();
  });

  it("is undone when the files cannot move, and says why", async () => {
    const refusal = new Error("Couldn't move this bot's files. Try again.");
    moved.move.mockImplementation(async () => {
      throw refusal;
    });
    const back = vi.fn();
    const failed = await switchBotComputerWithFiles(
      deps,
      { botId: "bot", fromComputerId: "team", context },
      async () => onOwn,
      back,
    ).catch((error: unknown) => error);
    expect(failed).toBe(refusal);
    expect(back).toHaveBeenCalledOnce();
  });
});
