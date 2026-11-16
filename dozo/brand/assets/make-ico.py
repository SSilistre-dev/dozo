# Packs PNGs (16/32/48) into a PNG-embedded favicon.ico, same layout as upstream. Usage: make-ico.py out.ico a.png b.png ...
import struct, sys
out, pngs = sys.argv[1], [open(p, "rb").read() for p in sys.argv[2:]]
off, head, body = 6 + 16 * len(pngs), b"", b""
for d in pngs:
    w, h = struct.unpack(">II", d[16:24])
    head += struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(d), off + len(body))
    body += d
open(out, "wb").write(struct.pack("<HHH", 0, 1, len(pngs)) + head + body)
