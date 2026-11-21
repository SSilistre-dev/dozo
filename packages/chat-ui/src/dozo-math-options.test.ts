import katex from "katex";
import { describe, expect, it } from "vitest";
import { mathMarkup, mathOptions } from "./dozo-math-options";

// What the WebView is given is written by KaTeX from untrusted TeX, so these run the real KaTeX
// with the real options. The TeX source is kept in an <annotation>, escaped; everything else must
// carry no tag, attribute or address the TeX could have smuggled in.
const withoutSource = (markup: string) => markup.replace(/<annotation[\s\S]*?<\/annotation>/g, "");

const HOSTILE = [
  "\\text{</div><script>alert(1)</script>}",
  '\\text{"><img src=x onerror=1>}',
  "\\text{</annotation></semantics></math><script>alert(1)</script>}",
  "\\text{' onmouseover='alert(1)}",
  "\\href{javascript:alert(1)}{x}",
  "\\url{javascript:alert(1)}",
  "\\includegraphics{javascript:alert(1)}",
  "\\htmlData{onclick=alert(1)}{x}",
  '\\htmlId{a" onclick="b}{x}',
  "\\htmlStyle{background:url(javascript:alert(1))}{x}",
  "\\mathrm{<svg onload=alert(1)>}",
  "x_{<script>}",
];

describe("math options", () => {
  it("refuse untrusted commands and cap size and expansion", () => {
    expect(mathOptions(true)).toMatchObject({
      displayMode: true,
      trust: false,
      throwOnError: true,
      maxSize: 20,
      maxExpand: 100,
      macros: {},
    });
    expect(mathOptions(false).displayMode).toBe(false);
  });
});

describe("MathML for the mobile WebView", () => {
  it("has the formula's structure and keeps its TeX for readers", () => {
    const markup = mathMarkup(katex, "\\frac{a}{b}+x^2", false) ?? "";
    expect(markup).toContain("<mfrac");
    expect(markup).toContain('<annotation encoding="application/x-tex">');
    expect(markup).not.toContain("katex-html");
    expect(mathMarkup(katex, "x", true)).toContain('display="block"');
    expect(mathMarkup(katex, "x", false)).not.toContain('display="block"');
  });

  it.each(HOSTILE)("lets nothing through from %s", (tex) => {
    const markup = mathMarkup(katex, tex, false);
    // Either KaTeX refuses it (null, so the app keeps the code) or what it wrote is inert.
    const body = withoutSource(markup ?? "");
    expect(body).not.toMatch(/<script|<img|<svg|<iframe|<a[ >]|javascript:/i);
    // Inside a tag only: what the TeX says as text is escaped, so it has no tag of its own.
    expect(body).not.toMatch(/<[^>]*\son\w+\s*=/i);
    expect(body).not.toMatch(/<[^>]*\s(href|src|style|id|data-\w+)\s*=/i);
    expect(body.replace(/<[^>]*>/g, "")).not.toMatch(/[<>]/);
    if (markup) {
      // In the source annotation the TeX is text: no raw angle bracket or quote can end it.
      const source = /<annotation[^>]*>([\s\S]*?)<\/annotation>/.exec(markup)?.[1] ?? "";
      expect(source).not.toMatch(/[<>"]/);
    }
  });

  it("is null for broken TeX, an unknown command or runaway macros", () => {
    expect(mathMarkup(katex, "\\frac{1}{", false)).toBeNull();
    expect(mathMarkup(katex, "\\notacommand{x}", false)).toBeNull();
    expect(mathMarkup(katex, "}{", true)).toBeNull();
    expect(mathMarkup(katex, "\\def\\a{\\a\\a}\\a", false)).toBeNull();
    expect(
      mathMarkup(katex, "\\def\\a{\\b\\b}\\def\\b{\\c\\c}\\def\\c{\\a\\a}\\a", false),
    ).toBeNull();
    expect(mathMarkup(katex, `${"\\frac{".repeat(5000)}x${"}{1}".repeat(5000)}`, false)).toBeNull();
  });

  it("caps a huge box at the size limit", () => {
    const markup = mathMarkup(katex, "\\rule{1000em}{1000em}", false) ?? "";
    expect(markup).toContain('width="20em"');
    expect(markup).not.toContain('1000em"');
  });

  it("is null when the engine returns no MathML", () => {
    expect(mathMarkup({ renderToString: () => "<span>x</span>" }, "x", false)).toBeNull();
  });

  it("does not let one formula's macros reach the next", () => {
    expect(mathMarkup(katex, "\\gdef\\a{1}\\a", false)).toContain("<math");
    expect(mathMarkup(katex, "\\a", false)).toBeNull();
  });
});
