import { lightTokens } from "@rakazo/ui-tokens";
import { expect, it } from "vitest";
import { dozoMentionStyle } from "./dozo-mention-style";
import { tokensForAppearance } from "./dozo-theme";

it("underlines a mention in the link ink, and adds bold only while it is selected", () => {
  const tokens = tokensForAppearance("light");
  expect(tokens.link).toBe(lightTokens.foreground);
  expect(dozoMentionStyle(tokens, false)).toEqual({
    color: tokens.link,
    textDecorationLine: "underline",
    fontWeight: undefined,
  });
  expect(dozoMentionStyle(tokens, true).fontWeight).toBe("bold");
});
