import { BOT_COLOR_LIST } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { dozoBotColor } from "./dozo-avatar-art.js";
import { dozoBotFill, dozoChatUserColors, dozoContrast } from "./dozo-chat-colors.js";
import * as core from "./index.js";

const hexOf = (id: string) => BOT_COLOR_LIST.find((color) => color.id === id)?.hex as string;
const PHOTO = "data:image/png;base64,iVBORw0KGgo=";

describe("your own bubble in a bot's chat", () => {
  it("wears the colour picked for the bot, darkened until white text on it holds 4.5:1", () => {
    for (const { id, hex } of BOT_COLOR_LIST.filter(({ id }) => id !== "white")) {
      for (const value of [hex, core.botLookWithShape(hex, 2)]) {
        const colors = dozoChatUserColors(value, "bot-1");
        expect(colors, id).toEqual({
          background: dozoBotFill(hex.toLowerCase()),
          foreground: "#ffffff",
        });
        expect(dozoContrast(colors?.background ?? "", "#ffffff")).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("is the colour the avatar's accessory wears, and neutral for a photo or a white bot", () => {
    expect(dozoChatUserColors(hexOf("magenta"), "bot-1")?.background).toBe(
      dozoBotFill(dozoBotColor("bot-1", hexOf("magenta")) as string),
    );
    expect(dozoChatUserColors(hexOf("magenta"), "bot-1")).not.toEqual(
      dozoChatUserColors(hexOf("red"), "bot-1"),
    );
    expect(dozoChatUserColors(PHOTO, "bot-1")).toBeUndefined();
    expect(dozoChatUserColors(hexOf("white"), "bot-1")).toBeUndefined();
  });

  it("darkens a light colour past the design's mix until white text holds 4.5:1", () => {
    const fill = dozoBotFill("#ffff66");
    expect(fill).not.toBe("#b8b849");
    expect(dozoContrast(fill, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(dozoContrast(dozoBotFill("#4f8fd8"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("falls back to the avatar value as the seed when the bot has no id yet", () => {
    expect(dozoChatUserColors(hexOf("blue"), "")).toEqual(
      dozoChatUserColors(hexOf("blue"), hexOf("blue")),
    );
  });

  it("gives a bot with no valid colour the one upstream assigns it", () => {
    for (const value of ["nonsense", "", "#zzz", "rgb(1, 2, 3)"]) {
      const assigned = dozoBotColor("bot-1", value);
      expect(dozoChatUserColors(value, "bot-1")).toEqual(
        assigned ? { background: dozoBotFill(assigned), foreground: "#ffffff" } : undefined,
      );
    }
  });

  it("measures contrast as WCAG does", () => {
    expect(dozoContrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(dozoContrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});
