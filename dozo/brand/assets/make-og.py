# Builds og-image.svg: lockup + tagline converted to paths (no font needed at render time).
# Needs fonttools and Inter (fonts-inter). Run via build.sh.
import re
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

TEXT, SIZE, FILL = "AI bots with their own computer", 30, "#8a8a86"
f = TTFont("/usr/share/fonts/opentype/inter/Inter-Regular.otf")
gs, cmap, upm = f.getGlyphSet(), f.getBestCmap(), f["head"].unitsPerEm
s = SIZE / upm
x, parts = 0.0, []
for ch in TEXT:
    g = cmap[ord(ch)]
    if ch != " ":
        pen = SVGPathPen(gs, ntos=lambda v: ("%.2f" % v).rstrip("0").rstrip("."))
        gs[g].draw(TransformPen(pen, (s, 0, 0, -s, x, 0)))
        parts.append(pen.getCommands())
    x += gs[g].width * s
w = x
lk = open("logo-dark.svg").read()
inner = re.search(r'<svg[^>]*>(.*)</svg>', lk, re.S).group(1).strip()
# lockup content spans x 0..338, y 0..100; scale 2 -> 676x200, centred horizontally
out = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#141414"/><g transform="translate(262 195) scale(2)">{inner}</g><path fill="{FILL}" transform="translate({600 - w/2:.2f} 440)" d="{' '.join(parts)}"/></svg>
'''
open("og-image.svg", "w").write(out)
