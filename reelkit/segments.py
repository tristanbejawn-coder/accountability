"""Per-segment renderers.

Each segment becomes its own intermediate .mp4 in the work dir, encoded with
identical parameters, then the lot is stitched with the concat demuxer
(stream copy — cuts stay frame-accurate, nothing is re-encoded twice).
Frame counts are forced with -frames:v so segment durations are exact.

Filter graphs are assembled from small commented pieces — resist the urge to
inline them into one string; they get unreadable fast.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image

from reelkit.config import PAD_COLOUR, DEFAULT_E_CROSSFADE, DEFAULT_E_SCALE_RAMP
from reelkit.ffkit import run
from reelkit.overlays import (fit_contain, render_dim_mask,
                              render_circle_sequence, render_end_card)

# Still segments that move (A/B/D pushes) are composed at this supersample so
# zoompan never crops below output resolution mid-push.
SS = 1.12


def zoom_tail(z_end: float, n: int, W: int, H: int, fps: int) -> str:
    """Filter tail applying an eased push from 1.0 to z_end across n frames,
    landing on exactly WxH. z_end == 1.0 degrades to a plain downscale.
    The ease is a cosine smoothstep — starts and settles gently, no
    mechanical linear read."""
    if z_end <= 1.0001:
        return f"scale={W}:{H}:flags=lanczos,setsar=1"
    return (f"zoompan=z='1+{z_end - 1:.4f}*(0.5-0.5*cos(PI*on/{n - 1}))'"
            f":x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2'"
            f":d=1:s={W}x{H}:fps={fps},setsar=1")


def enc_args(q: dict) -> list:
    """Shared encoder settings for every intermediate — identical params are
    what make lossless concat possible."""
    return [
        "-c:v", "libx264", "-profile:v", "high", "-crf", str(q["crf"]),
        "-preset", q["preset"], "-pix_fmt", "yuv420p",
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
        "-video_track_timescale", "15360",   # common timescale keeps concat clean
        "-an",
    ]


def frames_for(dur: float, fps: int) -> int:
    return max(1, round(dur * fps))


# Cover: fill the 9:16 frame, cropping overflow (portrait stills, clips)
def vf_cover(W: int, H: int) -> str:
    return (f"scale={W}:{H}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={W}:{H},setsar=1")


class SegmentRenderer:
    def __init__(self, root: Path, work: Path, q: dict, log: Path,
                 movement: dict | None = None):
        self.root = root
        self.work = work
        self.q = q            # {'w','h','fps','crf','preset'}
        self.log = log
        self.movement = movement or {}
        # supersampled canvas for the moving still segments
        self.sw = round(q["w"] * SS / 2) * 2
        self.sh = round(q["h"] * SS / 2) * 2

    # -- shared plumbing ----------------------------------------------------

    def _encode_still(self, vf: str, img: Path, dur: float, out: Path):
        q = self.q
        run(["ffmpeg", "-y", "-loop", "1", "-framerate", q["fps"], "-i", img,
             "-vf", vf + f",fps={q['fps']}",
             "-frames:v", frames_for(dur, q["fps"]), *enc_args(q), out],
            self.log)

    def sheet_base(self, contact_sheet: Path):
        """Compose the contact sheet, letterboxed on near-black, ONCE in
        Pillow — B and D reuse the same base png, and the dim masks / circle
        share the same Fit, so everything lines up to the pixel. Composed at
        the supersampled canvas so pushes never upscale."""
        base_path = self.work / "sheet_base.png"
        sheet = Image.open(contact_sheet).convert("RGB")
        fit = fit_contain(sheet.width, sheet.height, self.sw, self.sh)
        canvas = Image.new("RGB", (self.sw, self.sh), PAD_COLOUR)
        canvas.paste(sheet.resize((fit.w, fit.h), Image.LANCZOS), (fit.x, fit.y))
        canvas.save(base_path)
        return base_path, fit

    # -- A: final frame, full bleed, eased push-in --------------------------

    def seg_A(self, seg, assets) -> Path:
        q = self.q
        out = self.work / "seg_A.mp4"
        n = frames_for(seg.dur, q["fps"])
        # cover-crop at supersample, then the push lands on the output size
        vf = (vf_cover(self.sw, self.sh) + f",fps={q['fps']},"
              + zoom_tail(self.movement.get("A", 1.0), n, q["w"], q["h"], q["fps"]))
        run(["ffmpeg", "-y", "-loop", "1", "-framerate", q["fps"],
             "-i", self.root / assets["final_frame"], "-vf", vf,
             "-frames:v", n, *enc_args(q), out], self.log)
        return out

    # -- B: hard cut to the contact sheet, wide -----------------------------

    def seg_B(self, seg, sheet_base: Path) -> Path:
        q = self.q
        out = self.work / "seg_B.mp4"
        n = frames_for(seg.dur, q["fps"])
        vf = (f"fps={q['fps']},"
              + zoom_tail(self.movement.get("B", 1.0), n, q["w"], q["h"], q["fps"]))
        run(["ffmpeg", "-y", "-loop", "1", "-framerate", q["fps"],
             "-i", sheet_base, "-vf", vf,
             "-frames:v", n, *enc_args(q), out], self.log)
        return out

    # -- C / F: pre-rendered clips ------------------------------------------

    def seg_clip(self, seg, clip_rel: str) -> Path:
        """Conform a pre-rendered clip: 30fps, cover-crop to frame, and if the
        clip runs short, clone the last frame out to the segment length
        (tpad) rather than freezing mid-motion elsewhere."""
        q = self.q
        out = self.work / f"seg_{seg.key}.mp4"
        vf = (f"fps={q['fps']},"
              + vf_cover(q["w"], q["h"])
              + ",tpad=stop_mode=clone:stop=-1")   # frames:v caps the clone
        run(["ffmpeg", "-y", "-i", self.root / clip_rel, "-vf", vf,
             "-frames:v", frames_for(seg.dur, q["fps"]), *enc_args(q), out],
            self.log)
        return out

    # -- D: selects narrowing + chinagraph circle ---------------------------

    def seg_D(self, seg, cfg, timeline, sheet_base: Path, fit) -> Path:
        q = self.q
        W, H, fps = q["w"], q["h"], q["fps"]
        grid = cfg["selects_grid"]

        # Beat boundaries relative to the start of D
        t_six = seg.beats["b_full"]                       # 6 frames lit
        t_one = seg.beats["b_full"] + seg.beats["b_six"]  # 1 frame lit
        cs = timeline.circle_start - seg.start            # pen touch-down

        # Overlay artwork — composed on the supersampled canvas (same space
        # as sheet_base/fit), so the whole stack pushes together afterwards
        mask6 = self.work / "mask_six.png"
        mask1 = self.work / "mask_one.png"
        render_dim_mask(mask6, grid, grid["cells_round_1"], fit, self.sw, self.sh)
        render_dim_mask(mask1, grid, [grid["cell_final"]], fit, self.sw, self.sh)

        circle_dir = self.work / "circle"
        n_draw = max(2, round(timeline.circle_draw * fps))
        # sequence must cover from touch-down to segment end (then some)
        hold = max(1, math.ceil((seg.dur - cs) * fps) - n_draw + 3)
        render_circle_sequence(circle_dir, cfg["selects_circle"], fit,
                               self.sw, self.sh, fps, timeline.circle_draw, hold)

        n = frames_for(seg.dur, fps)
        # Filter graph, one overlay per layer:
        #   base sheet -> +dim(6 lit) during beat 2 -> +dim(1 lit) during
        #   beat 3 -> +circle sequence (PTS-shifted to touch down at `cs`,
        #   last frame held to the cut) -> slow lightbox push to output size
        graph = ";".join([
            f"[0:v]fps={fps}[base]",
            "[1:v]format=rgba[m6]",
            "[2:v]format=rgba[m1]",
            f"[3:v]format=rgba,setpts=PTS-STARTPTS+{cs:.4f}/TB[circ]",
            f"[base][m6]overlay=enable='between(t,{t_six:.4f},{t_one:.4f})'[v1]",
            f"[v1][m1]overlay=enable='gte(t,{t_one:.4f})'[v2]",
            f"[v2][circ]overlay=eof_action=repeat:enable='gte(t,{cs:.4f})'[v3]",
            f"[v3]{zoom_tail(self.movement.get('D', 1.0), n, W, H, fps)},"
            "format=yuv420p[vout]",
        ])
        out = self.work / "seg_D.mp4"
        run(["ffmpeg", "-y",
             "-loop", "1", "-framerate", fps, "-i", sheet_base,
             "-loop", "1", "-framerate", fps, "-i", mask6,
             "-loop", "1", "-framerate", fps, "-i", mask1,
             "-framerate", fps, "-start_number", "0", "-i",
             circle_dir / "circle_%04d.png",
             "-filter_complex", graph, "-map", "[vout]",
             "-frames:v", n, *enc_args(q), out],
            self.log)
        return out

    # -- E: grade progression -----------------------------------------------

    def seg_E(self, seg, cfg, assets) -> Path:
        """Three grade states, 0.5s crossfades, holds stretched so the chain
        exactly fills the segment; a continuous 1.00 -> 1.03 push across the
        whole segment via zoompan on the composited stream.

        The xfade chain is built at a 1.15x supersample so zoompan's crop at
        1.03 never samples below output resolution.
        """
        q = self.q
        W, H, fps = q["w"], q["h"], q["fps"]
        grades = [self.root / p for p in assets["grade_states"]]
        fade = float((cfg.get("grade") or {}).get("crossfade", DEFAULT_E_CROSSFADE))
        ramp = float((cfg.get("grade") or {}).get("scale_to", DEFAULT_E_SCALE_RAMP))

        n = len(grades)
        hold = (seg.dur - (n - 1) * fade) / n     # 3.0s -> 0.667s holds
        if hold <= 0:
            raise SystemExit(f"segment E too short for {n-1} crossfades of {fade}s")

        ss = 1.15                                  # supersample for the push
        SW, SH = (round(W * ss / 2) * 2, round(H * ss / 2) * 2)

        # Input i is trimmed so consecutive xfades overlap by `fade`:
        #   clip0: hold+fade | middle clips: fade+hold+fade | last: fade+hold
        lens = []
        for i in range(n):
            L = hold + fade * (2 if 0 < i < n - 1 else 1)
            lens.append(L)

        inputs, chains = [], []
        for i, g in enumerate(grades):
            inputs += ["-loop", "1", "-framerate", fps, "-t", f"{lens[i]:.4f}", "-i", g]
            chains.append(f"[{i}:v]{vf_cover(SW, SH)},fps={fps},format=yuv420p[g{i}]")

        # xfade offsets are cumulative visible time before each fade starts
        prev, offset = "g0", 0.0
        for i in range(1, n):
            offset += hold + (fade if i > 1 else 0)
            nxt = f"x{i}" if i < n - 1 else "xf"
            chains.append(
                f"[{prev}][g{i}]xfade=transition=fade:duration={fade:.4f}:"
                f"offset={offset:.4f}[{nxt}]")
            prev = nxt

        # Continuous scale ramp over the whole segment. zoompan emits one
        # frame per input frame (d=1); `on` is the running output frame index.
        N = frames_for(seg.dur, fps)
        chains.append(
            f"[xf]zoompan=z='1+{ramp - 1:.4f}*on/{N - 1}'"
            f":x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2'"
            f":d=1:s={W}x{H}:fps={fps},format=yuv420p,setsar=1[vout]")

        out = self.work / "seg_E.mp4"
        run(["ffmpeg", "-y", *inputs,
             "-filter_complex", ";".join(chains), "-map", "[vout]",
             "-frames:v", N, *enc_args(q), out], self.log)
        return out

    # -- G: end card ---------------------------------------------------------

    def seg_G(self, seg, cfg, fonts) -> Path:
        card = self.work / "end_card.png"
        render_end_card(card, cfg, fonts, self.q["w"], self.q["h"])
        out = self.work / "seg_G.mp4"
        self._encode_still("setsar=1", card, seg.dur, out)
        return out

    # -- stitch --------------------------------------------------------------

    def concat(self, parts: list, out: Path):
        lst = self.work / "concat.txt"
        lst.write_text("".join(f"file '{p.resolve()}'\n" for p in parts))
        run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst,
             "-c", "copy", out], self.log)
