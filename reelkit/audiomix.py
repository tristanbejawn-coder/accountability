"""Three-layer audio mix.

Layers (all times derived from the resolved Timeline — nothing hardcoded):
  bed     music bed, low, full length, fades in across segment A,
          ducked `duck_db` under each shutter hit
  room    room tone under segments C..F only
  clicks  one shutter instance per event (cut into B + each beat of D)

Master is normalised to target LUFS / true peak with two-pass loudnorm:
pass 1 measures the mixed programme, pass 2 applies with measured values in
linear mode (single-pass loudnorm's dynamic mode audibly pumps on an
18-second piece with transients).
"""

from __future__ import annotations

import json
from pathlib import Path

from reelkit.config import DEFAULT_AUDIO
from reelkit.ffkit import run


def _duck_expr(clicks: list, duck_db: float, duck_len: float) -> str:
    """volume= expression: unity, dipping to -duck_db inside each click
    window. Stepped windows, not envelopes — at 2 dB the step is inaudible
    and it keeps the graph legible."""
    dip = 1 - 10 ** (-abs(duck_db) / 20)          # e.g. 2dB -> 0.2057
    windows = "+".join(
        f"between(t,{t - 0.02:.3f},{t + duck_len:.3f})" for t in clicks)
    return f"1-{dip:.4f}*({windows})"


def build_audio(root: Path, work: Path, cfg: dict, timeline, log: Path) -> Path:
    audio_cfg = {**DEFAULT_AUDIO, **(cfg.get("audio") or {})}
    T = timeline.total
    room_start, room_end = timeline.room_span
    room_len = room_end - room_start
    clicks = timeline.shutter_times

    fmt = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"

    # --- bed: pad/trim to programme length, fade in over A, trim, duck ----
    bed_chain = (
        f"[0:a]{fmt},apad,atrim=0:{T:.4f},"
        f"afade=t=in:st=0:d={timeline.bed_fade_in:.4f},"
        f"volume={audio_cfg['bed_db']}dB,"
        f"volume='{_duck_expr(clicks, audio_cfg['duck_db'], audio_cfg['duck_len'])}'"
        f":eval=frame[bed]"
    )

    # --- room tone: C..F only, edges feathered, then delayed into place ---
    room_ms = round(room_start * 1000)
    room_chain = (
        f"[1:a]{fmt},apad,atrim=0:{room_len:.4f},"
        f"volume={audio_cfg['room_db']}dB,"
        f"afade=t=in:st=0:d=0.25,"
        f"afade=t=out:st={room_len - 0.35:.4f}:d=0.35,"
        f"adelay={room_ms}|{room_ms},apad,atrim=0:{T:.4f}[room]"
    )

    # --- shutter: one delayed copy per event -------------------------------
    n = len(clicks)
    click_chains = [f"[2:a]{fmt},volume={audio_cfg['shutter_db']}dB,"
                    f"asplit={n}" + "".join(f"[k{i}]" for i in range(n))]
    for i, t in enumerate(clicks):
        ms = round(t * 1000)
        click_chains.append(f"[k{i}]adelay={ms}|{ms},apad,atrim=0:{T:.4f}[c{i}]")

    # --- mix (no auto-normalise: levels are the trims above) ---------------
    mix_inputs = "[bed][room]" + "".join(f"[c{i}]" for i in range(n))
    mix_chain = (f"{mix_inputs}amix=inputs={2 + n}:normalize=0"
                 f":duration=first[mix]")

    graph = ";".join([bed_chain, room_chain, *click_chains, mix_chain])

    inputs = ["-i", root / cfg["audio"]["music_bed"],
              "-i", root / cfg["audio"]["room_tone"],
              "-i", root / cfg["audio"]["shutter"]]

    # AAC encoding overshoots the loudnorm ceiling by a few tenths of a dB,
    # so normalise 0.5 below the spec'd true peak and let the codec ring
    # back up under it.
    tp_ceiling = float(audio_cfg["true_peak"]) - 0.5
    tgt = (f"I={audio_cfg['target_lufs']}:TP={tp_ceiling}:LRA=11")

    # --- pass 1: measure the mixed programme -------------------------------
    proc = run(["ffmpeg", "-y", *inputs,
                "-filter_complex", graph + f";[mix]loudnorm={tgt}:print_format=json[out]",
                "-map", "[out]", "-f", "null", "-"], log)
    stderr = proc.stderr
    j = json.loads(stderr[stderr.rfind("{"):])

    # --- pass 2: apply with measured values (linear gain) ------------------
    measured = (f":measured_I={j['input_i']}:measured_TP={j['input_tp']}"
                f":measured_LRA={j['input_lra']}:measured_thresh={j['input_thresh']}"
                f":offset={j['target_offset']}:linear=true")
    out = work / "mix.m4a"
    run(["ffmpeg", "-y", *inputs,
         "-filter_complex",
         graph + f";[mix]loudnorm={tgt}{measured},aresample=48000:first_pts=0[out]",
         "-map", "[out]", "-c:a", "aac", "-b:a", "192k", out], log)
    return out


def mux(video: Path, audio: Path, out: Path, log: Path):
    """Final container: copy both streams, faststart for social upload."""
    run(["ffmpeg", "-y", "-i", video, "-i", audio,
         "-map", "0:v:0", "-map", "1:a:0", "-c", "copy",
         "-movflags", "+faststart", out], log)
