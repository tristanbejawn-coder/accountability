# Outline Rush 🖍️⏱️

The TikTok **outline trend** turned into a game: a hand-drawn doodle outline
appears over your webcam feed, a countdown starts ticking, and you have to
contort yourself to **fit inside the outline** before it hits zero. At zero the
game snaps a photo and scores how well you fit.

Think *Hole in the Wall*, but the wall is a wobbly TikTok-style doodle.

## How to play

1. Serve the folder (camera access requires `localhost` or HTTPS):

   ```bash
   python3 -m http.server 8000
   # then open http://localhost:8000
   ```

2. Click **Start Game** and allow camera access.
3. **Scan mode**: stand back so your whole body is in frame and hold the scan
   pose (arms out wide and raised, legs apart). The sci-fi scanner tracks your
   skeleton, and after ~1.5s of holding still it locks on and measures you —
   your height, limb lengths, shoulder width, and where you're standing.
   Every outline is then generated *from your body*, so it fits no matter how
   far from the camera you are. (You can also skip the scan.)
4. **Hole-in-the-Wall approach**: each round, the person-shaped outline starts
   tiny in the distance and rushes toward you on a perspective curve, arriving
   at your standing plane exactly as the countdown hits zero — so you must
   already be in the pose. It's hazy, cool-tinted and soft-glowing while far
   off, and resolves to crisp bright white as it reaches you. Pick the arrival
   timing on the start screen: **😌 Easy** parks the wall at your plane early
   and waits so you can settle, while **😰 Hard** slams it in at the exact
   instant of the snap.
5. **5 warm-up rounds** with a dramatic difficulty ramp — round 1 is a gentle
   both-feet pose and each round climbs a tier (easy → real pose → one-leg
   balance → hard → an extreme finale) while the timer shrinks 7s → 3s. Then…
6. **☠️ ELIMINATION TIME**: one pose per level, and you must beat a target
   score to survive. Each level the target rises (45 → 80), the timer shrinks
   (4.5s → 2s), the pose pool gets harder, and the outline itself slowly
   *shrinks*. Survive as many levels as you can — your final rank goes from
   🧱 First-Round Faller to 🏆 Balance Deity.

   The game draws from a **library of 120 poses** (`js/poses-library.js`):
   11 hand-made classics, **20 real yoga poses** (Tree, Warrior I/II/III,
   Triangle, Half Moon, Dancer, Eagle, Chair, Goddess, Standing Splits…),
   and 89 procedurally generated ones — one-leg balances, warrior lunges,
   frog crouches, crossed tightropes, leans, and every arm shape from
   overhead crosses to prayer hands — each with a generated name like
   *The Haunted Sasquatch* or *The Feral Windmill*. No pose repeats within
   a game.

   Difficulty is an **awkwardness ladder**: any pose with a foot off the
   ground is at least difficulty 2, and the *extreme* tier (side kicks,
   sky-high kicks, sideways sprinter balances, and **airborne poses** where
   the outline floats and you must time a jump for the snap) is difficulty 3.
   Elimination levels climb the ladder: levels 1–2 draw difficulty 2+,
   levels 3–6 draw only difficulty 3, and level 7+ is exclusively extreme.
   Regenerate or extend the library with `node scripts/generate-poses.mjs`
   (deterministic seed).
7. When the timer hits zero: 📸 snap, score, and a big on-screen (and spoken!)
   verdict — then the next round starts automatically. The whole game is
   hands-free after you press Start: pose names, tips, and score commentary
   are announced out loud via speech synthesis, so nobody has to walk back
   to the phone.
8. At the end you get the **photo wall** — every round's snapshot with the
   outline and score burned in, rollercoaster-style. Tap any photo to save
   it, or hit *Save photo strip* to download all of them composed into one
   shareable image.

**🖐 Pick poses by hand** (optional, toggle on the home screen): before each
round, three difficulty bubbles appear above your head — **Easy (×1)**,
**Medium (×1.25)**, **Hard (×1.5)**. Reach a hand up and hold it in a bubble
for ~0.85s to lock it; the next pose is drawn from that difficulty and the
round's score is multiplied by the shown bonus. The multiplier is displayed
during the round (`⚡ 1.5× BONUS`) and in the result (`⚡ 62 × 1.5 BONUS`).
If you don't pick within 8s it defaults to Easy, so the hands-free flow still
works. Uses the same pose-landmark tracking as the scan.

**🔊 Voice** (settings on the home screen): choose between the free built-in
**device voice** (pick any installed voice), **ElevenLabs** live, or a
**prebaked pack**. For ElevenLabs live, paste your own API key — stored only
in your browser's `localStorage`, never committed — then Connect to list and
pick a voice. All announcements route through the chosen provider, with
automatic fallback to the device voice on any error.

### Prebaked voice pack (recommended for a shared build)

Generating an ElevenLabs clip on every play adds latency and cost and needs
every player to have a key. Instead you can **pre-render the whole voice pack
once** and ship it as audio files — then the game plays instant local clips
and no player needs a key:

```bash
ELEVENLABS_API_KEY=sk_...  ELEVENLABS_VOICE_ID=<voice_id> \
  node scripts/generate-voice.mjs
git add assets/voice && git commit -m "Add voice pack"
```

This renders one MP3 per fixed phrase (every pose's name + tip, all score
commentary, difficulty labels, scan/flow lines) plus number clips `0…150` and
connective words into `assets/voice/`, with a `manifest.json`. At runtime the
game auto-detects the pack, defaults to it, and composes dynamic lines like
"78 points — Nice squeeze!" from the number + word + comment clips (see
`say()` in `js/game.js`). Your API key is only read from the environment —
it's never written to disk or the manifest. Re-run after changing pose text
(`--force` re-renders everything). Only ship audio for a voice your ElevenLabs
plan lets you distribute.

The countdown has a tense soundtrack: accelerating tick-tock, heartbeat, and
a rising panic whine, synthesized in WebAudio (plus a sad trombone when
you're eliminated). Want the actual trend sound instead? Drop an audio file
at `assets/tension.mp3` — if it's present the game plays it during every
countdown instead of the synthesized track. (No audio ships with the repo
for copyright reasons.)

## How it works

One in-browser model does everything:
[MediaPipe PoseLandmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
(`@mediapipe/tasks-vision`, loaded from CDN, GPU-accelerated) provides:

- **33 body landmarks** — used by the calibration scan (measuring your
  proportions, detecting the scan pose, auto-triggering the lock) and for
  re-anchoring outlines between rounds
- **a person segmentation mask** — used at the buzzer to score your fit:

  - **coverage** (recall) — how much of the outline you filled
  - **precision** — how much of you stayed inside the outline

  These are combined with an **F-beta overlap score** (β = 0.6, precision-
  leaning) so that spilling outside the shape — the "just stand close and be
  a big blob" exploit — is punished harder than a small miss, then put through
  a steep curve (`score = 100 · f^1.5`) so only a near-perfect overlap scores
  high. A perfect fit is 100; a slightly-off fit lands in the low 50s; a
  shapeless blob covering the whole outline only scores ~35. Elimination
  thresholds (32 → 68) are tuned to this curve.

Poses are defined as limb *angles*; forward kinematics in `js/skeleton.js`
combines them with your measured segment lengths to build the silhouette,
which is grounded at your feet. The wobbly hand-drawn outline comes from
rendering the silhouette with jittered joints three times and cycling the
frames; dilate-minus-original produces the contour ring.

If the model can't load (e.g. offline), the game falls back to a standard
outline size and honor-system scoring. No video ever leaves the browser —
there is no server-side anything.

## Project layout

```
index.html      – screens & markup
css/style.css   – doodle/hand-drawn styling, fullscreen stage
js/skeleton.js  – body measurement, forward kinematics, silhouette drawing
js/tracker.js   – PoseLandmarker wrapper (landmarks + segmentation mask)
js/game.js      – game loop, scan mode, outline rendering, scoring, audio
```

Add a new pose by appending an angle set to `POSES` in `js/game.js`
(0° = limb pointing down, 90° = straight out, 180° = straight up; negative
angles cross inward). Optional `lean` tilts the upper body for balance poses,
and `difficulty` (1–3) controls when it appears — warm-up rounds use 1–2,
elimination levels 5+ use only 3.
