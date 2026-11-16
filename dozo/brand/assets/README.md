# Dozo brand assets

Logo concept 02 "Visor" (`design/d/logos.html`): blue pill, two eye cut-outs, lowercase `dozo`.
Masters are hand-written SVG (no fonts, no raster); PNG/ICO are generated, do not edit by hand.

## Files
| File | Purpose |
|---|---|
| `mark.svg` | Mark alone, blue `#2b74ea`, true cut-out eyes, transparent |
| `mark-mono-light.svg` / `mark-mono-dark.svg` | One colour (`#141414` / `#f2f2f0`) for light / dark backgrounds |
| `logo-dark.svg` / `logo-light.svg` | Mark + `dozo` wordmark (paths) for dark / light backgrounds |
| `app-icon.svg` | Mark on rounded dark tile (`#1f1f1f`), safe-zone padding |
| `app-icon-fullbleed.svg` | Same, square corners: source of the opaque PWA/touch icons |
| `favicon.svg` | Small-size mark (32 grid, bigger eyes): source of favicons |
| `og-image.svg` / `og-image.png` | 1200x630 social card, tagline converted to paths (Inter Regular) |
| `web/*` | Drop-in replacements for `apps/web/public/*` |

## Web map (upstream file -> our file, all pixel sizes verified equal)
| Upstream (`apps/web/public/`) | Ours (`dozo/brand/assets/web/`) | Size | Use |
|---|---|---|---|
| `favicon.ico` | `favicon.ico` | 16+32+48 (PNG-embedded) | `<link rel=icon sizes=any>` |
| `favicon.png` | `favicon.png` | 128x128 | `<link rel=icon type=png>` |
| `favicon-16x16.png` | `favicon-16x16.png` | 16x16 | legacy tab icon |
| `favicon-32x32.png` | `favicon-32x32.png` | 32x32 | legacy tab icon |
| `apple-touch-icon.png` | `apple-touch-icon.png` | 180x180 | iOS home screen |
| `icon-192.png` | `icon-192.png` | 192x192 | PWA, purpose any + maskable |
| `icon-512.png` | `icon-512.png` | 512x512 | PWA, purpose any + maskable |

Not in upstream, new: `og-image.png` (no upstream equivalent in `public/`; `index.html` has no og tags).
Upstream has no `favicon.svg` or separate maskable files; `plugin.ts` reuses the 192/512 for both purposes.
Icons are full-bleed dark with the mark at about 56% width, inside the maskable safe zone.

## Rasterise
`dozo/brand/assets/build.sh` (needs Docker, runs everything in a throwaway `python:3.12-slim`,
installs `librsvg2-bin imagemagick fonts-inter` + `fonttools`, host stays clean). Core commands:

    rsvg-convert -w N -h N <src>.svg -o out.png ; convert out.png PNG32:out.png   # RGBA like upstream
    python make-ico.py favicon.ico favicon-16x16.png favicon-32x32.png f48.png   # PNG-embedded ICO
    python make-og.py && rsvg-convert -w 1200 -h 630 og-image.svg -o og-image.png

`make-og.py` turns the tagline into SVG paths with fonttools, so the SVG needs no font.

## Colours
Blue `#2b74ea` (mark, accent) | dark `#141414` | tile `#1f1f1f` | text on dark `#f2f2f0`
| light bg `#f5f5f3` | tagline grey `#8a8a86`.

## Open decision
Concept 02 was chosen without the owner's final sign-off. To swap: replace `MARK` path in the masters
(`mark*.svg`, `logo-*.svg`, `app-icon*.svg`, `favicon.svg`; wordmark paths in `logo-*.svg`),
then run `build.sh`. File names and sizes stay the same, so the brand tool's map does not change.
