import { BOT_COLOR_LIST } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  DOZO_AVATAR_ART,
  DOZO_BOT_PALETTE,
  DOZO_CHARACTERS,
  dozoAvatarSvg,
  dozoCharacterForLook,
  dozoCharacterForSeed,
  dozoHashSeed,
  notificationAvatarSource,
} from "./dozo-avatar-art.js";
import * as core from "./index.js";

const hexOf = (id: string) => BOT_COLOR_LIST.find((color) => color.id === id)?.hex as string;
const PHOTO = "data:image/png;base64,iVBORw0KGgo=";

describe("Dozo avatar art", () => {
  it("draws every character with a head, a visor and eyes", () => {
    for (const character of DOZO_CHARACTERS) {
      const shapes = DOZO_AVATAR_ART[character];
      expect(shapes.some(([part, , paint]) => part === "head" && paint === "body")).toBe(true);
      expect(shapes.filter(([, , paint]) => paint === "visor")).toHaveLength(1);
      expect(shapes.some(([part]) => part === "eyes")).toBe(true);
      expect(shapes.some(([part]) => part === "feature")).toBe(true);
    }
  });

  it("gives each character its own tile and glow", () => {
    const tiles = DOZO_CHARACTERS.flatMap((name) => DOZO_BOT_PALETTE[name].tile);
    expect(new Set(tiles).size).toBe(12);
    expect(new Set(DOZO_CHARACTERS.map((name) => DOZO_BOT_PALETTE[name].glow)).size).toBe(6);
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
  ])("draws upstream's %s as %s, the closest tile in hue", (id, character) => {
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
  it("is one tile with the character's shapes, inked for a light page", () => {
    for (const character of DOZO_CHARACTERS) {
      const svg = dozoAvatarSvg(character);
      const { tile, glow } = DOZO_BOT_PALETTE[character];
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="96" height="96"/);
      expect(svg).toContain(`<rect width="64" height="64" rx="18" fill="${tile[0]}"/>`);
      expect(svg).toContain(glow);
      expect(svg).not.toContain(tile[1]);
      expect(svg).not.toContain("undefined");
      expect(svg.match(/<(?:rect|circle|ellipse|path) /g)).toHaveLength(
        DOZO_AVATAR_ART[character].length + 1,
      );
    }
    expect(dozoAvatarSvg("sora", 40)).toContain('width="40" height="40"');
  });

  it("strokes line eyes and paints Taro's band in the tile colour", () => {
    expect(dozoAvatarSvg("mochi")).toMatch(
      /<path d="[^"]+" fill="none" stroke-width="2\.6" stroke-linecap="round" stroke="#b8f0f0"\/>/i,
    );
    expect(dozoAvatarSvg("taro")).toContain(
      `<rect x="18" y="26" width="28" height="4" fill="${DOZO_BOT_PALETTE.taro.tile[0]}"/>`,
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
