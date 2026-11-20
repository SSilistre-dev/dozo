import { describe, expect, it } from "vitest";
import { DozoCommandRuleSchema, dozoCommandRulesContract } from "./dozo-command-rules.js";

describe("dozoCommandRulesContract", () => {
  it("lists rules with their words and folder, and removes one by id", () => {
    const rule = { id: "r", botId: "b", botName: "Chef", words: ["npm", "test"], cwd: "" };
    expect(DozoCommandRuleSchema.parse(rule)).toEqual(rule);
    expect(DozoCommandRuleSchema.safeParse({ ...rule, words: "npm test" }).success).toBe(false);
    expect(Object.keys(dozoCommandRulesContract)).toEqual(["list", "remove"]);
  });
});
