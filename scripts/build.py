#!/usr/bin/env python3
"""Assemble the static site under dist/.

Minifies each page's CSS/JS with esbuild and inlines them — plus the voice
metadata from build/voices.json (produced by scripts/voicemap.py) — into the
HTML templates under src/, writing:

    dist/
      .nojekyll
      favicon.svg
      index.html             # css + js + window.VOICE_COUNTS inlined
      dashboard/index.html   # css + js inlined
      admin/index.html       # css + js + window.VOICE_MAP inlined
      privacy/index.html     # css inlined

esbuild is a single standalone binary (no node_modules); it's found at
$ESBUILD, then ./esbuild in the repo root, then on PATH. Install the pinned
version with:  curl -fsSL https://esbuild.github.io/dl/v0.28.0 | sh

JS is `--bundle`d into an IIFE so esbuild can mangle top-level names too (pages
never reference their own script's internals from outside) and so shared
modules resolve via plain `import`; `--charset=utf8` keeps kana literal. Output
is valid by construction — esbuild is a real parser, so there's no separate
minifier-corruption audit to run.

Audio transcoding is scripts/transcode_audio.py; voicemap generation is
scripts/voicemap.py. This script reads only their committed-shape outputs.
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
DIST = ROOT / "dist"
BUILD = ROOT / "build"
ESBUILD_VERSION = "0.28.0"


def esbuild_bin() -> str:
    cand = os.environ.get("ESBUILD") or str(ROOT / "esbuild")
    if Path(cand).is_file():
        return cand
    on_path = shutil.which("esbuild")
    if on_path:
        return on_path
    sys.exit(
        f"esbuild not found. Install the pinned binary into the repo root:\n"
        f"  curl -fsSL https://esbuild.github.io/dl/v{ESBUILD_VERSION} | sh\n"
        f"(or set $ESBUILD, or put esbuild on PATH)."
    )


ESBUILD = esbuild_bin()


def minify(src_path: Path, *flags: str) -> str:
    return subprocess.run(
        [ESBUILD, str(src_path), "--minify", "--charset=utf8", *flags],
        capture_output=True, text=True, check=True,
    ).stdout


def read_voices_json() -> dict[str, dict]:
    path = BUILD / "voices.json"
    if not path.exists():
        sys.exit(f"{path.relative_to(ROOT)} missing; run scripts/voicemap.py first.")
    return json.loads(path.read_text(encoding="utf-8"))


def inline(html: str, src_dir: Path, css_name: str | None,
           js_name: str | None, js_prelude: str = "") -> str:
    """Minify the page's referenced CSS/JS (esbuild) and inline them in place
    of its <link rel=stylesheet> / <script src> tags."""
    if css_name:
        css = minify(src_dir / css_name)
        html = re.sub(
            rf'<link\s+rel="stylesheet"\s+href="{re.escape(css_name)}"\s*/?>',
            lambda _m: f"<style>{css}</style>",
            html, count=1,
        )
    if js_name:
        js = minify(src_dir / js_name, "--bundle", "--format=iife")
        html = re.sub(
            rf'<script\s+src="{re.escape(js_name)}"></script>',
            lambda _m: f"<script>{js_prelude}{js}</script>",
            html, count=1,
        )
    return re.sub(r">\s+<", "><", html).strip()


def bundle_index(voice_counts: dict[str, int]) -> None:
    html = (SRC / "index.html").read_text(encoding="utf-8")
    counts_js = json.dumps(voice_counts, ensure_ascii=False, separators=(",", ":"))
    html = inline(html, SRC, "app.css", "app.js",
                  js_prelude=f"window.VOICE_COUNTS={counts_js};")
    DIST.mkdir(parents=True, exist_ok=True)
    (DIST / "index.html").write_text(html, encoding="utf-8")
    (DIST / ".nojekyll").write_text("")
    shutil.copy(SRC / "favicon.svg", DIST / "favicon.svg")


def bundle_dashboard() -> None:
    src = SRC / "dashboard"
    html = inline((src / "index.html").read_text(encoding="utf-8"),
                  src, "dashboard.css", "dashboard.js")
    out = DIST / "dashboard"
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(html, encoding="utf-8")


def bundle_privacy() -> None:
    src = SRC / "privacy"
    html = inline((src / "index.html").read_text(encoding="utf-8"),
                  src, "privacy.css", None)
    out = DIST / "privacy"
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(html, encoding="utf-8")


def bundle_admin(voice_map: dict[str, list[str]]) -> None:
    src = SRC / "admin"
    voice_js = json.dumps(voice_map, ensure_ascii=False, separators=(",", ":"))
    html = inline((src / "index.html").read_text(encoding="utf-8"),
                  src, "admin.css", "admin.js",
                  js_prelude=f"window.VOICE_MAP={voice_js};")
    out = DIST / "admin"
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(html, encoding="utf-8")


def main() -> None:
    voices = read_voices_json()
    voice_counts = {mora: len(info["voices"]) for mora, info in voices.items()}
    voice_map = {mora: info["voices"] for mora, info in voices.items()}

    bundle_index(voice_counts)
    bundle_dashboard()
    bundle_privacy()
    bundle_admin(voice_map)

    pages = list(DIST.rglob("index.html"))
    html_total = sum(f.stat().st_size for f in pages if f.is_file())
    print(f"bundled: {html_total / 1024:.1f} KB across {len(pages)} index.html files in dist/")


if __name__ == "__main__":
    main()
