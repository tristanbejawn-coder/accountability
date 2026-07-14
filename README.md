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
4. Each round shows one of six poses (Star Jump, T-Pose, Muscle Flex,
   Disco Fever, Flamingo, Invisible Chair) with a shrinking timer
   (6s → 3s as rounds progress). The outline re-anchors to wherever you're
   standing at the start of each round.
5. When the timer hits zero: 📸 snap, score, verdict. Save the photo if it's
   funny enough to post.

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
(0° = limb pointing down, 90° = straight out, 180° = straight up).
