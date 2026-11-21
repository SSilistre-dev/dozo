import { mathOptions } from "@rakazo/chat-ui/native";

/** How long a formula may take to report its size before it stays as code. */
export const MATH_TIMEOUT_MS = 5_000;

/** A formula inside a line of text is at most this wide; a longer one scrolls sideways inside it. */
export const MAX_INLINE_MATH_WIDTH = 320;

export const MAX_MATH_HEIGHT = 2_000;

export type MathMessage = { type: "drawn"; width: number; height: number } | { type: "failed" };

type Katex = { renderToString(tex: string, options: ReturnType<typeof mathOptions>): string };

/**
 * The formula as MathML, or null when KaTeX cannot read it. MathML needs no font files and no
 * script in the page: the WebView's own engine draws it, so nothing is fetched and the only code
 * that runs in the page is `mathBootScript`. The TeX is untrusted, which is why the options are the
 * web's (`trust: false`, size and expansion caps) and why KaTeX, not this file, writes the markup.
 */
export function mathMarkup(katex: Katex, tex: string, display: boolean): string | null {
  try {
    const markup = katex.renderToString(tex, { ...mathOptions(display), output: "mathml" });
    return markup.includes("<math") ? markup : null;
  } catch {
    return null;
  }
}

// A color the page puts into its style: only what the app's tokens look like.
const CSS_COLOR = /^(#[0-9a-f]{3,8}|[a-z]+|(rgb|hsl)a?\([0-9a-z%.,\s/]+\))$/i;

/**
 * The page a formula is drawn in. Its policy allows no script, request, frame, form or font; it
 * loads as `about:blank` HTML, so it has none of the app's cookies or storage either. A formula
 * wider than the view scrolls sideways; the view is as tall as the formula, so never down.
 */
export function mathDocument(
  markup: string,
  options: { color: string; fontSize: number; display: boolean },
): string {
  const color = CSS_COLOR.test(options.color) ? options.color : "inherit";
  const policy = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
    `<style>html,body{margin:0;padding:0;background:transparent;color:${color};`,
    "overflow-x:auto;overflow-y:hidden;-webkit-text-size-adjust:none}",
    `body{font-size:${options.fontSize}px;${options.display ? "text-align:center" : ""}}`,
    "#m{display:inline-block;white-space:nowrap;padding:4px 0;vertical-align:top}",
    "math{font-family:'STIX Two Math','Latin Modern Math','Cambria Math',serif}</style>",
    `</head><body><div id="m">${markup}</div></body></html>`,
  ].join("");
}

/**
 * Runs in the page once it loads (native injection, which the page's policy does not block). It
 * posts the formula's size, or `failed` when the engine has no MathML so the app keeps the code.
 */
export const mathBootScript = `(function () {
  var post = function (message) {
    window.ReactNativeWebView.postMessage(JSON.stringify(message));
  };
  var root = document.getElementById("m");
  if (typeof MathMLElement === "undefined" || !root || !root.querySelector("math")) {
    return post({ type: "failed" });
  }
  var report = function () {
    var box = root.getBoundingClientRect();
    post({ type: "drawn", width: Math.ceil(box.width), height: Math.ceil(box.height) });
  };
  report();
  if (window.ResizeObserver) new ResizeObserver(report).observe(root);
})();
true;`;

const isSize = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max;

export function parseMathMessage(data: string): MathMessage | null {
  try {
    const message = JSON.parse(data) as { type?: unknown; width?: unknown; height?: unknown };
    if (message.type === "failed") return { type: "failed" };
    if (message.type === "drawn") {
      // A size no formula has means the page is not drawing one: keep the code.
      if (!isSize(message.width, 100_000) || !isSize(message.height, MAX_MATH_HEIGHT)) {
        return { type: "failed" };
      }
      return { type: "drawn", width: message.width, height: message.height };
    }
  } catch {
    // Not a message this page sends.
  }
  return null;
}
