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

Theme: dark unless the address says `?theme=light`. Every page loads `theme.js` in `<head>`, the one
copy of the theme logic, so it paints in its theme; the header button switches it and the choice
travels in the page's address and in its links to the site's other pages. Nothing is stored, so the
privacy pages' one-cookie statement stays true. The home page's own script is `landing.js`.

Legal pages: `privacy/`, `terms/` and `refunds/`, one `index.html` each per language, linked from
every footer. Plain text under the landing page's header and footer. They state only what the code does (the data flows were read
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

Closed pre-release state, to undo at launch:

- `robots.txt` disallows everything, the page has `<meta name="robots" content="noindex">` and the
  server sends `X-Robots-Tag: noindex` (`dozo/deploy/site.nginx.conf`). Remove all three.
- The repository is published at github.com/SSilistre-dev/dozo. The header and footer navs link
  to "GitHub", the footer's "Licence" to `dozo/NOTICE` (which file is under which licence), and "Self-host", the primary buttons and the self-hosting row's "Set it up" point at the fork guide, `dozo/README.md`, there (the upstream guide names the upstream product).
- The "Desktop app." block links the macOS and Windows installers by the fixed asset names of the
  latest GitHub release (`releases/latest/download/Dozo-macOS.dmg`,
  `Dozo-Windows-x64-setup.exe`), so a new release needs no edit here; renaming an asset breaks them.
  The "not signed yet" note is the one `<p>` in that block, once per language: edit that line when
  a package is signed.
- Plans: the "Plans." section shows the three hosted plans as cards, one under the other on a
  phone, with self-hosting as one row under them. Each card holds both the monthly and the yearly
  price; the Monthly / Yearly switch (`landing.js`, yearly first) shows one and sets `period=` on the
  paid cards' sign-up links, which also carry `plan=premium` or `plan=premium_plus`. Without the
  script both prices show. Premium has the ink frame. The prices, the yearly saving, computer
  hours, file storage and each computer's vCPUs and memory are read from the code by
  `dozo/e2e/landing-pages.test.mjs` (`BYOK_TIERS` in `packages/contracts/src/billing.ts`,
  `dozo-plans.ts`, and the default `RAKAZO_COMPUTER_SIZES` in `dozo/deploy/compose.deploy.yml`), and
  it fails when a page disagrees. No discount, tax line or other number: write one only once the
  owner has set it and the code enforces it.
- The dragon behind the plans (`.scales`) is decoration, drawn once per language page: the logo
  mark as its head, in the mark's red, kept faint. Its body path is generated, not hand-drawn:
  redraw it whole if the shape changes. The plan cards are slightly translucent so it shows
  through; keep text contrast at 4.5 or more when changing either opacity.
- The demo scenes avoid plan and pricing words, so nothing in them reads as Dozo's own offer.
- The page claims only what ships. The local-model panel is gone because the catalog is empty
  (`dozo/README.md`, "Status and known limits"); bring it back when models are listed.
