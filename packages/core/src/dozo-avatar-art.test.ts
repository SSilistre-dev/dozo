import { BOT_COLOR_LIST } from "@rakazo/contracts";
import { darkTokens } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";
import {
  DOZO_AVATAR_ART,
  DOZO_BOT_PALETTE,
  DOZO_CHARACTERS,
  dozoAvatarSvg,
  dozoCharacterForLook,
  dozoChatUserColors,
  dozoContrast,
  dozoCharacterForSeed,
  dozoHashSeed,
  notificationAvatarSource,
} from "./dozo-avatar-art.js";
import * as core from "./index.js";

const hexOf = (id: string) => BOT_COLOR_LIST.find((color) => color.id === id)?.hex as string;
const PHOTO = "data:image/png;base64,iVBORw0KGgo=";

describe("Dozo avatar art", () => {
  it("draws every character as a head with a visor hole, eyes in the head's ink and an accessory", () => {
    for (const character of DOZO_CHARACTERS) {
      const shapes = DOZO_AVATAR_ART[character];
      // One head path holds two closed outlines: the head, and the visor cut out of it.
      const heads = shapes.filter(
        ([part, tag, paint, attrs]) =>
          part === "head" && tag === "path" && paint === "body" && /Z.+Z$/.test(String(attrs.d)),
      );
      expect(heads).toHaveLength(1);
      const eyes = shapes.filter(([part]) => part === "eyes");
      expect(eyes.length).toBeGreaterThan(0);
      expect(eyes.every(([, , paint]) => paint === "body" || paint === "line")).toBe(true);
      const accessory = shapes.filter(([part]) => part === "feature");
      expect(accessory.some(([, , paint]) => paint === "accent")).toBe(true);
      // The character's colour is on the accessory alone.
      expect(shapes.some(([part, , paint]) => part === "eyes" && paint === "accent")).toBe(false);
    }
  });

  it("keeps every drawing inside the 64 x 64 canvas and gives each its own outline", () => {
    const heads = DOZO_CHARACTERS.map(
      (name) =>
        DOZO_AVATAR_ART[name].find(([part, tag]) => part === "head" && tag === "path")?.[3].d,
    );
    expect(new Set(heads).size).toBe(6);
    for (const character of DOZO_CHARACTERS) {
      for (const [, , , attrs] of DOZO_AVATAR_ART[character]) {
        if (attrs.transform) continue;
        const numbers = String(attrs.d ?? "").match(/-?\d+(?:\.\d+)?/g) ?? [];
        for (const value of [...numbers.map(Number), attrs.cx ?? 0, attrs.cy ?? 0]) {
          expect(Number(value)).toBeGreaterThanOrEqual(0);
          expect(Number(value)).toBeLessThanOrEqual(64);
        }
      }
    }
  });

  it("gives each character its own colour for a light page and a dark one", () => {
    expect(new Set(DOZO_CHARACTERS.flatMap((name) => DOZO_BOT_PALETTE[name])).size).toBe(12);
  });

  it("names a character by its own name and hashes any other seed", () => {
    expect(DOZO_CHARACTERS.map((name) => dozoCharacterForSeed(` ${name.toUpperCase()} `))).toEqual(
      DOZO_CHARACTERS,
    );
    expect(dozoHashSeed("bot-1")).toBe(dozoHashSeed("bot-1"));
    expect(dozoHashSeed("bot-1")).not.toBe(dozoHashSeed("bot-2"));
    const seen = new Set(Array.from({ length: 200 }, (_, i) => dozoCharacterForSeed(`bot-${i}`)));
    expect(seen.size).toBe(6);
  });
});

describe("the character a bot is drawn as", () => {
  it.each([
    ["blue", "sora"],
    ["violet", "kumo"],
    ["green", "hana"],
    ["yellow", "taro"],
    ["orange", "taro"],
    ["brown", "taro"],
    ["red", "yuki"],
    ["magenta", "yuki"],
    ["cyan", "mochi"],
  ])("draws upstream's %s as %s, the closest character in hue", (id, character) => {
    expect(dozoCharacterForLook("bot-1", hexOf(id))).toBe(character);
    expect(dozoCharacterForLook("bot-2", hexOf(id))).toBe(character);
  });

  it("reads a three-digit colour and a colour named by its palette id", () => {
    expect(dozoCharacterForLook("bot-1", "#07f")).toBe("sora");
    expect(dozoCharacterForLook("bot-1", "#0f0")).toBe("hana");
    expect(dozoCharacterForLook("bot-1", "blue")).toBe("sora");
  });

  it("lets a shape picked in the avatar editor name the character, whatever the colour", () => {
    const picked = Array.from({ length: 8 }, (_, shape) =>
      dozoCharacterForLook("bot-1", `${hexOf("red")}::shape_${shape}`),
    );
    expect(picked).toEqual([...DOZO_CHARACTERS, "sora", "kumo"]);
  });

  it("falls back to the bot's identity when its colour has no hue", () => {
    for (const id of ["bot-1", "bot-2", "bot-3"]) {
      expect(dozoCharacterForLook(id, hexOf("white"))).toBe(dozoCharacterForSeed(id));
    }
  });

  it("draws a bot with no stored colour as the same character every time", () => {
    for (const value of [undefined, null, ""]) {
      expect(DOZO_CHARACTERS).toContain(dozoCharacterForLook("bot-1", value));
      expect(dozoCharacterForLook("bot-1", value)).toBe(dozoCharacterForLook("bot-1", undefined));
    }
  });
});

describe("the still drawing", () => {
  it("is the character's shapes on one dark tile, so it reads on any surface", () => {
    for (const character of DOZO_CHARACTERS) {
      const svg = dozoAvatarSvg(character);
      const [light, dark] = DOZO_BOT_PALETTE[character];
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="96" height="96"/);
      expect(svg).toContain(
        `<rect width="64" height="64" rx="18" fill="${darkTokens.background}"/>`,
      );
      expect(svg).toContain(`fill="${dark}"`);
      expect(svg).not.toContain(light);
      expect(svg).not.toContain("undefined");
      expect(svg.match(/<(?:rect|circle|ellipse|path) /g)).toHaveLength(
        DOZO_AVATAR_ART[character].length + 1,
      );
    }
    expect(dozoAvatarSvg("sora", 40)).toContain('width="40" height="40"');
  });

  it("cuts the visor out of the head, strokes line eyes and paints the accessory", () => {
    const ink = darkTokens.foreground;
    expect(dozoAvatarSvg("sora")).toContain(`Z" fill="${ink}" fill-rule="evenodd"/>`);
    expect(dozoAvatarSvg("mochi")).toContain(
      `fill="none" stroke-width="2.6" stroke-linecap="round" stroke="${ink}"/>`,
    );
    expect(dozoAvatarSvg("taro")).toMatch(
      new RegExp(`<rect x="8" y="20\\.8" [^>]* fill="${DOZO_BOT_PALETTE.taro[1]}"/>`),
    );
  });
});

describe("the notification portrait", () => {
  it("keeps a saved photo", () => {
    expect(notificationAvatarSource({ id: "bot-1", color: PHOTO })).toBe(PHOTO);
  });

  it("draws the bot's character, also when the stored value is not a valid avatar", () => {
    for (const color of [hexOf("blue"), "not-a-colour", ""]) {
      const source = notificationAvatarSource({ id: "bot-1", color });
      expect(source.startsWith("data:image/svg+xml,")).toBe(true);
      const drawing = decodeURIComponent(source.slice(source.indexOf(",") + 1));
      expect(drawing).toBe(dozoAvatarSvg(dozoCharacterForLook("bot-1", color)));
    }
  });

  it("is the one the package exports, in place of upstream's drawing", () => {
    expect(core.notificationAvatarSource).toBe(notificationAvatarSource);
    expect(core.DOZO_CHARACTERS).toBe(DOZO_CHARACTERS);
  });
});

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
      const channels = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      const order = (hex: string) => channels(hex).map((v, _, all) => all.filter((o) => o < v).length);
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
