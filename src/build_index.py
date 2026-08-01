#!/usr/bin/env python3
"""Generate build/index.html from src/base.html + src/category.xml.

Replaces the original blockly/joint.py, which was Python 2 and depended on
lxml. Two things drove the rewrite:

  * lxml round-tripped the whole document, which silently dropped the DOCTYPE
    (putting the app in quirks mode) and rewrote every void tag from `<meta />`
    to `<meta>`. Neither was intentional.
  * It escaped the injected toolbox XML and then string-replaced the escapes
    back out again, which only worked by luck.

A plain substitution into the empty <xml id="toolbox"> element avoids all of
that: everything outside the toolbox element survives byte-for-byte from
base.html, so what you read in the source is what ships.
"""

import pathlib
import re
import sys

SRC = pathlib.Path(__file__).resolve().parent
ROOT = SRC.parent

BASE = SRC / "base.html"
CATEGORY = SRC / "category.xml"
OUTPUT = ROOT / "build" / "index.html"

# The empty placeholder element in base.html that the toolbox XML drops into.
TOOLBOX = re.compile(r'(<xml\s+id="toolbox"[^>]*>)(\s*)(</xml>)', re.IGNORECASE)


def main() -> int:
    base = BASE.read_text(encoding="utf-8")
    category = CATEGORY.read_text(encoding="utf-8").strip()

    if not TOOLBOX.search(base):
        print(f"error: no <xml id=\"toolbox\"> element found in {BASE}", file=sys.stderr)
        return 1

    # Guard against a base.html that already carries a populated toolbox, which
    # would mean someone pasted generated output back into the source.
    if TOOLBOX.search(base).group(2).strip():
        print(f"error: <xml id=\"toolbox\"> in {BASE} is not empty", file=sys.stderr)
        return 1

    index = TOOLBOX.sub(lambda m: m.group(1) + "\n" + category + "\n" + m.group(3), base, count=1)

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(index, encoding="utf-8")

    print(f"wrote {OUTPUT.relative_to(ROOT)} ({len(index):,} chars)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
