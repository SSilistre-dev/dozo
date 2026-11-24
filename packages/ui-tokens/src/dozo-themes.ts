import type { ResolvedAppearance, WebColorTokens } from "./index.js";
import { cssVariableName } from "./index.js";

/**
 * The named themes of Settings > Appearance (dozo/design/themes-v2.css). Each is a tint of the
 * neutral surfaces and ink of Light or Dark, nothing more: the main button stays ink, status
 * colours and bot identity colours never change. The mockup's per-theme accent is left out, as
 * the product is monochrome. Where the mockup's surface would read upstream's destructive or link
 * text worse than the default of its tone does, that surface is moved just far enough toward the
 * default (the light sidebars, Yoru's popover). `mutedForeground` and `faintForeground` are the ink mixed over the
 * background at the mockup's second and third ink steps; the test holds every step's contrast.
 */
export type DozoThemePalette = {
  sidebar: string;
  background: string;
  card: string;
  popover: string;
  foreground: string;
  mutedForeground: string;
  faintForeground: string;
};

export type DozoTheme = {
  id: string;
  /** A name, shown as it is in every language. */
  label: string;
  tone: ResolvedAppearance;
  palette: DozoThemePalette;
};

export const DOZO_THEMES = [
  {
    id: "sumi",
    label: "Sumi",
    tone: "dark",
    palette: {
      sidebar: "#070708",
      background: "#0e0e10",
      card: "#18181b",
      popover: "#202024",
      foreground: "#e8e8ea",
      mutedForeground: "#a7a7a9",
      faintForeground: "#88888a",
    },
  },
  {
    id: "yoru",
    label: "Yoru",
    tone: "dark",
    palette: {
      sidebar: "#0b0e15",
      background: "#111621",
      card: "#1a2030",
      popover: "#1e2636",
      foreground: "#e6e9f0",
      mutedForeground: "#aaaeb6",
      faintForeground: "#91959d",
    },
  },
  {
    id: "hoji",
    label: "Hoji",
    tone: "dark",
    palette: {
      sidebar: "#110d0a",
      background: "#18130f",
      card: "#231c17",
      popover: "#2b231d",
      foreground: "#efe7de",
      mutedForeground: "#aea7a0",
      faintForeground: "#979089",
    },
  },
  {
    id: "washi",
    label: "Washi",
    tone: "light",
    palette: {
      sidebar: "#f1ece0",
      background: "#f5f0e6",
      card: "#fbf8f2",
      popover: "#fffdf8",
      foreground: "#2a2420",
      mutedForeground: "#534d48",
      faintForeground: "#655f59",
    },
  },
  {
    id: "matcha",
    label: "Matcha",
    tone: "light",
    palette: {
      sidebar: "#eaeee4",
      background: "#eff2ea",
      card: "#f8faf5",
      popover: "#fdfefb",
      foreground: "#1e2a20",
      mutedForeground: "#485248",
      faintForeground: "#5b645b",
    },
  },
  {
    id: "kasumi",
    label: "Kasumi",
    tone: "light",
    palette: {
      sidebar: "#e9edf0",
      background: "#eff2f5",
      card: "#f9fafc",
      popover: "#fdfeff",
      foreground: "#1d2530",
      mutedForeground: "#474e57",
      faintForeground: "#5a6069",
    },
  },
] as const satisfies readonly DozoTheme[];

export type DozoThemeId = (typeof DOZO_THEMES)[number]["id"];

/**
 * Light and Dark as the fork's theme file paints them (dozo/theme/theme.json; olc's
 * dozo/e2e/theme-defaults.test.mjs holds the two equal): the swatches and the contrast test read
 * them, and every named theme is measured against the default of its tone.
 */
export const DOZO_DEFAULT_PALETTES: Record<
  ResolvedAppearance,
  DozoThemePalette & { chatUser: string }
> = {
  dark: {
    sidebar: "#0a0a0a",
    background: "#141414",
    card: "#1f1f1f",
    popover: "#262626",
    foreground: "#ededed",
    mutedForeground: "#a3a3a3",
    faintForeground: "#8a8a8a",
    chatUser: "#262626",
  },
  light: {
    sidebar: "#ececea",
    background: "#f5f5f3",
    card: "#fdfdfc",
    popover: "#ffffff",
    foreground: "#1a1a1a",
    mutedForeground: "#5c5c5c",
    faintForeground: "#777777",
    chatUser: "#ffffff",
  },
};

export function dozoTheme(id: unknown): DozoTheme | undefined {
  return DOZO_THEMES.find((theme) => theme.id === id);
}

/** Which token each palette entry paints, as dozo/theme/theme.json maps the default palettes. */
const TOKENS: Record<keyof DozoThemePalette, (keyof WebColorTokens)[]> = {
  sidebar: ["sidebar"],
  background: ["background", "primaryForeground"],
  card: ["card", "muted"],
  popover: ["popover", "secondary", "chatUser"],
  foreground: [
    "foreground",
    "sidebarForeground",
    "sidebarAccentForeground",
    "cardForeground",
    "popoverForeground",
    "secondaryForeground",
    "chatUserForeground",
    "primary",
    "ring",
  ],
  mutedForeground: ["mutedForeground"],
  faintForeground: ["faintForeground"],
};

/** The dialog is the card in dark and the popover in light, as in the theme file. */
const DIALOG_FROM = { dark: "card", light: "popover" } as const satisfies Record<
  ResolvedAppearance,
  keyof DozoThemePalette
>;

/** Neutral in light: an ink bubble (settings-v2.html); in dark the theme's own bubble already is. */
const NEUTRAL_LIGHT_BUBBLE = {
  chatUser: "foreground",
  chatUserForeground: "background",
} as const satisfies Partial<Record<keyof WebColorTokens, keyof WebColorTokens>>;

const themeVar = (key: keyof DozoThemePalette) =>
  `--dozo-theme-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/**
 * The stylesheet `packages/ui-web/src/dozo-themes.css`, which the test holds equal to this. A theme
 * applies only beside its own tone, so a stale `data-skin` under the other tone changes nothing.
 * `html[data-theme][data-skin]` outranks the instance theme's `html[data-theme]`, loaded later.
 */
export function renderDozoThemesCss(): string {
  const lines = [
    "/* Generated from packages/ui-tokens/src/dozo-themes.ts; its test holds this file equal. */",
  ];
  for (const theme of DOZO_THEMES) {
    lines.push(`html[data-skin="${theme.id}"] {`);
    for (const [key, value] of Object.entries(theme.palette)) {
      lines.push(`  ${themeVar(key as keyof DozoThemePalette)}: ${value};`);
    }
    lines.push("}");
  }
  const selector = (tone: ResolvedAppearance) => {
    const skins = DOZO_THEMES.filter((theme) => theme.tone === tone)
      .map((theme) => `[data-skin="${theme.id}"]`)
      .join(", ");
    return `html[data-theme="${tone}"]:is(${skins})`;
  };
  const ink = themeVar("foreground");
  lines.push(`${selector("dark")},`, `${selector("light")} {`);
  for (const [key, tokens] of Object.entries(TOKENS)) {
    for (const token of tokens) {
      lines.push(`  ${cssVariableName(token)}: var(${themeVar(key as keyof DozoThemePalette)});`);
    }
  }
  lines.push(
    `  ${cssVariableName("primaryHover")}: color-mix(`,
    "    in srgb,",
    `    var(${ink}) 88%,`,
    `    var(${themeVar("background")})`,
    "  );",
    `  ${cssVariableName("primaryDisabled")}: color-mix(in srgb, var(${ink}) 32%, transparent);`,
    "}",
    `${selector("dark")} {`,
    `  ${cssVariableName("dialog")}: var(${themeVar(DIALOG_FROM.dark)});`,
    "}",
    `${selector("light")} {`,
    `  ${cssVariableName("dialog")}: var(${themeVar(DIALOG_FROM.light)});`,
    "}",
  );
  lines.push(`html[data-theme="light"][data-bubble="neutral"] {`);
  for (const [token, from] of Object.entries(NEUTRAL_LIGHT_BUBBLE)) {
    lines.push(
      `  ${cssVariableName(token as keyof WebColorTokens)}: var(${cssVariableName(from)});`,
    );
  }
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

/**
 * A theme on the phone: `base` (the phone's Light or Dark palette) with every token the web's
 * stylesheet paints from the theme's palette painted the same way, from the same table. A token
 * the base does not have (the web's hover and disabled steps) is left out.
 */
export function dozoThemeTokens<T extends object>(base: T, theme: DozoTheme): T {
  const painted: Record<string, string> = {};
  for (const [key, tokens] of Object.entries(TOKENS)) {
    for (const token of tokens) painted[token] = theme.palette[key as keyof DozoThemePalette];
  }
  painted.dialog = theme.palette[DIALOG_FROM[theme.tone]];
  const own = Object.fromEntries(Object.entries(painted).filter(([token]) => token in base));
  return { ...base, ...own };
}

/** Message color set to Neutral: your own bubble in light is the ink; in dark it is the theme's own. */
export function dozoNeutralBubbleTokens<T extends object>(tokens: T, tone: ResolvedAppearance): T {
  if (tone === "dark") return tokens;
  const source = tokens as Record<string, string>;
  const ink = Object.fromEntries(
    Object.entries(NEUTRAL_LIGHT_BUBBLE).map(([token, from]) => [token, source[from]]),
  );
  return { ...tokens, ...ink };
}
