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
- `--muted` -> `mutedForeground`; `--quiet` -> `faintForeground`
- `--accent` -> `primary`, `ring`; `--on-accent` -> `primaryForeground`
- `--green` -> `success`, `statusWorking`, `workingDot`; `--amber` -> `warning`
- `radius` 16px: a judgement between the mockup's 20-24 px cards and upstream's 12 px
- `fonts.sans`, `fonts.mono`: the mockup stacks; no font files shipped

Derived, not in the mockup: `primaryHover`, `primaryDisabled` (accent shifted, or at 32% alpha)
and `sidebarAccent` (6% neutral ink instead of the per-bot tinted active row).

## Left at upstream's value

`accent` and `accentForeground` (upstream's hover wash; Dozo's `--accent` is the blue fill, which
maps to `primary`), `input`, `link` (upstream's blue is tuned for text contrast), `destructive*`,
`unread`, `overlay`, `scrollbar*`, `glass*`, `faviconPlate`, `pageIcon*`, `pageTile*`. The mockups
show none of these surfaces, so there is no source value to map.

## What the overlay cannot express

Only colours, one radius and font stacks. Pill shapes (999 px buttons and rows), the seigaiha
sidebar pattern, the seal dot, tinted per-bot active rows, shadows and the six bot tile colours
(in `packages/ui-web/src/dozo-avatar.css`) must come from a stylesheet.

## Activation

Set `RAKAZO_THEME=/theme/theme.json` on the web service. The file must be readable there: mount
this folder (`./dozo/theme:/theme:ro` in `docker-compose.override.yml`) and layer that file after
the base compose file. It is re-read on each page load; an invalid file is skipped with a
`web.instance_theme_ignored` warning.
