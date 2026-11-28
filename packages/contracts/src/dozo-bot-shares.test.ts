import { describe, expect, it } from "vitest";
import {
  DOZO_BOT_SHARE_LIMITS,
  DozoBotDefinitionSchema,
  dozoBotShareExcerpt,
  dozoBotSharePublic,
} from "./dozo-bot-shares.js";

const definition = {
  name: "Gardener",
  avatar: { color: "#22aa55", avatarSet: "organic" as const },
  instructions: "One\r\nTwo\nThree\nFour\nFive",
  description: "Knows plants",
  routines: [{ name: "Morning", prompt: "Look", crons: ["0 8 * * *"] }],
};

describe("a shared bot's definition", () => {
  it("refuses any field it does not list, so nothing else can be published", () => {
    expect(DozoBotDefinitionSchema.safeParse(definition).success).toBe(true);
    expect(DozoBotDefinitionSchema.safeParse({ ...definition, memory: "x" }).success).toBe(false);
    const skill = { ...definition, routines: [{ ...definition.routines[0], skills: [] }] };
    expect(DozoBotDefinitionSchema.safeParse(skill).success).toBe(false);
  });

  it("refuses a routine prompt over its limit", () => {
    const long = "x".repeat(DOZO_BOT_SHARE_LIMITS.routinePrompt + 1);
    const routines = [{ ...definition.routines[0], prompt: long }];
    expect(DozoBotDefinitionSchema.safeParse({ ...definition, routines }).success).toBe(false);
  });
});

describe("what a signed-out reader sees", () => {
  it("is the avatar, name, first four lines and routine names", () => {
    expect(dozoBotSharePublic(definition)).toEqual({
      name: "Gardener",
      avatar: definition.avatar,
      instructionsExcerpt: "One\nTwo\nThree\nFour",
      routineNames: ["Morning"],
    });
  });

  it("cuts long first lines short", () => {
    const excerpt = dozoBotShareExcerpt("a".repeat(1000));
    expect(excerpt).toHaveLength(401);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});
