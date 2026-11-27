import type { ColorTokens } from "@rakazo/ui-tokens";

/**
 * A mention in the composer. Links read in the ink, so colour no longer sets a mention apart from
 * the text around it: the underline does, and a selected mention turns bold on top of it.
 */
export function dozoMentionStyle(tokens: Pick<ColorTokens, "link">, selected: boolean) {
  return {
    color: tokens.link,
    textDecorationLine: "underline" as const,
    fontWeight: selected ? ("bold" as const) : undefined,
  };
}
