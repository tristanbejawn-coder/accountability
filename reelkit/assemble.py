#!/usr/bin/env python3
"""Assemble "The Edit" — an 18s vertical Reel from stills + two AI clips.

Usage, from the project root (where reel.yaml lives):

    python3 reelkit/assemble.py --dry-run       # resolved timeline, no render
    python3 reelkit/assemble.py --preview       # 540x960 CRF28, fast
    python3 reelkit/assemble.py                 # 1080x1920 CRF18 master

First run with no reel.yaml scaffolds an annotated example and exits.
See reelkit/README.md for the full asset contract.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from datetime import date
from pathlib import Path

if __package__ in (None, ""):                      # allow `python3 reelkit/assemble.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from reelkit import config as C
from reelkit.audiomix import build_audio, mux
from reelkit.ffkit import (ffprobe_stream, measure_lufs, require_ffmpeg,
                           resolve_fonts)
from reelkit.segments import SegmentRenderer


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def print_timeline(cfg: dict, tl, root: Path, fonts: dict, out_path: Path):
    print(f"\n  series   : {cfg.get('series_name')}")
    print(f"  output   : {out_path}")
    print(f"  font     : {fonts['name']} ({fonts['source']})")
    print(f"  total    : {tl.total:.2f}s\n")
    print("  seg    in      out     dur   content")
    print("  " + "-" * 74)
    for s in tl.segments:
        print(f"  {s.key}   {s.start:6.2f}  {s.end:6.2f}  {s.dur:5.2f}"
              f"   {s.label}")
        if s.key == "D":
            b = s.beats
            print(f"        beats: full@{b['full']:.2f}  six@{b['six']:.2f}"
                  f"  one@{b['one']:.2f}   circle@{tl.circle_start:.2f}"
                  f" (+{tl.circle_draw:.2f}s draw)")
    print("\n  audio events")
    print("  " + "-" * 74)
    print(f"  bed      : 0.00 -> {tl.total:.2f}  (fade-in {tl.bed_fade_in:.2f}s,"
          f" ducked at shutter hits)")
    print(f"  room     : {tl.room_span[0]:.2f} -> {tl.room_span[1]:.2f}")
    print(f"  shutter  : " + ", ".join(f"{t:.2f}" for t in tl.shutter_times))
    audio = cfg.get("audio") or {}
    if audio.get("film_advance"):
        print(f"  wind-on  : " + ", ".join(f"{t:.2f}" for t in tl.advance_times))
    if audio.get("film_texture"):
        print(f"  texture  : {tl.room_span[0]:.2f} -> {tl.room_span[1]:.2f}"
              f"  (projector gate, low)")
    moves = C.resolve_movement(cfg)
    active = ", ".join(f"{k} -> x{v:.3f}" for k, v in moves.items() if v > 1.0001)
    print(f"  movement : {active or 'none (all still segments static)'}")


def print_asset_map(cfg: dict, root: Path):
    print("\n  asset map")
    print("  " + "-" * 74)
    assets = cfg.get("assets") or {}
    audio = cfg.get("audio") or {}
    rows = []
    for k in C.REQUIRED_ASSET_KEYS:
        rows.append((f"assets.{k}", assets.get(k)))
    for i, p in enumerate(assets.get("selects_round_1") or []):
        rows.append((f"assets.selects_round_1[{i}]", p))
    for i, p in enumerate(assets.get("grade_states") or []):
        rows.append((f"assets.grade_states[{i}]", p))
    for k in C.REQUIRED_AUDIO_KEYS:
        rows.append((f"audio.{k}", audio.get(k)))
    for label, rel in rows:
        state = "ok" if rel and (root / rel).exists() else "MISSING"
        print(f"  {state:7s}  {label:32s} {rel}")


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

def verify(out_path: Path, q: dict, tl, cfg: dict) -> bool:
    info = ffprobe_stream(out_path)
    loud = measure_lufs(out_path)
    target = float((cfg.get("audio") or {}).get("target_lufs",
                                                C.DEFAULT_AUDIO["target_lufs"]))
    ok = True

    def check(label, good, detail):
        nonlocal ok
        mark = "ok " if good else "FAIL"
        if not good:
            ok = False
        print(f"  {mark}  {label:14s} {detail}")

    print("\n  verification")
    print("  " + "-" * 74)
    check("duration", abs(info["duration"] - tl.total) <= 0.2,
          f"{info['duration']:.3f}s (target {tl.total:.1f} ±0.2)")
    check("resolution", (info["width"], info["height"]) == (q["w"], q["h"]),
          f"{info['width']}x{info['height']} (target {q['w']}x{q['h']})")
    check("pix_fmt", info["pix_fmt"] == "yuv420p", info["pix_fmt"])
    check("fps", info["fps"] in (f"{q['fps']}/1", str(q["fps"])), info["fps"])
    if loud:
        tp_target = float((cfg.get("audio") or {}).get("true_peak",
                                                       C.DEFAULT_AUDIO["true_peak"]))
        # loudnorm linear mode can land ~0.5 LU off target; report, warn wide
        check("loudness", abs(loud["input_i"] - target) <= 1.0,
              f"{loud['input_i']:.1f} LUFS integrated (target {target})")
        check("true peak", loud["input_tp"] <= tp_target + 0.1,
              f"{loud['input_tp']:.1f} dBTP (ceiling {tp_target})")
    else:
        check("loudness", False, "could not measure")
    return ok


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--config", default="reel.yaml", help="config path")
    ap.add_argument("--dry-run", action="store_true",
                    help="print resolved timeline + asset map, no render")
    ap.add_argument("--preview", action="store_true",
                    help="540x960 CRF28 fast render for iteration")
    ap.add_argument("--keep-work", action="store_true",
                    help="keep the work/ dir of intermediates")
    args = ap.parse_args(argv)

    require_ffmpeg()
    root = Path.cwd()
    cfg = C.load_config(root / args.config)
    tl = C.resolve_timeline(cfg)
    fonts = resolve_fonts(root)
    q = dict(C.VIDEO_PREVIEW if args.preview else C.VIDEO_FULL)

    slug = C.slugify(cfg.get("series_name") or "series")
    suffix = "_preview" if args.preview else ""
    out_dir = root / "out"
    out_path = out_dir / f"{slug}_{date.today():%Y%m%d}{suffix}.mp4"

    print_timeline(cfg, tl, root, fonts, out_path)
    print_asset_map(cfg, root)

    problems = C.validate(cfg, root)
    if problems:
        print(f"\n{len(problems)} problem(s) — nothing rendered:", file=sys.stderr)
        for p in problems:
            print(f"  * {p}", file=sys.stderr)
        return 2
    if args.dry_run:
        print("\n  dry run — nothing rendered.")
        return 0

    # ---- render ----------------------------------------------------------
    work = root / "work" / ("preview" if args.preview else "full")
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    out_dir.mkdir(exist_ok=True)
    log = work / "commands.log"
    assets = cfg["assets"]

    r = SegmentRenderer(root, work, q, log, movement=C.resolve_movement(cfg))
    print(f"\n  rendering at {q['w']}x{q['h']} crf {q['crf']} ({fonts['name']})")

    sheet_base, fit = r.sheet_base(root / assets["contact_sheet"])
    parts = []
    for seg in tl.segments:
        print(f"  - segment {seg.key}: {seg.label}")
        if seg.key == "A":
            parts.append(r.seg_A(seg, assets))
        elif seg.key == "B":
            parts.append(r.seg_B(seg, sheet_base))
        elif seg.key == "C":
            parts.append(r.seg_clip(seg, assets["clip_contact_push"]))
        elif seg.key == "D":
            parts.append(r.seg_D(seg, cfg, tl, sheet_base, fit))
        elif seg.key == "E":
            parts.append(r.seg_E(seg, cfg, assets))
        elif seg.key == "F":
            parts.append(r.seg_clip(seg, assets["clip_living_portrait"]))
        elif seg.key == "G":
            parts.append(r.seg_G(seg, cfg, fonts))

    print("  - concat video")
    silent = work / "video.mp4"
    r.concat(parts, silent)

    print("  - audio mix (2-pass loudnorm)")
    mix = build_audio(root, work, cfg, tl, log)

    print("  - mux")
    mux(silent, mix, out_path, log)

    ok = verify(out_path, q, tl, cfg)
    if not args.keep_work:
        shutil.rmtree(work, ignore_errors=True)
    print(f"\n  {'done' if ok else 'done WITH FAILURES'}: {out_path}\n")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
