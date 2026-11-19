#!/usr/bin/env bash
# Cache-proof asset addresses for the landing page. A CDN in front may keep a stylesheet for hours
# whatever the origin says, so a deploy would show new HTML with the old CSS. The address therefore
# carries the content: landing.css?v=<first 10 hex digits of its SHA-256>. New content, new address.
#   site-assets.sh stamp <dir>         rewrite every local css/js/svg/png/ico address in <dir>'s
#                                      HTML files, in place. Run on the copy that is published:
#                                      the repository's pages carry no version.
#   site-assets.sh verify <dir> <url>  the page at <url> must name the same stamped addresses as
#                                      <dir>/index.html, and each must serve the bytes of the file
#                                      in <dir>.
#   site-assets.sh lang <url>          the language rule of site.nginx.conf, by behaviour: <url>tr/
#                                      must set the dozo_lang=tr cookie and <url> must answer that
#                                      cookie with a 302 to <url>tr/. A config that was copied
#                                      but not loaded fails here.
# Not stamped: absolute URLs (og:image, read by crawlers, not by the page) and url() inside CSS
# (none today; stamp fails on nothing there, so check when one is added).
# Exits 2 on failure and 64 on a usage error.
set -Eeuo pipefail
# Ranges like [a-z] follow the locale's collation: under tr_TR.UTF-8, GNU grep and sed leave "i" out.
export LC_ALL=C

die() {
  printf '[site-assets] FAIL: %s\n' "$*" >&2
  exit 2
}
trap 'die "line $LINENO: $BASH_COMMAND"' ERR

digest() { # stdin
  if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi | cut -c1-10
}

# The stamped addresses in the HTML on stdin, one attribute per line.
stamped() { { grep -Eo '(href|src)="[^"]*\?v=[0-9a-f]{10}"' || true; } | sort -u; }

stamp() {
  local dir=$1 page ref file escaped
  cd "$dir"
  find . -type f -name '*.html' | while IFS= read -r page; do
    # No ":" in the address: an absolute URL is not ours to version.
    { grep -Eo '(href|src)="[A-Za-z0-9._/-]+\.(css|js|svg|png|ico)"' "$page" || true; } | sort -u |
      while IFS= read -r ref; do
        ref=${ref#*\"}
        ref=${ref%\"}
        case "$ref" in
          /*) file=.$ref ;;
          *) file=$(dirname "$page")/$ref ;;
        esac
        [ -f "$file" ] || die "$page names $ref, which is not a file in the tree"
        escaped=$(printf '%s' "$ref" | sed 's/\./\\./g')
        # "#" is never in $ref (see the grep above); an escaped "|" delimiter is read differently by sed builds.
        sed -E "s#(href|src)=\"$escaped\"#\\1=\"$ref?v=$(digest <"$file")\"#g" "$page" >"$page.stamp"
        cat "$page.stamp" >"$page"
        rm "$page.stamp"
      done
    # An address written another way (single quotes, no quotes, upper case, a fragment) would stay
    # unversioned and cached without a word: fail instead.
    ! grep -Eio "(href|src)=[\"']?[^\"' >:?]*\.(css|js|svg|png|ico)([\"' >#]|\$)" "$page" ||
      die "$page: the addresses above are local assets the stamp cannot version"
  done
}

verify() {
  local dir=$1 url=${2%/}/ page want live ref path local_digest live_digest
  want=$(stamped <"$dir/index.html")
  [ -n "$want" ] || die "$dir/index.html has no stamped address (run stamp first)"
  # Into a variable, never `curl | grep -q`: grep leaves at the first match and curl then fails.
  page=$(curl -fsS -m 20 "$url") || die "$url does not answer"
  live=$(stamped <<<"$page")
  [ "$live" = "$want" ] || die "$url names other asset addresses than the published tree:
live:
$live
published:
$want"
  while IFS= read -r ref; do
    path=${ref#*\"}
    path=${path%\"}
    local_digest=$(digest <"$dir/${path%%\?*}")
    live_digest=$(curl -fsS -m 20 "$url$path" | digest) || die "$url$path does not answer"
    [ "$live_digest" = "$local_digest" ] ||
      die "$url$path serves other content ($live_digest) than the published file ($local_digest)"
  done <<<"$live"
  printf '[site-assets] %s: %s stamped addresses serve the published files\n' \
    "$url" "$(wc -l <<<"$live" | tr -d ' ')"
}

lang() {
  local url=${1%/}/ headers answer
  headers=$(curl -fsS -m 20 -o /dev/null -D - "${url}tr/") || die "${url}tr/ does not answer"
  grep -qi '^set-cookie: dozo_lang=tr;' <<<"$headers" || die "${url}tr/ does not set the dozo_lang=tr cookie"
  answer=$(curl -sS -m 20 -o /dev/null -w '%{http_code} %{redirect_url}' -H 'Cookie: dozo_lang=tr' "$url") ||
    die "$url does not answer"
  [ "$answer" = "302 ${url}tr/" ] || die "$url answers the dozo_lang=tr cookie with \"$answer\", not a 302 to ${url}tr/"
  printf '[site-assets] %s: the language cookie is set and acted on\n' "$url"
}

case "${1:-}" in
  stamp) [ $# -eq 2 ] && [ -d "$2" ] || exit 64; stamp "$2" ;;
  verify) [ $# -eq 3 ] && [ -f "$2/index.html" ] || exit 64; verify "$2" "$3" ;;
  lang) [ $# -eq 2 ] || exit 64; lang "$2" ;;
  *) exit 64 ;;
esac
