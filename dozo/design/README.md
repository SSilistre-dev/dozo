# Dozo design references

Approved static mockups (plain HTML, CSS and one script, no build). They are the
visual source of truth for the Dozo layer; upstream's `.gitignore` ignores the repo-root
`design/` folder, so they live here where they are tracked.

## Open them

Serve this folder with any static server (for example `python3 -m http.server`)
and open a page. The pages are fixed at 1440x900.
- `bots.html`: bot list and the six avatars at 28, 36 and 72 px
- `chat.html`: a chat with a working bot, approval ask and composer
- `computer.html`: the bot's computer view
- `logos.html`: logo and wordmark studies
- add `?theme=light` to any page for the light theme (dark is the default)

## Decisions they fix

- Palette: the variables at the top of `dozo.css` (neutral surfaces, one blue accent,
  one red seal dot, six bot tile colours), dark and light.
- Pill controls: buttons and sidebar rows are fully rounded (999px), 38 px tall.
- Six avatar characters: Sora, Kumo, Hana, Taro, Yuki, Mochi, each a rounded tile
  with a white robot head, a dark visor and glowing eyes.
- Motion: eyes follow the pointer (clamped, eased), random blinking; working bots bob
  and pulse the antenna, waiting bots pulse for attention, idle bots sleep until hovered;
  a small hop on hover; all of it off under `prefers-reduced-motion`.
- Seigaiha sidebar pattern: faint concentric-wave scales behind the wordmark, fading out
  downward (`.wag` in `dozo.js` and `dozo.css`).

The React port of the avatars is `packages/ui-web/src/dozo-avatar.tsx`.
