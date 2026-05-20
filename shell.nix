# Slim shell by default (python + ffmpeg + uv) — enough for src/, scripts/build.py
# and CI. Pass `--arg voicevox true` to also get voicevox-engine for
# data/phonetic_training/morae/00_synthesize.py.
{ pkgs ? import <nixpkgs> {
    config.allowUnfreePredicate = pkg:
      builtins.elem (pkg.pname or pkg.name or "") [
        "voicevox-onnxruntime"
      ];
  },
  voicevox ? false
}:

let
  python = pkgs.python314;
  voicevoxEngine = pkgs.voicevox-engine.override { python3Packages = pkgs.python314Packages; };
in
pkgs.mkShell {
  packages = [
    python
    pkgs.uv
    pkgs.ffmpeg
  ] ++ pkgs.lib.optional voicevox voicevoxEngine;

  shellHook = ''
    # uv should build its venv on top of the nix python so any ABI-sensitive
    # deps (notably onnxruntime under voicevox) stay compatible.
    export UV_PYTHON="${python}/bin/python3"
  '' + pkgs.lib.optionalString voicevox ''

    # Path that the nixpkgs voicevox-engine derivation bundles its Python
    # site-packages (+ Rust/C core libs) into.
    export VOICEVOX_VOICELIB_DIR=$(
      grep -oE -- '--voicelib_dir=[^ "]+' \
        ${voicevoxEngine}/bin/voicevox-engine | head -1 | cut -d= -f2
    )
    export PYTHONPATH="${voicevoxEngine}/lib/python${python.pythonVersion}/site-packages''${PYTHONPATH:+:$PYTHONPATH}"
    echo "VOICEVOX_VOICELIB_DIR=$VOICEVOX_VOICELIB_DIR"
  '' + ''
    echo "Run scripts with:  uv run python <script>"
  '';
}
