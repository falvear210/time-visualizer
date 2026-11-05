#!/usr/bin/env python3
"""Regenerate the favicon set from the geometry below.

favicon.svg is the real icon -- everything here exists for the clients that
still want a raster. Run after editing the shape or the palette:

  python3 build-icons.py

Writes favicon.svg, favicon.ico, apple-touch-icon.png, site.webmanifest and
icons/*.png. Pure stdlib on purpose: no ImageMagick, rsvg or cairo needed, so
this keeps working on a machine with nothing installed.

The mark is three ascending progress bars on a SLUH-navy tile --
literally what the app draws for each class period, in the same
navy/dim/Spirit Blue family as the exam timer and attendance icons.
"""

import os
import struct
import zlib

NAVY = (0x00, 0x33, 0x66)     # SLUH Navy, the tile
DIM = (0x1a, 0x5b, 0x8a)      # a finished period
SPIRIT = (0x88, 0xcc, 0xec)   # the period underway

BOX = 64.0      # design grid; every dimension below is in these units
CORNER = 14.0   # tile corner radius
SS = 4          # supersampling factor per axis

SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#003366"/>
  <rect x="14.5" y="38" width="9" height="14" fill="#1a5b8a"/>
  <rect x="27.5" y="28" width="9" height="24" fill="#88ccec"/>
  <rect x="40.5" y="34" width="9" height="18" fill="#1a5b8a"/>
</svg>
"""

MANIFEST = """{
  "name": "SLUH Time Visualizer",
  "short_name": "SLUH Time",
  "description": "Live progress through the SLUH school day, period by period.",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#003366",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
"""


def classify(dx, dy):
    """dx, dy are offsets in BOX units from the tile center. Returns an RGB
    tuple for this point -- the glyph geometry lives here."""
    bars = [
        (-17.5, -8.5, 6, 20, DIM),
        (-4.5, 4.5, -4, 20, SPIRIT),
        (8.5, 17.5, 2, 20, DIM),
    ]
    for x0, x1, y0, y1, colour in bars:
        if x0 <= dx <= x1 and y0 <= dy <= y1:
            return colour
    return NAVY


def render(size, rounded=True):
    """Rasterise the mark at `size` px, returning RGBA bytes, row-major.

    `rounded` off gives a full-bleed square: iOS applies its own mask to the
    apple-touch icon and paints anything transparent black, and Android's
    maskable icons crop to a circle.
    """
    scale = BOX / size
    pixels = bytearray(size * size * 4)
    at = 0
    for py in range(size):
        for px in range(size):
            r = g = b = 0
            covered = 0
            for sy in range(SS):
                y = (py + (sy + 0.5) / SS) * scale
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) * scale
                    if rounded:
                        nx = min(max(x, CORNER), BOX - CORNER)
                        ny = min(max(y, CORNER), BOX - CORNER)
                        if (x - nx) ** 2 + (y - ny) ** 2 > CORNER * CORNER:
                            continue
                    covered += 1
                    colour = classify(x - BOX / 2, y - BOX / 2)
                    r += colour[0]
                    g += colour[1]
                    b += colour[2]
            if covered:
                pixels[at] = r // covered
                pixels[at + 1] = g // covered
                pixels[at + 2] = b // covered
                pixels[at + 3] = (covered * 255) // (SS * SS)
            at += 4
    return bytes(pixels)


def png(size, rgba):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    stride = size * 4
    raw = b"".join(b"\x00" + rgba[y * stride:(y + 1) * stride] for y in range(size))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def ico(sizes):
    """Pack `sizes` into a multi-resolution .ico as 32-bit BMPs.

    PNG-compressed entries are legal too, but BMP is what every reader
    including old Windows shells agrees on, and at these sizes it's tiny.
    """
    images = []
    for size in sizes:
        rgba = render(size)
        header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
        xor = bytearray()
        for y in range(size - 1, -1, -1):
            row = rgba[y * size * 4:(y + 1) * size * 4]
            for x in range(0, len(row), 4):
                xor += bytes((row[x + 2], row[x + 1], row[x], row[x + 3]))
        mask_stride = ((size + 31) // 32) * 4
        images.append(header + bytes(xor) + b"\x00" * (mask_stride * size))

    out = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    for size, data in zip(sizes, images):
        out += struct.pack("<BBBBHHII", size & 0xFF, size & 0xFF, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return out + b"".join(images)


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    os.makedirs(os.path.join(root, "icons"), exist_ok=True)

    def write(name, data):
        path = os.path.join(root, name)
        with open(path, "wb") as handle:
            handle.write(data)
        print("%-32s %6d bytes" % (name, len(data)))

    write("favicon.svg", SVG.encode())
    write("site.webmanifest", MANIFEST.encode())
    write("favicon.ico", ico([16, 32, 48]))
    write("apple-touch-icon.png", png(180, render(180, rounded=False)))
    write("icons/icon-192.png", png(192, render(192)))
    write("icons/icon-512.png", png(512, render(512)))
    write("icons/icon-maskable-512.png", png(512, render(512, rounded=False)))


if __name__ == "__main__":
    main()
