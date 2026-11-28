import { describe, expect, it } from "vitest";
import {
  DOZO_BOT_SHARE_LIMITS,
  DozoBotDefinitionSchema,
  dozoBotShareExcerpt,
  dozoBotShareHiddenField,
  dozoBotSharePublic,
  dozoBotShareText,
} from "./dozo-bot-shares.js";

const definition = {
  name: "Gardener",
  avatar: { color: "#22aa55", avatarSet: "organic" as const },
  instructions: "One\nTwo\nThree\nFour\nFive",
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

describe("text a reader cannot see", () => {
  const classes = {
    "a zero-width space": "\u200b",
    "a zero-width joiner": "\u200d",
    "a byte order mark": "\ufeff",
    "a soft hyphen": "\u00ad",
    "a bidi embedding": "\u202a",
    "a bidi override": "\u202e",
    "a bidi isolate": "\u2066",
    "a tag character": "\u{E0041}",
    "the tag block's first code point": "\u{E0000}",
    "a control character": "\u0007",
    "a carriage return": "\r",
  };
  const fields: [string, (char: string) => typeof definition][] = [
    ["name", (char) => ({ ...definition, name: `Gar${char}dener` })],
    ["instructions", (char) => ({ ...definition, instructions: `One${char}` })],
    ["description", (char) => ({ ...definition, description: `Kno${char}ws` })],
    [
      "routine name",
      (char) => ({ ...definition, routines: [{ ...definition.routines[0]!, name: `M${char}` }] }),
    ],
    [
      "routine prompt",
      (char) => ({ ...definition, routines: [{ ...definition.routines[0]!, prompt: `L${char}` }] }),
    ],
    [
      "routine schedule",
      (char) => ({
        ...definition,
        routines: [{ ...definition.routines[0]!, crons: [`0 8 * * *${char}`] }],
      }),
    ],
  ];
  for (const [field, place] of fields) {
    it.each(Object.entries(classes))(`finds %s in the ${field}`, (_kind, char) => {
      expect(dozoBotShareHiddenField(place(char))).toBe(field);
      expect(DozoBotDefinitionSchema.safeParse(place(char)).success).toBe(false);
    });
  }

  it("lets newlines, tabs and visible text in every script through", () => {
    const visible = { ...definition, instructions: "a\n\tb שלום مرحبا 你好 é" };
    expect(dozoBotShareHiddenField(visible)).toBeNull();
    expect(DozoBotDefinitionSchema.safeParse(visible).success).toBe(true);
  });

  it("refuses text not in NFC, the one form that is shown and fingerprinted", () => {
    expect(dozoBotShareText("Cafe\u0301\r\nx\ry")).toBe("Caf\u00e9\nx\ny");
    expect(dozoBotShareHiddenField({ ...definition, name: "Cafe\u0301" })).toBe("name");
  });
});
