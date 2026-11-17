# Writes the SVG masters of the desktop, mobile and mail images from mark.svg, mark-mono-dark.svg,
# logo-dark.svg and the six avatar symbols of ../../design/dozo.js (standard library only; no
# drawing by hand). Rasterise with build.sh. Sizes follow the files they replace.
import re

INK, RED, TILE, DARK = "#f4f3f0", "#C8372D", "#161616", "#141414"
CX, CY, W = 29.71, 32, 54.58  # centre and width of the mark's viewBox


def inner(name):
    return re.search(r"</title>(.*)</svg>", open(name).read(), re.S).group(1)


def put(art, x, y, width):
    # the mark, `width` px wide, centred on (x, y)
    s = width / W
    return f'<g transform="translate({x:g} {y:g}) scale({s:.5f}) translate({-CX} {-CY})">{art}</g>'


MARK = inner("mark.svg").replace("currentColor", INK)  # light head, red band
MONO = lambda ink: inner("mark-mono-dark.svg").replace(INK, ink)  # one ink


def svg(name, w, h, body, title="Dozo"):
    open(name, "w").write(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}"><title>{title}</title>{body}</svg>\n')


# macOS dev icon: 824 px plate with the Dock margin and a soft shadow (Icon Composer's pre-Tahoe look).
svg("app-icon-macos.svg", 1024, 1024,
    '<defs><filter id="s" x="-10%" y="-10%" width="120%" height="125%">'
    '<feDropShadow dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.3"/></filter></defs>'
    f'<rect x="100" y="100" width="824" height="824" rx="185" fill="{TILE}" filter="url(#s)"/>'
    + put(MARK, 512, 512, 439))
# Splash: the plate alone on a transparent square, so it reads on both splash colours.
svg("splash-icon.svg", 1024, 1024,
    f'<rect x="202" y="202" width="620" height="620" rx="155" fill="{TILE}"/>' + put(MARK, 512, 512, 360))
# Android adaptive layers: no mask, no plate; the mark stays inside the 66 % safe circle.
svg("adaptive-foreground.svg", 1024, 1024, put(MARK, 512, 512, 520))
svg("adaptive-monochrome.svg", 1024, 1024, put(MONO("#ffffff"), 512, 512, 520))
svg("icon-background.svg", 1024, 1024, f'<rect width="1024" height="1024" fill="{TILE}"/>')
svg("notification-icon.svg", 72, 72, put(MONO("#ffffff"), 36, 36, 60))
# Layer of the shared Icon Composer bundle: centred, transparent; the system fill is the plate.
svg("icon-layer.svg", 1024, 1024, put(MARK, 512, 512, 439))
# DMG window 660x400; the app and Applications icons sit at x 170 and 490, y 175. Light on purpose:
# Finder draws the icon labels dark.
svg("dmg-background.svg", 660, 400,
    f'<rect width="660" height="400" fill="{INK}"/>'
    '<path d="M280 175H380M362 160L380 175L362 190" fill="none" stroke="#a9a8a4" stroke-width="3" '
    'stroke-linecap="round" stroke-linejoin="round"/>')

# Welcome mail hero, 1040x546: the lockup over the six avatar characters, one ink, one red.
lock = open("logo-dark.svg").read()
vb = [float(v) for v in re.search(r'viewBox="([^"]+)"', lock).group(1).split()]
S = 3.2
heads = ""
for i, (n, body) in enumerate(re.findall(
        r'<symbol id="a-(\w+)" viewBox="0 0 64 64">(.*?)</symbol>', open("../../design/dozo.js").read(), re.S)):
    body = re.sub(r'<rect class="t\d" [^>]*/>', "", body)  # the coloured tile is not part of the hero
    body = re.sub(r"#(?:bfe0ff|e2d6ff|c4f2d9|ffe2ae|ffd0c6|b8f0f0)", INK, body).replace("var(--taro)", RED)
    heads += f'<g transform="translate({112 + i * 144} 336.5) scale(1.5)">{body}</g>'
svg("welcome-hero.svg", 1040, 546,
    f'<rect width="1040" height="546" fill="{DARK}"/>'
    f'<g transform="translate({(1040 - vb[2] * S) / 2:.2f} 130) scale({S}) translate({-vb[0]:g} {-vb[1]:g})">'
    f'{inner("logo-dark.svg")}</g>' + heads)
