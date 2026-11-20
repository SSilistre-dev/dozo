import { describe, expect, it } from "vitest";
import { dozoActivityPrompt } from "./dozo-activity-preview.js";
import { botIntroPrompt, HANG_UP_PROMPT, mcpConnectedPrompt } from "./hidden-turns.prompt.js";
import { activityPreview } from "./runs.js";

const intro = botIntroPrompt({ userName: "Ada", spaceName: null, disabledBuiltinTools: [] });

const shown = (trigger: string, prompt: string, sourceMessageId: string | null) =>
  activityPreview({ trigger, prompt: dozoActivityPrompt({ trigger, prompt, sourceMessageId }) })
    .promptSnippet;

describe("the activity list's prompt", () => {
  it("leaves out the prompts the server writes to wake the bot", () => {
    expect(shown("created", intro, null)).toBe("");
    expect(shown("call_end", HANG_UP_PROMPT, null)).toBe("");
    expect(shown("user", mcpConnectedPrompt("Files"), null)).toBe("");
  });

  it("keeps what a person asked for", () => {
    expect(shown("user", "Plan the week", "message-1")).toBe("Plan the week");
    expect(shown("routine", "Summarize the news", null)).toBe("Summarize the news");
  });
});
