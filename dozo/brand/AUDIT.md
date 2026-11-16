# Brand leak audit, 2026-11-16

Five auditors examined the branded build (compose project `dozo`): **source** (staged tree vs
`brand.json`), **bundle** (built web/api/worker artefacts and the computer image), **runtime** (a
browser driven over the running web app, three languages), **server** (e-mails, model prompts, tool
definitions, vendor-facing strings, billing, update paths) and **images** (every raster/vector file
plus inline art). About 50 raw findings were merged into distinct ones; rows 29 and 30 came later,
while the gate was tightened. Rules live in `brand.json`; the gate is `check.mjs` (README "Leak
gate": every occurrence of the old name is a leak unless it is a listed identifier shape or a
reviewed text). Status below is as of the audit date, checked against `brand.json` afterwards.

## Findings and resolution

| # | Finding | Resolution |
|---|---|---|
| 1 | Web favicon, apple-touch, PWA icons are upstream's mascot | Fixed: 7 `assets` entries plus `favicon.svg` (anchored link in `index.html`); art is the approved H1 logo. Gate: mapped asset must equal ours; any unmapped image in scope fails until reviewed |
| 2 | Lowercase `rakazo` wordmark in every auth e-mail | Fixed: anchored rule, `email.tsx`. Gate: any lowercase `rakazo` outside the identifier shapes |
| 3 | Download names `rakazo-export-*.zip`, `rakazo-audit-log-*.jsonl`, `rakazo.apk` | Fixed: 3 anchored rules. Gate: `rakazo-export-*` is no listed shape, so a new download name fails. The format id `rakazo-account-export` inside the zip stays (rejected: import compares it) |
| 4 | Bot computer user/home `rakazo`, `/home/rakazo` in the model prompt, passwd, prompt | Fixed: literal `/home/rakazo` (every in-scope use; consistent only inside a Dozo build, NOT with an upstream Rakazo image or data: see README "Identifiers"), anchored rules for useradd/groupadd/USER, terminal-server passwd, guard words, regex twin; `dozo-runtime` for arbitrary uids. Gate: literal still present fails. Needs image rebuild; not run live (see "What the audit could not reach") |
| 5 | `Rakazo-owned compacted context` in model history | Fixed: emits `Dozo-owned`; reader accepts both (anchored, `keep` still protects the old prefix) |
| 6 | Memory provider text: placeholder, `rakazo-shared` message, bank error | Fixed: placeholder and default workspace id to `dozo-`, reserved peer id `rakazo-shared` to `dozo-shared` everywhere (literal incl. all 15 `.po`), bank error reworded. Hindsight prefix regex `^rakazo-` stays (stored namespace, not shown) |
| 7 | Offline emulator seeds (`composio-fake`, `release-watch`) | Rejected: not user-visible; both files are in `exclude` (offline emulators matched by owner/repo) |
| 8 | Default/orange bot avatar draws the ghost; avatar set `rakazo` | Fixed: body, hand paths and eyes in `logo-avatar-art.ts` swapped for the Dozo pill (exports unchanged, so `LogoAvatar`, notification avatars, mobile follow); orange palette special case removed. Enum value `rakazo` stays (stored). The pill is not the approved H1 mark: redrawing the avatars from it is a design decision, open (see "Inline SVG mascots") |
| 9 | Sign-in/sign-up 74px orange mascot | Fixed: anchored rule `Auth.tsx` uses the `blue` colour of the same component |
| 10 | Build-time Dozo bug: `rakazo.computerOwner` became `dozo.exampleputerOwner`, same for localStorage keys `rakazo.composer*` | Fixed in `lib.mjs`: URL keys need a non-word char after. Gate: URL target glued to a word. Images built before the fix carry the bad names: stage and rebuild |
| 11 | MCP/GraphQL/host names sent outward: `rakazo` client names, `RakazoIntrospection`, `hostInfo` | Fixed: 5 anchored rules + 2 literals (remote-mcp, mcp-transport, mcp-connector, serenity, cua, mcp-app, GraphQL op). Gate: a quoted `"RakazoXyz"` name and a lowercase `"rakazo"` outside `allow.text` fail |
| 12 | Model tool prefix `mcp__rakazo__` (Claude Code CLI provider) | Fixed: `TOOL_SERVER` constant, all uses go through it |
| 13 | Page-kit import specifier `rakazo/page` in the model's guide | Fixed: `PAGE_KIT_MODULE` and guide text to `dozo/page` (validate/runtime use the constant) |
| 14 | E-mails signed "Elie" (welcome, referral) | Fixed: anchored rules to "Dozo". Gate: `leakWords: ["Elie"]` |
| 15 | Welcome mail hero image (upstream art, then broken `dozo.example` URL) | Fixed: hero dropped, text header used. Owner action: Dozo hero image |
| 16 | Placeholder domains/owner `dozo.example`, `OWNER/dozo` | Owner action (`LAUNCH-CHECKLIST.md`). Gate: `check.mjs --launch` fails on them |
| 17 | Self-update/compute image defaults pull `ghcr.io/elie222/rakazo/*` | Owner action: publish images. `--launch` fails while the allow-listed names exist. Until then disable self-update |
| 18 | Mobile-only strings in web `messages-*.js` catalogs | Rejected for now: `apps/mobile` is out of scope, extracted at build, not shown on web. Gate cannot see build output |
| 19 | `orange-bot.png` mascot source | Reviewed in `allow.binary`: export-script source, never shipped |
| 20 | Vendor `originator`/`x-opencode-client`/`X-Keenable-Title` `rakazo` | Rejected: vendor-validated or operator-only; `allow.text` entries (`{file, text, reason}`) |
| 21 | Third-party catalogs and imports naming "Grok Bot", xAI | Rejected as leak (other vendor, not Rakazo); product decision, owner action if unwanted |
| 22 | `~/rakazo-home`, `/tmp/rakazo`, `rakazo-browser` binaries, `.rakazo-command-env` | Rejected: internal paths (out of scope per brief); `~/rakazo-home` is the most visible, revisit later |
| 23 | Stripe account name/descriptor, OAuth consent names, Slack/Discord/Telegram apps, OpenRouter listing | Owner action |
| 24 | `com.rakazo.app` mobile id, app-store listings | Owner action (mobile out of scope) |
| 25 | Stale-ID entries in compiled catalogs; source maps shipping | Rejected/unverified: not rendered on reachable screens |
| 26 | OG image has no upstream equivalent | Rejected: no leak, nothing to map. `assets/og-image.png` (H1 lockup, 1200x630) is ready for the site |
| 27 | Lowercase `rakazo` inside `.po` entries | Gate: the same rule applies to `.po` entries; the `Project-Id-Version: rakazo-web` header is the `rakazo-web` service-name shape |
| 28 | Operator logs, DB/role names, labels, headers, storage keys | Rejected: deliberate identifiers |
| 29 | Serenity memory provenance label `rakazo space:<id> bot:<id>` (`serenity-memory-provider.ts`), found while tightening the gate | Fixed: anchored rule, label is `dozo space:<id> bot:<id>` (free text sent to the memory provider, nothing reads it back; the entity ids `rakazo-space/...` are identifiers and stay). The allow-list phrase is gone, so the gate sees the line again |
| 30 | The lowercase part of the gate recognised prose by heuristics and missed bulleted and wrapped lines, lines with code punctuation, `rakazo.`, `rakazo-powered`, `#rakazo`, other TLDs and e-mail addresses; `allow.lowercase` hid every lowercase text of 19 files; `keep` and `allow.phrases` were global and unanchored on the right (`Rakazo.apps`, `…/rakazo-evil/img` passed); url keys had no left boundary (`getrakazo.com`); names of files and directories were never looked at | Fixed: the gate is inverted (every occurrence is a leak unless it is one of the finite `SHAPES` in `lib.mjs`, or a reviewed `keep`/`allow.phrases`/`allow.text` entry, each scoped to files and matched as a whole); prose heuristics, `allow.lowercase` and `allow.files` are gone; url keys are whole hosts; the old name with a listed TLD and the bare store and invite ids are needles; a path scan with `allow.paths`; dead entries fail `apply --strict`. Result on the committed tree: no user-visible leak found. `test_focus_or_launch.py` asserted the old `rakazo-runtime` passwd name, so the literal `rakazo-runtime:x:` lists it in `files` next to `user-env.sh` |

## Persisted identifiers changed by the overlay

Moved to `README.md` (Identifiers), the one home for the identifiers the overlay keeps and the few
persisted ones it renames, and for what that means for data and images from an upstream install.

## Owner actions

The list lives in `../LAUNCH-CHECKLIST.md` (domain, GitHub owner, images, welcome-mail hero, Stripe and
OAuth names, the Android APK name, third-party catalog branding, logo parts still open). Rows marked
"Owner action" above refer to it.

## What the audit could not reach

- No real bot run: model replies, tool output, the bot's computer (the supervisor answered 500 on the
  first start; see `../README.md`, Status and known limits), the shell prompt, a sent e-mail. The
  `dozo` user rename is untested in a built image.
- Inline-SVG avatars were never rasterised; the new pill and eye placement are unchecked visually.
- Settings Model picker, Notifications sub-pages, Upload tab, share dialog, OAuth/social sign-in,
  install and notification prompts, billing, admin pages with data.
- `.map` files were not read; infra and scripts hits not read one by one; `apps/www`,
  `apps/desktop`, `apps/mobile`, `docs/` out of scope.
- Locale text other than en/tr/ja was checked by grep only.

## Images and mascots not covered by the asset map (logo pass)

Under `include` (the stack: web, api, worker, packages, infra/sandboxes) the only images are the 7
`apps/web/public` icons, mapped, and `packages/ui-tokens/assets/Rakazo.icon/Assets/orange-bot.png`,
reviewed in `allow.binary`; `favicon.svg` is new and mapped.

Phase 3, outside `include` (desktop and mobile are neither branded nor gated; still the orange mascot):

| Path | Size | Used by |
|---|---|---|
| `apps/desktop/assets/icon.png`, `icon-macos.png` | 1024x1024 | window/dock icon (`window-options.ts`) |
| `apps/desktop/assets/icon.ico` | 6 sizes | Windows packaging |
| `apps/desktop/assets/background.png`, `background@2x.png` | 660x400, 1320x800 | macOS DMG background |
| `apps/mobile/assets/icon.png`, `adaptive-icon.png`, `monochrome-icon.png`, `icon-background.png`, `splash-icon.png` | 1024x1024 | `app.json` app icon, adaptive icon, splash |
| `apps/mobile/assets/favicon.png` | 128x128 | Expo web favicon |
| `apps/mobile/assets/notification-icon.png` | 72x72 | `app.json` notification icon |
| `apps/mobile/ios-widgets/Assets.xcassets/AppMark.imageset/app-mark.png` | 180x180 | iOS widget (`RakazoWidgets.swift:25`) |

Out of `include`, not shipped by the stack: `apps/www/public/**` (marketing site: favicons, `og-image.png`
1200x630, `email/welcome.jpg` 1040x546, `brand/kit/*`, `avatars/*.svg`, `og/*.png`) and
`packages/testkit/src/evals/fixtures/example-*.png` (eval fixtures). The welcome mail hero is dropped by an
anchored rule (`packages/auth/src/welcome-email.tsx:87` points at `www/email/welcome.jpg`).

Inline SVG mascots and wordmarks (cannot be replaced by the asset map; a later anchored rule plus a
`dozo-` prefixed component should replace them, not changed here). The ones fed by
`logo-avatar-art.ts` already draw the pill (row 8); the others were not inspected for upstream art:

- `packages/ui-web/src/logo-avatar.tsx:62`: `<svg>` of `LogoAvatar` (sign-in 74 px mascot at `apps/web/src/pages/Auth.tsx:657`).
- `packages/ui-web/src/bot-avatar.tsx:120` (`<svg>` in the bot avatar) and `:146-148` (the `rakazo` avatar set uses `LogoAvatar`).
- `packages/core/src/logo-avatar-art.ts:31-34`: body and hand paths (swapped for the pill by anchored rules).
- `packages/core/src/notification-avatar.ts:54,60`: the same art as a `data:image/svg+xml` avatar.
- `packages/ui-web/src/dozo-avatar.tsx:508`: existing fork avatar `<svg>`.
- `packages/auth/src/email.tsx:163`: lowercase text wordmark `rakazo` in every mail header (anchored to `dozo`).
