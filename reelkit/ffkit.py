"""ffmpeg plumbing: process runner, probing, font resolution.

Everything shells out to the ffmpeg/ffprobe on PATH — no bindings, no GUI.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

INSTALL_HINT = (
    "ffmpeg/ffprobe not found on PATH.\n"
    "  macOS:   brew install ffmpeg\n"
    "  Debian:  sudo apt install ffmpeg\n"
    "  Windows: winget install Gyan.FFmpeg (then reopen the shell)"
)


def require_ffmpeg():
    """Fail loudly, with an install hint, before any work starts."""
    missing = [t for t in ("ffmpeg", "ffprobe") if shutil.which(t) is None]
    if missing:
        raise SystemExit(INSTALL_HINT)


def run(cmd: list, log_path: Path | None = None, quiet: bool = True):
    """Run one ffmpeg/ffprobe command; on failure surface the tail of stderr
    (the useful part) instead of a silent non-zero exit."""
    if log_path:
        with open(log_path, "a") as fh:
            fh.write(" \\\n  ".join(str(c) for c in cmd) + "\n\n")
    proc = subprocess.run([str(c) for c in cmd], capture_output=True, text=True)
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.splitlines()[-25:])
        raise SystemExit(
            f"command failed ({proc.returncode}): {' '.join(str(c) for c in cmd[:6])} ...\n{tail}"
        )
    if not quiet and proc.stderr:
        print(proc.stderr, file=sys.stderr)
    return proc


def ffprobe_stream(path: Path) -> dict:
    """First video stream info + container duration."""
    proc = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,pix_fmt,r_frame_rate,duration",
        "-show_entries", "format=duration",
        "-of", "json", path,
    ])
    data = json.loads(proc.stdout)
    stream = (data.get("streams") or [{}])[0]
    fmt = data.get("format") or {}
    dur = stream.get("duration") or fmt.get("duration") or 0
    return {
        "width": stream.get("width"),
        "height": stream.get("height"),
        "pix_fmt": stream.get("pix_fmt"),
        "fps": stream.get("r_frame_rate"),
        "duration": float(dur),
    }


def image_size(path: Path) -> tuple:
    info = ffprobe_stream(path)
    return int(info["width"]), int(info["height"])


def measure_lufs(path: Path) -> dict:
    """EBU R128 measurement of a finished file (verification step)."""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
         "-map", "a:0", "-af",
         "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    # loudnorm prints its JSON block at the end of stderr
    text = proc.stderr
    start = text.rfind("{")
    if start == -1:
        return {}
    try:
        j = json.loads(text[start:])
        return {"input_i": float(j["input_i"]), "input_tp": float(j["input_tp"]),
                "input_lra": float(j["input_lra"])}
    except (json.JSONDecodeError, KeyError, ValueError):
        return {}


# ---------------------------------------------------------------------------
# Fonts
# ---------------------------------------------------------------------------

# Fallback chain: a project fonts/ dir wins; otherwise the cleanest grotesque
# we can find on the host. Liberation Sans is metrically Helvetica/Arial.
FALLBACK_FONTS = [
    ("Liberation Sans", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
     "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
    ("Helvetica", "/System/Library/Fonts/Helvetica.ttc",
     "/System/Library/Fonts/Helvetica.ttc"),
    ("Arial", "/Library/Fonts/Arial.ttf", "/Library/Fonts/Arial Bold.ttf"),
    ("Arial", "C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
    ("DejaVu Sans", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
     "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
]


def resolve_fonts(root: Path) -> dict:
    """Return {'name', 'regular', 'bold', 'source'} for the end card.

    fonts/ dir convention: any .ttf/.otf files; a file with 'bold' in the
    name is used for the display line, the first non-bold file for the rest.
    """
    fonts_dir = root / "fonts"
    if fonts_dir.is_dir():
        files = sorted([p for p in fonts_dir.iterdir()
                        if p.suffix.lower() in (".ttf", ".otf")])
        if files:
            bolds = [p for p in files if "bold" in p.name.lower()]
            regs = [p for p in files if "bold" not in p.name.lower()] or files
            reg = regs[0]
            bold = bolds[0] if bolds else reg
            return {"name": reg.stem, "regular": str(reg), "bold": str(bold),
                    "source": "project fonts/ dir"}
    for name, reg, bold in FALLBACK_FONTS:
        if Path(reg).exists():
            bold_path = bold if Path(bold).exists() else reg
            return {"name": name, "regular": reg, "bold": bold_path,
                    "source": "system fallback"}
    return {"name": "PIL default", "regular": "", "bold": "", "source": "last resort"}
