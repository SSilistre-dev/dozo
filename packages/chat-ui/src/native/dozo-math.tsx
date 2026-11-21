import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import type { MarkdownStyleMap, RenderRules } from "@ronradtke/react-native-markdown-display";
import type { ComponentType, ReactNode } from "react";
import { createContext, useContext } from "react";
import type { TextStyle } from "react-native";
import { Text } from "react-native";
import { MAX_FORMULAS_PER_MESSAGE, MAX_MATH_SOURCE } from "../dozo-math-options";
import { CodeFence, DiagramSurfaceContext } from "./code";

export type MathViewProps = {
  /** The formula's TeX, as written; it is also what a screen reader reads. */
  tex: string;
  /** A formula on its own (`$$`), as opposed to one in a line of text. */
  display: boolean;
  palette: ColorTokens;
  colorScheme: ResolvedAppearance;
  /** The TeX in the code style, for the app to show until the formula is drawn or when it cannot be. */
  fallback: ReactNode;
};

/**
 * Draws a formula. KaTeX and a browser engine are the app's (a WebView); without one, or while a
 * reply is still streaming, a formula stays in the code style it had before it could be drawn.
 */
export const MathViewContext = createContext<ComponentType<MathViewProps> | null>(null);

/** Where the parser put the formula among those of its message; the first few are drawn. */
function drawnFormula(meta: unknown) {
  const place = (meta as { formula?: number } | null)?.formula;
  return place === undefined || place < MAX_FORMULAS_PER_MESSAGE;
}

function Formula({
  tex,
  display,
  allowed,
  fallback,
}: {
  tex: string;
  display: boolean;
  allowed: boolean;
  fallback: ReactNode;
}) {
  const View = useContext(MathViewContext);
  const { streaming, palette, colorScheme } = useContext(DiagramSurfaceContext);
  if (!View || !allowed || streaming || tex.length > MAX_MATH_SOURCE || !/\S/.test(tex))
    return fallback;
  return (
    <View
      tex={tex}
      display={display}
      palette={palette}
      colorScheme={colorScheme}
      fallback={fallback}
    />
  );
}

function BlockSource({ tex, styleMap }: { tex: string; styleMap: MarkdownStyleMap }) {
  const { colorScheme } = useContext(DiagramSurfaceContext);
  return (
    <CodeFence
      code={tex.replace(/\n$/, "")}
      language="tex"
      colorScheme={colorScheme === "dark" ? "dark" : "light"}
      styleMap={styleMap}
    />
  );
}

/** The text style a parent hands down, as the library's own code rule reads it. */
function inheritedTextStyle(inherited: unknown): TextStyle | undefined {
  return inherited && typeof inherited === "object" && !Array.isArray(inherited)
    ? (inherited as TextStyle)
    : undefined;
}

/** The rules for the tokens `mathAsCode` makes. */
export const mathRules: RenderRules = {
  dozo_math_inline: (node, _children, _parents, styleMap, inherited) => (
    <Formula
      key={node.key}
      tex={node.content}
      allowed={drawnFormula(node.sourceMeta)}
      display={false}
      fallback={
        <Text style={[inheritedTextStyle(inherited), styleMap.code_inline]}>{node.content}</Text>
      }
    />
  ),
  dozo_math_block: (node, _children, _parents, styleMap) => (
    <Formula
      key={node.key}
      tex={node.content}
      allowed={drawnFormula(node.sourceMeta)}
      display
      fallback={<BlockSource tex={node.content} styleMap={styleMap} />}
    />
  ),
};
