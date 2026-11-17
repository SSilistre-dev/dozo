import { BotAvatarValueSchema, parseBotAvatarValue } from "@rakazo/contracts";
import { darkTokens } from "@rakazo/ui-tokens";
import { resolvePersonaColorDef } from "./bot-avatar-colors.js";

export const DOZO_CHARACTERS = ["sora", "kumo", "hana", "taro", "yuki", "mochi"] as const;
export type DozoCharacter = (typeof DOZO_CHARACTERS)[number];

/**
 * The Dozo bot identity palette, the only place the avatar's identity colours are written down:
 * the colour of each character's accessory, for a light page and for a dark one. Upstream's
 * `botColors` in `@rakazo/ui-tokens` could not be used: it holds seven colours instead of six,
 * with other hues.
 */
export const DOZO_BOT_PALETTE: Record<DozoCharacter, readonly [light: string, dark: string]> = {
  sora: ["#3f7fcb", "#4f8fd8"],
  kumo: ["#8f6bcb", "#a07ed8"],
  hana: ["#3f9468", "#4fa37a"],
  taro: ["#c4872f", "#d19a45"],
  yuki: ["#d26a59", "#dc7a6a"],
  mochi: ["#2f9297", "#3fa3a8"],
};

/** What fills a shape: the head's ink, the same ink as a stroke, or the character's colour. */
export type DozoPaint = "body" | "line" | "accent";
/** One drawn element: the group it moves with, its SVG tag, what paints it, its attributes. */
export type DozoShape = readonly [
  part: "head" | "feature" | "eyes",
  tag: "rect" | "circle" | "ellipse" | "path",
  paint: DozoPaint,
  attrs: Readonly<Record<string, string | number>>,
];

/**
 * The six drawings on a 64 x 64 canvas, back to front, the same as the design mockups
 * (`dozo/design/dozo.js`). Each is a sibling of the brand mark: a soft head whose tilted visor is a
 * hole in the head path (painted even-odd, so the surface behind shows through), two eyes in the
 * head's ink, and one accessory. Sora wears a kasa hat, Kumo has kitsune ears, Hana a bun and a
 * kanzashi pin, Taro a hachimaki, Yuki the ears of a snow rabbit, Mochi the tanuki's leaf.
 */
export const DOZO_AVATAR_ART: Record<DozoCharacter, readonly DozoShape[]> = {
  sora: [
    [
      "head",
      "path",
      "body",
      {
        d: "M32 24L43 24C50.04 24 54 27.96 54 35L54 38C54 52.08 46.08 60 32 60L21 60C13.96 60 10 56.04 10 49L10 46C10 31.92 17.92 24 32 24ZM21.76 38.71L40.66 36.39A5.98 5.98 0 0 1 47.32 41.59L47.45 42.63A5.98 5.98 0 0 1 42.24 49.29L23.34 51.61A5.98 5.98 0 0 1 16.68 46.41L16.55 45.37A5.98 5.98 0 0 1 21.76 38.71Z",
      },
    ],
    [
      "feature",
      "path",
      "accent",
      {
        d: "M29.57 7.26Q32 5.5 34.43 7.26L58.57 24.74Q61 26.5 58 26.5L6 26.5Q3 26.5 5.43 24.74Z",
        transform: "rotate(-6 32 24)",
      },
    ],
    ["eyes", "circle", "body", { cx: 26.64, cy: 44.66, r: 2.9 }],
    ["eyes", "circle", "body", { cx: 37.36, cy: 43.34, r: 2.9 }],
  ],
  kumo: [
    [
      "feature",
      "path",
      "body",
      { d: "M12.9 36.34Q10.4 38 10.55 35L11.85 9.5Q12 6.5 14.23 8.5L29.27 22Q31.5 24 29 25.66Z" },
    ],
    [
      "feature",
      "path",
      "body",
      { d: "M51.1 36.34Q53.6 38 53.45 35L52.15 9.5Q52 6.5 49.77 8.5L34.73 22Q32.5 24 35 25.66Z" },
    ],
    [
      "feature",
      "path",
      "accent",
      {
        d: "M16.08 24.38Q14.6 25 14.68 23.4L15.12 15.1Q15.2 13.5 16.32 14.65L21.88 20.35Q23 21.5 21.52 22.12Z",
      },
    ],
    [
      "feature",
      "path",
      "accent",
      {
        d: "M47.92 24.38Q49.4 25 49.32 23.4L48.88 15.1Q48.8 13.5 47.68 14.65L42.12 20.35Q41 21.5 42.48 22.12Z",
      },
    ],
    [
      "head",
      "path",
      "body",
      {
        d: "M22 21L42 21C49.68 21 54 25.32 54 33L54 37C54 51.08 46.08 59 32 59L26 59C15.76 59 10 53.24 10 43L10 33C10 25.32 14.32 21 22 21ZM21.76 36.21L40.66 33.89A5.98 5.98 0 0 1 47.32 39.09L47.45 40.13A5.98 5.98 0 0 1 42.24 46.79L23.34 49.11A5.98 5.98 0 0 1 16.68 43.91L16.55 42.87A5.98 5.98 0 0 1 21.76 36.21Z",
      },
    ],
    [
      "eyes",
      "ellipse",
      "body",
      { cx: 26.64, cy: 42.16, rx: 2.4, ry: 3.4, transform: "rotate(-7 26.64 42.16)" },
    ],
    [
      "eyes",
      "ellipse",
      "body",
      { cx: 37.36, cy: 40.84, rx: 2.4, ry: 3.4, transform: "rotate(-7 37.36 40.84)" },
    ],
  ],
  hana: [
    [
      "head",
      "rect",
      "accent",
      { x: 38, y: 15.6, width: 21, height: 2.8, rx: 1.4, transform: "rotate(-38 38 17)" },
    ],
    ["feature", "circle", "accent", { cx: 55.0, cy: 3.0, r: 2.5 }],
    ["feature", "circle", "accent", { cx: 58.04, cy: 5.21, r: 2.5 }],
    ["feature", "circle", "accent", { cx: 56.88, cy: 8.79, r: 2.5 }],
    ["feature", "circle", "accent", { cx: 53.12, cy: 8.79, r: 2.5 }],
    ["feature", "circle", "accent", { cx: 51.96, cy: 5.21, r: 2.5 }],
    ["feature", "circle", "body", { cx: 55, cy: 6.2, r: 1.5 }],
    ["head", "circle", "body", { cx: 41.5, cy: 16.5, r: 7.6 }],
    [
      "head",
      "path",
      "body",
      {
        d: "M31 21L35 21C45.88 21 52 27.12 52 38L52 37C52 51.72 43.72 60 29 60L25 60C14.12 60 8 53.88 8 43L8 44C8 29.28 16.28 21 31 21ZM19.76 36.21L38.66 33.89A5.98 5.98 0 0 1 45.32 39.09L45.45 40.13A5.98 5.98 0 0 1 40.24 46.79L21.34 49.11A5.98 5.98 0 0 1 14.68 43.91L14.55 42.87A5.98 5.98 0 0 1 19.76 36.21Z",
      },
    ],
    ["eyes", "circle", "body", { cx: 24.64, cy: 42.16, r: 2.9 }],
    ["eyes", "circle", "body", { cx: 35.36, cy: 40.84, r: 2.9 }],
  ],
  taro: [
    [
      "head",
      "path",
      "body",
      {
        d: "M26 10L38 10C46.32 10 51 14.68 51 23L51 38C51 50.16 44.16 57 32 57L24 57C14.4 57 9 51.6 9 42L9 27C9 16.12 15.12 10 26 10ZM20.75 32.59L37.66 30.51A5.98 5.98 0 0 1 44.33 35.72L44.46 36.75A5.98 5.98 0 0 1 39.25 43.41L22.34 45.49A5.98 5.98 0 0 1 15.67 40.28L15.54 39.25A5.98 5.98 0 0 1 20.75 32.59Z",
      },
    ],
    [
      "head",
      "rect",
      "accent",
      { x: 8, y: 20.8, width: 44, height: 4.6, rx: 1.4, transform: "rotate(-7 30 23.1)" },
    ],
    [
      "feature",
      "path",
      "accent",
      {
        d: "M0 -0.3Q0 -1.1 0.79 -1.19L12.21 -2.51Q13 -2.6 12.58 -1.92L11.82 -0.68Q11.4 0 11.82 0.68L12.58 1.92Q13 2.6 12.21 2.51L0.79 1.19Q0 1.1 0 0.3Z",
        transform: "translate(51.6 20.6) rotate(-46)",
      },
    ],
    [
      "feature",
      "path",
      "accent",
      {
        d: "M0 -0.3Q0 -1.1 0.79 -1.2L11.21 -2.5Q12 -2.6 11.58 -1.92L10.82 -0.68Q10.4 0 10.82 0.68L11.58 1.92Q12 2.6 11.21 2.5L0.79 1.2Q0 1.1 0 0.3Z",
        transform: "translate(51.6 20.6) rotate(8)",
      },
    ],
    [
      "feature",
      "rect",
      "accent",
      { x: 48.2, y: 17.2, width: 6.8, height: 6.8, rx: 2.2, transform: "rotate(-7 51.6 20.6)" },
    ],
    ["eyes", "circle", "body", { cx: 24.64, cy: 38.66, r: 2.9 }],
    ["eyes", "circle", "body", { cx: 35.36, cy: 37.34, r: 2.9 }],
  ],
  yuki: [
    [
      "feature",
      "ellipse",
      "body",
      { cx: 25, cy: 16, rx: 4.6, ry: 12, transform: "rotate(-9 25 26)" },
    ],
    [
      "feature",
      "ellipse",
      "accent",
      { cx: 25, cy: 16, rx: 1.9, ry: 7.2, transform: "rotate(-9 25 26)" },
    ],
    [
      "feature",
      "ellipse",
      "body",
      { cx: 40, cy: 16, rx: 4.6, ry: 12, transform: "rotate(56 40 26)" },
    ],
    [
      "feature",
      "ellipse",
      "accent",
      { cx: 40, cy: 16, rx: 1.9, ry: 7.2, transform: "rotate(56 40 26)" },
    ],
    [
      "head",
      "path",
      "body",
      {
        d: "M31 22L38 22C48.88 22 55 28.12 55 39L55 37C55 51.08 47.08 59 33 59L26 59C15.12 59 9 52.88 9 42L9 44C9 29.92 16.92 22 31 22ZM21.46 35.99L40.89 33.61A6.21 6.21 0 0 1 47.81 39.01L47.95 40.09A6.21 6.21 0 0 1 42.54 47.01L23.11 49.39A6.21 6.21 0 0 1 16.19 43.99L16.05 42.91A6.21 6.21 0 0 1 21.46 35.99Z",
      },
    ],
    ["eyes", "circle", "body", { cx: 26.64, cy: 42.16, r: 2.9 }],
    ["eyes", "path", "line", { d: "M34.31 42.22Q37.07 38.46 40.66 41.44" }],
  ],
  mochi: [
    [
      "feature",
      "path",
      "accent",
      {
        d: "M0 0C6.2-4.6 6.2-13.4 0-20C-6.2-13.4-6.2-4.6 0 0Z",
        transform: "translate(33 30) rotate(26)",
      },
    ],
    [
      "head",
      "path",
      "body",
      {
        d: "M27 26L42 26C51.6 26 57 31.4 57 41L57 44C57 53.6 51.6 59 42 59L18 59C10.96 59 7 55.04 7 48L7 46C7 33.2 14.2 26 27 26ZM20.57 38.61L41.91 35.99A5.75 5.75 0 0 1 48.32 40.99L48.44 41.99A5.75 5.75 0 0 1 43.43 48.39L22.09 51.01A5.75 5.75 0 0 1 15.68 46.01L15.56 45.01A5.75 5.75 0 0 1 20.57 38.61Z",
      },
    ],
    ["eyes", "path", "line", { d: "M23.86 46.11Q26.27 41.18 29.81 45.38" }],
    ["eyes", "path", "line", { d: "M34.58 44.8Q36.99 39.86 40.53 44.06" }],
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
 * otherwise it is the character whose colour is closest in hue to the bot's colour, so the colour
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
    hueDistance(hue, hueOf(DOZO_BOT_PALETTE[name][1]) as number) <
    hueDistance(hue, hueOf(DOZO_BOT_PALETTE[best][1]) as number)
      ? name
      : best,
  );
}

/**
 * A still drawing for surfaces without the web component. It stands on a dark tile, like the app
 * icon, because a notification gives no say over the surface behind it.
 */
export function dozoAvatarSvg(character: DozoCharacter, size = 96): string {
  const ink = darkTokens.foreground;
  const fill: Record<DozoPaint, string> = {
    body: `fill="${ink}" fill-rule="evenodd"`,
    line: `fill="none" stroke-width="2.6" stroke-linecap="round" stroke="${ink}"`,
    accent: `fill="${DOZO_BOT_PALETTE[character][1]}"`,
  };
  const shapes = DOZO_AVATAR_ART[character].map(([, tag, paint, attrs]) => {
    const drawn = Object.entries(attrs).map(([name, value]) => `${name}="${value}"`);
    return `<${tag} ${drawn.join(" ")} ${fill[paint]}/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="${darkTokens.background}"/><g transform="translate(32 33) scale(0.78) translate(-32 -32.5)">${shapes.join("")}</g></svg>`;
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
