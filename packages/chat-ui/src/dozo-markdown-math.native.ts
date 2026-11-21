import type { createMarkdownIt } from "@ronradtke/react-native-markdown-display";

/**
 * Math in mobile chat Markdown. The web draws `$…$` and `$$…$$` as formulas with KaTeX; here the
 * parser reads them into `dozo_math_inline` (`$…$`, and a `$$…$$` on one line) and
 * `dozo_math_block` (a `$$` block) tokens that hold the TeX exactly as the bot wrote it. The
 * render rules in `native/dozo-math.tsx` draw them when the app can, and otherwise show the TeX in
 * the code style. Like code, the TeX is never read as Markdown, so `_`, `*`, backslashes and HTML
 * inside a formula stay as written.
 *
 * The delimiter rules are the web's (`dozo-markdown-math.ts`): a single dollar opens math only
 * before a non-space and closes it only after a non-space and not before a digit, so prices
 * ("$5 and $10") stay text.
 */

type Parser = ReturnType<typeof createMarkdownIt>;

/** The parts of a markdown-it token, and of the parser state a rule reads and writes. */
type Token = { markup: string; content: string; info: string; map: [number, number] | null };
type InlineState = {
  src: string;
  pos: number;
  posMax: number;
  pending: string;
  push(type: string, tag: string, nesting: number): Token;
};
type BlockState = {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  sCount: number[];
  blkIndent: number;
  line: number;
  push(type: string, tag: string, nesting: number): Token;
  getLines(begin: number, end: number, indent: number, keepLastLF: boolean): string;
};
type InlineRule = (state: InlineState, silent: boolean) => boolean;
type BlockRule = (
  state: BlockState,
  startLine: number,
  endLine: number,
  silent: boolean,
) => boolean;

/** A line-table entry; markdown-it fills one for every line it asks about. */
const entry = (list: number[], line: number) => list[line] as number;

const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char);

/** How many dollars run on from `at`, up to `limit`. */
function runLength(source: string, at: number, limit: number) {
  let end = at;
  while (end < limit && source[end] === "$") end++;
  return end - at;
}

/** Where the next run of exactly `length` dollars starts in `from`..`limit`, or -1. A `\` skips a character. */
function closingRun(source: string, from: number, limit: number, length: number) {
  for (let at = from; at < limit; ) {
    if (source[at] === "\\") {
      at += 2;
    } else if (source[at] === "$") {
      const run = runLength(source, at, limit);
      if (run === length) return at;
      at += run;
    } else {
      at++;
    }
  }
  return -1;
}

const mathSpan: InlineRule = (state, silent) => {
  const { src, pos, posMax } = state;
  if (src[pos] !== "$") return false;
  const run = runLength(src, pos, posMax);
  const close = closingRun(src, pos + run, posMax, run);
  const content = close === -1 ? "" : src.slice(pos + run, close);
  const math =
    /\S/.test(content) &&
    (run > 1 ||
      (!isSpace(src[pos + 1]) && !isSpace(src[close - 1]) && !/\d/.test(src[close + 1] ?? "")));
  if (!math) {
    // The whole run is text, so a part of it never opens math on its own.
    if (!silent) state.pending += "$".repeat(run);
    state.pos = pos + run;
    return true;
  }
  if (!silent) {
    const token = state.push("dozo_math_inline", "span", 0);
    token.markup = "$".repeat(run);
    token.content = content.replace(/\s*\n\s*/g, " ").trim();
  }
  state.pos = close + run;
  return true;
};

/** A `$$` line that opens a block and the line that closes it with as many dollars or more. */
const mathBlock: BlockRule = (state, startLine, endLine, silent) => {
  const { src, bMarks, eMarks, tShift, sCount, blkIndent } = state;
  const start = entry(bMarks, startLine) + entry(tShift, startLine);
  const lineEnd = entry(eMarks, startLine);
  if (entry(sCount, startLine) - blkIndent >= 4 || src[start] !== "$") return false;
  const run = runLength(src, start, lineEnd);
  const first = src.slice(start + run, lineEnd);
  if (run < 2 || first.includes("$")) return false;
  let line = startLine + 1;
  for (; line < endLine; line++) {
    const from = entry(bMarks, line) + entry(tShift, line);
    const to = entry(eMarks, line);
    // A line out of the block's container ends it without a closing line.
    if (from < to && entry(sCount, line) < blkIndent) return false;
    const closing = runLength(src, from, to);
    if (closing >= run && !/\S/.test(src.slice(from + closing, to))) break;
  }
  if (line >= endLine) return false;
  if (silent) return true;
  const token = state.push("dozo_math_block", "div", 0);
  token.markup = "$".repeat(run);
  token.map = [startLine, line + 1];
  token.content =
    (first.trim() ? `${first.trim()}\n` : "") +
    state.getLines(startLine + 1, line, entry(sCount, startLine), true);
  state.line = line + 1;
  return true;
};

/** Makes the chat's Markdown parser read `$…$` and `$$…$$` as math tokens. */
export function mathAsCode<T extends Parser>(parser: T): T {
  parser.block.ruler.before("fence", "dozo_math", mathBlock, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  parser.inline.ruler.before("escape", "dozo_math", mathSpan);
  return parser;
}
