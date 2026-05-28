#!/usr/bin/env python3
"""Assemble the static site under dist/.

Reads pre-minified CSS/JS from build/ (produced by scripts/minify.py) and
voice metadata from build/voices.json (produced by scripts/voicemap.py),
inlines everything into the HTML templates under src/, and writes:

    dist/
      .nojekyll
      favicon.svg
      index.html             # css + js + window.VOICE_COUNTS inlined
      dashboard/index.html   # css + js inlined
      admin/index.html       # css + js + window.VOICE_MAP inlined
      privacy/index.html     # css inlined

Audio transcoding is scripts/transcode_audio.py; voicemap generation is
scripts/voicemap.py. This script depends on neither directly — it only
reads their committed-shape outputs in build/.
"""

import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
DIST = ROOT / "dist"
BUILD = ROOT / "build"


def read_voices_json() -> dict[str, dict]:
    path = BUILD / "voices.json"
    if not path.exists():
        import sys
        sys.exit(
            f"{path.relative_to(ROOT)} missing; "
            f"run scripts/voicemap.py first."
        )
    return json.loads(path.read_text(encoding="utf-8"))


def read_bundle(label: str, ext: str) -> str:
    path = BUILD / f"{label}.{ext}"
    if not path.exists():
        import sys
        sys.exit(
            f"{path.relative_to(ROOT)} missing; "
            f"run scripts/minify.py first."
        )
    return path.read_text(encoding="utf-8")


def inline(html: str, css_name: str | None, js_name: str | None,
           bundle_label: str, js_prelude: str = "") -> str:
    """Inline <link rel=stylesheet> and <script src> tags using the
    pre-minified bundles under build/<bundle_label>.{css,js}."""
    if css_name:
        css = read_bundle(bundle_label, "css")
        html = re.sub(
            rf'<link\s+rel="stylesheet"\s+href="{re.escape(css_name)}"\s*/?>',
            lambda _m: f"<style>{css}</style>",
            html, count=1,
        )
    if js_name:
        js = read_bundle(bundle_label, "js")
        html = re.sub(
            rf'<script\s+src="{re.escape(js_name)}"></script>',
            lambda _m: f"<script>{js_prelude}{js}</script>",
            html, count=1,
        )
    return re.sub(r">\s+<", "><", html).strip()


def bundle_index(voice_counts: dict[str, int]) -> None:
    html = (SRC / "index.html").read_text(encoding="utf-8")
    counts_js = json.dumps(voice_counts, ensure_ascii=False, separators=(",", ":"))
    html = inline(html, "app.css", "app.js",
                  bundle_label="app",
                  js_prelude=f"window.VOICE_COUNTS={counts_js};")
    DIST.mkdir(parents=True, exist_ok=True)
    (DIST / "index.html").write_text(html, encoding="utf-8")
    (DIST / ".nojekyll").write_text("")
    shutil.copy(SRC / "favicon.svg", DIST / "favicon.svg")


def bundle_dashboard() -> None:
    src = SRC / "dashboard"
    html = inline((src / "index.html").read_text(encoding="utf-8"),
                  "dashboard.css", "dashboard.js", bundle_label="dashboard")
    out = DIST / "dashboard"
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(html, encoding="utf-8")


def bundle_privacy() -> None:
    src = SRC / "privacy"
    html = inline((src / "index.html").read_text(encoding="utf-8"),
                  "privacy.css", None, bundle_label="privacy")
    out = DIST / "privacy"
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(html, encoding="utf-8")


def bundle_admin(voice_map: dict[str, list[str]]) -> None:
    src = SRC / "admin"
    voice_js = json.dumps(voice_map, ensure_ascii=False, separators=(",", ":"))
    html = inline((src / "index.html").read_text(encoding="utf-8"),
                  "admin.css", "admin.js",
                  bundle_label="admin",
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

    html_total = sum(
        f.stat().st_size for f in DIST.rglob("index.html") if f.is_file()
    )
    print(f"bundled: {html_total / 1024:.1f} KB across "
          f"{len(list(DIST.rglob('index.html')))} index.html files in dist/")


if __name__ == "__main__":
    main()
