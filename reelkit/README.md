# reelkit — "The Edit" Reel assembler

Config-driven pipeline that assembles an 18-second, 9:16 Instagram Reel
showing a portrait edit process: final frame → contact sheet → selects
narrowing → grade progression → living portrait → end card. Built to be rerun
per series: the timeline is data in `reel.yaml`, not ffmpeg strings.

```
final frame   contact    contact-push   selects        grade         living      end
(full bleed)  sheet      AI clip        narrowing      progression   portrait    card
A 0.0–1.5     B 1.5–2.0  C 2.0–7.0      D 7.0–10.0     E 10.0–13.0   F 13.0–16.5 G 16.5–18.0
```

Hard cuts everywhere except E (crossfades). Shutter clicks on the cut into B
and on each beat of D; a chinagraph circle is drawn over the final select.

## Requirements

- Python 3.10+, `pip install -r requirements.txt` (PyYAML + Pillow —
  Pillow generates the dim masks, circle animation, contact sheet and end
  card; all video/audio work is ffmpeg via subprocess)
- `ffmpeg`/`ffprobe` on PATH (the tool fails loudly with an install hint
  if missing)

## Quick start

```bash
# 1. prep a series from a folder of stills (writes assets + reel.yaml)
python3 reelkit/prep.py --series "Thaipusam — Batu Caves" \
    --stills ~/shoots/thaipusam/selects --hero 2

# 2. sanity-check the resolved timeline + asset map (no render)
python3 reelkit/assemble.py --dry-run

# 3. fast iteration render (540x960 CRF28)
python3 reelkit/assemble.py --preview

# 4. master (1080x1920 30fps H.264 high / yuv420p, CRF18, AAC 192k,
#    -14 LUFS / -1 dBTP, faststart) -> out/{series-slug}_{YYYYMMDD}.mp4
python3 reelkit/assemble.py
```

Running `assemble.py` with no `reel.yaml` scaffolds an annotated example and
exits. A render is followed by a verification step (duration ±0.2s,
resolution, pixel format, fps, measured LUFS/true-peak) and fails visibly if
anything is off.

## What to hand it per series

| You supply | Convention |
|---|---|
| 6 round-1 selects | JPEGs in one folder — `prep.py --stills DIR` copies them in as `select_01..06.jpg` |
| hero pick | `--hero N` (index into the selects) |
| 2 pre-rendered AI clips (~5s each) | drop over the `*_standin.mp4` files (or edit the `clip_*` paths in `reel.yaml`) |
| music bed / room tone / shutter | `audio/*.wav` — replace the `*_standin.wav` files |
| series metadata | `series_name`, `subject_line`, `camera`, `site`, `name`, `city` in `reel.yaml` |

`prep.py` derives the rest: the contact sheet (with its grid geometry written
into `reel.yaml` so segment D's dim masks and the circle land on real cells),
the three grade states from the hero, the circle coordinates, and stand-ins
for anything not yet delivered. **Stand-ins are always named `*_standin.*`**
so they can't be mistaken for finals; replace them and rerun.

If you already have a real contact sheet / grade exports, skip prep and point
`reel.yaml` straight at your files — set `selects_grid` (rows/cols + cell
rects, normalised 0–1) and `selects_circle` by hand.

## reel.yaml contract

See the scaffold for the annotated version. Key blocks:

- `assets.*` — every path validated up front; **all** missing files are
  reported in one run, never one at a time.
- `timeline` — per-segment seconds; `D` is its three beats
  (`{full, six, one}`). Change these freely per series; every downstream
  time (clicks, room-tone span, mask windows, xfade offsets) is derived.
- `selects_grid` — normalised geometry of the sheet grid +
  `cells_round_1` (6 row-major indices) + `cell_final`.
- `selects_circle` — normalised centre/size of the chinagraph ellipse on
  the sheet.
- `audio` — file paths, `target_lufs`/`true_peak`, and balance trims
  (`bed_db`, `room_db`, `shutter_db`, `duck_db`, `film_advance_db`,
  `film_texture_db`).
- `audio.film_advance` / `audio.film_texture` (optional) — the Kodak-flavour
  layers: a wind-on ratchet fired the moment the chinagraph circle settles
  (select made → lever advances the film), and a low projector-gate
  hiss/flicker running under C..F with the room tone. Delete either line to
  drop the layer.
- `movement` — end scale of an eased (cosine smoothstep) push across each
  still segment: `A` (opener, default 1.05), `B` (default 1.0 — static so
  the cut into the pre-rendered contact push starts from matching framing),
  `D` (lightbox creep, default 1.025; masks and circle ride the same push).
  C/F come pre-rendered and E has its own spec'd 1.00→1.03 ramp.
- `circle` (optional) — `{delay, draw}` to retime the stroke reveal.
- `grade` (optional) — `{crossfade, scale_to}` for segment E.

## Judgement calls (things the brief left open)

1. **Segment E arithmetic.** "0.5s holds + 0.5s crossfades" over three
   states sums to 2.5s, but E is 3.0s — holds are stretched to
   `(E − 2×fade)/3` ≈ 0.67s so the chain exactly fills the segment. Shorten
   `timeline.E` to 2.5 if you want literal 0.5s holds.
2. **"Each beat of D"** = three clicks (the cut into D counts as beat one:
   full sheet), so shutters land at 1.5, 7.0, 8.0, 9.0 with default beats.
3. **End card fields.** The brief's card wants "name and city", which
   weren't in the config spec — added `name:` / `city:` keys. Layout, top to
   bottom: series name (tracked caps) → subject_line (small grey) →
   NAME — CITY (bold) → site. All left-aligned in the lower third.
4. **Contact sheet on 9:16.** A landscape sheet is letterboxed on near-black
   (#0b0b0b) so the *whole* take is visible ("wide"); B, D and the
   contact-push stand-in share identical framing so the cuts feel
   continuous. A portrait-format sheet would fill more of the frame.
5. **Clip audio is ignored.** The two AI clips contribute picture only; the
   three-layer mix owns the soundtrack.
6. **Clip length mismatches.** Shorter than the segment → last frame is
   cloned (`tpad`); longer → trimmed at the cut.
7. **Ducking** is a stepped −2 dB window on the bed (20ms before each click,
   0.30s long), not sidechain compression — inaudible as a step at 2 dB and
   the filter graph stays legible/deterministic.
8. **True peak headroom.** loudnorm's ceiling is set 0.5 dB below the spec'd
   −1 dBTP because AAC encoding rings ~0.3–0.5 dB above whatever the
   normaliser produced. Measured result on this example: −1.3 dBTP.
9. **Loudness tolerance.** Two-pass linear loudnorm lands within ~0.2 LU
   (−13.8 measured vs −14 target here); verification only fails beyond
   ±1.0 LU.
10. **Output name** slugifies the series name:
    `out/thaipusam-batu-caves_20260729.mp4`.
11. **Fonts.** `fonts/` dir wins if present (a file with "bold" in the name
    is used for the display line); otherwise the cleanest system grotesque
    is used and reported at render time — on this machine that's
    **Liberation Sans** (metrically Helvetica). Last resort is PIL's
    built-in, with a warning.
12. **Grade states from prep** are synthesised (log-flat → half → final)
    with lifted blacks / pulled sat, so the segment works before you've
    exported real grade snapshots. The real workflow is three exports from
    your grading tool listed under `grade_states`, ungraded → final.
13. **Dimming** is a hard-edged 65% black overlay (frames read at 35%),
    lightbox-style, with ~1px of anti-aliasing only.
14. **Circle feel.** The ellipse wobbles off-true with two low-frequency
    radius modulations, dab pressure varies along the path, the stroke eases
    out and overshoots ~35° so the ends cross, and a faint blurred copy sits
    under the line like wax smear. Drawn as an alpha PNG sequence at 2×
    supersample, overlaid at 30fps.
15. **Wind-on placement.** The film-advance ratchet fires once, 50ms after
    the circle finishes drawing (~9.60 with default beats) — the story beat
    is "frame marked, advance to the next". It is deliberately absent from
    the B/D shutter hits; those stay clean clicks. No bed duck under it
    (it sits 4dB down already).
16. **Movement defaults.** A pushes 5%, D creeps 2.5%, B stays static —
    a moving B would jump-cut against the first frame of the pre-rendered
    contact-push clip, which starts from the same wide framing. If your
    Higgsfield push starts already moving, a little `B: 1.015` works.
17. **Stand-in click synthesis.** The generated shutter is a four-event SLR
    model (mirror slap, linkage tick, first-curtain ping, second curtain
    ~80ms later); the wind-on is a 7-pawl ratchet (42ms period) with a
    spring zip and end clunk. They're placeholders with the right *shape* —
    a real recorded Nikon/Canon click will still read better.

## This example series (and its provenance)

The committed `assets/thaipusam-batu-caves/` set uses six **generated,
labelled test plates** ("REELKIT TEST PLATE — NOT A PHOTOGRAPH") that echo
the Thaipusam night palette, because the real Batu Caves frames weren't
transferable into the build environment — chat attachments arrive there as
previews, not files. Everything else about the series config is real and
ready: on a machine with the `bej1` backup mounted, rerun

```bash
python3 reelkit/prep.py --series "Thaipusam — Batu Caves" \
    --stills "/Volumes/bej1/<thaipusam folder>" --hero <index> --force
python3 reelkit/assemble.py
```

and the same reel renders with the actual photographs. Check `camera:`,
`city:` and `site:` in `reel.yaml` — prep fills them with EDIT-ME guesses.

## Layout

```
reelkit/
  assemble.py   CLI: --dry-run / --preview / render + verify
  prep.py       CLI: per-series asset prep + reel.yaml writer
  config.py     defaults, timeline resolution, validation, scaffold
  segments.py   per-segment renderers (commented filter graphs)
  overlays.py   Pillow: fit math, dim masks, chinagraph circle, end card
  audiomix.py   3-layer mix, ducking, 2-pass loudnorm
  ffkit.py      subprocess runner, probing, font resolution
reel.yaml       the series being assembled (project root)
assets/<slug>/  per-series assets
audio/          bed / room / shutter
out/            renders (gitignored)
work/           intermediates (gitignored, kept with --keep-work)
```
