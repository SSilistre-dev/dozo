import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import type { Pluggable } from "unified";
import { unified } from "unified";

/**
 * Math in chat Markdown: `$…$` inline, `$$…$$` on its own and `$$` fenced blocks display.
 *
 * A dollar is math only by the usual TeX-in-Markdown rules: the opening `$` is followed by a
 * non-space, the closing one follows a non-space and is not followed by a digit, and both are in
 * the same paragraph. Every other dollar (prices, "$5 and $10") is swapped for a stand-in of the
 * same length before parsing, so the math parser leaves it alone and the parser's offsets still
 * point into the original text; the tree plugin puts the dollar back.
 */

const STAND_IN = "";
const STAND_INS = new RegExp(STAND_IN, "g");

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: Record<string, unknown>;
};

// Text the math parser never reads as math, or where a stand-in would change a URL.
const LITERAL = new Set([
  "code",
  "inlineCode",
  "html",
  "link",
  "image",
  "imageReference",
  "definition",
]);

const plainParser = unified().use(remarkParse).use(remarkGfm);

function literalRanges(source: string): [number, number][] {
  const ranges: [number, number][] = [];
  const walk = (node: MdNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (LITERAL.has(node.type) && start !== undefined && end !== undefined) {
      ranges.push([start, end]);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(plainParser.parse(source) as MdNode);
  return ranges;
}

const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char);

function runLength(source: string, at: number) {
  let end = at;
  while (source[end] === "$") end++;
  return end - at;
}

/** Where the paragraph holding `from` ends: the next blank line, or the end of the text. */
function paragraphEnd(source: string, from: number) {
  const blank = /\n[ \t>]*\n/g;
  blank.lastIndex = from;
  return blank.exec(source)?.index ?? source.length;
}

/** The next run of exactly `length` dollars from `from` before `limit`, or -1. */
function nextRun(source: string, from: number, limit: number, length: number) {
  for (let at = source.indexOf("$", from); at !== -1 && at < limit; ) {
    const run = runLength(source, at);
    if (run === length) return at;
    at = source.indexOf("$", at + run);
  }
  return -1;
}

const FLOW_CLOSE = /^(?:[ \t]*>)*[ \t]*(\${2,})[ \t]*$/;

/** A `$$` that opens a display block on its own line: where the closing line ends, or -1. */
function flowEnd(source: string, at: number, run: number) {
  const lineStart = source.lastIndexOf("\n", at - 1) + 1;
  if (!/^(?:[ \t]*>)*[ \t]*$/.test(source.slice(lineStart, at))) return -1;
  const lineEnd = source.indexOf("\n", at);
  if (lineEnd === -1 || source.slice(at + run, lineEnd).includes("$")) return -1;
  let from = lineEnd + 1;
  while (from <= source.length) {
    const end = source.indexOf("\n", from);
    const line = source.slice(from, end === -1 ? source.length : end);
    const closing = FLOW_CLOSE.exec(line)?.[1];
    if (closing && closing.length >= run) return end === -1 ? source.length : end;
    if (end === -1) break;
    from = end + 1;
  }
  return -1;
}

/**
 * The text with each dollar that does not open or close math replaced by a stand-in of the same
 * length. Code, HTML, links and images are left as written.
 */
export function mathSource(source: string): string {
  if (!source.includes("$")) return source;
  // Text that already holds the stand-in gets no math at all, so nothing in it changes meaning.
  const strayOnly = source.includes(STAND_IN);
  const literal = literalRanges(source);
  const out = source.split("");
  const stray = (from: number, length: number) => {
    for (let i = from; i < from + length; i++) out[i] = STAND_IN;
  };
  let range = 0;
  let at = 0;
  while (at < source.length) {
    while (range < literal.length && (literal[range]?.[1] ?? 0) <= at) range++;
    const current = literal[range];
    if (current && current[0] <= at) {
      at = current[1];
      continue;
    }
    const char = source[at];
    if (char === "\\") {
      at += 2;
      continue;
    }
    if (char !== "$") {
      at++;
      continue;
    }
    const run = runLength(source, at);
    if (strayOnly) {
      stray(at, run);
      at += run;
      continue;
    }
    if (run >= 2) {
      const flow = flowEnd(source, at, run);
      if (flow !== -1) {
        at = flow;
        continue;
      }
    }
    const limit = paragraphEnd(source, at + run);
    const close = nextRun(source, at + run, limit, run);
    const math =
      close !== -1 &&
      (run > 1 ||
        (!isSpace(source[at + 1]) &&
          !isSpace(source[close - 1]) &&
          !/\d/.test(source[close + 1] ?? "")));
    if (math) {
      at = close + run;
    } else {
      stray(at, run);
      at += run;
    }
  }
  return out.join("");
}

function only<T>(items: T[] | undefined): T | undefined {
  const meaningful = (items ?? []).filter(
    (item) => !((item as MdNode).type === "text" && !(item as MdNode).value?.trim()),
  );
  return meaningful.length === 1 ? meaningful[0] : undefined;
}

/** Each math node becomes one `dozo-math` element holding its TeX; stand-ins become dollars. */
function mathElements() {
  return (tree: MdNode, file: { value: unknown }) => {
    const source = String(file.value);
    const walk = (node: MdNode, parent: MdNode | undefined) => {
      if (node.type === "text" && node.value?.includes(STAND_IN)) {
        node.value = node.value.replace(STAND_INS, "$");
      }
      if (node.type === "inlineMath" || node.type === "math") {
        const start = node.position?.start.offset ?? -1;
        const display =
          node.type === "math" ||
          (source.startsWith("$$", start) &&
            parent?.type === "paragraph" &&
            only(parent.children) === node);
        node.data = {
          hName: "dozo-math",
          hProperties: { className: display ? ["rk-math", "rk-math-display"] : ["rk-math"] },
          hChildren: [{ type: "text", value: node.value ?? "" }],
        };
        return;
      }
      for (const child of node.children ?? []) walk(child, node);
    };
    walk(tree, undefined);
  };
}

/** The remark plugins that read math; the text must first go through `mathSource`. */
export const remarkChatMath: Pluggable[] = [remarkMath, mathElements];
