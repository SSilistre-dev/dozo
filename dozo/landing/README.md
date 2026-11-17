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
- No GitHub link is shown because the repository is not published. When it is, add "GitHub"
  and "Licence" links back to the header and footer navs and let "Self-host" point at
  `docs/self-host.md` in the repository.
- The page claims only what ships. The local-model panel is gone because the catalog is empty
  (`dozo/README.md`, "Status and known limits"); bring it back when models are listed.
