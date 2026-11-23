# Dozo theme overlay
`theme.json` maps the Dozo palette (`dozo/design/dozo.css`) onto upstream's instance-theme
schema (`apps/web/src/instance-theme.ts`), using token names from `packages/ui-tokens`.

## Tokens set (mockup variable -> tokens; both themes unless noted)

- `--bg` -> `background`; `--side` -> `sidebar`
- `--text` -> `foreground`, `sidebarForeground`, `sidebarAccentForeground`, `cardForeground`,
  `popoverForeground`, `secondaryForeground`, `chatUserForeground`
- `--line` -> `border`, `sidebarBorder`
- `--raise` -> `card`, `muted`, and `dialog` (dark)
- `--raise2` -> `popover`, `secondary`, `chatUser`, and `dialog` (light)
- `--muted` -> `mutedForeground` (light: `#5C5C5C` instead of the mockup's `#6B6B6B`, which falls to
  3.8:1 on the open sidebar row); `--quiet` -> `faintForeground`
- `--text` -> `primary`, `ring`; `--bg` -> `primaryForeground`: the fill of the main button is ink,
  as on the landing page (`--primary` there). The mockups' blue `--accent` is not used: the owner
  asked for no blue buttons.
- `--green` -> `success`, `statusWorking`, `workingDot`; `--amber` -> `warning`
- `radius` 16px: a judgement between the mockup's 20-24 px cards and upstream's 12 px
- `fonts.sans`, `fonts.mono`: the mockup stacks; no font files shipped

Derived, not in the mockup: `primaryHover`, `primaryDisabled` (primary shifted, or at 32% alpha)
and `sidebarAccent` (6% neutral ink instead of the per-bot tinted active row).

## Left at upstream's value

`accent` and `accentForeground` (upstream's hover wash), `input`, `link` (upstream's blue is tuned for text contrast), `destructive*`,
`unread`, `overlay`, `scrollbar*`, `glass*`, `faviconPlate`, `pageIcon*`, `pageTile*`. The mockups
show none of these surfaces, so there is no source value to map.

## What the overlay cannot express

Only colours, one radius and font stacks. The chat window of `dozo/design/chat-v2.html` comes from
`packages/ui-web/src/dozo-shell.css`, which an anchored rule imports into the web app's stylesheet:
surfaces told apart by tone instead of lines, pill controls, two-line sidebar rows, the seigaiha
pattern and the wordmark with its seal dot, tonal bubbles and cards, the one-pill composer and the
bot panel on the sidebar's tone. The six bot identity colours are in the avatar palette
(`packages/core/src/dozo-avatar-art.ts`), which also gives your own bubble and the send button the
open bot's colour (`dozoChatUserColors`, an anchored rule in `Shell.tsx`). Other anchored rules set
the sizes the design shows: a 288 px sidebar and a 320 px bot panel.

The tone steps are named once, at the top of `dozo-shell.css`, and derived from the tokens above,
so both themes follow this file:

| Name | Value | Used for |
| --- | --- | --- |
| `--dozo-surface-0` | `sidebar` | sidebar, bot panel |
| `--dozo-surface-1` | `background` | the thread |
| `--dozo-surface-2` | `foreground` 4% over `background` | the bot's bubble |
| `--dozo-surface-3` | `card` | cards, composer, round buttons, the name pill |
| `--dozo-surface-4` | `popover` | a round button's hover |
| `--dozo-row-hover`, `--dozo-row-on` | `foreground` 6% / 9% over `sidebar` | a hovered / the open sidebar row |
| `--dozo-wash`, `--dozo-wash-strong` | `foreground` at 6% / 10% | icon hovers, the microphone, choices |
| `--dozo-edge` | `foreground` at 6% | the half-pixel edge of cards and the composer |
| `--dozo-ink-2`, `--dozo-ink-3` | `mutedForeground` | secondary text; icons and placeholders |

`mutedForeground` holds 4.5:1 (WCAG) against every surface above in both themes; the closest is
the open sidebar row in light (4.7:1).

- `--dozo-seigaiha` (on `:root`) switches the sidebar pattern: `1` shows it, `0` hides it, a value
  between fades it.
- `--dozo-seal` is the seal dot's red, the one colour the stylesheet writes itself.

## Activation

On by default in the fork's stack: `compose.theme.yml` in this folder sets
`RAKAZO_THEME=/theme/theme.json` on the web service and mounts this folder at `/theme`, and
`dozo/docker/build.sh` layers it after upstream's compose file (which stays unedited) and passes
this folder as `DOZO_THEME_DIR`. The file is re-read on each page load, so an edit shows after a
reload with no rebuild; an invalid file is skipped with a `web.instance_theme_ignored` warning and
the app falls back to upstream's colours. The stack reads the folder of the checkout that started
it: start it again (`make up`) from another checkout before removing the first.

Dark is the default: two anchored rules make a missing appearance choice resolve to dark (the
pre-paint script and the app's own resolution). System and Light still work once chosen in
settings. To run the stack elsewhere, mount the folder and set the variable the same way.

## Named themes and Message color

Settings > General > Appearance offers, after System, Light and Dark, the six named themes of
`dozo/design/themes-v2.css` (Sumi, Yoru and Hoji dark; Washi, Matcha and Kasumi light). Their
palettes are in `packages/ui-tokens/src/dozo-themes.ts`, which renders
`packages/ui-web/src/dozo-themes.css` (imported by `dozo-shell.css`, so it applies before the first
paint; a test holds the file equal to the source). A theme only tints the surfaces and the ink of its
tone: the main button stays ink, status and bot colours stay. The mockup's per-theme accent is not
used. Every theme holds text and secondary text at 4.5:1 on each surface and faint text at 3:1,
and reads upstream's destructive and link text on its surfaces at least as well as the default of
its tone (destructive at 4.5:1); the light sidebars and Yoru's popover are a little lighter or
darker than the mockup for that (`packages/core/src/dozo-themes-contrast.test.ts`). The default
palettes the themes are measured against are copied in `dozo-themes.ts`; olc's
`dozo/e2e/theme-defaults.test.mjs` holds that copy equal to `theme.json`.

The choice is per device, like Light and Dark: upstream's `rakazo.uiAppearance` keeps the theme's
tone and `dozo.uiTheme` its name; `apps/web/public/dozo-boot.js` sets `data-skin` before first paint
only when the two agree, so an unknown or older name falls back to plain Light or Dark. Message
color (`dozo.uiBubble`) gives your own bubble and the send button the open bot's colour (the
default) or the theme's neutral bubble, an ink bubble in light. Mobile does not read these yet and
stays on Light and Dark.
