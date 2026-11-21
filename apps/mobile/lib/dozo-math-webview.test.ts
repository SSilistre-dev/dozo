import katex from "katex";
import { describe, expect, it } from "vitest";

import { mathBootScript, mathDocument, mathMarkup, parseMathMessage } from "./dozo-math-webview";

describe("formula markup", () => {
  it("is the shared writer, so the app uses the web's options", () => {
    expect(mathMarkup(katex, "x^2", false)).toContain("<math");
    expect(mathMarkup(katex, "\\frac{1}{", false)).toBeNull();
  });
});

describe("formula page", () => {
  const options = { color: "#ffffff", fontSize: 17, display: false };

  it("allows no script, request, frame, form or font", () => {
    const page = mathDocument("<math></math>", options);
    expect(page).toContain("default-src 'none'");
    expect(page).toContain("style-src 'unsafe-inline'");
    expect(page).not.toMatch(/script-src|<script|https?:\/\//);
    expect(page).toContain('<div id="m"><math></math></div>');
  });

  it("scrolls sideways only, and centres a display formula", () => {
    expect(mathDocument("", options)).toContain("overflow-x:auto;overflow-y:hidden");
    expect(mathDocument("", options)).not.toContain("text-align:center");
    expect(mathDocument("", { ...options, display: true })).toContain("text-align:center");
  });

  it("takes a color the tokens could be, and nothing that would end the style", () => {
    expect(mathDocument("", { ...options, color: "rgba(10, 20, 30, 0.5)" })).toContain(
      "color:rgba(10, 20, 30, 0.5)",
    );
    expect(mathDocument("", { ...options, color: "red;}</style><script>" })).toContain(
      "color:inherit",
    );
  });

  it("reports its size from the page, or that the engine has no MathML", () => {
    expect(mathBootScript).toContain("MathMLElement");
    expect(mathBootScript).toContain("ReactNativeWebView.postMessage");
    expect(mathBootScript).toContain("ResizeObserver");
    // The boot script is valid JavaScript.
    expect(() => new Function(mathBootScript)).not.toThrow();
  });

  it("runs the boot script as a page would", () => {
    const posted: string[] = [];
    const run = (page: { MathMLElement?: unknown; math: boolean; box: object }) => {
      const root = {
        querySelector: () => (page.math ? {} : null),
        getBoundingClientRect: () => page.box,
      };
      new Function("window", "document", "MathMLElement", "ResizeObserver", mathBootScript)(
        { ReactNativeWebView: { postMessage: (data: string) => posted.push(data) } },
        { getElementById: () => root },
        page.MathMLElement,
        undefined,
      );
    };
    run({ MathMLElement: class {}, math: true, box: { width: 40.2, height: 20.5 } });
    run({ MathMLElement: undefined, math: true, box: {} });
    run({ MathMLElement: class {}, math: false, box: {} });
    expect(posted.map((data) => JSON.parse(data))).toEqual([
      { type: "drawn", width: 41, height: 21 },
      { type: "failed" },
      { type: "failed" },
    ]);
  });
});

describe("page messages", () => {
  it("reads a size and a failure", () => {
    expect(parseMathMessage('{"type":"drawn","width":40,"height":20}')).toEqual({
      type: "drawn",
      width: 40,
      height: 20,
    });
    expect(parseMathMessage('{"type":"failed"}')).toEqual({ type: "failed" });
  });

  it("treats a size no formula has as a failure", () => {
    for (const size of [
      '"width":0,"height":20',
      '"width":40,"height":-1',
      '"width":40,"height":99999',
      '"width":"40","height":20',
      '"width":1e9,"height":20',
    ]) {
      expect(parseMathMessage(`{"type":"drawn",${size}}`)).toEqual({ type: "failed" });
    }
  });

  it("ignores what the page does not send", () => {
    expect(parseMathMessage("not json")).toBeNull();
    expect(parseMathMessage('{"type":"other"}')).toBeNull();
    expect(parseMathMessage("null")).toBeNull();
  });
});
