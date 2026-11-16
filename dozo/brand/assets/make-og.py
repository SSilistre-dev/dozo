# Rebuilds og-image.svg: the dark lockup (logo-dark.svg) over the tagline.
# The tagline is already converted to a path (Inter Regular, 30 px, #8a8a86; no font needed) and
# lives in og-image.svg as <path id="tagline" transform="translate(x 414)" d=...>: it is read back
# from there, so this script needs only the standard library. Rasterise with build.sh.
import re
S, W, H, TOP, BASE = 3, 1200, 630, 216, 414
lock = open("logo-dark.svg").read()
vb = [float(v) for v in re.search(r'viewBox="([^"]+)"', lock).group(1).split()]
inner = re.search(r"</title>(.*)</svg>", lock, re.S).group(1)
old = open("og-image.svg").read()
tx, d = re.search(r'<path id="tagline"[^>]*translate\(([\d.]+) \d+\)" d="([^"]+)"', old).groups()
x = (W - vb[2] * S) / 2
out = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}"><title>Dozo</title>'
       f'<rect width="{W}" height="{H}" fill="#141414"/>'
       f'<g transform="translate({x:.2f} {TOP}) scale({S}) translate({-vb[0]:g} {-vb[1]:g})">{inner}</g>'
       f'<path id="tagline" fill="#8a8a86" transform="translate({tx} {BASE})" d="{d}"/></svg>\n')
open("og-image.svg", "w").write(out)
