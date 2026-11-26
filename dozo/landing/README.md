# Dozo landing page

Plain static files, no build step: open `index.html` or run
`python3 -m http.server 8080 --directory dozo/landing`.

It is not part of `apps/www`: that Astro site is upstream's and is not edited by hand, and one
static page needs no framework. Publishing: `dozo/deploy/README.md`, "Landing page".

Languages: English at `/` (`index.html`, `404.html`) and Turkish at `/tr/` (`tr/`). Each language is
its own hand-kept static page, so it works without scripts and previews show the right language;
the CSS, script and images are one shared copy. There is no generator: a second copy of the markup
is cheaper than a build step, a generated tree to keep in step and a deploy that knows about both.
`dozo/e2e/landing-pages.test.mjs` (part of `make olc`) holds every language to the English page's
structure: same tags, attributes, link targets and text slots. The words the script shows during
the animations are `data-*` attributes on the page, not strings in `landing.js`. Nothing redirects
by browser language; the header links are the only switch. The server remembers the switch in one
cookie (`dozo_lang`, a year, set and read only by `dozo/deploy/site.nginx.conf`, no script): the
home address sends a visitor who chose Turkish to `/tr/`, and the English link on a translated page
carries `?lang=en` to end that. Links to the app carry the page's language as `?lang=`, which the
app's sign-in page reads (`apps/web/src/pages/dozo-auth.tsx`).

Theme: the system's light or dark scheme, also when it changes, unless the address says
`?theme=light` or `?theme=dark`. Without the script the page is dark. Every page loads `theme.js` in `<head>`, the one
copy of the theme logic, so it paints in its theme; the header button switches it and the choice
travels in the page's address and in its links to the site's other pages. Nothing is stored, so the
privacy pages' one-cookie statement stays true. The home page's own script is `landing.js`.

Legal pages: `privacy/`, `terms/` and `refunds/`, one `index.html` each per language, linked from
every footer. `delete-account/` is built the same way (the stores require a web page that explains
account deletion) and is linked from the privacy page, not the footer. `support/` is the stores'
Support URL: the same template, but indexable and listed in `sitemap.xml`; it points to the contact
address, the deletion page and the legal pages. Plain text under the landing page's header and footer. They state only what the code does (the data flows were read
from the code) and what the owner's own published policies say; a lawyer has not reviewed them
(`dozo/LAUNCH-CHECKLIST.md`). The app's privacy and terms links open them through two anchored rules
in `dozo/brand/brand.json`. A value only the owner can supply is written `[[NAME]]`, and `make olc`
fails while any page holds one. When the code changes what is collected, kept or sent (a new
cookie, a retention period, a provider), change the pages in both languages in the same PR.

To add a language: copy `tr/` to `<code>/` and translate it, add its `hreflang` link and header
link to every page (the legal pages too), and copy the two `/tr/` locations and the two `tr` lines of the language cookie in `dozo/deploy/site.nginx.conf`. The test
names whatever is missing. `og.png` carries English words and is shared by every language.

The site is `dozo.bot` and the app `app.dozo.bot`. A domain change touches `og:url`, `og:image`,
the calls to action, every page's `canonical` and `hreflang` links, `dozo/e2e/landing-pages.test.mjs`
and the site links in `dozo/brand/brand.json` and the `dozo-*` files that name it (`git grep`).

Search and answer engines: the site is open to them. `robots.txt` allows every crawler, names the
AI crawlers each vendor documents and points to `sitemap.xml`, which lists the two home pages and the two
support pages with their `hreflang` alternates. The legal pages and the deletion page stay `noindex` (plain boilerplate with no search value;
crawlers still follow their links) and are not in the sitemap, like the 404 pages. `llms.txt` is a
short factual summary for answer engines: its prices are held to the page by the test. Each home
page carries one JSON-LD block (Organization, WebSite, SoftwareApplication with the page's prices).
It is a data block, so the CSP's `script-src 'self'` does not apply to it. No FAQ or rating markup:
the page has neither. `www.dozo.bot` redirects permanently to `dozo.bot` in `site.nginx.conf`. A
fixed `canonical` on every page covers `?theme=` and `?lang=` addresses.

Closed pre-release state (lifted):

- The repository is published at github.com/SSilistre-dev/dozo. The header and footer navs link
  to "GitHub", the footer's "Licence" to `dozo/NOTICE` (which file is under which licence), and "Self-host", the second hero and closing buttons and the self-hosting row's "Set it up" point at the fork guide, `dozo/README.md`, there (the upstream guide names the upstream product).
- Order: hero, the two ideas, "What it does." (`.does`: six short items, each read from the code; a new item needs the
  same check, and nothing that ships only with a new mobile build), then the run-it-yourself section (`#get`: the "Apps." block and
  the self-hosting row), then "Hosted plans.", then the closing buttons. The header has no plans or
  pricing link; the plans are reached by scrolling. The first hero and closing button, "Download",
  links to `#get`; `landing.js` points it straight at the build for the visitor's system (the plain
  macOS, Windows, Linux and iOS links under the hero button, found by `data-os`; iPhone and iPad get
  the App Store listing) and leaves it on `#get` on Android, on an unknown system and without the script.
- The "Apps." block links the macOS, Windows and Linux installers by the fixed asset names of the
  latest GitHub release (`releases/latest/download/Dozo-macOS.dmg`,
  `Dozo-Windows-x64-setup.exe`, `Dozo-Linux-x86_64.AppImage`), so a new release needs no edit here; renaming an asset breaks them.
  The iOS link beside them opens the App Store listing (`apps.apple.com/app/dozo-bot/id6837702832`),
  the same address as `IOS_APP_STORE_URL` in `dozo/brand/brand.json`. Android has no listing and no link.
  The links work only while the latest release is a published desktop release (`dozo-desktop-release`
  creates it as a draft; the server bundles never become latest).
  The "not signed yet" note (Windows and Linux; macOS is signed) is in the one `<p>` in that block,
  once per language: edit that line when a package is signed.
- Plans: the "Hosted plans." section shows the three hosted plans as cards, one under the other on a
  phone, equal in weight (no frame, badge or larger type for any of them). Each card holds both the monthly and the yearly
  price; the Monthly / Yearly switch (`landing.js`, yearly first) shows one and sets `period=` on the
  paid cards' sign-up links, which also carry `plan=premium` or `plan=premium_plus`. Without the
  script both prices show. The prices, the yearly saving, computer
  hours, file storage and each computer's vCPUs and memory are read from the code by
  `dozo/e2e/landing-pages.test.mjs` (`BYOK_TIERS` in `packages/contracts/src/billing/billing.ts`,
  `dozo-plans.ts`, and the default `RAKAZO_COMPUTER_SIZES` in `dozo/deploy/compose.deploy.yml`), and
  it fails when a page disagrees. No discount, tax line or other number: write one only once the
  owner has set it and the code enforces it.
- The dragon behind the plans (`.scales`) is decoration, drawn once per language page: the logo
  mark as its head, in the mark's red, kept faint. Its body path is generated, not hand-drawn:
  redraw it whole if the shape changes. The plan cards are slightly translucent so it shows
  through; keep text contrast at 4.5 or more when changing either opacity. The "Save 20%" saving
  is plain text beside the period switch, not inside it.
- Download buttons (`.dlb`, hero row and the "Apps." block) are outlined in the muted ink, with
  a generic platform glyph and a download arrow; `landing.js` fills the visitor's own system
  (`.w`). Light theme: white pills and hairline card borders get an edge from `--draft-line`.
- The iOS pill under the hero carries one bot (`.peek`, Sora in ink): it rises over the pill's top
  edge once after load and then only blinks, glances and hops on hover; static with reduced motion.
- The demo scenes avoid plan and pricing words, so nothing in them reads as Dozo's own offer.
- The page claims only what ships. The local-model panel is gone because the catalog is empty
  (`dozo/README.md`, "Status and known limits"); bring it back when models are listed.
