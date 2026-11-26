import { readFileSync } from "node:fs";
import { BOT_COLOR_LIST } from "@rakazo/contracts";
import { darkTokens } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";
import {
  DOZO_AVATAR_ART,
  DOZO_AVATAR_MOTION,
  DOZO_BOT_PALETTE,
  DOZO_CHARACTERS,
  dozoAvatarFrame,
  dozoAvatarLayout,
  dozoAvatarSvg,
  dozoBlinkPeriod,
  dozoBotColor,
  dozoCharacterForLook,
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

describe("the colour a bot wears", () => {
  it("is the colour picked for it, as #rrggbb, whatever shape it has", () => {
    for (const { id, hex } of BOT_COLOR_LIST) {
      const want = id === "white" ? undefined : hex.toLowerCase();
      expect(dozoBotColor("bot-1", hex)).toBe(want);
      expect(dozoBotColor("bot-2", `${hex}::shape_3`)).toBe(want);
    }
    expect(dozoBotColor("bot-1", "#07F")).toBe("#0077ff");
    expect(dozoBotColor("bot-1", "blue")).toBe(hexOf("blue").toLowerCase());
  });

  it("is the one upstream assigns a bot with no valid colour, the same every time", () => {
    for (const value of [undefined, null, "", "nonsense"]) {
      expect(dozoBotColor("bot-1", value)).toBe(dozoBotColor("bot-1", undefined));
    }
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
      expect(drawing).toBe(
        dozoAvatarSvg(dozoCharacterForLook("bot-1", color), 96, dozoBotColor("bot-1", color)),
      );
    }
  });

  it("paints the accessory in the bot's own colour, and a white bot's in the head's ink", () => {
    const drawing = (color: string) => {
      const source = notificationAvatarSource({ id: "bot-1", color });
      return decodeURIComponent(source.slice(source.indexOf(",") + 1));
    };
    expect(drawing(hexOf("magenta"))).toContain(`fill="${hexOf("magenta").toLowerCase()}"/>`);
    expect(drawing(hexOf("white"))).not.toMatch(/fill="#(?!FFFFFF|141414)/i);
  });

  it("is the one the package exports, in place of upstream's drawing", () => {
    expect(core.notificationAvatarSource).toBe(notificationAvatarSource);
    expect(core.DOZO_CHARACTERS).toBe(DOZO_CHARACTERS);
  });
});

describe("the groups that move together", () => {
  it("are the ones the web drawing makes, for every character", () => {
    const webGroups = (character: (typeof DOZO_CHARACTERS)[number]) => {
      const runs: [string, number][] = [];
      for (const [part] of DOZO_AVATAR_ART[character]) {
        const last = runs[runs.length - 1];
        if (last?.[0] === part && part !== "head") last[1] += 1;
        else runs.push([part, 1]);
      }
      return runs;
    };
    for (const character of DOZO_CHARACTERS) {
      const layout = dozoAvatarLayout(character);
      expect(layout.map(({ part, shapes }) => [part, shapes.length])).toEqual(webGroups(character));
      expect(layout.flatMap(({ shapes }) => shapes)).toEqual(DOZO_AVATAR_ART[character]);
      expect(dozoAvatarLayout(character)).toBe(layout);
    }
    expect(dozoAvatarLayout("hana").map(({ part }) => part)).toEqual([
      "head",
      "feature",
      "head",
      "head",
      "eyes",
    ]);
  });

  it("scale around the middle of the eyes and the foot of an accessory", () => {
    const sora = dozoAvatarLayout("sora");
    const eyes = sora.find(({ part }) => part === "eyes");
    // Two eyes at x 26.64 and 37.36, y 43.34 and 44.66, radius 2.9.
    expect(eyes?.originX).toBeCloseTo(32, 5);
    expect(eyes?.originY).toBeCloseTo(44, 5);
    const hat = sora.find(({ part }) => part === "feature");
    expect(hat?.originX).toBeGreaterThan(30.5);
    expect(hat?.originX).toBeLessThan(33.5);
    // The foot of the tilted hat, not its crown.
    expect(hat?.originY).toBeGreaterThan(28);
    expect(hat?.originY).toBeLessThan(30);
    const mochiLeaf = dozoAvatarLayout("mochi")[0];
    // A leaf drawn from its own origin: translate(33 30), rotate 26, 20 units tall.
    expect(mochiLeaf?.originY).toBeCloseTo(30, 0);
    expect(dozoAvatarLayout("yuki")[0]?.shapes).toHaveLength(4);
  });
});

describe("the avatar's motion", () => {
  const seed = "bot-1";
  const hash = dozoHashSeed(seed);
  const open = { headY: 0, featureScale: 1, featureOpacity: 1, eyeScaleY: 1 };

  it("closes the eyes at the blink's low point and opens them well before it", () => {
    const period = dozoBlinkPeriod(seed);
    const offset = (((hash >>> 16) % 100) / 100) * period;
    const at = (share: number) => share * period - offset;
    expect(dozoAvatarFrame("sora", "working", at(0.985), seed).eyeScaleY).toBeCloseTo(0.1, 5);
    expect(dozoAvatarFrame("sora", "waiting", at(0.985), seed).eyeScaleY).toBeCloseTo(0.1, 5);
    expect(dozoAvatarFrame("sora", "working", at(0.5), seed).eyeScaleY).toBe(1);
    expect(dozoAvatarFrame("sora", "working", at(0.9999), seed).eyeScaleY).toBeGreaterThan(0.99);
  });

  it("keeps a sleeper's eyes half shut and the rest still, at any moment", () => {
    for (const seconds of [0, 1.7, 40, -3]) {
      expect(dozoAvatarFrame("hana", "idle", seconds, seed)).toEqual({
        ...open,
        eyeScaleY: DOZO_AVATAR_MOTION.sleepScale,
      });
    }
    expect(DOZO_AVATAR_MOTION.sleepScale).toBe(0.3);
  });

  it("raises a working bot's head at the middle of its bob and lets the accessory pulse", () => {
    const bob = dozoAvatarFrame("hana", "working", 1.6 - (hash % 30) / 10, seed);
    expect(bob.headY).toBeCloseTo(-2.2, 5);
    const start = dozoAvatarFrame("hana", "working", 0, seed);
    expect(start.featureScale).toBe(1);
    expect(start.featureOpacity).toBe(1);
    const glow = dozoAvatarFrame("hana", "working", 1.2, seed);
    expect(glow.featureScale).toBeCloseTo(1.25, 5);
    expect(glow.featureOpacity).toBeCloseTo(0.5, 5);
    // The ears of a character that does not fade stay opaque.
    expect(dozoAvatarFrame("kumo", "working", 1.2, seed).featureOpacity).toBe(1);
  });

  it("nudges the accessory of a bot waiting on you, once in each cycle, and keeps the head still", () => {
    const peak = dozoAvatarFrame("hana", "waiting", 0.8 * 4.5, seed);
    expect(peak.featureScale).toBeCloseTo(1.6, 5);
    expect(peak.featureOpacity).toBeCloseTo(0.5, 5);
    expect(peak.headY).toBe(0);
    for (const share of [0, 0.5, 0.68, 0.92, 0.99]) {
      const rest = dozoAvatarFrame("hana", "waiting", share * 4.5, seed);
      expect([rest.featureScale, rest.featureOpacity]).toEqual([1, 1]);
    }
    const half = dozoAvatarFrame("hana", "waiting", 0.74 * 4.5, seed);
    expect(half.featureScale).toBeGreaterThan(1);
    expect(half.featureScale).toBeLessThan(1.6);
    const after = dozoAvatarFrame("hana", "waiting", 0.86 * 4.5, seed);
    expect(after.featureScale).toBeGreaterThan(1);
    expect(after.featureScale).toBeLessThan(1.6);
  });

  it("gives every seed a blink period of four to six seconds", () => {
    for (let i = 0; i < 50; i++) {
      const period = dozoBlinkPeriod(`bot-${i}`);
      expect(period).toBeGreaterThanOrEqual(4);
      expect(period).toBeLessThan(6);
    }
  });
});

describe("the motion the stylesheet declares", () => {
  const css = readFileSync(new URL("../../ui-web/src/dozo-avatar.css", import.meta.url), "utf8");

  it("is the motion the mobile drawing plays, per character", () => {
    const declared: Record<string, Record<string, number>> = {};
    for (const [, selector, body] of css.matchAll(
      /\.dozo-avatar(?::is\()?(\[data-character[^{]*)\{([^}]*)\}/g,
    )) {
      for (const [, name] of (selector as string).matchAll(/data-character="(\w+)"/g)) {
        const variables = Object.fromEntries(
          [...(body as string).matchAll(/--dozo-(pulse|attn|dim):\s*([\d.]+)/g)].map(
            ([, variable, value]) => [variable, Number(value)],
          ),
        );
        declared[name as string] = { ...declared[name as string], ...variables };
      }
    }
    // A character that declares no --dozo-dim fades to the fallback written in the keyframes.
    expect(css).toContain("var(--dozo-dim, 0.5)");
    const fallback = { dim: 0.5 };
    expect(Object.keys(declared).sort()).toEqual([...DOZO_CHARACTERS].sort());
    for (const name of DOZO_CHARACTERS) {
      expect(DOZO_AVATAR_MOTION.characters[name]).toEqual({ ...fallback, ...declared[name] });
    }
  });

  it("has the timings the mobile drawing plays", () => {
    const motion = DOZO_AVATAR_MOTION;
    expect(css).toContain(`dozo-bob ${motion.bobSeconds}s`);
    expect(css).toContain(`dozo-glow ${motion.glowSeconds}s`);
    expect(css).toContain(`dozo-attn ${motion.attnSeconds}s`);
    expect(css).toContain(`translateY(${motion.bobRise}px)`);
    expect(css).toContain(`scaleY(${motion.blinkScale})`);
    expect(css).toContain("transform: scaleY(0.3)");
    const percent = (share: number) => `${Number((share * 100).toFixed(1))}%`;
    const [from, shut] = motion.blinkKeyframes;
    expect(css).toMatch(new RegExp(`0%,\\s*${percent(from)},\\s*100%`));
    expect(css).toContain(`${percent(shut)} {`);
    const attn = css.slice(css.indexOf("@keyframes dozo-attn"));
    const [, rise, peak, fall] = motion.attnKeyframes;
    expect(attn).toMatch(new RegExp(`0%,\\s*${percent(rise)},\\s*100%`));
    expect(attn).toContain(`${percent(peak)} {`);
    expect(attn).toContain(`${percent(fall)} {`);
  });
});
