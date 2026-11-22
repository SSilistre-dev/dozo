import { describe, expect, it } from "vitest";
import { appContract } from "./rpc.js";

// The iOS and Android apps in people's hands lag the server by days or weeks, and the server checks
// every call against this contract. These are the calls the mobile app as built for the first
// store release (main at 2026-11-21) makes on a bot's profile and its Edit screen, in the shape
// it sends them. A contract change that refuses one breaks that screen for everyone who has not
// updated: keep accepting it, or change this file on purpose.

const botId = "cmwrpv4anh90bt2x69rx2yxy5";
const spaceId = "d18abb655539639284ffca519ab840cd";
const versionId = "32a7158d-5344-4d65-9352-61f659cfc2a0";

type Path = string;
const SENT: [Path, unknown][] = [
  // The profile.
  ["bots/get", { botId }],
  ["computer/status", { botId }],
  ["bots/update", { botId, notifyOnFinish: false }],
  // Edit: what it reads when it opens.
  ["me", undefined],
  ["models/list", undefined],
  ["models/credentials", undefined],
  ["billing/status", undefined],
  ["dozoAvatarGenerate/status", undefined],
  ["spaces/members/list", { spaceId }],
  // Edit: each switch saves at once.
  ["bots/update", { botId, name: "Pixel" }],
  ["bots/update", { botId, dailyCheckIns: false }],
  ["bots/update", { botId, crossSpaceCommunication: false }],
  ["bots/update", { botId, fleetManagement: true }],
  // Edit: Save, with every field it can send.
  [
    "bots/update",
    {
      botId,
      description: "",
      instructions: "Be brief.",
      expectedInstructions: "",
      color: "#3b82f6",
      avatarSet: "organic",
      modelProvider: null,
      modelId: null,
      thinkingLevel: null,
      autoSpeak: true,
    },
  ],
  ["bots/setComputer", { botId, mode: "dedicated" }],
  // Edit: the rarer actions.
  ["bots/restoreInstructions", { botId, versionId, expectedInstructions: "Be brief." }],
  ["export/bot", { botId }],
  ["threads/clear", { botId }],
  ["computer/reset", { botId }],
  ["dozoAvatarGenerate/generate", { prompt: "a small red fox" }],
];

type Procedure = { "~orpc": { inputSchema?: { safeParse(input: unknown): { success: boolean } } } };

function procedure(path: Path): Procedure {
  const found = path
    .split("/")
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown> | undefined)?.[key],
      appContract,
    );
  if (!found || typeof found !== "object" || !("~orpc" in found))
    throw new Error(`${path} is no longer a procedure`);
  return found as Procedure;
}

describe("calls the previous mobile app makes on a bot's screens", () => {
  it.each(SENT)("%s accepts %j", (path, input) => {
    const schema = procedure(path)["~orpc"].inputSchema;
    expect(schema ? schema.safeParse(input).success : input === undefined).toBe(true);
  });
});
