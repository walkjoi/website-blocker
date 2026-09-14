#!/usr/bin/env python3
"""Draws the extension icons (a "no entry" sign) into icons/.

Uses only the standard library. Run from anywhere:
    python3 scripts/make_icons.py
"""
import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "icons"
COLORS = {"on": (229, 72, 77), "off": (145, 150, 156)}
SIZES = (16, 32, 48, 128)
SAMPLES = 4  # supersampling per axis, for smooth edges


def pixel(size, x, y, color):
    radius = size * 0.47
    bar_half_width = size * 0.27
    bar_half_height = size * 0.085
    circle = bar = 0
    for sy in range(SAMPLES):
        for sx in range(SAMPLES):
            px = x + (sx + 0.5) / SAMPLES - size / 2
            py = y + (sy + 0.5) / SAMPLES - size / 2
            if px * px + py * py <= radius * radius:
                circle += 1
                if abs(px) <= bar_half_width and abs(py) <= bar_half_height:
                    bar += 1
    if not circle:
        return bytes(4)
    white = bar / circle
    rgb = (round(c + (255 - c) * white) for c in color)
    return bytes([*rgb, round(255 * circle / SAMPLES**2)])


def png(size, color):
    rows = (
        b"\x00" + b"".join(pixel(size, x, y, color) for x in range(size))
        for y in range(size)
    )

    def chunk(tag, data):
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
        + chunk(b"IEND", b"")
    )


if __name__ == "__main__":
    OUT_DIR.mkdir(exist_ok=True)
    for state, color in COLORS.items():
        for size in SIZES:
            path = OUT_DIR / f"{state}-{size}.png"
            path.write_bytes(png(size, color))
            print(f"wrote {path.relative_to(OUT_DIR.parent)}")
