# Brand leak audit, 2026-11-16

Five auditors examined the branded build (compose project `dozo`): **source** (staged tree vs
`brand.json`), **bundle** (built web/api/worker artefacts and the computer image), **runtime** (a
browser driven over the running web app, three languages), **server** (e-mails, model prompts, tool
definitions, vendor-facing strings, billing, update paths) and **images** (every raster/vector file
plus inline art). about 50 raw findings merged into 29 distinct ones. Rules live in `brand.json`; the gate
is `check.mjs` (new checks listed in README "Leak gate").

## Findings and resolution

| # | Finding | Resolution |
|---|---|---|
| 1 | Web favicon, apple-touch, PWA icons are upstream's mascot | Fixed: 7 `assets` entries plus `favicon.svg` (anchored link in `index.html`); art is the approved H1 logo. Gate: mapped asset must equal ours; any unmapped image in scope fails until reviewed |
| 2 | Lowercase `rakazo` wordmark in every auth e-mail | Fixed: anchored rule, `email.tsx`. Gate: bare text node `>rakazo<` / line `rakazo` |
| 3 | Download names `rakazo-export-*.zip`, `rakazo-audit-log-*.jsonl`, `rakazo.apk` | Fixed: 3 anchored rules. Gate: `rakazo-...\.zip/jsonl/apk/...` pattern. The format id `rakazo-account-export` inside the zip stays (rejected: import compares it) |
| 4 | Bot computer user/home `rakazo`, `/home/rakazo` in the model prompt, passwd, prompt | Fixed: literal `/home/rakazo` (51 uses, all in scope; consistent only inside a Dozo build, NOT with an upstream Rakazo image or data: see "Persisted identifiers changed by the overlay"), anchored rules for useradd/groupadd/USER, terminal-server passwd, guard words, regex twin; `dozo-runtime` for arbitrary uids. Gate: literal still present fails. Needs image rebuild; not run live (see gaps) |
| 5 | `Rakazo-owned compacted context` in model history | Fixed: emits `Dozo-owned`; reader accepts both (anchored, `keep` still protects the old prefix) |
| 6 | Memory provider text: placeholder, `rakazo-shared` message, bank error | Fixed: placeholder and default workspace id to `dozo-`, reserved peer id `rakazo-shared` to `dozo-shared` everywhere (literal incl. all 15 `.po`), bank error reworded. Hindsight prefix regex `^rakazo-` stays (stored namespace, not shown) |
| 7 | Offline emulator seeds (`composio-fake`, `release-watch`) | Rejected: `FakeComposioClient` is built only in `packages/testkit`; no non-test consumer in api/worker |
| 8 | Default/orange bot avatar draws the ghost; avatar set `rakazo` | Fixed: body, hand paths and eyes in `logo-avatar-art.ts` swapped for the Dozo pill (exports unchanged, so `LogoAvatar`, notification avatars, mobile follow); orange palette special case removed. Enum value `rakazo` stays (stored) |
| 9 | Sign-in/sign-up 74px orange mascot | Fixed: anchored rule `Auth.tsx` uses the `blue` colour of the same component |
| 10 | Build-time Dozo bug: `rakazo.computerOwner` became `dozo.exampleputerOwner`, same for localStorage keys `rakazo.composer*` | Fixed in `lib.mjs`: URL keys need a non-word char after. Gate: URL target glued to a word. Affects the currently running images (see report) |
| 11 | MCP/GraphQL/host names sent outward: `rakazo` client names, `RakazoIntrospection`, `hostInfo` | Fixed: 5 anchored rules + 2 literals (remote-mcp, mcp-transport, mcp-connector, serenity, cua, mcp-app, GraphQL op). Gate: quoted exact `"rakazo"`/`"RakazoXyz"` in new places |
| 12 | Model tool prefix `mcp__rakazo__` (Claude Code CLI provider) | Fixed: `TOOL_SERVER` constant, all uses go through it |
| 13 | Page-kit import specifier `rakazo/page` in the model's guide | Fixed: `PAGE_KIT_MODULE` and guide text to `dozo/page` (validate/runtime use the constant) |
| 14 | E-mails signed "Elie" (welcome, referral) | Fixed: anchored rules to "Dozo". Gate: `leakWords: ["Elie"]` |
| 15 | Welcome mail hero image (upstream art, then broken `dozo.example` URL) | Fixed: hero dropped, text header used. Owner action: Dozo hero image |
| 16 | Placeholder domains/owner `dozo.example`, `OWNER/dozo` | Owner action. Gate: `check.mjs --launch` fails on them |
| 17 | Self-update/compute image defaults pull `ghcr.io/elie222/rakazo/*` | Owner action: publish images. `--launch` fails while the allow-listed names exist. Until then disable self-update |
| 18 | Mobile-only strings in web `messages-*.js` catalogs | Rejected for now: `apps/mobile` is out of scope, extracted at build, not shown on web. Gate cannot see build output |
| 19 | `orange-bot.png` mascot source | Reviewed in `allow.images`: export-script source, never shipped |
| 20 | Vendor `originator`/`x-opencode-client`/`X-Keenable-Title` `rakazo` | Rejected: vendor-validated or operator-only; `allow.lowercase` with reasons |
| 21 | Third-party catalogs and imports naming "Grok Bot", xAI | Rejected as leak (other vendor, not Rakazo); product decision, owner action if unwanted |
| 22 | `~/rakazo-home`, `/tmp/rakazo`, `rakazo-browser` binaries, `.rakazo-command-env` | Rejected: internal paths (out of scope per brief); `~/rakazo-home` is the most visible, revisit later |
| 23 | Stripe account name/descriptor, OAuth consent names, Slack/Discord/Telegram apps, OpenRouter listing | Owner action |
| 24 | `com.rakazo.app` mobile id, app-store listings | Owner action (mobile out of scope) |
| 25 | Stale-ID entries in compiled catalogs; source maps shipping | Rejected/unverified: not rendered on reachable screens |
| 26 | OG image has no upstream equivalent | Rejected: no leak, nothing to map. `assets/og-image.png` (H1 lockup, 1200x630) is ready for the site |
| 27 | Lowercase `rakazo` inside `.po` entries | Gate: `.po` msgid/msgstr scan (headers excluded) |
| 28 | Operator logs, DB/role names, labels, headers, storage keys | Rejected: deliberate identifiers |
| 29 | Serenity memory provenance label `rakazo space:<id> bot:<id>` (`serenity-memory-provider.ts`), found while tightening the gate | Fixed: anchored rule, label is `dozo space:<id> bot:<id>` (free text sent to the memory provider, nothing reads it back; the entity ids `rakazo-space/...` are identifiers and stay). The allow-list phrase is gone, so the gate sees the line again |

## Persisted identifiers changed by the overlay

The overlay renames these persisted or shared identifiers (each exists in `brand.json`):

- Bot computer user and home directory: `/home/rakazo` -> `/home/dozo` (literal), plus the
  `useradd`/`USER` anchored rules and `rakazo-runtime` -> `dozo-runtime`.
- Shared workspace and peer ids: `rakazo-shared` -> `dozo-shared` (literal) and the default
  workspace id `rakazo-<space>` -> `dozo-<space>` (anchored rules in the Honcho provider and settings).
- Compaction prefix: `Rakazo-owned compacted context` -> `Dozo-owned compacted context`
  (new summaries; the reader still accepts the old prefix).

This is consistent for a fresh Dozo installation built entirely from the staged tree. It is NOT
compatible with (a) data or volumes created by an upstream Rakazo installation (home
directories, Honcho workspaces and peers) or (b) the prebuilt upstream computer image
`ghcr.io/elie222/rakazo/computer`, which still uses `/home/rakazo`. Dozo must always run its own
computer image built from the staged tree.

## Owner actions

1. Pick the product domain and GitHub owner; replace placeholders in `brand.json` `urls`; run
   `check.mjs --launch` until clean. Host `/docs/*.md` (the bot fetches them).
2. Publish Dozo server and computer images; change `PUBLISHED_IMAGE_REPO` and image defaults.
3. Design a welcome-mail hero image (1040x546) and wire it with an anchored rule.
4. Set names and branding in Stripe, OAuth providers, messaging apps, OpenRouter.
5. Publish the Android build as `dozo.apk` under the release tag the URL names.
6. Decide on third-party catalog branding (xAI/Grok plugin catalog, import text).
7. Logo: H1 (red headband) approved and applied to the web assets. The avatar pill and the inline SVG mascots below still show the old pill; replace them in a later step.

## What the audit could not reach

- No real bot run: model replies, tool output, the bot's computer (supervisor 500 on wake), the
  shell prompt, a sent e-mail. The `dozo` user rename is untested in a built image.
- Inline-SVG avatars were never rasterised; the new pill and eye placement are unchecked visually.
- Settings Model picker, Notifications sub-pages, Upload tab, share dialog, OAuth/social sign-in,
  install and notification prompts, billing, admin pages with data.
- `.map` files were not read; infra and scripts hits not read one by one; `apps/www`,
  `apps/desktop`, `apps/mobile`, `docs/` out of scope.
- Locale text other than en/tr/ja was checked by grep only.

## Images and mascots not covered by the asset map (logo pass)

Mapped and served by the web/API/worker/self-host stack: the 7 `apps/web/public` icons and the new
`favicon.svg`. Every other image under `include` (web, api, worker, packages, infra) is listed here.

Phase 3, not mapped (desktop and mobile, outside the stack; still the orange mascot):

| Path | Size | Used by |
|---|---|---|
| `apps/desktop/assets/icon.png`, `icon-macos.png` | 1024x1024 | window/dock icon (`window-options.ts`) |
| `apps/desktop/assets/icon.ico` | 256x256 | Windows packaging |
| `apps/desktop/assets/background.png`, `background@2x.png` | 660x400, 1320x800 | macOS DMG background |
| `apps/mobile/assets/icon.png`, `adaptive-icon.png`, `monochrome-icon.png`, `icon-background.png`, `splash-icon.png` | 1024x1024 | `app.json` app icon, adaptive icon, splash |
| `apps/mobile/assets/favicon.png` | 128x128 | Expo web favicon |
| `apps/mobile/assets/notification-icon.png` | 72x72 | `app.json` notification icon |
| `apps/mobile/ios-widgets/Assets.xcassets/AppMark.imageset/app-mark.png` | 180x180 | iOS widget (`RakazoWidgets.swift:25`) |
| `packages/ui-tokens/assets/Rakazo.icon/Assets/orange-bot.png` | 1024x1024 | icon export script source (`allow.images`, never shipped) |

Out of `include`, not shipped by the stack: `apps/www/public/**` (marketing site: favicons, `og-image.png`
1200x630, `email/welcome.jpg` 1040x546, `brand/kit/*`, `avatars/*.svg`, `og/*.png`) and
`packages/testkit/src/evals/fixtures/example-*.png` (eval fixtures). The welcome mail hero is dropped by an
anchored rule (`packages/auth/src/welcome-email.tsx:87` points at `www/email/welcome.jpg`).

Inline SVG mascots and wordmarks (cannot be replaced by the asset map; a later anchored rule plus a
`dozo-` prefixed component should replace them, not changed here):

- `packages/ui-web/src/logo-avatar.tsx:62`: `<svg>` of `LogoAvatar` (sign-in 74 px mascot at `apps/web/src/pages/Auth.tsx:657`).
- `packages/ui-web/src/bot-avatar.tsx:120` (`<svg>` in the bot avatar) and `:146-148` (the `rakazo` avatar set uses `LogoAvatar`).
- `packages/core/src/logo-avatar-art.ts:31-34`: body and hand paths (already swapped for the pill by anchored rules).
- `packages/core/src/notification-avatar.ts:54,60`: the same art as a `data:image/svg+xml` avatar.
- `packages/ui-web/src/dozo-avatar.tsx:483`: existing fork avatar `<svg>`.
- `packages/auth/src/email.tsx:163`: lowercase text wordmark `rakazo` in every mail header (anchored to `dozo`).
