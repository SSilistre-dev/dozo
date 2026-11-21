import { createMarkdownIt } from "@ronradtke/react-native-markdown-display";
import { describe, expect, it, vi } from "vitest";
import { mathAsCode } from "./dozo-markdown-math.native";

vi.mock("react-native", () => ({
  Platform: { OS: "ios", select: (choices: Record<string, unknown>) => choices.ios },
  StyleSheet: { create: (styles: unknown) => styles, flatten: (style: unknown) => style },
  Dimensions: { get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }) },
  PixelRatio: { get: () => 3, roundToNearestPixel: (value: number) => value },
}));

type Token = { type: string; content: string; info?: string; markup?: string; children?: Token[] };

function parse(source: string): Token[] {
  const parser = mathAsCode(createMarkdownIt());
  const tokens: Token[] = parser.parse(source, {});
  return tokens.flatMap((token) => [token, ...(token.children ?? [])]);
}

const code = (source: string) =>
  parse(source)
    .filter((token) => token.type === "dozo_math_inline" || token.type === "dozo_math_block")
    .map((token) => [token.type, token.content]);

const text = (source: string) =>
  parse(source)
    .filter((token) => token.type === "text")
    .map((token) => token.content)
    .join("");

describe("math on mobile reads as math tokens", () => {
  it("reads inline math as an inline math token, TeX kept as written", () => {
    expect(code("Area is $\\pi r^2$ here")).toEqual([["dozo_math_inline", "\\pi r^2"]]);
    expect(text("Area is $\\pi r^2$ here")).toBe("Area is  here");
  });

  it("does not let Markdown change the TeX inside", () => {
    expect(code("so $a_b + c_d$ and $x*y*z$ and $\\{ \\}$")).toEqual([
      ["dozo_math_inline", "a_b + c_d"],
      ["dozo_math_inline", "x*y*z"],
      ["dozo_math_inline", "\\{ \\}"],
    ]);
  });

  it("reads $$ on one line as inline math with no delimiters left", () => {
    expect(code("$$\\frac{1}{3}$$")).toEqual([["dozo_math_inline", "\\frac{1}{3}"]]);
    expect(text("$$\\frac{1}{3}$$")).toBe("");
  });

  it("reads a $$ block as a block math token", () => {
    const tokens = parse("Before\n\n$$\n\\int_0^1 x\\,dx\n= \\tfrac12\n$$\n\nAfter");
    expect(tokens.filter((token) => token.type === "dozo_math_block")).toMatchObject([
      { content: "\\int_0^1 x\\,dx\n= \\tfrac12\n", markup: "$$" },
    ]);
    expect(text("Before\n\n$$\n\\int\n$$\n\nAfter")).toBe("BeforeAfter");
  });

  it("takes text after an opening $$ as the block's first line", () => {
    expect(code("$$ a = b\n+ c\n$$")).toEqual([["dozo_math_block", "a = b\n+ c\n"]]);
  });

  it("leaves a block that never closes as written", () => {
    expect(code("$$\nx = 1\n")).toEqual([]);
    expect(text("$$\nx = 1\n")).toBe("$$x = 1");
  });

  it("leaves prices and lone dollars as text", () => {
    expect(code("It costs $5 and $10 total")).toEqual([]);
    expect(text("It costs $5 and $10 total")).toBe("It costs $5 and $10 total");
    expect(code("a $ b $ c")).toEqual([]);
    expect(code("pay $x$5 now")).toEqual([]);
    expect(code("$$")).toEqual([]);
    expect(code("$$ $$")).toEqual([]);
    expect(code("$$$$")).toEqual([]);
  });

  it("keeps an escaped dollar literal, and one inside math", () => {
    expect(code("cost \\$5 and \\$x\\$")).toEqual([]);
    expect(code("$a \\$ b$")).toEqual([["dozo_math_inline", "a \\$ b"]]);
    expect(code("$a \\")).toEqual([]);
  });

  it("leaves dollars in code spans and fences alone", () => {
    expect(code("`$x$`")).toEqual([]);
    expect(code("```\n$$\nx\n$$\n```")).toEqual([]);
    const codeTokens = parse("`$x$`\n\n```\n$$\nx\n$$\n```").map((token) => [
      token.type,
      token.content,
    ]);
    expect(codeTokens).toContainEqual(["code_inline", "$x$"]);
    expect(codeTokens).toContainEqual(["fence", "$$\nx\n$$\n"]);
  });

  it("skips a longer run of dollars inside single-dollar math", () => {
    expect(code("$a $$ b$")).toEqual([["dozo_math_inline", "a $$ b"]]);
  });

  it("keeps math on one line inline, even when written across lines", () => {
    expect(code("$a\nb$")).toEqual([["dozo_math_inline", "a b"]]);
  });

  it("does not read math across paragraphs", () => {
    expect(code("$a\n\nb$")).toEqual([]);
  });

  it("does not run markup or HTML inside math", () => {
    expect(code("$<b>x</b>$")).toEqual([["dozo_math_inline", "<b>x</b>"]]);
    expect(code("$$\n<script>alert(1)</script>\n$$")).toEqual([
      ["dozo_math_block", "<script>alert(1)</script>\n"],
    ]);
  });

  it("works inside lists and quotes", () => {
    expect(code("- item $x^2$")).toEqual([["dozo_math_inline", "x^2"]]);
    expect(code("> $$\n> y\n> $$")).toEqual([["dozo_math_block", "y\n"]]);
  });

  it("does not take the $$ lines of an indented code block", () => {
    expect(code("    $$\n    x\n    $$")).toEqual([]);
  });

  it("closes a block with a longer run of dollars, not a shorter one", () => {
    expect(code("$$$\nx\n$$\n$$$")).toEqual([["dozo_math_block", "x\n$$\n"]]);
  });
});
