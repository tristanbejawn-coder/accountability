#!/usr/bin/env python3
"""Prep a series for the assembler: derived assets + reel.yaml.

Given a folder of stills this builds everything assemble.py needs that isn't
shot in camera:

  * copies/resizes the six round-1 selects + hero into the series asset dir
  * a contact sheet laid out on a known grid (geometry written to reel.yaml,
    so segment D's dim masks and the chinagraph circle land on real cells)
  * three grade states from the hero (log-flat -> half -> final)
  * STAND-INS, generated only when the real thing is missing:
      - the two pre-rendered AI clips (contact push / living portrait)
      - the three audio files (music bed / room tone / shutter)
    Stand-ins are named *_standin.* — replace them with the Higgsfield
    renders and your real audio, update reel.yaml, rerun assemble.
  * with no --stills at all it synthesises six labelled abstract test plates
    so the whole pipeline can be exercised end to end.

Usage:
    python3 reelkit/prep.py --series "Thaipusam — Batu Caves" \
        --stills /path/to/shoot/selects --hero 2
    python3 reelkit/prep.py            # test plates, example config
"""

from __future__ import annotations

import argparse
import math
import random
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from reelkit.config import slugify
from reelkit.ffkit import require_ffmpeg, resolve_fonts, run

FPS = 30

# ---------------------------------------------------------------------------
# Synthetic test plates (used only when no --stills are given)
# ---------------------------------------------------------------------------

# Palette riffs on the Thaipusam night frames: sodium amber, marigold,
# saffron, festival LEDs against near-black.
PLATE_PALETTES = [
    ((10, 8, 4), (232, 160, 32), [(255, 214, 120), (255, 120, 40)]),
    ((8, 6, 10), (196, 120, 20), [(255, 190, 90), (150, 60, 200)]),
    ((6, 10, 8), (180, 150, 20), [(240, 230, 140), (40, 200, 180)]),
    ((12, 6, 6), (210, 80, 30), [(255, 160, 60), (255, 60, 90)]),
    ((6, 8, 14), (60, 80, 150), [(140, 180, 255), (255, 200, 90)]),
    ((10, 7, 5), (170, 110, 60), [(255, 220, 170), (90, 220, 255)]),
]

PLATE_W, PLATE_H = 1600, 2400


def synth_plate(idx: int, out_path: Path, label_font: str):
    """One abstract 2:3 plate: gradient base, soft bokeh, band, vignette,
    grain — photographic in feel, unmistakably not a photograph (labelled)."""
    rng = random.Random(100 + idx)
    base, mid, accents = PLATE_PALETTES[idx % len(PLATE_PALETTES)]
    img = Image.new("RGB", (PLATE_W, PLATE_H))
    px = img.load()

    # vertical gradient, brighter band around a third-line
    band_y = rng.uniform(0.28, 0.45)
    for y in range(PLATE_H):
        f = y / PLATE_H
        glow = math.exp(-((f - band_y) ** 2) / 0.045)
        r = base[0] + (mid[0] - base[0]) * glow
        g = base[1] + (mid[1] - base[1]) * glow
        b = base[2] + (mid[2] - base[2]) * glow
        for x in range(0, PLATE_W, 4):        # coarse fill, blurred after
            px[x, y] = (int(r), int(g), int(b))
    img = img.resize((PLATE_W // 4, PLATE_H // 4)).resize(
        (PLATE_W, PLATE_H), Image.BILINEAR)

    # soft bokeh glows
    glow_layer = Image.new("RGB", (PLATE_W, PLATE_H), (0, 0, 0))
    gd = ImageDraw.Draw(glow_layer)
    for _ in range(rng.randint(4, 7)):
        cx, cy = rng.uniform(0, PLATE_W), rng.uniform(0, PLATE_H * 0.8)
        rad = rng.uniform(60, 340)
        col = accents[rng.randrange(len(accents))]
        amp = rng.uniform(0.25, 0.8)
        gd.ellipse([cx - rad, cy - rad, cx + rad, cy + rad],
                   fill=tuple(int(c * amp) for c in col))
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(90))
    img = ImageChops_add(img, glow_layer)   # additive: light on night

    # small hard bokeh dots
    dots = Image.new("RGB", (PLATE_W, PLATE_H), (0, 0, 0))
    dd = ImageDraw.Draw(dots)
    for _ in range(rng.randint(10, 26)):
        cx, cy = rng.uniform(0, PLATE_W), rng.uniform(0, PLATE_H * 0.6)
        rad = rng.uniform(4, 22)
        col = accents[rng.randrange(len(accents))]
        dd.ellipse([cx - rad, cy - rad, cx + rad, cy + rad],
                   fill=tuple(int(c * rng.uniform(0.3, 0.9)) for c in col))
    dots = dots.filter(ImageFilter.GaussianBlur(rng.uniform(2, 7)))
    img = ImageChops_add(img, dots)

    # vignette
    vig = Image.new("L", (PLATE_W, PLATE_H), 0)
    vd = ImageDraw.Draw(vig)
    vd.ellipse([-PLATE_W * 0.35, -PLATE_H * 0.25,
                PLATE_W * 1.35, PLATE_H * 1.25], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(220)).point(
        lambda v: 90 + v * 165 // 255)
    img = Image.composite(img, Image.new("RGB", img.size, (0, 0, 0)), vig)

    # grain
    noise = Image.effect_noise((PLATE_W, PLATE_H), 26).convert("L")
    img = Image.blend(img, Image.merge("RGB", (noise, noise, noise)), 0.055)

    # honesty label
    d = ImageDraw.Draw(img)
    try:
        f = ImageFont.truetype(label_font, 26)
    except OSError:
        f = ImageFont.load_default(26)
    d.text((36, PLATE_H - 58), f"REELKIT TEST PLATE {idx + 1:02d} — NOT A PHOTOGRAPH",
           font=f, fill=(110, 100, 90))
    img.save(out_path, quality=90)


def ImageChops_add(a: Image.Image, b: Image.Image) -> Image.Image:
    from PIL import ImageChops
    return ImageChops.add(a, b)


# ---------------------------------------------------------------------------
# Contact sheet
# ---------------------------------------------------------------------------

SHEET_W, SHEET_H = 2400, 1600
ROWS, COLS = 3, 8       # 24 cells of ~2:3 portrait frames


def build_contact_sheet(stills: list, out_path: Path, label_font: str,
                        series_tag: str, cell_map: dict | None = None):
    """Tile the stills across a 3x8 grid, cycling with exposure/crop jitter
    so repeats read as neighbouring takes. `cell_map` pins specific cells to
    specific stills (cell index -> still index) — used so the six lit cells
    show six *distinct* frames and the circled cell shows the hero, not
    whatever the cycling happened to land there. Returns the normalised grid
    geometry that reel.yaml records for segment D."""
    margin, gx, gy, label_h = 48, 24, 22, 44
    cw = (SHEET_W - 2 * margin - (COLS - 1) * gx) // COLS
    ch = (SHEET_H - 2 * margin - (ROWS - 1) * (gy + label_h) - label_h) // ROWS

    sheet = Image.new("RGB", (SHEET_W, SHEET_H), (16, 16, 16))
    d = ImageDraw.Draw(sheet)
    try:
        f_label = ImageFont.truetype(label_font, 20)
    except OSError:
        f_label = ImageFont.load_default(20)

    rng = random.Random(4)
    thumbs = []
    for p in stills:
        im = Image.open(p).convert("RGB")
        thumbs.append(im)

    cell_map = cell_map or {}
    for idx in range(ROWS * COLS):
        r, c = divmod(idx, COLS)
        x = margin + c * (cw + gx)
        y = margin + r * (ch + gy + label_h)
        src = thumbs[cell_map.get(idx, idx % len(thumbs)) % len(thumbs)]

        # cover-crop the still to the cell aspect, with take-to-take jitter
        jx, jy = rng.uniform(-0.04, 0.04), rng.uniform(-0.04, 0.04)
        scale = max(cw / src.width, ch / src.height) * rng.uniform(1.0, 1.08)
        w, h = int(src.width * scale), int(src.height * scale)
        thumb = src.resize((w, h), Image.LANCZOS)
        ox = (w - cw) // 2 + int(jx * w)
        oy = (h - ch) // 2 + int(jy * h)
        ox, oy = max(0, min(w - cw, ox)), max(0, min(h - ch, oy))
        cell = thumb.crop((ox, oy, ox + cw, oy + ch))
        # exposure jitter between "takes"
        cell = cell.point(lambda v, k=rng.uniform(0.82, 1.10): min(255, int(v * k)))
        sheet.paste(cell, (x, y))
        d.rectangle([x - 1, y - 1, x + cw, y + ch], outline=(42, 42, 42))
        d.text((x + 2, y + ch + 8), f"{series_tag}-{idx + 1:03d}",
               font=f_label, fill=(105, 105, 105))

    sheet.save(out_path, quality=92)
    return {
        "rows": ROWS, "cols": COLS,
        "x0": round(margin / SHEET_W, 4), "y0": round(margin / SHEET_H, 4),
        "cw": round(cw / SHEET_W, 4), "ch": round(ch / SHEET_H, 4),
        "gx": round(gx / SHEET_W, 4), "gy": round((gy + label_h) / SHEET_H, 4),
    }


def circle_for_cell(grid: dict, idx: int) -> dict:
    """Chinagraph circle coords centred on a grid cell (normalised)."""
    r, c = divmod(idx, grid["cols"])
    cx = grid["x0"] + c * (grid["cw"] + grid["gx"]) + grid["cw"] / 2
    cy = grid["y0"] + r * (grid["ch"] + grid["gy"]) + grid["ch"] / 2
    return {"x": round(cx, 4), "y": round(cy, 4),
            "w": round(grid["cw"] * 1.1, 4), "h": round(grid["ch"] * 1.1, 4)}


# ---------------------------------------------------------------------------
# Grade states (ffmpeg, from the hero)
# ---------------------------------------------------------------------------

def build_grades(hero: Path, out_dir: Path, log: Path) -> list:
    """grade_01 log-flat -> grade_02 halfway -> grade_03 = the final grade
    (the hero as delivered). Filters approximate an ungraded scan: lifted
    blacks, pulled highlights, low sat, slightly cool."""
    looks = [
        ("grade_01.jpg",
         "curves=all='0/0.075 0.5/0.52 1/0.93',"
         "eq=contrast=0.82:saturation=0.40:gamma=1.05,"
         "colorbalance=rs=-0.03:bs=0.03"),
        ("grade_02.jpg",
         "curves=all='0/0.035 0.5/0.51 1/0.965',"
         "eq=contrast=0.92:saturation=0.72:gamma=1.02,"
         "colorbalance=rs=-0.012:bs=0.012"),
        ("grade_03.jpg", "null"),
    ]
    outs = []
    for name, vf in looks:
        out = out_dir / name
        run(["ffmpeg", "-y", "-i", hero, "-vf", vf, "-q:v", "2", out], log)
        outs.append(out)
    return outs


# ---------------------------------------------------------------------------
# Stand-in clips (replaced by the Higgsfield renders per series)
# ---------------------------------------------------------------------------

CLIP_ENC = ["-c:v", "libx264", "-profile:v", "high", "-crf", "18",
            "-preset", "medium", "-pix_fmt", "yuv420p", "-an"]


def standin_contact_push(sheet: Path, grid: dict, cell: int, out: Path, log: Path):
    """5s push into the contact sheet toward the chosen cell. Composed like
    segment B (contained on near-black) so the cut from B feels continuous,
    then zoompan eases in. Supersampled 2x against zoompan shimmer."""
    W, H = 1080, 1920
    ss = 2
    n = 5 * FPS
    tgt = circle_for_cell(grid, cell)
    # target position in canvas space: sheet is contained, full width
    sw, sh = SHEET_W, SHEET_H
    scale = (W * ss) / sw
    fit_h = sh * scale
    top = (H * ss - fit_h) / 2
    tx = tgt["x"] * W * ss                 # sheet spans full canvas width
    ty = top + tgt["y"] * fit_h
    ease = f"(0.5-0.5*cos(PI*on/{n - 1}))"
    graph = (
        f"[0:v]scale={W * ss}:{H * ss}:force_original_aspect_ratio=decrease:"
        f"flags=lanczos,pad={W * ss}:{H * ss}:(ow-iw)/2:(oh-ih)/2:color=0x0b0b0b,"
        f"setsar=1,fps={FPS},"
        # push: zoom 1 -> 2.2 while the crop window centre travels to the cell
        f"zoompan=z='1+1.2*{ease}'"
        f":x='(1-{ease})*((iw-iw/zoom)/2)+{ease}*({tx:.0f}-iw/zoom/2)'"
        f":y='(1-{ease})*((ih-ih/zoom)/2)+{ease}*({ty:.0f}-ih/zoom/2)'"
        f":d=1:s={W}x{H}:fps={FPS},format=yuv420p"
    )
    run(["ffmpeg", "-y", "-loop", "1", "-framerate", FPS, "-i", sheet,
         "-vf", graph, "-frames:v", n, *CLIP_ENC, out], log)


def standin_living(hero: Path, out: Path, log: Path):
    """5s 'living portrait' stand-in: one slow breath of scale and a drift of
    light — enough to cut against; the real Higgsfield clip replaces it."""
    W, H = 1080, 1920
    ss = 2
    n = 5 * FPS
    breathe = f"(0.5-0.5*cos(2*PI*on/{n - 1}))"     # one full in-out
    graph = (
        f"[0:v]scale={W * ss}:{H * ss}:force_original_aspect_ratio=increase:"
        f"flags=lanczos,crop={W * ss}:{H * ss},setsar=1,fps={FPS},"
        f"zoompan=z='1+0.045*{breathe}'"
        f":x='(iw-iw/zoom)/2':y='(ih-ih/zoom)*0.42'"
        f":d=1:s={W}x{H}:fps={FPS},"
        # slow warmth/brightness drift so it doesn't read as a freeze frame
        f"eq=brightness='0.012*sin(2*PI*t/5)',format=yuv420p"
    )
    run(["ffmpeg", "-y", "-loop", "1", "-framerate", FPS, "-i", hero,
         "-vf", graph, "-frames:v", n, *CLIP_ENC, out], log)


# ---------------------------------------------------------------------------
# Stand-in audio
# ---------------------------------------------------------------------------

def standin_audio(audio_dir: Path, log: Path) -> dict:
    """Synth stand-ins so the mix stage is exercised: a detuned sine pad
    (bed), pink-noise air (room), an SLR-style two-curtain click (shutter),
    a wind-on ratchet (film_advance) and projector-gate hiss (film_texture).
    Replace with real recordings per series; the mix doesn't care."""
    audio_dir.mkdir(parents=True, exist_ok=True)
    bed = audio_dir / "bed_standin.wav"
    room = audio_dir / "room_standin.wav"
    shutter = audio_dir / "shutter_standin.wav"
    advance = audio_dir / "advance_standin.wav"
    texture = audio_dir / "texture_standin.wav"

    if not bed.exists():
        left = ("0.17*sin(2*PI*55*t)*(0.75+0.25*sin(2*PI*0.09*t))"
                "+0.11*sin(2*PI*110.4*t)*(0.72+0.28*sin(2*PI*0.061*t+1.1))"
                "+0.07*sin(2*PI*164.8*t)*(0.7+0.3*sin(2*PI*0.047*t+2.3))"
                "+0.045*sin(2*PI*220.9*t)*(0.7+0.3*sin(2*PI*0.031*t))")
        right = left.replace("55*", "55.13*").replace("110.4", "110.55") \
                    .replace("164.8", "164.55").replace("220.9", "221.15")
        run(["ffmpeg", "-y", "-f", "lavfi", "-i",
             f"aevalsrc={left}|{right}:s=48000:d=20",
             "-af", "lowpass=f=520,highpass=f=35",
             "-c:a", "pcm_s16le", bed], log)

    if not room.exists():
        run(["ffmpeg", "-y",
             "-f", "lavfi", "-i", "anoisesrc=color=pink:seed=11:amplitude=0.30:d=20",
             "-f", "lavfi", "-i", "anoisesrc=color=pink:seed=47:amplitude=0.30:d=20",
             "-filter_complex",
             "[0:a][1:a]join=inputs=2:channel_layout=stereo,"
             "lowpass=f=750,highpass=f=55,tremolo=f=0.13:d=0.22,volume=0.5[a]",
             "-map", "[a]", "-c:a", "pcm_s16le", room], log)

    if not shutter.exists():
        # SLR anatomy, four events in ~180ms: mirror slap (broadband thud),
        # a metallic linkage tick right behind it, first curtain ping, then
        # the second curtain landing ~80ms later, drier and duller. Escaped
        # commas: the expression rides inside a filtergraph string.
        click = (
            "(2*random(0)-1)*0.95*exp(-130*t)"                       # mirror slap
            "+0.30*sin(2*PI*128*t)*exp(-52*t)"                       # body thump
            "+gte(t\\,0.012)*0.18*sin(2*PI*3400*(t-0.012))*exp(-300*(t-0.012))"  # linkage tick
            "+gte(t\\,0.02)*0.22*sin(2*PI*2500*(t-0.02))*exp(-220*(t-0.02))"     # curtain ping
            "+gte(t\\,0.082)*(2*random(1)-1)*0.75*exp(-170*(t-0.082))"           # 2nd curtain
            "+gte(t\\,0.082)*0.16*sin(2*PI*1750*(t-0.082))*exp(-260*(t-0.082))"
        )
        run(["ffmpeg", "-y", "-f", "lavfi", "-i",
             f"aevalsrc={click}:s=48000:d=0.30",
             "-af", "highpass=f=140,lowpass=f=9500,pan=stereo|c0=c0|c1=c0",
             "-c:a", "pcm_s16le", shutter], log)

    if not advance.exists():
        # Film wind-on: a thumb-lever ratchet — decaying burst every 42ms
        # (mod(t,…) restarts the envelope, seven pawl clicks over ~0.3s)
        # with a sprocket-spring zip under it and a final lever clunk.
        ratchet = (
            "lt(t\\,0.30)*(2*random(0)-1)*0.85*exp(-420*mod(t\\,0.042))"
            "+lt(t\\,0.30)*0.10*sin(2*PI*4200*t)*exp(-260*mod(t\\,0.042))"
            "+lt(t\\,0.30)*(2*random(1)-1)*0.06"                      # spring zip
            "+gte(t\\,0.315)*(2*random(2)-1)*0.5*exp(-160*(t-0.315))"  # end clunk
            "+gte(t\\,0.315)*0.14*sin(2*PI*900*(t-0.315))*exp(-120*(t-0.315))"
        )
        run(["ffmpeg", "-y", "-f", "lavfi", "-i",
             f"aevalsrc={ratchet}:s=48000:d=0.45",
             "-af", "highpass=f=900,lowpass=f=7500,volume=0.9,"
                    "pan=stereo|c0=c0|c1=c0",
             "-c:a", "pcm_s16le", advance], log)

    if not texture.exists():
        # Projector-gate texture: filtered hiss with a 24Hz gate flicker and
        # a slow wow underneath. Mixed ~-28dB — felt, not heard.
        run(["ffmpeg", "-y",
             "-f", "lavfi", "-i", "anoisesrc=color=white:seed=5:amplitude=0.18:d=20",
             "-f", "lavfi", "-i", "anoisesrc=color=pink:seed=9:amplitude=0.22:d=20",
             "-filter_complex",
             "[0:a][1:a]join=inputs=2:channel_layout=stereo,"
             "highpass=f=300,lowpass=f=5500,"
             "tremolo=f=24:d=0.30,"          # gate flicker at frame rate
             "tremolo=f=0.4:d=0.15,"         # slow wow
             "volume=0.55[a]",
             "-map", "[a]", "-c:a", "pcm_s16le", texture], log)

    return {"music_bed": bed, "room_tone": room, "shutter": shutter,
            "film_advance": advance, "film_texture": texture}


# ---------------------------------------------------------------------------
# reel.yaml writer (template, not yaml.dump — the comments matter)
# ---------------------------------------------------------------------------

YAML_TEMPLATE = """\
# reel.yaml — generated by reelkit/prep.py for "{series}"
# Edit freely; assemble.py treats this file as the source of truth.
# EDIT-ME markers flag values prep could not know.

series_name: "{series}"
subject_line: "{subject}"
camera: "{camera}"            # EDIT ME if wrong
site: "{site}"                # EDIT ME
name: "{name}"
city: "{city}"                # EDIT ME

assets:
  final_frame: {final}
  contact_sheet: {sheet}
  selects_round_1:
{selects}
  hero_frame: {hero}
  grade_states:               # ungraded -> final (prep generated from hero)
{grades}
  # *_standin files are generated placeholders — swap in the pre-rendered
  # Higgsfield clips for this series and rerun assemble.
  clip_contact_push: {push}
  clip_living_portrait: {living}

audio:
  # *_standin files are synthesised placeholders — swap in the real bed /
  # room tone / shutter recordings. Trims are balance only; the master is
  # normalised to target_lufs.
  music_bed: {bed}
  shutter: {shutter}
  room_tone: {room}
  # Kodak-flavour layers (delete either line to drop the layer):
  film_advance: {advance}     # wind-on ratchet, fires as the circle lands
  film_texture: {texture}     # projector-gate hiss/flicker under C..F
  target_lufs: -14.0
  true_peak: -1.0
  bed_db: -7.0
  room_db: -16.0
  shutter_db: 0.0
  duck_db: -2.0
  film_advance_db: -4.0
  film_texture_db: -28.0

movement:                     # end scale of an eased push per still segment
  A: 1.05                     # opener push-in
  B: 1.0                      # static: the cut into clip C keeps its framing
  D: 1.025                    # slow creep on the lightbox

selects_circle:               # centred on cell {final_cell} of the sheet grid
  x: {cx}
  y: {cy}
  w: {cw_}
  h: {ch_}

selects_grid:                 # geometry written by prep — matches the sheet
  rows: {rows}
  cols: {cols}
  x0: {x0}
  y0: {y0}
  cw: {cw}
  ch: {ch}
  gx: {gx}
  gy: {gy}
  cells_round_1: {cells6}
  cell_final: {final_cell}

timeline:                     # seconds; per-series beat lengths
  A: 1.5
  B: 0.5
  C: 5.0
  D: {{full: 1.0, six: 1.0, one: 1.0}}
  E: 3.0
  F: 3.5
  G: 1.5
"""


def main(argv=None):
    ap = argparse.ArgumentParser(description="Prep a series for assemble.py")
    ap.add_argument("--stills", help="folder of source JPEGs (>=1); omit to "
                                     "generate labelled test plates")
    ap.add_argument("--series", default="Thaipusam — Batu Caves")
    ap.add_argument("--subject", default="Kavadi bearers on the temple stairs, before dawn")
    ap.add_argument("--camera", default="Fujifilm X-Pro3 / 23mm")
    ap.add_argument("--site", default="tristanbejawn.com")
    ap.add_argument("--name", default="Tristan Bejawn")
    ap.add_argument("--city", default="London")
    ap.add_argument("--hero", type=int, default=None,
                    help="index into the selects used as hero/final frame; "
                         "a filename containing 'hero' wins by convention "
                         "unless this flag is passed explicitly")
    ap.add_argument("--out", help="asset dir (default assets/<series-slug>)")
    ap.add_argument("--force", action="store_true",
                    help="overwrite an existing reel.yaml")
    args = ap.parse_args(argv)

    require_ffmpeg()
    root = Path.cwd()
    slug = slugify(args.series)
    out_dir = Path(args.out) if args.out else root / "assets" / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    log = out_dir / "prep_commands.log"
    fonts = resolve_fonts(root)

    # --- gather or synthesise the six selects ------------------------------
    if args.stills:
        src = sorted(Path(args.stills).glob("*.[jJ][pP]*[gG]")) + \
              sorted(Path(args.stills).glob("*.png"))
        if not src:
            raise SystemExit(f"no images found in {args.stills}")
        # convention: a filename containing 'hero' is the hero frame and
        # sorts to the front (an explicit --hero index overrides it)
        named = [p for p in src if "hero" in p.stem.lower()]
        if named:
            src = [named[0]] + [p for p in src if p != named[0]]
            print(f"hero by filename convention: {named[0].name}")
        picks = (src * 6)[:6] if len(src) < 6 else src[:6]
        selects = []
        for i, p in enumerate(picks):
            dst = out_dir / f"select_{i + 1:02d}{p.suffix.lower()}"
            im = Image.open(p).convert("RGB")
            im.thumbnail((2400, 2400), Image.LANCZOS)
            im.save(dst, quality=90)
            selects.append(dst)
        print(f"selects: {len(src)} stills found, using first 6")
    else:
        print("no --stills given: generating 6 labelled test plates")
        selects = []
        for i in range(6):
            dst = out_dir / f"select_{i + 1:02d}.jpg"
            if not dst.exists():
                synth_plate(i, dst, fonts["regular"])
            selects.append(dst)

    hero_idx = args.hero if args.hero is not None else 0
    hero_idx = max(0, min(hero_idx, len(selects) - 1))
    hero_src = selects[hero_idx]
    hero = out_dir / "hero.jpg"
    Image.open(hero_src).convert("RGB").save(hero, quality=92)

    # --- contact sheet + grid geometry -------------------------------------
    # Six lit cells spread across the grid; the final pick sits just
    # off-centre (row 1, col 5 of 8). The cell map pins the hero into the
    # circled cell and one distinct select into each other lit cell, so the
    # narrowing beats light six different frames and the circle rings the
    # frame the reel actually ends on.
    cells6 = [2, 5, 9, 13, 18, 22]
    final_cell = 13
    others = [i for i in range(len(selects)) if i != hero_idx]
    cell_map = {final_cell: hero_idx}
    cell_map.update(dict(zip([c for c in cells6 if c != final_cell], others)))

    sheet = out_dir / "contact.jpg"
    tag = "".join(w[0] for w in slug.split("-"))[:3].upper() or "TP"
    grid = build_contact_sheet(selects, sheet, fonts["regular"], tag, cell_map)
    circ = circle_for_cell(grid, final_cell)

    # --- grades + final frame ----------------------------------------------
    grades = build_grades(hero, out_dir, log)
    final_frame = out_dir / "final.jpg"
    Image.open(grades[2]).save(final_frame, quality=92)

    # --- stand-in clips (only if not already provided) ---------------------
    push = out_dir / "contact_push_standin.mp4"
    living = out_dir / "living_standin.mp4"
    if not push.exists():
        print("stand-in: contact push clip")
        standin_contact_push(sheet, grid, final_cell, push, log)
    if not living.exists():
        print("stand-in: living portrait clip")
        standin_living(hero, living, log)

    # --- stand-in audio -----------------------------------------------------
    audio = standin_audio(root / "audio", log)

    # --- reel.yaml ----------------------------------------------------------
    yaml_path = root / "reel.yaml"
    if yaml_path.exists() and not args.force:
        print(f"{yaml_path} exists — not overwriting (use --force). Assets are in {out_dir}")
        return 0

    rel = lambda p: str(Path(p).resolve().relative_to(root))
    yaml_text = YAML_TEMPLATE.format(
        series=args.series, subject=args.subject, camera=args.camera,
        site=args.site, name=args.name, city=args.city,
        final=rel(final_frame), sheet=rel(sheet), hero=rel(hero),
        selects="".join(f"    - {rel(s)}\n" for s in selects).rstrip("\n"),
        grades="".join(f"    - {rel(g)}\n" for g in grades).rstrip("\n"),
        push=rel(push), living=rel(living),
        bed=rel(audio["music_bed"]), room=rel(audio["room_tone"]),
        shutter=rel(audio["shutter"]), advance=rel(audio["film_advance"]),
        texture=rel(audio["film_texture"]),
        cx=circ["x"], cy=circ["y"], cw_=circ["w"], ch_=circ["h"],
        cells6=cells6, final_cell=final_cell, **grid,
    )
    yaml_path.write_text(yaml_text)
    print(f"wrote {yaml_path}\nassets in {out_dir}\n"
          f"next: python3 reelkit/assemble.py --dry-run")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
