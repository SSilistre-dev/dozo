import type { KatexOptions } from "katex";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Pluggable } from "unified";
import { MAX_MATH_SOURCE, mathOptions } from "./dozo-math-options";
import "./dozo-markdown-math.css";

export { MAX_MATH_SOURCE, mathOptions };

type MathParsing = typeof import("./dozo-markdown-math");

// The Markdown parser that reads math (remark-math, micromark) is a chunk of its own, loaded the
// first time a message holds a dollar sign. Until it arrives such a message shows as plain text,
// and everything that already drew is drawn again once it is there.
let parsing: MathParsing | undefined;
let parsingLoad: Promise<void> | undefined;
const loadedListeners = new Set<() => void>();
const plugins: Pluggable[][] = [];

function loadParsing() {
  if (parsingLoad) return;
  parsingLoad = import("./dozo-markdown-math").then(
    (module) => {
      parsing = module;
      for (const list of plugins) list.push(...module.remarkChatMath);
      for (const listener of loadedListeners) listener();
    },
    // Not loaded: dollars stay text, and the next message holding one tries again.
    () => {
      parsingLoad = undefined;
    },
  );
}

/** Runs when the math parser has just loaded, before anything drawn is drawn again. */
export function onMathLoaded(listener: () => void) {
  loadedListeners.add(listener);
  return () => void loadedListeners.delete(listener);
}

/** The remark plugins to read with: these, and the math ones once they have loaded. */
export function withChatMath(list: Pluggable[]): Pluggable[] {
  plugins.push(list);
  if (parsing) list.push(...parsing.remarkChatMath);
  return list;
}

/** Draws the calling block again when the math parser loads. */
export function useMathReady(): boolean {
  return useSyncExternalStore(
    onMathLoaded,
    () => parsing !== undefined,
    () => false,
  );
}

/** The text with the dollars that are not math kept as text; the text as it is until the parser loads. */
export function mathSource(source: string): string {
  if (!source.includes("$")) return source;
  if (!parsing) {
    loadParsing();
    return source;
  }
  return parsing.mathSource(source);
}

type Katex = { render(tex: string, element: HTMLElement, options: KatexOptions): void };

// KaTeX and its fonts load the first time a message holds math, never with the chat.
let katexLoad: Promise<Katex> | undefined;

function loadKatex(): Promise<Katex> {
  katexLoad ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(
    ([module]) => module.default,
    (error: unknown) => {
      // A failed chunk load is retried by the next formula instead of failing every later one.
      katexLoad = undefined;
      throw error;
    },
  );
  return katexLoad;
}

let loaded: Katex | undefined;

function useKatex(): Katex | undefined {
  const [katex, setKatex] = useState(loaded);
  useEffect(() => {
    if (katex) return;
    loadKatex().then(
      (module) => {
        loaded = module;
        setKatex(module);
      },
      // Not loaded: the formula stays as its source, which is still readable.
      () => undefined,
    );
  }, [katex]);
  return katex;
}

/** The element `remarkChatMath` makes: its one child is the formula's TeX. */
type MathNode = { children: { value: string }[] };

function DrawnMath(props: {
  katex: Katex;
  tex: string;
  display: boolean;
  className: string;
  onFail: (tex: string) => void;
}) {
  const { katex, tex, display, onFail } = props;
  const target = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    try {
      katex.render(tex, target.current as HTMLSpanElement, mathOptions(display));
    } catch {
      // A formula still streaming in, or TeX KaTeX does not know.
      onFail(tex);
    }
  }, [katex, tex, display, onFail]);
  return <span ref={target} className={props.className} />;
}

/** A formula: drawn by KaTeX once loaded, otherwise (and when it cannot be drawn) its source. */
export function ChatMath({ node, className }: { node: MathNode; className: string }) {
  const tex = node.children.map((child) => child.value).join("");
  const display = className.includes("rk-math-display");
  const katex = useKatex();
  const [failed, setFailed] = useState<string>();
  if (katex && tex.length <= MAX_MATH_SOURCE && failed !== tex) {
    return (
      <DrawnMath
        katex={katex}
        tex={tex}
        display={display}
        className={className}
        onFail={setFailed}
      />
    );
  }
  const fence = display ? "$$" : "$";
  return (
    <span className={`${className} rk-math-source`}>
      {fence}
      {tex}
      {fence}
    </span>
  );
}

export const mathComponents = { "dozo-math": ChatMath };
