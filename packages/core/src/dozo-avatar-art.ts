import { BotAvatarValueSchema, parseBotAvatarValue } from "@rakazo/contracts";
import { lightTokens } from "@rakazo/ui-tokens";
import { resolvePersonaColorDef } from "./bot-avatar-colors.js";

export const DOZO_CHARACTERS = ["sora", "kumo", "hana", "taro", "yuki", "mochi"] as const;
export type DozoCharacter = (typeof DOZO_CHARACTERS)[number];

/**
 * The Dozo bot identity palette, the only place the avatar's identity colours are written down:
 * a tile colour (light page, dark page) and an eye glow per character. Upstream's `botColors` and
 * `botEyeColor` in `@rakazo/ui-tokens` could not be used: they hold seven colours instead of six,
 * with other hues, and one dark eye ink, while these eyes glow light on a dark visor.
 */
export const DOZO_BOT_PALETTE: Record<
  DozoCharacter,
  { readonly tile: readonly [light: string, dark: string]; readonly glow: string }
> = {
  sora: { tile: ["#3f7fcb", "#4f8fd8"], glow: "#bfe0ff" },
  kumo: { tile: ["#8f6bcb", "#a07ed8"], glow: "#e2d6ff" },
  hana: { tile: ["#3f9468", "#4fa37a"], glow: "#c4f2d9" },
  taro: { tile: ["#c4872f", "#d19a45"], glow: "#ffe2ae" },
  yuki: { tile: ["#d26a59", "#dc7a6a"], glow: "#ffd0c6" },
  mochi: { tile: ["#2f9297", "#3fa3a8"], glow: "#b8f0f0" },
};

export type DozoPaint = "body" | "visor" | "glow" | "glow-line" | "band";
/** One drawn element: the group it moves with, its SVG tag, what paints it, its attributes. */
export type DozoShape = readonly [
  part: "head" | "feature" | "eyes",
  tag: "rect" | "circle" | "ellipse" | "path",
  paint: DozoPaint,
  attrs: Readonly<Record<string, string | number>>,
];

/** The six drawings on a 64 x 64 tile, back to front, ported from the design mockups. */
export const DOZO_AVATAR_ART: Record<DozoCharacter, readonly DozoShape[]> = {
  sora: [
    ["head", "rect", "body", { x: 30.5, y: 9, width: 3, height: 10, rx: 1.5 }],
    ["feature", "circle", "glow", { cx: 32, cy: 9, r: 3.5 }],
    ["head", "circle", "body", { cx: 32, cy: 36, r: 18 }],
    ["head", "rect", "visor", { x: 20, y: 30, width: 24, height: 13, rx: 6.5 }],
    ["eyes", "circle", "glow", { cx: 27, cy: 36.5, r: 2.6 }],
    ["eyes", "circle", "glow", { cx: 37, cy: 36.5, r: 2.6 }],
  ],
  kumo: [
    ["feature", "rect", "body", { x: 22, y: 11, width: 3, height: 10, rx: 1.5 }],
    ["feature", "rect", "body", { x: 39, y: 11, width: 3, height: 10, rx: 1.5 }],
    ["head", "rect", "body", { x: 15, y: 20, width: 34, height: 30, rx: 9 }],
    ["head", "rect", "visor", { x: 20, y: 28, width: 24, height: 14, rx: 5 }],
    ["eyes", "rect", "glow", { x: 23.5, y: 34.5, width: 6, height: 3, rx: 1.5 }],
    ["eyes", "rect", "glow", { x: 34.5, y: 34.5, width: 6, height: 3, rx: 1.5 }],
  ],
  hana: [
    ["head", "rect", "body", { x: 30, y: 17, width: 4, height: 8 }],
    ["feature", "circle", "glow", { cx: 32, cy: 15, r: 3.5 }],
    ["head", "rect", "body", { x: 10, y: 24, width: 44, height: 26, rx: 13 }],
    ["head", "rect", "visor", { x: 16, y: 30, width: 32, height: 14, rx: 7 }],
    ["eyes", "rect", "glow", { x: 21, y: 35.2, width: 22, height: 3.6, rx: 1.8 }],
  ],
  taro: [
    ["head", "rect", "body", { x: 18, y: 12, width: 28, height: 42, rx: 13 }],
    ["feature", "rect", "band", { x: 18, y: 26, width: 28, height: 4 }],
    ["head", "rect", "visor", { x: 22, y: 33, width: 20, height: 15, rx: 7 }],
    ["eyes", "ellipse", "glow", { cx: 28, cy: 40.5, rx: 2.3, ry: 3.3 }],
    ["eyes", "ellipse", "glow", { cx: 36, cy: 40.5, rx: 2.3, ry: 3.3 }],
  ],
  yuki: [
    ["feature", "circle", "body", { cx: 12, cy: 35, r: 4.5 }],
    ["feature", "circle", "body", { cx: 52, cy: 35, r: 4.5 }],
    ["head", "rect", "body", { x: 14, y: 18, width: 36, height: 34, rx: 16 }],
    ["head", "rect", "visor", { x: 19, y: 27, width: 26, height: 15, rx: 7.5 }],
    ["eyes", "circle", "glow", { cx: 27, cy: 34.5, r: 2.7 }],
    ["eyes", "path", "glow-line", { d: "M33.5 35q3.5-3.4 7 0" }],
  ],
  mochi: [
    [
      "feature",
      "ellipse",
      "glow",
      { cx: 41, cy: 13, rx: 3, ry: 8.5, transform: "rotate(28 41 13)" },
    ],
    ["head", "rect", "body", { x: 15, y: 21, width: 34, height: 30, rx: 11 }],
    ["head", "rect", "visor", { x: 20, y: 29, width: 24, height: 14, rx: 7 }],
    ["eyes", "path", "glow-line", { d: "M24 38q3-5 6 0M34 38q3-5 6 0" }],
  ],
};

export function dozoHashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A seed that is a character's own name gets that character; any other seed is hashed. */
export function dozoCharacterForSeed(seed: string): DozoCharacter {
  const key = seed.trim().toLowerCase();
  return (
    DOZO_CHARACTERS.find((name) => name === key) ??
    (DOZO_CHARACTERS[dozoHashSeed(key) % DOZO_CHARACTERS.length] as DozoCharacter)
  );
}

/** Hue in degrees, or undefined for a colour too grey to have one. */
function hueOf(hex: string): number | undefined {
  const digits = hex.length === 4 ? [...hex.slice(1)].map((c) => c + c).join("") : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(digits.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const spread = max - Math.min(r, g, b);
  if (spread < 0.12) return undefined;
  const sixth =
    max === r ? ((g - b) / spread) % 6 : max === g ? (b - r) / spread + 2 : (r - g) / spread + 4;
  return (sixth * 60 + 360) % 360;
}

const hueDistance = (a: number, b: number) => 180 - Math.abs(Math.abs(a - b) - 180);

/**
 * The character a bot is drawn as. A shape picked in the avatar editor names one directly;
 * otherwise it is the character whose tile is closest in hue to the bot's colour, so the colour
 * picker still changes the avatar; a colourless bot (white, grey) falls back to its identity.
 */
export function dozoCharacterForLook(identity: string, avatarValue?: string | null): DozoCharacter {
  const parsed = avatarValue ? parseBotAvatarValue(avatarValue) : undefined;
  if (parsed?.kind === "shape") {
    return DOZO_CHARACTERS[parsed.shapeIndex % DOZO_CHARACTERS.length] as DozoCharacter;
  }
  const explicit = parsed && "color" in parsed ? parsed.color : avatarValue;
  const hue = hueOf(resolvePersonaColorDef(identity, explicit).hex);
  if (hue === undefined) return dozoCharacterForSeed(identity);
  return DOZO_CHARACTERS.reduce((best, name) =>
    hueDistance(hue, hueOf(DOZO_BOT_PALETTE[name].tile[1]) as number) <
    hueDistance(hue, hueOf(DOZO_BOT_PALETTE[best].tile[1]) as number)
      ? name
      : best,
  );
}

const GLOW_LINE = 'fill="none" stroke-width="2.6" stroke-linecap="round"';

/** A still drawing for surfaces without the web component, inked for a light page. */
export function dozoAvatarSvg(character: DozoCharacter, size = 96): string {
  const { tile, glow } = DOZO_BOT_PALETTE[character];
  const fill: Record<DozoPaint, string> = {
    body: `fill="${lightTokens.background}"`,
    visor: `fill="${lightTokens.foreground}"`,
    glow: `fill="${glow}"`,
    "glow-line": `${GLOW_LINE} stroke="${glow}"`,
    band: `fill="${tile[0]}"`,
  };
  const shapes = DOZO_AVATAR_ART[character].map(([, tag, paint, attrs]) => {
    const drawn = Object.entries(attrs).map(([name, value]) => `${name}="${value}"`);
    return `<${tag} ${drawn.join(" ")} ${fill[paint]}/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="${tile[0]}"/>${shapes.join("")}</svg>`;
}

/** A static notification portrait: the bot's saved photo, or the character it is drawn as. */
export function notificationAvatarSource(bot: { id: string; color: string }): string {
  const parsed = BotAvatarValueSchema.safeParse(bot.color).success
    ? parseBotAvatarValue(bot.color)
    : undefined;
  if (parsed?.kind === "image") return parsed.imageUrl;
  const drawing = dozoAvatarSvg(dozoCharacterForLook(bot.id, bot.color));
  return `data:image/svg+xml,${encodeURIComponent(drawing)}`;
}
