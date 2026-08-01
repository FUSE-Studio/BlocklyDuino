#!/usr/bin/env python3
"""Materialise dist/ from build/, substituting the asset base.

build/ is the app as edited; it carries a literal __ASSET_BASE__ token wherever
an asset URL is built. This copies build/ to dist/ and replaces that token, so
nothing environment-specific is ever committed and dist/ is exactly what ships.

Usage: build_dist.py <asset-base>

  build_dist.py .                                        # local, relative
  build_dist.py https://satellite.fusestudio.net/blockly/a1b2c3d
"""

import pathlib
import shutil
import sys

TOKEN = "__ASSET_BASE__"

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
DIST = ROOT / "dist"


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2

    asset_base = argv[1].rstrip("/")

    if not BUILD.is_dir():
        print(f"error: {BUILD} does not exist", file=sys.stderr)
        return 1
    if not (BUILD / "index.html").is_file():
        print("error: build/index.html missing — run `make index` first", file=sys.stderr)
        return 1

    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(BUILD, DIST)

    substituted = []
    for path in sorted(DIST.rglob("*")):
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, ValueError):
            continue  # binary asset (fonts, images, the .swf)
        if TOKEN not in text:
            continue
        path.write_text(text.replace(TOKEN, asset_base), encoding="utf-8")
        substituted.append(path.relative_to(DIST))

    if not substituted:
        print(f"error: {TOKEN} not found anywhere in build/ — asset paths would 404", file=sys.stderr)
        return 1

    print(f"dist/ built with asset base {asset_base!r}")
    for rel in substituted:
        print(f"  substituted {rel}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
