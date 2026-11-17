# Drops the alpha channel of 8-bit RGBA PNGs in place (the browser always writes RGBA; the iOS icon,
# the widget mark and the DMG background must have none). Fails when a pixel is not fully opaque.
# Usage: make-rgb.py a.png b.png ... (standard library only)
import struct, sys, zlib


def chunks(data):
    i = 8
    while i < len(data):
        n, kind = struct.unpack(">I4s", data[i:i + 8])
        yield kind, data[i + 8:i + 8 + n]
        i += 12 + n


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c


for path in sys.argv[1:]:
    data = open(path, "rb").read()
    ihdr = next(b for k, b in chunks(data) if k == b"IHDR")
    w, h, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", ihdr)
    if (depth, color, interlace) != (8, 6, 0):
        sys.exit(f"{path}: expected 8-bit RGBA without interlace")
    raw = zlib.decompress(b"".join(b for k, b in chunks(data) if k == b"IDAT"))
    stride, prev, rows = w * 4, bytearray(w * 4), []
    for y in range(h):
        f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - 4] if i >= 4 else 0
            c = prev[i - 4] if i >= 4 else 0
            line[i] = (line[i] + (0, a, prev[i], (a + prev[i]) // 2, paeth(a, prev[i], c))[f]) & 255
        if any(line[3::4][j] != 255 for j in range(w)):
            sys.exit(f"{path}: row {y} has a pixel that is not fully opaque")
        rows.append(b"\0" + b"".join(bytes(line[j:j + 3]) for j in range(0, stride, 4)))
        prev = line
    body = zlib.compress(b"".join(rows), 9)
    png = lambda k, b: struct.pack(">I", len(b)) + k + b + struct.pack(">I", zlib.crc32(k + b))
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + png(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                           + png(b"IDAT", body) + png(b"IEND", b""))
