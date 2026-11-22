import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOZO_THEMES, dozoTheme, renderDozoThemesCss } from "./dozo-themes.js";
import { cssVariableName } from "./index.js";

const css = readFileSync(new URL("../../ui-web/src/dozo-themes.css", import.meta.url), "utf8");

describe("named themes", () => {
  it("are the stylesheet the app loads before its first paint", () => {
    // To refresh it: print renderDozoThemesCss() into packages/ui-web/src/dozo-themes.css.
    expect(css).toBe(renderDozoThemesCss());
  });

  it("are the six of the approved mockup, three dark and three light", () => {
    expect(DOZO_THEMES.map((theme) => `${theme.label}:${theme.tone}`)).toEqual([
      "Sumi:dark",
      "Yoru:dark",
      "Hoji:dark",
      "Washi:light",
      "Matcha:light",
      "Kasumi:light",
    ]);
  });

  it("paint only neutral surfaces and ink: the main button stays ink, status and bot colours stay", () => {
    const painted = [...css.matchAll(/^\s+(--[\w-]+):/gm)].map((match) => match[1]);
    for (const token of [
      "destructive",
      "success",
      "warning",
      "link",
      "unread",
      "border",
    ] as const) {
      expect(painted).not.toContain(cssVariableName(token));
    }
    expect(css).toContain(`${cssVariableName("primary")}: var(--dozo-theme-foreground);`);
  });

  it("apply only beside their own tone, so a stale name under the other tone changes nothing", () => {
    for (const theme of DOZO_THEMES) {
      const block = css
        .split("\n")
        .find((line) => line.includes(`[data-skin="${theme.id}"]`) && line.includes(":is("));
      expect(block).toContain(`html[data-theme="${theme.tone}"]`);
    }
  });

  it("finds a theme by its id, and nothing for an unknown or missing one", () => {
    expect(dozoTheme("yoru")?.tone).toBe("dark");
    expect(dozoTheme("neon")).toBeUndefined();
    expect(dozoTheme(null)).toBeUndefined();
  });
});
