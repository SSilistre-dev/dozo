# Dozo landing page

Plain static files, no build step: open `index.html` or run
`python3 -m http.server 8080 --directory dozo/landing`.

It is not part of `apps/www`: that Astro site is upstream's and is not edited by hand, and one
static page needs no framework. Publishing: `dozo/deploy/README.md`, "Landing page".

Closed pre-release state, to undo at launch:

- `robots.txt` disallows everything, the page has `<meta name="robots" content="noindex">` and the
  server sends `X-Robots-Tag: noindex` (`dozo/deploy/site.nginx.conf`). Remove all three.
- `og:url` and `og:image` and the call to action point at the pre-release addresses
  (`dozo-site.ssilistre.dev`, `dozo.ssilistre.dev/sign-in`). Swap in the real domain.
- The repository is published at github.com/SSilistre-dev/dozo. The header and footer navs link
  to "GitHub", the footer to "Licence", and "Self-host" points at the fork guide, `dozo/README.md`, there (the upstream guide names the upstream product).
- Hosted plan placeholder: the "We run it for you." block says only that hosted Dozo is in a
  closed preview and that plans and pricing come later. It has no price, plan table, form or
  payment link on purpose. Rewrite it when pricing is set and payment is connected.
- The page claims only what ships. The local-model panel is gone because the catalog is empty
  (`dozo/README.md`, "Status and known limits"); bring it back when models are listed.
