import type { ResolvedAppearance, WebColorTokens } from "./index.js";
import { cssVariableName } from "./index.js";

/**
 * The named themes of Settings > Appearance (dozo/design/themes-v2.css). Each is a tint of the
 * neutral surfaces and ink of Light or Dark, nothing more: the main button stays ink, status
 * colours and bot identity colours never change. The mockup's per-theme accent is left out, as
 * the product is monochrome. `mutedForeground` and `faintForeground` are the ink mixed over the
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
      popover: "#222a3c",
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
      sidebar: "#ece5d6",
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
      sidebar: "#e3e8dc",
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
      sidebar: "#e3e7ec",
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

/** Light and Dark as the fork's theme file (dozo/theme/theme.json) paints them, for the swatches. */
export const DOZO_DEFAULT_SWATCHES: Record<
  ResolvedAppearance,
  Pick<DozoThemePalette, "background" | "foreground">
> = {
  dark: { background: "#141414", foreground: "#EDEDED" },
  light: { background: "#F5F5F3", foreground: "#1A1A1A" },
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
  for (const tone of ["dark", "light"] as const) {
    const skins = DOZO_THEMES.filter((theme) => theme.tone === tone)
      .map((theme) => `[data-skin="${theme.id}"]`)
      .join(", ");
    lines.push(`html[data-theme="${tone}"]:is(${skins}) {`);
    for (const [key, tokens] of Object.entries(TOKENS)) {
      for (const token of tokens) {
        lines.push(`  ${cssVariableName(token)}: var(${themeVar(key as keyof DozoThemePalette)});`);
      }
    }
    // The dialog is the card in dark and the popover in light, as in the theme file.
    const dialog = tone === "dark" ? "card" : "popover";
    const ink = themeVar("foreground");
    lines.push(
      `  ${cssVariableName("dialog")}: var(${themeVar(dialog)});`,
      `  ${cssVariableName("primaryHover")}: color-mix(`,
      "    in srgb,",
      `    var(${ink}) 88%,`,
      `    var(${themeVar("background")})`,
      "  );",
      `  ${cssVariableName("primaryDisabled")}: color-mix(in srgb, var(${ink}) 32%, transparent);`,
      "}",
    );
  }
  // Neutral in light: an ink bubble (settings-v2.html); in dark the theme's own bubble already is.
  lines.push(
    `html[data-theme="light"][data-bubble="neutral"] {`,
    `  ${cssVariableName("chatUser")}: var(${cssVariableName("foreground")});`,
    `  ${cssVariableName("chatUserForeground")}: var(${cssVariableName("background")});`,
    "}",
  );
  return `${lines.join("\n")}\n`;
}
