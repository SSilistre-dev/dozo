# Dozo brand assets

Approved logo: variant H1 (soft robot head, tilted dark visor, two eyes, thin red headband).
Masters are hand-written SVG (no fonts, no raster, no strokes: the wordmark is outlined fills);
PNG/ICO are generated, do not edit by hand.

## Files
| File | Purpose |
|---|---|
| `mark.svg` | Full mark, head ink `currentColor`, band fixed `#C8372D`. viewBox is the tight bounds |
| `mark-small.svg` | Reduced variant for 16 to 32 px (the 16 and 32 px favicon tiles use this artwork). No script reads this file |
| `mark-mono-dark.svg` / `mark-mono-light.svg` | One ink (`#f4f3f0` / `#0d0d0d`), band in the same ink |
| `logo-dark.svg` / `logo-light.svg` | Mark + outlined `dozo` wordmark, explicit colours |
| `app-icon.svg` | Mark on a dark rounded tile (`#161616`), 12/128 margin |
| `app-icon-fullbleed.svg` | Same, square corners, mark at 125%: source of the opaque PWA/touch icons (inside the maskable safe circle) |
| `favicon.svg` | Reduced variant, ink `#0d0d0d` / `#f4f3f0` via `prefers-color-scheme` |
| `favicon-tile.svg`, `favicon-tile-large.svg` | Dark rounded tile + mark: sources of the 16/32 px and 48/128 px PNGs (PNG/ICO cannot switch ink, the tile keeps them legible on any tab strip) |
| `og-image.svg` / `og-image.png` | 1200x630 card: lockup + tagline (tagline is a path, Inter Regular, kept in `og-image.svg`) |
| `web/*` | Drop-in replacements for `apps/web/public/*` |
| `build.sh`, `render.mjs`, `raster.json`, `make-og.py`, `make-ico.py` | The pipeline |

## Web map (all pixel sizes equal upstream's)
| Upstream (`apps/web/public/`) | Ours | Size | Source |
|---|---|---|---|
| `favicon.ico` | `web/favicon.ico` | 16+32+48 (PNG-embedded) | tiles |
| `favicon.png` | `web/favicon.png` | 128x128 | `favicon-tile-large.svg` |
| `favicon-16x16.png`, `favicon-32x32.png` | `web/` | 16, 32 | `favicon-tile.svg` (reduced variant) |
| `apple-touch-icon.png` | `web/apple-touch-icon.png` | 180x180 | `app-icon-fullbleed.svg` |
| `icon-192.png`, `icon-512.png` | `web/` | 192, 512 | `app-icon-fullbleed.svg` (any + maskable) |
| (new) `favicon.svg` | `favicon.svg` | vector | linked by an anchored rule in `apps/web/index.html` |

`og-image.png` has no upstream equivalent in `public/`; it is not mapped.

## Rebuild
`dozo/brand/assets/build.sh` runs on the host, not in Docker: host `node` (`render.mjs`, built-ins
only) drives headless Brave (`$E2E_BROWSER_PATH` or the macOS default path) over CDP to draw each SVG
on a canvas of the exact pixel size, and host `python3` (standard library) runs `make-og.py`
(recomposes `og-image.svg`) and `make-ico.py` (packs the ICO). Nothing is installed. This is the
owner-accepted exception to the Docker-only rule in `dozo/AGENTS.md`. Brave needs to run outside
restrictive sandboxes (it fails to start inside one). Run it only when the masters change: the
outputs are committed.

## Colours
Band red `#C8372D` | ink on dark `#f4f3f0` | ink on light `#0d0d0d` | tile `#161616` | OG background
`#141414` | tagline grey `#8a8a86`.

## Wordmark outlines
The source drew `dozo` as 6.4-wide round-capped strokes. Each stroke is now a filled outline computed
exactly: letters `o`, `d` bowl = ring (outer r 16, inner r 9.6), `d` stem = stadium, `z` = three
stadiums (round joins equal the union of capsules). Rendered at 5x it differs from the stroked source
by at most 0.06 units on curved edges (the browser's stroker approximates arcs).
