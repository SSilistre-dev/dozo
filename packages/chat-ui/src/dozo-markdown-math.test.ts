import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { mathSource, remarkChatMath } from "./dozo-markdown-math";

type Node = {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
  data?: { hProperties?: { className?: string[] }; hChildren?: { value: string }[] };
};

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkChatMath);

function tree(markdown: string): Node {
  const source = mathSource(markdown);
  return processor.runSync(processor.parse(source), source) as Node;
}

function all(node: Node, found: Node[] = []): Node[] {
  found.push(node);
  for (const child of node.children ?? []) all(child, found);
  return found;
}

/** Each formula as [display, TeX], in order. */
function formulas(markdown: string): [boolean, string][] {
  return all(tree(markdown))
    .filter((node) => node.data?.hChildren)
    .map((node) => [
      node.data?.hProperties?.className?.includes("rk-math-display") ?? false,
      node.data?.hChildren?.[0]?.value ?? "",
    ]);
}

function text(markdown: string): string {
  return all(tree(markdown))
    .filter((node) => node.type === "text")
    .map((node) => node.value)
    .join("");
}

describe("chat math parsing", () => {
  it("reads inline and display math", () => {
    expect(formulas("Area is $\\pi r^2$ here.")).toEqual([[false, "\\pi r^2"]]);
    expect(formulas("$$\n\\int_0^1 x\\,dx\n$$")).toEqual([[true, "\\int_0^1 x\\,dx"]]);
    expect(formulas("$$E = mc^2$$")).toEqual([[true, "E = mc^2"]]);
    expect(formulas("so $$a+b$$ inline")).toEqual([[false, "a+b"]]);
    expect(formulas("> $$\n> x^2\n> $$")).toEqual([[true, "x^2"]]);
  });

  it("leaves prices as text", () => {
    for (const price of [
      "It costs $5 and $10.",
      "between $5-$10 a month",
      "$10,000 to $20,000",
      "$5/month, $50/year",
      "US$5 vs $6",
      "pay $ 5 now",
      "costs $5\n\nand later $6",
    ]) {
      expect(formulas(price), price).toEqual([]);
      expect(text(price), price).toBe(price.replace("\n\n", ""));
    }
  });

  it("keeps math next to a price", () => {
    expect(formulas("Price $5 per $x$ unit")).toEqual([[false, "x"]]);
    expect(text("Price $5 per $x$ unit")).toBe("Price $5 per  unit");
  });

  it("does not let a price swallow emphasis", () => {
    const parsed = all(tree("costs $5, while **premium** costs $10"));
    expect(parsed.some((node) => node.type === "strong")).toBe(true);
    expect(formulas("costs $5, while **premium** costs $10")).toEqual([]);
  });

  it("never reads math in code, links or escaped dollars", () => {
    expect(formulas("`$x$` and\n\n```\n$y$\n```")).toEqual([]);
    expect(formulas("\\$x$ costs")).toEqual([]);
    const link = all(tree("[pay](https://example.com/$a$b) $5")).find(
      (node) => node.type === "link",
    );
    expect(link?.url).toBe("https://example.com/$a$b");
  });

  it("shows unclosed math as text", () => {
    expect(formulas("so $x^2 + ")).toEqual([]);
    expect(text("so $x^2 + ")).toBe("so $x^2 +");
    expect(formulas("$$\n\\frac{a}{")).toEqual([]);
    expect(formulas("$$a and more")).toEqual([]);
    expect(formulas("trailing $")).toEqual([]);
  });

  it("keeps the source length, so parser offsets still point into it", () => {
    const source = "It costs $5 and $x$ is `$` here $$\n$$y$$\n";
    expect(mathSource(source)).toHaveLength(source.length);
    expect(mathSource("no dollars")).toBe("no dollars");
  });

  it("reads no math in text that already holds the stand-in", () => {
    const markdown = "odd  char and $x$";
    expect(formulas(markdown)).toEqual([]);
    expect(text(markdown)).toBe("odd $ char and $x$");
  });
});
