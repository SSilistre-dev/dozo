// The named themes' source (packages/ui-tokens/src/dozo-themes.ts) keeps Light and Dark as the
// theme file paints them, for the swatches and for the contrast test that measures every theme
// against the default of its tone. The fork's unit run cannot read dozo/theme/ (the stage leaves
// it out), so olc holds the two copies equal here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

/** `DOZO_DEFAULT_PALETTES` from the TypeScript source: tone -> token -> lowercase hex. */
function sourcePalettes(source) {
  const start = source.indexOf("export const DOZO_DEFAULT_PALETTES");
  assert.ok(start >= 0, "DOZO_DEFAULT_PALETTES is not in dozo-themes.ts");
  const block = source.slice(start, source.indexOf("\n};", start));
  const palettes = {};
  for (const [, tone, body] of block.matchAll(/(dark|light): \{([^}]*)\}/g)) {
    palettes[tone] = Object.fromEntries(
      [...body.matchAll(/(\w+): "(#[0-9a-fA-F]{6})"/g)].map(([, key, hex]) => [
        key,
        hex.toLowerCase(),
      ]),
    );
  }
  return palettes;
}

test("the themes' copy of Light and Dark is the theme file's", () => {
  const theme = JSON.parse(read("dozo/theme/theme.json"));
  const palettes = sourcePalettes(read("packages/ui-tokens/src/dozo-themes.ts"));
  assert.deepEqual(Object.keys(palettes).sort(), ["dark", "light"]);
  for (const [tone, palette] of Object.entries(palettes)) {
    assert.ok(Object.keys(palette).length >= 8, `${tone}: too few entries read`);
    for (const [key, hex] of Object.entries(palette)) {
      assert.equal(hex, theme[tone][key]?.toLowerCase(), `${tone}.${key}`);
    }
  }
});

test("a changed theme file is noticed", () => {
  const source = read("packages/ui-tokens/src/dozo-themes.ts").replace(
    'background: "#141414"',
    'background: "#151515"',
  );
  const theme = JSON.parse(read("dozo/theme/theme.json"));
  assert.notEqual(sourcePalettes(source).dark.background, theme.dark.background.toLowerCase());
});
