import type { ComputerMode } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { promptVersionParts } from "./prompt-version.js";
import { loadComputerInstructions } from "./run-assembly-capabilities.js";

type Hold = Parameters<typeof loadComputerInstructions>[0];
type Parts = Parameters<typeof loadComputerInstructions>[1];

// What a bot needs to answer "can other bots see my files?" or "who shares this computer?" truthfully.
const SHARED_USER = "Other bots here run as the same Linux user";
const READ_AND_CHANGE = "they can read and change your files and browser sign-ins, and you theirs";
const KEEP_NOTHING_PRIVATE = "store nothing here that must stay private from them";
const OWN_COMPUTER = "suggest turning on Own computer in your settings";

async function workspaceInstruction(computerMode: ComputerMode): Promise<string> {
  const hold = { deps: {}, takeover: { heldForTakeover: false } } as unknown as Hold;
  const parts = {
    records: { bot: { id: "bot-1" } },
    connected: { context: { signal: new AbortController().signal } },
    computer: {
      computerKind: "docker",
      computerMode,
      graphical: true,
      storedComputer: { id: "c1", homeKey: "bot-1", diskUsedBytes: null, diskFreeBytes: null },
    },
    capabilities: { disabledBuiltinTools: new Set<string>(), graphicalToolsAllowed: true },
    tools: { tools: [] },
  } as unknown as Parts;
  return (await loadComputerInstructions(hold, parts)).workspaceInstruction;
}

describe("what a bot is told about who shares its computer", () => {
  it("tells a Team Computer bot that the other bots can read and change its files and sign-ins", async () => {
    const team = await workspaceInstruction("team");
    for (const fact of [SHARED_USER, READ_AND_CHANGE, KEEP_NOTHING_PRIVATE, OWN_COMPUTER]) {
      expect(team).toContain(fact);
    }
  });

  it("says nothing about other bots on an Own computer, which no other bot uses", async () => {
    const own = await workspaceInstruction("dedicated");
    expect(own).not.toContain(SHARED_USER);
    expect(own).not.toContain("bots/");
    expect(own).toContain("your private home");
  });

  it("is part of the behavior fingerprint, so changing the words changes the prompt version", () => {
    expect(promptVersionParts().workspaces.some((text) => text.includes(SHARED_USER))).toBe(true);
  });
});
