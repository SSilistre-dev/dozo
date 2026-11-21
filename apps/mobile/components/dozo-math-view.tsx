import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { MathViewProps } from "@rakazo/chat-ui/native";
import { typeScale } from "@rakazo/ui-tokens";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import {
  MATH_TIMEOUT_MS,
  MAX_INLINE_MATH_WIDTH,
  mathBootScript,
  mathDocument,
  mathMarkup,
  parseMathMessage,
} from "../lib/dozo-math-webview";

// Where a formula has been measured: a message that scrolls out of a list and back builds its
// formulas again, and a known size lets them appear drawn instead of as code first.
const measured = new Map<string, { width: number; height: number }>();
const MEASURED_LIMIT = 200;

function remember(html: string, width: number, height: number) {
  measured.delete(html);
  measured.set(html, { width, height });
  if (measured.size > MEASURED_LIMIT) measured.delete(measured.keys().next().value as string);
}

type Drawing =
  | { status: "drawing" }
  | { status: "drawn"; width: number; height: number }
  | { status: "failed" };

function isFormulaDocument(url: string): boolean {
  return url === "about:blank" || url === "about:blank/";
}

/**
 * Draws a chat formula. KaTeX runs here, loaded the first time a reply holds a formula, and the
 * WebView only shows the MathML it writes. The code stays on screen until the page reports the
 * formula's size, and comes back for good if the formula cannot be read or drawn.
 */
export function MathView({ tex, display, palette, fallback }: MathViewProps) {
  const [markup, setMarkup] = useState<string | null>();
  useEffect(() => {
    let current = true;
    import("katex").then(
      (module) => current && setMarkup(mathMarkup(module.default, tex, display)),
      () => current && setMarkup(null),
    );
    return () => {
      current = false;
    };
  }, [tex, display]);
  const html = useMemo(
    () =>
      markup
        ? mathDocument(markup, {
            color: palette.foreground,
            fontSize: typeScale.body.fontSize,
            display,
          })
        : undefined,
    [markup, palette.foreground, display],
  );
  // Still loading KaTeX, or KaTeX cannot read the formula.
  if (html === undefined) return fallback;
  return <FormulaPage html={html} tex={tex} display={display} fallback={fallback} />;
}

function FormulaPage({
  html,
  tex,
  display,
  fallback,
}: {
  html: string;
  tex: string;
  display: boolean;
  fallback: MathViewProps["fallback"];
}) {
  const [state, setState] = useState<{ html: string; drawing: Drawing }>(() => {
    const known = measured.get(html);
    return { html, drawing: known ? { status: "drawn", ...known } : { status: "drawing" } };
  });
  const drawing = state.html === html ? state.drawing : { status: "drawing" as const };
  useTimeout(
    () =>
      setState((current) =>
        current.html === html && current.drawing.status !== "drawing"
          ? current
          : { html, drawing: { status: "failed" } },
      ),
    MATH_TIMEOUT_MS,
    html,
  );
  if (drawing.status === "failed") return fallback;
  const drawn = drawing.status === "drawn";
  const width = display ? ("100%" as const) : 1;
  const size = drawn
    ? {
        width: display ? width : Math.min(drawing.width, MAX_INLINE_MATH_WIDTH),
        height: drawing.height,
      }
    : { width, height: 1 };
  const fail = () => setState({ html, drawing: { status: "failed" } });
  const page = (
    <View
      style={[drawn ? undefined : styles.measuring, size]}
      pointerEvents={drawn ? "auto" : "none"}
      accessible={drawn}
      accessibilityRole="image"
      accessibilityLabel={tex}
    >
      <WebView
        key={html}
        source={{ html, baseUrl: "about:blank" }}
        injectedJavaScript={mathBootScript}
        // Matches every address, so the library never hands one to the system to open (it does so
        // for any address outside this list, whatever the load handler below answers). The
        // handler then lets only the formula's own page load.
        originWhitelist={["*"]}
        onMessage={(event) => {
          const message = parseMathMessage(event.nativeEvent.data);
          if (!message) return;
          if (message.type === "drawn") remember(html, message.width, message.height);
          setState({
            html,
            drawing:
              message.type === "drawn"
                ? { status: "drawn", width: message.width, height: message.height }
                : { status: "failed" },
          });
        }}
        onError={fail}
        onHttpError={fail}
        style={styles.webview}
        javaScriptEnabled
        allowsLinkPreview={false}
        dataDetectorTypes="none"
        javaScriptCanOpenWindowsAutomatically={false}
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        thirdPartyCookiesEnabled={false}
        sharedCookiesEnabled={false}
        // Sideways only: the page is exactly as tall as the formula.
        scrollEnabled
        nestedScrollEnabled
        bounces={false}
        showsVerticalScrollIndicator={false}
        overScrollMode="never"
        onShouldStartLoadWithRequest={({ url }) => isFormulaDocument(url)}
      />
    </View>
  );
  // A formula in a line of text keeps its code in the line until its size is known.
  return drawn ? (
    page
  ) : (
    <>
      {fallback}
      {page}
    </>
  );
}

const styles = StyleSheet.create({
  // Laid out but unseen, so the page measures the size it will be shown at.
  measuring: { opacity: 0 },
  webview: { flex: 1, backgroundColor: "transparent" },
});
