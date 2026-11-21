import { describe, expect, it } from "vitest";
import { DozoCommandRuleSchema, dozoCommandRulesContract } from "./dozo-command-rules.js";

describe("dozoCommandRulesContract", () => {
  it("lists rules with their words, folder, effect and computer", () => {
    const rule = {
      id: "r",
      botId: "b",
      botName: "Chef",
      words: ["npm", "test"],
      cwd: "",
      effect: "allow_prefix",
      computer: "hosted",
    };
    expect(DozoCommandRuleSchema.parse(rule)).toEqual(rule);
    expect(DozoCommandRuleSchema.safeParse({ ...rule, words: "npm test" }).success).toBe(false);
    expect(DozoCommandRuleSchema.safeParse({ ...rule, effect: "always" }).success).toBe(false);
    expect(DozoCommandRuleSchema.safeParse({ ...rule, computer: "cloud" }).success).toBe(false);
    expect(Object.keys(dozoCommandRulesContract)).toEqual([
      "list",
      "update",
      "remove",
      "getHostedAsks",
      "setHostedAsks",
    ]);
  });
});
