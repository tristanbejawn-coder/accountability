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
4. **5 warm-up rounds** of easier poses with a shrinking timer, then…
5. **☠️ ELIMINATION TIME**: one pose per level, and you must beat a target
   score to survive. Each level the target rises (45 → 80), the timer shrinks
   (4.5s → 2s), the pose pool gets harder, and the outline itself slowly
   *shrinks*. Survive as many levels as you can — your final rank goes from
   🧱 First-Round Faller to 🏆 Balance Deity.

   The game draws from a **library of 100 poses** (`js/poses-library.js`):
   11 hand-made classics plus 89 procedurally generated ones — yoga-style
   one-leg balances (tree tucks, high knees), warrior lunges, frog crouches,
   goddess squats, crossed tightropes, leans, and every arm shape from
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
6. When the timer hits zero: 📸 snap, score, and a big on-screen (and spoken!)
   verdict — then the next round starts automatically. The whole game is
   hands-free after you press Start: pose names, tips, and score commentary
   are announced out loud via speech synthesis, so nobody has to walk back
   to the phone.
7. At the end you get the **photo wall** — every round's snapshot with the
   outline and score burned in, rollercoaster-style. Tap any photo to save
   it, or hit *Save photo strip* to download all of them composed into one
   shareable image.

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

  - **coverage** — how much of the outline you filled
  - **precision** — how much of you stayed inside the outline

  `score = 100 × (0.65 × coverage + 0.35 × precision)`

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
