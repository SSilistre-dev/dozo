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
