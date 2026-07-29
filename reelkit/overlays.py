"""Generated overlays: dim masks, the chinagraph circle, the end card.

Everything here is composed in *screen space* (final frame WxH) so the ffmpeg
side stays a plain overlay chain with no coordinate expressions. The fit math
that places the contact sheet on screen lives here and is reused by every
overlay so masks, circle and sheet always line up.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from reelkit.config import CIRCLE_COLOUR, CIRCLE_STROKE, DIM_OPACITY


# ---------------------------------------------------------------------------
# Fit math — how a source image sits on the 9:16 canvas
# ---------------------------------------------------------------------------

@dataclass
class Fit:
    """Placement of a source image scaled to fit inside W×H (letterboxed)."""
    scale: float
    x: int          # left offset on canvas
    y: int          # top offset on canvas
    w: int          # drawn width
    h: int          # drawn height

    def to_screen(self, nx: float, ny: float) -> tuple:
        """Map normalised source coords (0-1 on the image) to canvas px."""
        return self.x + nx * self.w, self.y + ny * self.h


def fit_contain(src_w: int, src_h: int, W: int, H: int) -> Fit:
    scale = min(W / src_w, H / src_h)
    w, h = round(src_w * scale), round(src_h * scale)
    return Fit(scale=scale, x=(W - w) // 2, y=(H - h) // 2, w=w, h=h)


# ---------------------------------------------------------------------------
# Segment D: dim masks
# ---------------------------------------------------------------------------

def _cell_rect(grid: dict, idx: int) -> tuple:
    """Normalised (x, y, w, h) of a row-major cell index on the sheet."""
    cols = int(grid["cols"])
    r, c = divmod(int(idx), cols)
    x = float(grid["x0"]) + c * (float(grid["cw"]) + float(grid["gx"]))
    y = float(grid["y0"]) + r * (float(grid["ch"]) + float(grid["gy"]))
    return x, y, float(grid["cw"]), float(grid["ch"])


def render_dim_mask(out_path: Path, grid: dict, lit_cells: list,
                    fit: Fit, W: int, H: int):
    """Full-frame RGBA png: 65% black everywhere except the lit cells, so
    non-selected frames read at 35% brightness. Hard edges (it should feel
    like a lightbox, not a vignette); 1px feather only to avoid aliasing."""
    alpha = round(255 * (1 - DIM_OPACITY))
    mask = Image.new("RGBA", (W, H), (0, 0, 0, alpha))
    draw = ImageDraw.Draw(mask)
    for idx in lit_cells:
        nx, ny, nw, nh = _cell_rect(grid, idx)
        x0, y0 = fit.to_screen(nx, ny)
        x1, y1 = fit.to_screen(nx + nw, ny + nh)
        draw.rectangle([x0, y0, x1, y1], fill=(0, 0, 0, 0))
    mask = mask.filter(ImageFilter.GaussianBlur(0.6))
    mask.save(out_path)


# ---------------------------------------------------------------------------
# Segment D: chinagraph circle (alpha PNG sequence)
# ---------------------------------------------------------------------------

def render_circle_sequence(out_dir: Path, circle: dict, fit: Fit,
                           W: int, H: int, fps: int,
                           draw_dur: float, hold_frames: int,
                           seed: int = 7) -> int:
    """Stroke-reveal of a hand-drawn ellipse; returns total frame count.

    The look is built from three things:
      * a wobbly ellipse path — two low-frequency radius modulations so the
        line drifts off a perfect ellipse the way a grease pencil does;
      * pressure variation — dab radius and opacity breathe along the path;
      * an overshoot — the stroke runs ~35° past a full turn and drifts
        slightly outward, so the ends visibly cross like a real mark-up.
    Drawn 2x supersampled, downscaled once, so dabs fuse into one waxy line.
    """
    rng = random.Random(seed)
    ss = 2  # supersample factor

    # Ellipse geometry in canvas px (circle coords are normalised to sheet)
    cx, cy = fit.to_screen(float(circle["x"]), float(circle["y"]))
    rx = float(circle["w"]) * fit.w / 2
    ry = float(circle["h"]) * fit.h / 2
    # Breathing room so the mark rings the frame instead of hugging it
    rx, ry = rx * 1.22, ry * 1.30

    stroke = CIRCLE_STROKE * (W / 1080) * ss          # scale-invariant width
    cx, cy, rx, ry = cx * ss, cy * ss, rx * ss, ry * ss

    start_angle = math.radians(-78)     # pen touches down top-left-ish
    total_sweep = math.radians(360 + 35)  # full turn + overshoot, ends cross
    phase = rng.uniform(0, math.tau)

    def point(theta_frac: float) -> tuple:
        """Path point at 0-1 along the stroke, with chinagraph wobble."""
        a = start_angle + theta_frac * total_sweep
        wobble = (1
                  + 0.030 * math.sin(3.1 * a + phase)
                  + 0.016 * math.sin(7.3 * a + 1.7 * phase))
        # overshoot drifts outward so the crossing reads
        drift = 1 + 0.045 * max(0.0, theta_frac - 0.82) / 0.18
        return (cx + rx * wobble * drift * math.cos(a),
                cy + ry * wobble * drift * math.sin(a))

    # Precompute dabs along the full path (dense enough to fuse into a line)
    n_dabs = 720
    dabs = []
    for i in range(n_dabs):
        f = i / (n_dabs - 1)
        x, y = point(f)
        x += rng.uniform(-0.9, 0.9) * ss                 # hand jitter
        y += rng.uniform(-0.9, 0.9) * ss
        pressure = 0.78 + 0.22 * math.sin(11.0 * f * math.tau + phase)
        radius = (stroke / 2) * (0.82 + 0.30 * pressure)
        alpha = int(255 * min(1.0, 0.55 + 0.45 * pressure))
        dabs.append((f, x, y, radius, alpha))

    n_draw = max(2, round(draw_dur * fps))
    # +1: frame 0 is fully transparent — overlay framesync extends the first
    # frame backwards in time, so nothing may be visible before touch-down.
    total = n_draw + 1 + hold_frames
    out_dir.mkdir(parents=True, exist_ok=True)

    r, g, b = CIRCLE_COLOUR
    for frame in range(total):
        # ease-out: the hand moves fast then settles into the overshoot
        t = min(1.0, frame / n_draw)
        progress = 1 - (1 - t) ** 2.2
        img = Image.new("RGBA", (W * ss, H * ss), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        for f, x, y, radius, alpha in dabs:
            if f > progress:
                break
            d.ellipse([x - radius, y - radius, x + radius, y + radius],
                      fill=(r, g, b, alpha))
        img = img.resize((W, H), Image.LANCZOS)
        # faint wax smear: a blurred copy under the crisp line
        smear = img.filter(ImageFilter.GaussianBlur(1.6))
        smear.putalpha(smear.getchannel("A").point(lambda a: a // 4))
        out = Image.alpha_composite(smear, img)
        out.save(out_dir / f"circle_{frame:04d}.png")
    return total


# ---------------------------------------------------------------------------
# Segment G: end card
# ---------------------------------------------------------------------------

def render_end_card(out_path: Path, cfg: dict, fonts: dict, W: int, H: int):
    """Black card, left-aligned lower third:
         SERIES NAME          (small caps, tracked out)
         subject line         (small, grey)
         NAME — CITY          (display line)
         site                 (small, grey)
    """
    img = Image.new("RGB", (W, H), (6, 6, 6))
    draw = ImageDraw.Draw(img)
    s = W / 1080  # scale factor so the card works at preview size too

    def font(path: str, size: int):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            return ImageFont.load_default(size)

    f_small = font(fonts["regular"], round(30 * s))
    f_name = font(fonts["bold"], round(58 * s))
    f_series = font(fonts["regular"], round(34 * s))

    left = round(96 * s)
    grey = (138, 138, 138)
    white = (240, 240, 240)

    def tracked(text: str, gap: float = 0.24) -> str:
        return (" " * 1).join(text)  # single hair-space approximation

    series = (cfg.get("series_name") or "").upper()
    subject = cfg.get("subject_line") or ""
    name = (cfg.get("name") or "").upper()
    city = cfg.get("city") or ""
    display = f"{name} — {city.upper()}" if city else name
    site = cfg.get("site") or ""

    # Stack upward from a baseline in the lower third
    y = round(H * 0.780)
    draw.text((left, y), site, font=f_small, fill=grey)
    y -= round(84 * s)
    draw.text((left, y), display, font=f_name, fill=white)
    y -= round(56 * s)
    draw.text((left, y), subject, font=f_small, fill=grey)
    y -= round(60 * s)
    draw.text((left, y), tracked(series), font=f_series, fill=(200, 200, 200))

    img.save(out_path)
