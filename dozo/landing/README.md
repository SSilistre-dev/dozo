# Dozo landing page

Plain static files, no build step: open `index.html` or run
`python3 -m http.server 8080 --directory dozo/landing`.

It is not part of `apps/www`: that Astro site is upstream's and is not edited by hand, and one
static page needs no framework. Links use placeholders (`dozo.example`, `github.com/OWNER/dozo`);
replace them when the domain and repository exist.
