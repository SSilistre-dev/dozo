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

- Palette: the variables at the top of `dozo.css` (neutral surfaces, one blue accent that the
  product no longer uses: the main button is ink, see `dozo/theme/README.md`,
  one red seal dot, six bot identity colours), dark and light.
- Pill controls: buttons and sidebar rows are fully rounded (999px), 38 px tall.
- Six avatar characters, siblings of the logo mark: Sora, Kumo, Hana, Taro, Yuki, Mochi. No tile:
  the head stands on the page in the text colour (light on dark, dark on light), a soft blob with
  the mark's tilted visor cut out of it and two eyes in the same ink. Each wears one accessory,
  the only place its identity colour shows: Sora a kasa hat, Kumo kitsune ears, Hana a bun with a
  kanzashi pin, Taro a hachimaki, Yuki the ears of a snow rabbit, Mochi the tanuki's leaf.
- Motion: eyes follow the pointer (clamped, eased), random blinking; working bots bob
  and pulse the accessory, waiting bots pulse for attention, idle bots sleep until hovered;
  a small hop on hover; all of it off under `prefers-reduced-motion`.
- Seigaiha sidebar pattern: faint concentric-wave scales behind the wordmark, fading out
  downward (`.wag` in `dozo.js` and `dozo.css`).

The React port of the avatars is `packages/ui-web/src/dozo-avatar.tsx`; the art and palette it
draws are data in `packages/core/src/dozo-avatar-art.ts`. `dozo-bot-avatar.tsx` puts it in place of
upstream's avatar components, and `dozo-shell.css` carries the pills, the pattern, the wordmark and
the tinted row and the narrow chat column.

## Where the app still differs

Compared at 1440 x 900 on 2026-11-17, dark and light. The mockups are a design target, not a
copy of upstream's screens, so what needs upstream's structure changed is left as it is:

- No bots overview page (`bots.html`): the app has no such screen; the sidebar is its bot list.
- Sidebar: upstream's header buttons (search, activity, minimise, new) sit beside the wordmark,
  so the kana shows only once the sidebar is dragged wider than 280 px; a space heading
  ("Personal") stands above the rows; rows are 46 px apart, not 40, with smaller names in the
  text colour; the dot at the row's end means unread, not status; no "New bot" row or group
  list; the footer is the account button and "Connect apps", not the user's name.
- Chat: the header is a centred pill (avatar and name), with no status text and no "Computer"
  button; time separators stand between messages; the composer has a border, an attach button
  and is 50 px tall, not 64; its send button is dimmed until there is text.
- Computer (`computer.html`): the bot's screen opens over the whole window with one title row,
  not beside the chat; no Screen, Files and Terminal tabs; "Take control" is an outline pill.
- A bot's character comes from its shape or colour (`dozoCharacterForLook`), not its name.
- Avatar editor (no mockup): upstream's icon-set switch and colour row are still there. Both
  sets draw the same characters, and a colour only picks the character while no shape is chosen.

