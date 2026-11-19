import { describe, expect, it } from "vitest";
import { historyWithRecall } from "./dozo-recalled-memory.js";

describe("recalled memory in the run history", () => {
  it("goes after the conversation, so the conversation keeps its cached prefix", () => {
    const summary = [{ role: "user" as const, content: "summary" }];
    const conversation = [
      { role: "user" as const, content: "earlier question" },
      { role: "assistant" as const, content: "earlier answer" },
    ];
    const recalled = [{ role: "user" as const, content: "recalled" }];
    expect(historyWithRecall(summary, conversation, recalled).map((m) => m.content)).toEqual([
      "summary",
      "earlier question",
      "earlier answer",
      "recalled",
    ]);
  });
});
