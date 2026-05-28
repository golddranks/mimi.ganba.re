#!/usr/bin/env python3
"""Minify the CSS and JS bundles consumed by scripts/build.py.

Reads src/**/{*.css,*.js} for each section and writes:

    build/app.{css,js}
    build/dashboard.{css,js}
    build/admin.{css,js}
    build/privacy.css

These standalone files are the inspectable artifacts — point any external
tool at them (`node --check build/admin.js`, eslint, prettier, …) to verify
the minifier didn't corrupt the source. scripts/build.py then inlines them
into the HTML templates.

Known fragility of the regex-based minifier here: a quote char inside a JS
regex literal (e.g. `/[&<>"']/g`) makes the tokenizer think a string opened,
and downstream `"` boundaries shift by one. Workaround in the source code
(e.g. use String.replaceAll with literal args instead of one regex literal).
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
BUILD = ROOT / "build"


def minify_css(src: str) -> str:
    src = re.sub(r"/\*[\s\S]*?\*/", "", src)
    src = re.sub(r"\s*([{}:;,>])\s*", r"\1", src)
    return re.sub(r"\s+", " ", src).strip()


def minify_js(src: str) -> str:
    # Single pass: at each position try strings/templates and comments together,
    # so a `'` inside a `// comment` doesn't get mistaken for a string opener
    # and a `//` inside a "https://..." doesn't get mistaken for a comment.
    preserved: list[str] = []
    def handle(m: re.Match) -> str:
        s = m.group(0)
        if s.startswith("/*") or s.startswith("//"):
            return ""
        preserved.append(s)
        return f"\x00{len(preserved) - 1}\x00"
    src = re.sub(
        r"`(?:\\.|[^`\\])*`"
        r"|'(?:\\.|[^'\\])*'"
        r"|\"(?:\\.|[^\"\\])*\""
        r"|/\*[\s\S]*?\*/"
        r"|//[^\n]*",
        handle, src,
    )
    src = re.sub(r"\s+", " ", src)
    src = re.sub(r" ?([^\w\s$]) ?", r"\1", src).strip()
    return re.sub(r"\x00(\d+)\x00", lambda m: preserved[int(m.group(1))], src)


# (label, src_path, kind)
ASSETS = [
    ("app",       SRC / "app.css",                   "css"),
    ("app",       SRC / "app.js",                    "js"),
    ("dashboard", SRC / "dashboard" / "dashboard.css", "css"),
    ("dashboard", SRC / "dashboard" / "dashboard.js",  "js"),
    ("admin",     SRC / "admin" / "admin.css",         "css"),
    ("admin",     SRC / "admin" / "admin.js",          "js"),
    ("privacy",   SRC / "privacy" / "privacy.css",     "css"),
]


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    sizes: list[tuple[str, int]] = []
    for label, src_path, kind in ASSETS:
        body = src_path.read_text(encoding="utf-8")
        out = minify_css(body) if kind == "css" else minify_js(body)
        dst = BUILD / f"{label}.{kind}"
        dst.write_text(out, encoding="utf-8")
        sizes.append((dst.name, len(out)))
    total = sum(n for _, n in sizes)
    print(f"minified {len(sizes)} files → build/ ({total / 1024:.1f} KB total)")
    for name, n in sizes:
        print(f"  {n / 1024:6.1f} KB  {name}")


if __name__ == "__main__":
    main()
