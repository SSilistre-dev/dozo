import type { KatexOptions } from "katex";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./dozo-markdown-math.css";

export { mathSource, remarkChatMath } from "./dozo-markdown-math";

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

/** Longer source is shown as written: it is far past any formula a reply needs. */
export const MAX_MATH_SOURCE = 4000;

// Model output is untrusted. `trust: false` refuses \href, \url, \includegraphics and the \html*
// commands; the size and expansion caps stop a formula from drawing huge boxes or looping macros.
// Every render gets fresh macros, so \gdef in one formula cannot change another.
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
