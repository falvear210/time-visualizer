#!/usr/bin/env python3
"""Assemble pi-kiosk/font-test.html from font-test-src/.

Bakes the candidate web fonts into the page as woff2 data: URIs so the result
is one self-contained file to scp onto a Pi -- no font packages, no network.

Run it from anywhere:  python3 pi-kiosk/build_font_test.py
Re-run it after editing font-test-src/font-test.template.html.
"""
import base64
import pathlib

SRC = pathlib.Path(__file__).parent / "font-test-src"
OUT = pathlib.Path(__file__).parent / "font-test.html"

# (CSS family name, woff2 file). Each is a variable font (weights 100-900)
# shipped by Google Fonts as a single latin-subset file.
EMBEDDED = [
    ("Inter", "Inter-400.woff2"),
    ("Source Sans 3", "SourceSans3-400.woff2"),
    ("IBM Plex Sans", "IBMPlexSans-400.woff2"),
    ("Public Sans", "PublicSans-400.woff2"),
    ("Figtree", "Figtree-400.woff2"),
]


def face(family: str, filename: str) -> str:
    b64 = base64.b64encode((SRC / filename).read_bytes()).decode()
    return (
        f"@font-face {{\n"
        f"  font-family: '{family}';\n"
        f"  font-weight: 100 900;\n"
        f"  font-display: swap;\n"
        f"  src: url(data:font/woff2;base64,{b64}) format('woff2');\n"
        f"}}"
    )


def main() -> None:
    faces = "\n".join(face(fam, fn) for fam, fn in EMBEDDED)
    html = (SRC / "font-test.template.html").read_text()
    html = html.replace("/*__FONT_FACES__*/", faces)
    OUT.write_text(html)
    print(f"wrote {OUT}  ({len(html) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
