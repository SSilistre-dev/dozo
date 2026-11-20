import { BOT_COLOR_LIST } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { DOZO_BOT_PALETTE, DOZO_CHARACTERS, dozoCharacterForLook } from "./dozo-avatar-art.js";
import { dozoChatUserColors, dozoContrast } from "./dozo-chat-colors.js";
import * as core from "./index.js";

const hexOf = (id: string) => BOT_COLOR_LIST.find((color) => color.id === id)?.hex as string;
const PHOTO = "data:image/png;base64,iVBORw0KGgo=";

describe("your own bubble in a bot's chat", () => {
  const fills = (value: string) =>
    /^light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\)$/.exec(value)?.slice(1) as [string, string];

  it("wears each character's colour, darkened until white text on it holds 4.5:1 in both themes", () => {
    for (const [index, character] of DOZO_CHARACTERS.entries()) {
      const colors = dozoChatUserColors(core.botLookWithShape(hexOf("blue"), index), "bot-1");
      expect(colors?.foreground).toBe("#ffffff");
      const [light, dark] = fills(colors?.background ?? "");
      for (const fill of [light, dark]) {
        expect(dozoContrast(fill, "#ffffff")).toBeGreaterThanOrEqual(4.5);
      }
      // Still the character's hue: the darkest channel of the palette colour stays the darkest.
      const [paletteLight] = DOZO_BOT_PALETTE[character];
      const channels = (hex: string) =>
        [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      const order = (hex: string) =>
        channels(hex).map((v, _, all) => all.filter((o) => o < v).length);
      expect(order(light)).toEqual(order(paletteLight));
    }
  });

  it("follows the avatar's character and leaves a photo avatar's chat neutral", () => {
    const blue = dozoCharacterForLook("bot-1", hexOf("blue"));
    const sameCharacter = core.botLookWithShape(hexOf("green"), DOZO_CHARACTERS.indexOf(blue));
    expect(dozoChatUserColors(hexOf("blue"), "bot-1")).toEqual(
      dozoChatUserColors(sameCharacter, "bot-2"),
    );
    expect(dozoChatUserColors(PHOTO, "bot-1")).toBeUndefined();
  });

  it("measures contrast as WCAG does", () => {
    expect(dozoContrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(dozoContrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});
