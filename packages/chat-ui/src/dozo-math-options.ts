import type { KatexOptions } from "katex";

/** Longer source is shown as written: it is far past any formula a reply needs. */
export const MAX_MATH_SOURCE = 4000;

// Model output is untrusted. `trust: false` refuses \href, \url, \includegraphics and the \html*
// commands; the size and expansion caps stop a formula from drawing huge boxes or looping macros.
// Every render gets fresh macros, so \gdef in one formula cannot change another. Web and mobile
// draw with the same options.
export function mathOptions(displayMode: boolean): KatexOptions {
  return {
    displayMode,
    throwOnError: true,
    trust: false,
    strict: "ignore",
    maxSize: 20,
    maxExpand: 100,
    macros: {},
    output: "htmlAndMathml",
  };
}

/** Formulas drawn in one message on mobile: each is a WebView, so the rest stay as code. */
export const MAX_FORMULAS_PER_MESSAGE = 12;

type Katex = { renderToString(tex: string, options: KatexOptions): string };

/**
 * The formula as MathML, or null when KaTeX cannot read it. MathML needs no font files and no
 * script in the page: the WebView's own engine draws it. The TeX is untrusted, which is why the
 * options are the web's (`trust: false`, size and expansion caps) and why KaTeX, not the app,
 * writes the markup.
 */
export function mathMarkup(katex: Katex, tex: string, display: boolean): string | null {
  try {
    const markup = katex.renderToString(tex, { ...mathOptions(display), output: "mathml" });
    return markup.includes("<math") ? markup : null;
  } catch {
    return null;
  }
}
