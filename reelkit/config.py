"""Config + timeline model for the reel assembler.

The timeline is DATA, not ffmpeg strings: every beat length lives either in
DEFAULT_TIMELINE below or in the `timeline:` block of reel.yaml, and every
downstream time (audio events, mask enable windows, xfade offsets) is derived
from the resolved segment list at run time. Adjusting a beat per series is a
config edit, never a code edit.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

# ---------------------------------------------------------------------------
# Defaults (all durations in seconds; these reproduce the 18.0s spec)
# ---------------------------------------------------------------------------

# Segment order is fixed (A..G tell the story in a fixed sequence); durations
# are per-series tunable. D is expressed as its three internal beats.
DEFAULT_TIMELINE = {
    "A": 1.5,                                   # final frame, full bleed
    "B": 0.5,                                   # hard cut to contact sheet
    "C": 5.0,                                   # clip_contact_push
    "D": {"full": 1.0, "six": 1.0, "one": 1.0},  # selects narrowing beats
    "E": 3.0,                                   # grade progression
    "F": 3.5,                                   # clip_living_portrait
    "G": 1.5,                                   # end card
}

DEFAULT_E_CROSSFADE = 0.5      # xfade length between grade states
DEFAULT_E_SCALE_RAMP = 1.03    # scale at end of E (starts at 1.00)
DEFAULT_CIRCLE_DRAW = 0.4      # chinagraph stroke-reveal duration
DEFAULT_CIRCLE_DELAY = 0.15    # pause after last beat lands before the pen moves

DEFAULT_AUDIO = {
    "target_lufs": -14.0,
    "true_peak": -1.0,
    # Pre-mix trims (dB). The master is loudnorm'd afterwards, so these set
    # the *balance*, not the absolute level.
    "bed_db": -7.0,
    "room_db": -16.0,
    "shutter_db": 0.0,
    "duck_db": -2.0,        # bed dip under each shutter hit
    "duck_len": 0.30,       # seconds the dip lasts (from click start)
    # Optional film elements (used when the files are configured):
    "film_advance_db": -4.0,   # wind-on ratchet after the select is circled
    "film_texture_db": -28.0,  # projector-gate hiss/flicker under C..F
}

# End scale of an eased push across a segment (1.0 = static). Only stills
# take movement: A (opener), B (sheet flash) and D (lightbox). B defaults to
# static so the cut into the pre-rendered contact push starts from the same
# framing; C/F are pre-rendered and E has its own spec'd ramp.
DEFAULT_MOVEMENT = {"A": 1.05, "B": 1.0, "D": 1.025}

VIDEO_FULL = {"w": 1080, "h": 1920, "fps": 30, "crf": 18, "preset": "slow"}
VIDEO_PREVIEW = {"w": 540, "h": 960, "fps": 30, "crf": 28, "preset": "veryfast"}

PAD_COLOUR = "#0b0b0b"   # near-black behind the letterboxed contact sheet
DIM_OPACITY = 0.35       # non-selected frames dim to 35%
CIRCLE_COLOUR = (0xC4, 0x32, 0x2A)   # warm chinagraph red
CIRCLE_STROKE = 6        # px at 1080-wide reference


# ---------------------------------------------------------------------------
# Timeline model
# ---------------------------------------------------------------------------

@dataclass
class Segment:
    key: str          # "A".."G"
    label: str
    start: float
    dur: float
    source: str       # human-readable source description for dry-run
    beats: dict = field(default_factory=dict)   # D only: resolved beat starts

    @property
    def end(self) -> float:
        return self.start + self.dur


@dataclass
class Timeline:
    segments: list
    total: float
    # Derived audio events -------------------------------------------------
    shutter_times: list        # absolute times of every shutter click
    advance_times: list        # film wind-on events (after the circle lands)
    bed_fade_in: float         # bed fades in across segment A
    room_span: tuple           # (start, end) of room tone (C through F)
    circle_start: float        # absolute time the chinagraph pen touches down
    circle_draw: float         # stroke-reveal duration

    def segment(self, key: str) -> Segment:
        return next(s for s in self.segments if s.key == key)


def resolve_timeline(cfg: dict) -> Timeline:
    """Turn the timeline config block into absolute segment in/out times and
    every derived event (shutter clicks, room-tone span, circle window)."""
    t = dict(DEFAULT_TIMELINE)
    user_t = cfg.get("timeline") or {}
    for k, v in user_t.items():
        if k in t:
            t[k] = v

    d_beats = t["D"] if isinstance(t["D"], dict) else {"full": float(t["D"]) / 3}
    d_full = float(d_beats.get("full", 1.0))
    d_six = float(d_beats.get("six", 1.0))
    d_one = float(d_beats.get("one", 1.0))
    d_total = d_full + d_six + d_one

    labels = {
        "A": "final frame, full bleed, static",
        "B": "contact sheet, wide",
        "C": "clip_contact_push (pre-rendered)",
        "D": "selects narrowing + chinagraph circle",
        "E": "grade progression (crossfades)",
        "F": "clip_living_portrait (pre-rendered)",
        "G": "end card",
    }
    sources = {
        "A": "assets.final_frame",
        "B": "assets.contact_sheet",
        "C": "assets.clip_contact_push",
        "D": "assets.contact_sheet + dim masks + circle overlay",
        "E": "assets.grade_states (3)",
        "F": "assets.clip_living_portrait",
        "G": "generated end card (series_name / name+city / site)",
    }

    segments, cursor = [], 0.0
    for key in "ABCDEFG":
        dur = d_total if key == "D" else float(t[key])
        seg = Segment(key=key, label=labels[key], start=round(cursor, 4),
                      dur=round(dur, 4), source=sources[key])
        if key == "D":
            seg.beats = {
                "full": seg.start,
                "six": round(seg.start + d_full, 4),
                "one": round(seg.start + d_full + d_six, 4),
                "b_full": d_full, "b_six": d_six, "b_one": d_one,
            }
        segments.append(seg)
        cursor += dur

    seg_a = segments[0]
    seg_b = segments[1]
    seg_c = segments[2]
    seg_d = segments[3]
    seg_f = segments[5]

    # Shutter clicks: the cut into B, plus each beat of D (including the cut
    # into D itself — three narrowing beats, three clicks).
    shutter_times = [seg_b.start,
                     seg_d.beats["full"], seg_d.beats["six"], seg_d.beats["one"]]

    circle_cfg = cfg.get("circle") or {}
    circle_draw = float(circle_cfg.get("draw", DEFAULT_CIRCLE_DRAW))
    circle_start = seg_d.beats["one"] + float(circle_cfg.get("delay", DEFAULT_CIRCLE_DELAY))

    # Film wind-on: the frame is marked, the lever advances — fires the
    # moment the chinagraph stroke settles.
    advance_times = [round(circle_start + circle_draw + 0.05, 4)]

    return Timeline(
        segments=segments,
        total=round(cursor, 4),
        shutter_times=[round(x, 4) for x in shutter_times],
        advance_times=advance_times,
        bed_fade_in=seg_a.dur,
        room_span=(seg_c.start, seg_f.end),
        circle_start=round(circle_start, 4),
        circle_draw=circle_draw,
    )


def resolve_movement(cfg: dict) -> dict:
    """Per-segment end scales for the eased push-ins, config-overridable."""
    m = dict(DEFAULT_MOVEMENT)
    for k, v in (cfg.get("movement") or {}).items():
        if k in m:
            m[k] = float(v)
    return m


# ---------------------------------------------------------------------------
# Config load / validate / scaffold
# ---------------------------------------------------------------------------

REQUIRED_ASSET_KEYS = [
    "final_frame", "contact_sheet", "hero_frame",
    "clip_contact_push", "clip_living_portrait",
]
REQUIRED_AUDIO_KEYS = ["music_bed", "shutter", "room_tone"]


class ConfigError(SystemExit):
    pass


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "series"


def load_config(path: Path) -> dict:
    if not path.exists():
        scaffold(path)
        raise ConfigError(
            f"No config found — scaffolded an annotated example at {path}.\n"
            "Fill in the asset paths (or run `python3 reelkit/prep.py`) and rerun."
        )
    with open(path) as fh:
        cfg = yaml.safe_load(fh) or {}
    return cfg


def validate(cfg: dict, root: Path) -> list:
    """Return ALL problems at once — never one per run."""
    problems = []

    for key in ("series_name", "site"):
        if not cfg.get(key):
            problems.append(f"config: `{key}` is empty")

    assets = cfg.get("assets") or {}
    audio = cfg.get("audio") or {}

    def check(path_str, what):
        if not path_str:
            problems.append(f"missing config entry: {what}")
            return
        p = root / path_str
        if not p.exists():
            problems.append(f"missing file: {what} -> {path_str}")

    for key in REQUIRED_ASSET_KEYS:
        check(assets.get(key), f"assets.{key}")

    selects = assets.get("selects_round_1") or []
    if len(selects) != 6:
        problems.append(f"assets.selects_round_1 must list exactly 6 paths (got {len(selects)})")
    for i, p in enumerate(selects):
        check(p, f"assets.selects_round_1[{i}]")

    grades = assets.get("grade_states") or []
    if len(grades) != 3:
        problems.append(f"assets.grade_states must list exactly 3 paths, ungraded → final (got {len(grades)})")
    for i, p in enumerate(grades):
        check(p, f"assets.grade_states[{i}]")

    for key in REQUIRED_AUDIO_KEYS:
        check(audio.get(key), f"audio.{key}")
    # Optional film elements: only validated when configured
    for key in ("film_advance", "film_texture"):
        if audio.get(key):
            check(audio.get(key), f"audio.{key}")

    circ = cfg.get("selects_circle") or {}
    for k in ("x", "y", "w", "h"):
        v = circ.get(k)
        if v is None:
            problems.append(f"selects_circle.{k} missing (normalised 0-1 coords on the contact sheet)")
        elif not (0.0 <= float(v) <= 1.0):
            problems.append(f"selects_circle.{k}={v} out of 0-1 range")

    grid = cfg.get("selects_grid") or {}
    if not grid.get("cells_round_1") or grid.get("cell_final") is None:
        problems.append(
            "selects_grid needs `cells_round_1` (6 row-major cell indices) and "
            "`cell_final` so segment D knows which frames stay lit"
        )
    return problems


SCAFFOLD = """\
# reel.yaml — one file per series. `python3 reelkit/assemble.py --dry-run`
# prints the resolved timeline; see reelkit/README.md for the full contract.

series_name: "Series Title"        # drives the output filename + end card
subject_line: "One line of context, used on the end card"
camera: "Camera / lens"            # e.g. "Sony Venice / 85mm"
site: "example.com"
name: "Your Name"                  # end card, lower third
city: "Your City"

assets:
  final_frame: assets/final.jpg          # segment A, full bleed
  contact_sheet: assets/contact.jpg      # segments B + D
  selects_round_1:                       # exactly 6 paths (round-1 picks)
    - assets/selects/01.jpg
    - assets/selects/02.jpg
    - assets/selects/03.jpg
    - assets/selects/04.jpg
    - assets/selects/05.jpg
    - assets/selects/06.jpg
  hero_frame: assets/hero.jpg            # basis of the grade states / clip F
  grade_states:                          # exactly 3 paths, ungraded -> final
    - assets/grade_01.jpg
    - assets/grade_02.jpg
    - assets/grade_03.jpg
  clip_contact_push: assets/higgsfield/contact_push.mp4   # ~5s, pre-rendered
  clip_living_portrait: assets/higgsfield/living.mp4      # ~5s, pre-rendered

audio:
  music_bed: audio/bed.wav
  shutter: audio/shutter.wav
  room_tone: audio/room.wav
  # Optional Kodak-flavour elements (omit either to drop the layer):
  # film_advance: audio/advance.wav   # wind-on ratchet, fires as the circle lands
  # film_texture: audio/texture.wav   # projector hiss/flicker, under C..F
  # Optional mix trims (dB, defaults shown) — balance only; the master is
  # normalised to target_lufs afterwards.
  # bed_db: -7.0
  # room_db: -16.0
  # shutter_db: 0.0
  # duck_db: -2.0
  # film_advance_db: -4.0
  # film_texture_db: -28.0

movement:                  # end scale of an eased push per still segment
  A: 1.05                  # opener push-in
  B: 1.0                   # keep static so the cut into clip C matches framing
  D: 1.025                 # slow creep on the lightbox

selects_circle:            # normalised 0-1 coords of the chosen frame
  x: 0.42                  # centre x on the contact sheet
  y: 0.61                  # centre y
  w: 0.11                  # ellipse width
  h: 0.07                  # ellipse height

selects_grid:              # geometry of the contact sheet grid (normalised)
  rows: 4
  cols: 6
  x0: 0.02                 # left edge of cell (0,0)
  y0: 0.03                 # top edge of cell (0,0)
  cw: 0.15                 # cell width
  ch: 0.21                 # cell height
  gx: 0.01                 # horizontal gap between cells
  gy: 0.03                 # vertical gap
  cells_round_1: [2, 5, 9, 13, 16, 21]   # row-major indices lit on beat 2
  cell_final: 13                          # the one frame lit on beat 3

# Per-series beat lengths (seconds). Delete to use defaults (18.0s total).
timeline:
  A: 1.5
  B: 0.5
  C: 5.0
  D: {full: 1.0, six: 1.0, one: 1.0}
  E: 3.0
  F: 3.5
  G: 1.5
"""


def scaffold(path: Path):
    path.write_text(SCAFFOLD)
    print(f"Scaffolded annotated config: {path}", file=sys.stderr)
