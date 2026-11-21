import { describe, expect, it } from "vitest";
import {
  COMPUTER_NO_SCREEN_REPLY,
  COMPUTER_NO_SCREEN_RESULT,
  screenFailureMessage,
} from "./dozo-device-screen.js";
import { COMPUTER_WITHOUT_SCREEN_INSTRUCTION } from "./dozo-device-screen.prompt.js";
import { userTurnInstructions } from "./run-instructions.prompt.js";

function instructions(userComputer?: "connected" | "offline") {
  return userTurnInstructions({
    botInstructions: "",
    groupContext: undefined,
    messagingContext: undefined,
    redactedMemoryContext: undefined,
    redactedScratchpadContext: undefined,
    hasHistoricalContext: false,
    computerInstruction: "",
    pageBrowserAllowed: false,
    workspaceInstruction: "",
    agentEnvironmentInstruction: undefined,
    botDirectory: undefined,
    pluginLine: undefined,
    agentSkillsLine: undefined,
    taughtSkillsLine: undefined,
    replyGuidance: "",
    userComputer,
  });
}

describe("the connected computer's prompt line", () => {
  it("is added when the computer is connected", () => {
    expect(instructions("connected")).toContain(COMPUTER_WITHOUT_SCREEN_INSTRUCTION);
  });

  it.each([["offline" as const], [undefined]])("is left out when the computer is %s", (state) => {
    expect(instructions(state)).not.toContain(COMPUTER_WITHOUT_SCREEN_INSTRUCTION);
  });
});

describe("a refused screen request", () => {
  it("tells the bot the computer has no screen control, in place of the device's bare refusal", () => {
    expect(screenFailureMessage(COMPUTER_NO_SCREEN_REPLY)).toBe(COMPUTER_NO_SCREEN_RESULT);
  });

  it("leaves any other failure as it was", () => {
    expect(screenFailureMessage("Device disconnected")).toBe(
      "The user's computer did not finish: Device disconnected",
    );
  });
});
