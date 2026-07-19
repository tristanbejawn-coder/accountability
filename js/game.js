// Outline Rush — scan yourself, then fit inside the doodle outline before
// time runs out. Survive 5 rounds, then it's ELIMINATION TIME. The whole
// game runs hands-free: big text + voice announcements, auto-advancing
// rounds, and a rollercoaster-style photo wall at the end.

const NORMAL_ROUNDS = 5;
const NORMAL_SECONDS = [6, 5, 5, 4, 4];
const GET_READY_MS = 3400; // long enough for a clean 3·2·1 countdown
const RESULT_MS = 4000;
const SCAN_HOLD_MS = 1400;
const SCAN_COLOR = '#59f7ff';
const GAME_FONT = "'Lilita One', 'Arial Rounded MT Bold', 'Segoe UI', system-ui, sans-serif";

// Funny score commentary, picked at random per band.
const COMMENTS = [
  { min: 90, color: '#7dff9c', lines: ['ARE YOU LIQUID?!', 'Absolute shapeshifter!', 'The outline never stood a chance!'] },
  { min: 75, color: '#7dff9c', lines: ['PERFECT FIT!', 'Chef\'s kiss geometry!', 'Outline? Demolished!'] },
  { min: 55, color: '#ffe14d', lines: ['Nice squeeze!', 'The outline is mildly impressed.', 'So close to greatness!'] },
  { min: 35, color: '#ffe14d', lines: ['Half of you made it…', 'Your left leg missed the memo.', 'A bold interpretation!'] },
  { min: 0, color: '#ff5c5c', lines: ['The outline wins!', 'Were you even trying?!', 'That was… certainly a shape.', 'My grandma fits better!'] },
];

function commentFor(score) {
  const band = COMMENTS.find((b) => score >= b.min);
  return { text: band.lines[Math.floor(Math.random() * band.lines.length)], color: band.color };
}

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
let W = 0;
let H = 0;

const video = document.createElement('video');
video.playsInline = true;
video.muted = true;

const els = {};
for (const id of [
  'start-screen', 'game-screen', 'final-screen', 'result-overlay',
  'start-btn', 'again-btn', 'rescan-btn', 'skip-scan',
  'judge-buttons', 'hud', 'round-label', 'pose-label', 'score-label',
  'snapshot-img', 'final-score', 'final-rank', 'start-error',
  'gallery', 'strip-btn', 'mode-toggle',
  'pause-btn', 'pause-overlay', 'resume-btn', 'restart-btn', 'menu-btn',
]) {
  els[id.replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = document.getElementById(id);
}

const state = {
  phase: 'idle', // idle | loading | scan | calibrated | elim-intro | getready | posing | scoring | judging | result | final
  mode: 'normal', // normal | elim
  round: 0,
  level: 1,
  threshold: 0,
  roundDuration: 6,
  hardMode: false, // easy: wall arrives early & waits; hard: arrives at zero
  pivot: null,     // canvas-space vanishing point the outline grows from
  lastSurvived: true,
  poses: [],
  totalScore: 0,
  deadline: 0,
  currentPose: null,
  ringFrames: [],
  farRingFrames: [],
  floorMark: null, // {x, y, rx, ry} "stand here" ring on the ground
  fillFrame: null,
  getReadyUntil: 0,
  readyTick: -1,
  pendingTimers: [],
  pauseInfo: null,
  targetMask: null,
  lastSnap: null,
  snapshotUrl: null,
  shots: [],       // rollercoaster photo wall: {url, label, score}
  usedPoses: new Set(), // no repeats within one game
  result: null,    // {headline, color, comment, sub}
  resultUntil: 0,
  calibVideo: null, // measured calibration in video pixels, null = defaults
  notice: '',
  noticeUntil: 0,
  scan: null,
  scanGhost: null,
  calibratedAt: 0,
};

// ---------------------------------------------------------------------------
// Voice — the game announces poses and results so nobody reads the phone.
// ---------------------------------------------------------------------------

function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(
      text.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}…—]/gu, ''));
    u.rate = 1.05;
    u.pitch = 0.85;
    speechSynthesis.speak(u);
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// Audio — synthesized blips, tension track, and stings. If assets/tension.mp3
// exists (e.g. the actual trend sound), it replaces the synthesized tension.
// ---------------------------------------------------------------------------

let audioCtx = null;

function beep(freq, duration, type = 'square', volume = 0.08) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + duration);
}

function playFanfare(good) {
  if (good) {
    [523, 659, 784, 1047].forEach((f, i) =>
      setTimeout(() => beep(f, 0.18, 'triangle', 0.1), i * 110));
  } else {
    beep(180, 0.5, 'sawtooth', 0.1);
    setTimeout(() => beep(140, 0.6, 'sawtooth', 0.1), 180);
  }
}

function playLockChirp() {
  [880, 1175, 1760].forEach((f, i) =>
    setTimeout(() => beep(f, 0.12, 'sine', 0.11), i * 90));
}

// Womp womp womp womaaaaah.
function sadTrombone() {
  if (!audioCtx) return;
  [[233.1, 0.30, 0], [220, 0.30, 340], [207.7, 0.30, 680], [196, 1.0, 1020]]
    .forEach(([f, dur, delay]) => setTimeout(() => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f * 1.02, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(f * 0.96, audioCtx.currentTime + dur);
      gain.gain.setValueAtTime(0.09, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + dur);
    }, delay));
}

function elimSting() {
  beep(110, 0.7, 'sawtooth', 0.11);
  beep(116.5, 0.7, 'sawtooth', 0.11); // dissonant pair = dread
  setTimeout(() => beep(55, 0.5, 'sine', 0.14), 100);
}

const tension = { timers: [], custom: null, customOk: false };

function initCustomTension() {
  if (tension.custom) return;
  try {
    const a = new Audio('assets/tension.mp3');
    a.preload = 'auto';
    a.addEventListener('canplaythrough', () => { tension.customOk = true; });
    tension.custom = a;
  } catch (e) {}
}

function thump() {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(80, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(45, audioCtx.currentTime + 0.13);
  gain.gain.setValueAtTime(0.13, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.15);
}

function panicWhine(ms) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(280, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(950, audioCtx.currentTime + ms / 1000);
  gain.gain.setValueAtTime(0.03, audioCtx.currentTime);
  gain.gain.linearRampToValueAtTime(0.055, audioCtx.currentTime + ms / 1000);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + ms / 1000 + 0.05);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + ms / 1000 + 0.05);
}

// Accelerating tick-tock + heartbeat + final rising whine for the countdown.
function startTension(ms, tense) {
  stopTension();
  if (tension.customOk && tension.custom) {
    tension.custom.currentTime = 0;
    tension.custom.volume = 0.7;
    tension.custom.play().catch(() => {});
    return;
  }
  if (!audioCtx) return;
  const startIv = tense ? 340 : 430;
  const endIv = tense ? 105 : 150;
  let t = 0;
  let i = 0;
  while (t < ms - 120) {
    const high = i % 2 === 0;
    tension.timers.push(setTimeout(
      () => beep(high ? 1040 : 830, 0.03, 'square', 0.055), t));
    t += startIv + (endIv - startIv) * (t / ms);
    i++;
  }
  for (let h = 0; h < ms - 350; h += tense ? 700 : 900) {
    tension.timers.push(setTimeout(thump, h));
  }
  const whineLen = Math.min(1200, ms);
  tension.timers.push(setTimeout(() => panicWhine(whineLen), Math.max(0, ms - whineLen)));
}

function stopTension() {
  tension.timers.forEach(clearTimeout);
  tension.timers = [];
  if (tension.custom && !tension.custom.paused) tension.custom.pause();
}

// ---------------------------------------------------------------------------
// Canvas sizing & camera drawing
// ---------------------------------------------------------------------------

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
  W = Math.round(window.innerWidth * dpr);
  H = Math.round(window.innerHeight * dpr);
  canvas.width = W;
  canvas.height = H;
  state.scanGhost = null; // rebuilt lazily at the new size
  if (state.currentPose &&
      ['getready', 'posing', 'scoring'].includes(state.phase)) {
    prepareRoundArt(state.currentPose, currentShrink());
  }
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Mirrored cover-crop draw, shared by display, snapshots and scoring.
function drawCover(g, src, sw, sh, dw, dh, mirror) {
  const s = Math.max(dw / sw, dh / sh);
  const w = sw * s;
  const h = sh * s;
  g.save();
  if (mirror) {
    g.translate(dw, 0);
    g.scale(-1, 1);
  }
  g.drawImage(src, (dw - w) / 2, (dh - h) / 2, w, h);
  g.restore();
}

function drawVideoFrame(g, dw = W, dh = H) {
  drawCover(g, video, video.videoWidth || dw, video.videoHeight || dh, dw, dh, true);
}

// Normalized video landmark -> canvas point (mirrored cover-crop).
function vidToCanvas(p) {
  const vw = video.videoWidth || W;
  const vh = video.videoHeight || H;
  const s = Math.max(W / vw, H / vh);
  const dx = (W - vw * s) / 2;
  const dy = (H - vh * s) / 2;
  return { x: W - (dx + p.x * vw * s), y: dy + p.y * vh * s };
}

// ---------------------------------------------------------------------------
// Outline art (silhouette mask -> wobbly contour ring)
// ---------------------------------------------------------------------------

function mkCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function silhouetteCanvas(calib, pose, jitter) {
  const c = mkCanvas(W, H);
  drawSilhouette(c.getContext('2d'), buildJoints(calib, pose, jitter), calib);
  return c;
}

function buildRingCanvas(mask, thickness, color) {
  const c = mkCanvas(W, H);
  const g = c.getContext('2d');
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    g.drawImage(mask, Math.cos(a) * thickness, Math.sin(a) * thickness);
  }
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(mask, 0, 0);
  return c;
}

function tintCanvas(mask, color) {
  const c = mkCanvas(W, H);
  const g = c.getContext('2d');
  g.drawImage(mask, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, W, H);
  return c;
}

function currentCalib() {
  return state.calibVideo
    ? calibToCanvas(state.calibVideo, video, W, H)
    : defaultCalib(W, H);
}

// Elimination levels slowly shrink the outline. Pure evil.
function currentShrink() {
  if (state.mode !== 'elim') return 1;
  return 1 - Math.min(0.10, 0.015 * (state.level - 1));
}

function prepareRoundArt(pose, sizeScale = 1) {
  state.currentPose = pose;
  const calib = currentCalib();
  if (sizeScale !== 1) {
    for (const k of CALIB_LENGTH_KEYS) calib[k] *= sizeScale;
  }
  const thickness = Math.max(4, H * 0.008);
  state.targetMask = silhouetteCanvas(calib, pose, 0);
  state.ringFrames = [0, 1, 2].map(() =>
    buildRingCanvas(silhouetteCanvas(calib, pose, 0.012), thickness, '#fff'));
  // Thicker ring for when the wall is far away and scaled small on screen.
  state.farRingFrames = [0, 1, 2].map(() =>
    buildRingCanvas(silhouetteCanvas(calib, pose, 0.012), Math.max(9, H * 0.02), '#fff'));
  state.fillFrame = tintCanvas(state.targetMask, 'rgba(255, 255, 255, 0.18)');
  // "Stand here" floor ring at the player's feet plane.
  const foot = Math.max(...['ankleL', 'ankleR'].map((k) =>
    buildJoints(calib, pose, 0)[k].y));
  state.floorMark = {
    x: calib.anchorX,
    y: Math.min(foot + calib.personH * 0.03, H - H * 0.02),
    rx: calib.shoulderHalf * 2.6,
    ry: calib.shoulderHalf * 0.9,
  };
  // Vanishing point the "wall" grows from — roughly the body's centre,
  // lifted for airborne poses so they scale about the floating figure.
  const airOff = (pose.air || 0) * calib.personH;
  state.pivot = { x: calib.anchorX, y: calib.feetY - calib.personH * 0.52 - airOff };
}

// Hole-in-the-Wall approach: the person-shaped gap materialises from a single
// glowing point in the distance (the vanishing point), pops quickly up to a
// readable size, then travels gently to the player's plane (scale 1), arriving
// as the countdown ends.
const WALL_POINT_SCALE = 0.04;  // "singular point" starting size
const WALL_READABLE = 0.35;     // size after the initial pop
const WALL_POP_FRAC = 0.16;     // fraction of the countdown spent popping
const WALL_EASY_ARRIVE = 0.75;  // easy mode reaches the plane at 75%, then holds

function wallScale(elapsedFrac) {
  let p = Math.max(0, Math.min(1, elapsedFrac));
  if (!state.hardMode) p = Math.min(1, p / WALL_EASY_ARRIVE);
  if (p < WALL_POP_FRAC) {
    const e = p / WALL_POP_FRAC;
    const ease = 1 - (1 - e) * (1 - e); // ease-out pop
    return WALL_POINT_SCALE + (WALL_READABLE - WALL_POINT_SCALE) * ease;
  }
  const q = (p - WALL_POP_FRAC) / (1 - WALL_POP_FRAC);
  return WALL_READABLE + (1 - WALL_READABLE) * Math.pow(q, 1.6);
}

function vanishingPoint() {
  return { x: W * 0.5, y: H * 0.36 };
}

// Draws the wall at approach scale `s`: a faint gold landing-zone ghost marks
// where the outline will arrive, the shape emerges from a glowing vanishing
// point and travels toward the player, thick-ringed and hazy while far,
// crisp and bright as it lands.
function drawApproachingOutline(now, s) {
  const p = state.pivot || { x: W / 2, y: H / 2 };
  const vp = vanishingPoint();
  const f = Math.max(0, Math.min(1, (s - WALL_POINT_SCALE) / (1 - WALL_POINT_SCALE)));
  const near = Math.max(0, Math.min(1, (s - WALL_READABLE) / (1 - WALL_READABLE)));
  const frame = Math.floor(now / 160) % 3;

  // The point in the distance the wall emerges from.
  if (f < 0.5) {
    const glow = 1 - f * 2;
    const r = H * 0.02 + H * 0.01 * Math.sin(now / 90);
    const grad = ctx.createRadialGradient(vp.x, vp.y, 0, vp.x, vp.y, r * 4);
    grad.addColorStop(0, `rgba(255, 255, 255, ${0.9 * glow})`);
    grad.addColorStop(0.3, `rgba(120, 220, 255, ${0.55 * glow})`);
    grad.addColorStop(1, 'rgba(120, 220, 255, 0)');
    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(vp.x - r * 4, vp.y - r * 4, r * 8, r * 8);
    ctx.restore();
  }

  // Wall transform: pivot glides from the vanishing point to the player's
  // plane as the scale grows — a true "coming at you from a point" path.
  const dp = { x: vp.x + (p.x - vp.x) * f, y: vp.y + (p.y - vp.y) * f };
  ctx.save();
  ctx.translate(dp.x, dp.y);
  ctx.scale(s, s);
  ctx.translate(-p.x, -p.y);
  ctx.globalAlpha = 0.6 + 0.4 * near;
  if (state.fillFrame) ctx.drawImage(state.fillFrame, 0, 0);
  ctx.shadowColor = `rgba(120, 220, 255, ${0.85 * (1 - near)})`;
  ctx.shadowBlur = (1 - near) * H * 0.04;
  if (state.farRingFrames.length && near < 1) {
    ctx.globalAlpha = 0.95 * (1 - near);
    ctx.drawImage(state.farRingFrames[frame], 0, 0);
  }
  if (state.ringFrames.length) {
    ctx.globalAlpha = 0.35 + 0.65 * near;
    ctx.drawImage(state.ringFrames[frame], 0, 0);
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Scan mode — sci-fi calibration scanner
// ---------------------------------------------------------------------------

function resetScan() {
  state.scan = {
    holdMs: 0, samples: [], lastNose: null, lastDetectAt: 0,
    lastFrameAt: 0, det: null, inPose: false, ticks: 0,
    framing: 'search', lastInstr: '', lastInstrAt: 0, saidHold: false,
  };
}

// Is the player at a good distance / position on SCREEN? Uses canvas-space
// landmarks so cover-cropping is accounted for. Returns:
//   'search' (no body), 'closer', 'back', 'center', or 'ok'.
function evalFraming(lms) {
  const core = [LM.NOSE, LM.HIP_L, LM.HIP_R, LM.ANKLE_L, LM.ANKLE_R];
  if (!lms || core.some((i) => (lms[i].visibility ?? 1) < 0.5)) return 'search';
  const nose = vidToCanvas(lms[LM.NOSE]);
  const ankleY = Math.max(vidToCanvas(lms[LM.ANKLE_L]).y, vidToCanvas(lms[LM.ANKLE_R]).y);
  const bodyH = ankleY - nose.y;
  const headTop = nose.y - bodyH * 0.12;
  const feetY = ankleY + bodyH * 0.07;
  const personH = feetY - headTop;
  if (personH < H * 0.48) return 'closer';
  if (personH > H * 0.85 || headTop < H * 0.02 || feetY > H * 0.995) return 'back';
  if (Math.abs(nose.x - W / 2) > W * 0.28) return 'center';
  return 'ok';
}

const FRAMING_PROMPTS = {
  closer: { text: 'STEP CLOSER!', say: 'Step closer!' },
  back: { text: 'STEP BACK!', say: 'Step back a bit!' },
  center: { text: 'MOVE TO THE MIDDLE!', say: 'Move to the middle!' },
};

function scanGhost() {
  if (!state.scanGhost) {
    const calib = defaultCalib(W, H);
    const mask = silhouetteCanvas(calib, SCAN_POSE, 0);
    state.scanGhost = {
      ring: buildRingCanvas(mask, Math.max(3, H * 0.006), SCAN_COLOR),
      fill: tintCanvas(mask, 'rgba(89, 247, 255, 0.07)'),
    };
  }
  return state.scanGhost;
}

function updateScan(now) {
  const sc = state.scan;
  const dt = sc.lastFrameAt ? now - sc.lastFrameAt : 16;
  sc.lastFrameAt = now;

  if (now - sc.lastDetectAt > 66) {
    sc.lastDetectAt = now;
    sc.det = Tracker.detect(video);
  }

  const vw = video.videoWidth || W;
  const vh = video.videoHeight || H;
  const lms = sc.det && sc.det.landmarks;
  sc.inPose = !!(lms && isScanPose(lms, vw, vh));

  // Distance/position coaching: calibration only accumulates once the player
  // fills the screen nicely (not tiny, not clipping, roughly centred).
  sc.framing = evalFraming(lms);
  const prompt = FRAMING_PROMPTS[sc.framing];
  if (prompt && (sc.lastInstr !== sc.framing) && now - sc.lastInstrAt > 2500) {
    sc.lastInstr = sc.framing;
    sc.lastInstrAt = now;
    sc.saidHold = false;
    speak(prompt.say);
  }
  if (sc.framing !== 'ok') {
    sc.inPose = false;
  } else if (sc.inPose && !sc.saidHold) {
    sc.saidHold = true;
    sc.lastInstr = '';
    speak('Perfect! Hold still!');
  }

  if (sc.inPose) {
    const nose = { x: lms[LM.NOSE].x * vw, y: lms[LM.NOSE].y * vh };
    const moved = sc.lastNose
      ? Math.hypot(nose.x - sc.lastNose.x, nose.y - sc.lastNose.y)
      : 0;
    sc.lastNose = nose;
    if (moved > vh * 0.03) {
      sc.holdMs = 0;
      sc.samples = [];
    } else {
      sc.holdMs += dt;
      sc.samples.push(measureBody(lms, vw, vh));
      const quarter = Math.floor((sc.holdMs / SCAN_HOLD_MS) * 4);
      if (quarter > sc.ticks && quarter < 4) {
        sc.ticks = quarter;
        beep(600 + quarter * 200, 0.08, 'sine', 0.09);
      }
    }
  } else {
    sc.holdMs = Math.max(0, sc.holdMs - dt * 2);
    if (sc.holdMs === 0) {
      sc.samples = [];
      sc.ticks = 0;
    }
  }

  if (sc.holdMs >= SCAN_HOLD_MS && sc.samples.length) {
    state.calibVideo = averageCalibs(sc.samples);
    setPhase('calibrated');
    state.calibratedAt = now;
    playLockChirp();
    speak('Calibrated! Let\'s play!');
    setTimeout(beginRounds, 1500);
  }
}

function averageCalibs(samples) {
  const out = {};
  for (const key of Object.keys(samples[0])) {
    if (typeof samples[0][key] !== 'number') { out[key] = samples[0][key]; continue; }
    out[key] = samples.reduce((sum, s) => sum + s[key], 0) / samples.length;
  }
  return out;
}

const SKELETON_EDGES = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28],
];

function drawScan(now) {
  const sc = state.scan;
  const locked = state.phase === 'calibrated';

  // Darken + grid
  ctx.fillStyle = 'rgba(6, 12, 24, 0.45)';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(89, 247, 255, 0.08)';
  ctx.lineWidth = 1;
  const grid = Math.max(40, H / 16);
  ctx.beginPath();
  for (let x = (W / 2) % grid; x < W; x += grid) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = 0; y < H; y += grid) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();

  // Sweeping scanline
  if (!locked) {
    const sy = ((now * 0.22) % (H * 1.4)) - H * 0.2;
    const band = ctx.createLinearGradient(0, sy - H * 0.08, 0, sy + H * 0.02);
    band.addColorStop(0, 'rgba(89, 247, 255, 0)');
    band.addColorStop(0.85, 'rgba(89, 247, 255, 0.16)');
    band.addColorStop(1, 'rgba(89, 247, 255, 0.55)');
    ctx.fillStyle = band;
    ctx.fillRect(0, sy - H * 0.08, W, H * 0.1);
  }

  // Corner brackets
  const m = Math.round(H * 0.035);
  const len = Math.round(H * 0.05);
  ctx.strokeStyle = SCAN_COLOR;
  ctx.lineWidth = Math.max(2, H * 0.004);
  ctx.beginPath();
  for (const [cx, cy, sx, sy2] of [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]]) {
    ctx.moveTo(cx + sx * len, cy);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx, cy + sy2 * len);
  }
  ctx.stroke();

  // What is happening & why — the scan explainer.
  if (!locked) {
    drawFittedText('🛸 BODY SCAN', H * 0.05, H * 0.055, SCAN_COLOR);
    drawFittedText('I measure you so every outline fits YOUR body', H * 0.05 + H * 0.07, H * 0.028, '#fff');
    drawFittedText('Whole body in frame · arms wide · legs apart · hold still', H * 0.05 + H * 0.105, H * 0.028, '#fff');
  }

  // Ghost of the scan pose
  const ghost = scanGhost();
  ctx.save();
  ctx.globalAlpha = locked ? 0.15 : 0.55 + 0.25 * Math.sin(now / 300);
  ctx.drawImage(ghost.fill, 0, 0);
  ctx.drawImage(ghost.ring, 0, 0);
  ctx.restore();

  // Live skeleton
  const lms = sc.det && sc.det.landmarks;
  if (lms) {
    const col = locked ? '#7dff9c' : sc.inPose ? SCAN_COLOR : 'rgba(89, 247, 255, 0.55)';
    ctx.save();
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = Math.max(2, H * 0.004);
    ctx.shadowColor = col;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    for (const [a, b] of SKELETON_EDGES) {
      if ((lms[a].visibility ?? 1) < 0.5 || (lms[b].visibility ?? 1) < 0.5) continue;
      const pa = vidToCanvas(lms[a]);
      const pb = vidToCanvas(lms[b]);
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
    }
    ctx.stroke();
    for (const i of SCAN_LANDMARKS) {
      if ((lms[i].visibility ?? 1) < 0.5) continue;
      const p = vidToCanvas(lms[i]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(3, H * 0.006), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Big framing prompt while the player finds the right distance.
  if (!locked && FRAMING_PROMPTS[sc.framing]) {
    ctx.save();
    ctx.globalAlpha = 0.75 + 0.25 * Math.sin(now / 180);
    drawFittedText(FRAMING_PROMPTS[sc.framing].text, H * 0.4, H * 0.062, '#ffcf3f');
    ctx.restore();
  }

  // Status readout
  const pct = Math.min(100, Math.round((sc.holdMs / SCAN_HOLD_MS) * 100));
  let status;
  if (locked) status = `LOCK ✓  SUBJECT CALIBRATED`;
  else if (!lms) status = 'SEARCHING FOR SUBJECT…';
  else if (FRAMING_PROMPTS[sc.framing]) status = `RANGE — ${FRAMING_PROMPTS[sc.framing].text}`;
  else if (!sc.inPose) status = 'IN RANGE ✓ — ARMS OUT WIDE, LEGS APART';
  else status = `CALIBRATING ${pct}% — HOLD STILL`;

  const fs = Math.max(13, Math.round(H * 0.022));
  ctx.font = `${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = SCAN_COLOR;
  const blink = Math.floor(now / 400) % 2 ? '█' : ' ';
  ctx.fillText('BODY SCANNER v2.1', m, H - m - fs * 2.6);
  ctx.fillText(`> ${status} ${blink}`, m, H - m - fs * 1.2);

  // Progress bar
  if (!locked) {
    const bw = W * 0.42;
    const bx = (W - bw) / 2;
    const by = H - m - fs * 0.4;
    ctx.strokeStyle = SCAN_COLOR;
    ctx.strokeRect(bx, by - fs * 0.6, bw, fs * 0.6);
    ctx.fillRect(bx, by - fs * 0.6, bw * (pct / 100), fs * 0.6);
  }

  if (locked) {
    const t = Math.min(1, (now - state.calibratedAt) / 250);
    if (t < 1) {
      ctx.fillStyle = `rgba(255, 255, 255, ${0.7 * (1 - t)})`;
      ctx.fillRect(0, 0, W, H);
    }
    drawBigText('CALIBRATED!', '#7dff9c');
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function computeScore(personMaskCanvas) {
  const sw = 160;
  const sh = Math.max(90, Math.round((160 * H) / W));
  const tc = mkCanvas(sw, sh);
  tc.getContext('2d').drawImage(state.targetMask, 0, 0, sw, sh);
  const pc = mkCanvas(sw, sh);
  drawCover(pc.getContext('2d'), personMaskCanvas,
    personMaskCanvas.width, personMaskCanvas.height, sw, sh, true);

  const target = tc.getContext('2d').getImageData(0, 0, sw, sh).data;
  const person = pc.getContext('2d').getImageData(0, 0, sw, sh).data;
  let tCount = 0, pCount = 0, both = 0;
  for (let i = 0; i < target.length; i += 4) {
    const t = target[i + 3] > 128; // silhouette alpha
    const p = person[i] > 128;     // person mask red channel
    if (t) tCount++;
    if (p) pCount++;
    if (t && p) both++;
  }
  if (!pCount || !tCount) return 0;
  const coverage = both / tCount;
  const precision = both / pCount;
  return Math.round(100 * Math.min(1, 0.65 * coverage + 0.35 * precision));
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

// Glowing "stand here" ring on the ground, so the player positions their feet
// where the outline will land. `label` shows STAND HERE (get-ready only).
function drawFloorMark(now, label) {
  const m = state.floorMark;
  if (!m) return;
  const pulse = 0.65 + 0.35 * Math.sin(now / 320);
  ctx.save();
  ctx.translate(m.x, m.y);
  // soft glow disc
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, m.rx);
  g.addColorStop(0, `rgba(89, 247, 255, ${0.22 * pulse})`);
  g.addColorStop(1, 'rgba(89, 247, 255, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, m.rx, m.ry, 0, 0, Math.PI * 2);
  ctx.fill();
  // ring
  ctx.lineWidth = Math.max(3, H * 0.006);
  ctx.strokeStyle = `rgba(120, 236, 255, ${0.85 * pulse})`;
  ctx.shadowColor = 'rgba(89, 247, 255, 0.9)';
  ctx.shadowBlur = H * 0.02;
  ctx.beginPath();
  ctx.ellipse(0, 0, m.rx, m.ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  // little foot arrows pointing in
  ctx.restore();
  if (label) {
    drawFittedText('STAND HERE', m.y - m.ry - H * 0.05, H * 0.028, '#59f7ff');
  }
}

function render(now) {
  ctx.clearRect(0, 0, W, H);
  if (video.readyState >= 2) drawVideoFrame(ctx);

  switch (state.phase) {
    case 'loading':
      drawBigText('BOOTING…', SCAN_COLOR);
      break;
    case 'scan':
      updateScan(now);
      drawScan(now);
      break;
    case 'calibrated':
      drawScan(now);
      break;
    case 'elim-intro': {
      ctx.fillStyle = `rgba(50, 0, 12, ${0.5 + 0.12 * Math.sin(now / 130)})`;
      ctx.fillRect(0, 0, W, H);
      drawBigText('ELIMINATION!', '#ff5c5c');
      const fs = Math.round(H * 0.035);
      drawFittedText(`Beat the target score or you're OUT!`, H * 0.26, fs, '#fff');
      drawFittedText(`It only gets harder from here… ☠️`, H * 0.26 + fs * 1.6, fs, '#fff');
      break;
    }
    case 'getready': {
      drawFloorMark(now, true);
      // Pose name up top, giant 3·2·1 counting into the round.
      drawBigText(state.currentPose.name.toUpperCase(),
        state.mode === 'elim' ? '#ff5c5c' : '#ffe14d');
      drawFittedText(state.currentPose.tip,
        H * 0.06 + Math.min(H * 0.15, W * 0.18) * 1.1, H * 0.038, '#fff');
      const rem = Math.max(0, state.getReadyUntil - now);
      const n = Math.ceil(rem / 1000);
      if (n !== state.readyTick) {
        state.readyTick = n;
        if (n >= 1) beep(560 + (3 - Math.min(n, 3)) * 120, 0.12, 'sine', 0.09);
      }
      if (n >= 1) {
        const pop = 1 - (rem % 1000) / 1000; // 0→1 within each second
        const fs = Math.min(H * 0.34, W * 0.5) * (0.75 + 0.25 * pop);
        ctx.save();
        ctx.globalAlpha = 0.5 + 0.5 * (1 - pop);
        drawFittedText(String(n), H * 0.42, fs, '#ffffff');
        ctx.restore();
      }
      break;
    }
    case 'posing': {
      const remaining = Math.max(0, state.deadline - now);
      const dur = state.roundDuration * 1000;
      const s = wallScale((dur - remaining) / dur);
      drawFloorMark(now, false);
      drawApproachingOutline(now, s);
      const secs = Math.ceil(remaining / 1000);
      drawBigText(String(secs), remaining < 1500 ? '#ff5c5c' : '#ffffff');
      if (state.mode === 'elim') {
        drawFittedText(`☠️ BEAT ${state.threshold}`,
          H * 0.06 + H * 0.155, H * 0.034, '#ff9db5');
      }
      if (remaining <= 0) {
        setPhase('scoring');
        captureAndScore();
      }
      break;
    }
    case 'paused':
      ctx.fillStyle = 'rgba(10, 6, 26, 0.55)';
      ctx.fillRect(0, 0, W, H);
      break;
    case 'scoring':
      drawBigText('📸', '#ffffff');
      break;
    case 'judging':
      if (state.lastSnap) ctx.drawImage(state.lastSnap, 0, 0);
      break;
    case 'result': {
      if (state.lastSnap) ctx.drawImage(state.lastSnap, 0, 0);
      const r = state.result;
      if (r) {
        drawBigText(r.headline, r.color);
        drawFittedText(r.comment,
          H * 0.06 + Math.min(H * 0.15, W * 0.18) * 1.1, H * 0.05, '#fff');
        if (r.sub) {
          drawFittedText(r.sub,
            H * 0.06 + Math.min(H * 0.15, W * 0.18) * 1.1 + H * 0.065,
            H * 0.032, '#ff9db5');
        }
      }
      // auto-advance progress bar along the bottom
      const frac = Math.min(1, Math.max(0, 1 - (state.resultUntil - now) / RESULT_MS));
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.fillRect(0, H - Math.max(4, H * 0.006), W * frac, Math.max(4, H * 0.006));
      if (now >= state.resultUntil) advance();
      break;
    }
  }

  if (state.notice && now < state.noticeUntil) {
    const fs = Math.max(14, Math.round(H * 0.024));
    ctx.font = `${fs}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#ffe14d';
    ctx.fillText(state.notice, W / 2, H - fs);
  }

  requestAnimationFrame(render);
}

// Draws centered outlined text, shrinking the font so it always fits on
// screen (long words like ELIMINATION! on narrow portrait phones).
function drawFittedText(text, y, baseFs, color) {
  ctx.save();
  let fs = Math.round(baseFs);
  ctx.font = `bold ${fs}px ${GAME_FONT}`;
  const width = ctx.measureText(text).width;
  if (width > W * 0.94) {
    fs = Math.round(fs * (W * 0.94) / width);
    ctx.font = `bold ${fs}px ${GAME_FONT}`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineWidth = Math.max(3, fs * 0.09);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.fillStyle = color;
  ctx.strokeText(text, W / 2, y);
  ctx.fillText(text, W / 2, y);
  ctx.restore();
}

function drawBigText(text, color) {
  drawFittedText(text, H * 0.06, Math.min(H * 0.15, W * 0.18), color);
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

function setPhase(p) {
  state.phase = p;
  els.skipScan.classList.toggle('hidden', p !== 'scan');
  els.hud.classList.toggle('hidden',
    ['loading', 'scan', 'calibrated', 'elim-intro', 'paused'].includes(p));
  // Pause button available only while a round is actively running.
  els.pauseBtn.classList.toggle('hidden', !['getready', 'posing'].includes(p));
}

function notice(text, ms = 4000) {
  state.notice = text;
  state.noticeUntil = performance.now() + ms;
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let rendering = false;

async function startGame() {
  els.startBtn.disabled = true;
  els.startError.textContent = '';
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
  }
  initCustomTension();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    els.startError.textContent =
      'Could not access the camera. Allow camera permission and try again.';
    els.startBtn.disabled = false;
    return;
  }

  showScreen('game');
  setPhase('loading');
  if (!rendering) {
    rendering = true;
    requestAnimationFrame(render);
  }

  const ok = await Tracker.load();
  if (ok) {
    startScan();
  } else {
    notice('Scanner offline — using standard outline size', 5000);
    beginRounds();
  }
}

function startScan() {
  state.calibVideo = null;
  resetScan();
  setPhase('scan');
  speak('Body scan time! I\'ll measure you so the outlines fit your body. ' +
    'Stand back so I can see all of you, spread your arms wide, and hold still.');
}

function skipScan() {
  state.calibVideo = null;
  notice('Scan skipped — using standard outline size', 4000);
  beginRounds();
}

function beginRounds() {
  state.mode = 'normal';
  state.poses = shuffled(POSES.filter((p) => p.difficulty <= 2 && !p.extreme))
    .slice(0, NORMAL_ROUNDS);
  state.round = 0;
  state.level = 1;
  state.totalScore = 0;
  state.shots = [];
  state.usedPoses = new Set();
  showScreen('game');
  nextRound();
}

// Re-anchor the outline to wherever the player is standing right now.
function reAnchor() {
  if (!state.calibVideo || !Tracker.ready()) return;
  const det = Tracker.detect(video);
  const lms = det && det.landmarks;
  const vw = video.videoWidth || W;
  const vh = video.videoHeight || H;
  if (lms &&
      [LM.HIP_L, LM.HIP_R, LM.ANKLE_L, LM.ANKLE_R].every((i) => (lms[i].visibility ?? 1) > 0.5)) {
    state.calibVideo.anchorX = ((lms[LM.HIP_L].x + lms[LM.HIP_R].x) / 2) * vw;
    state.calibVideo.feetY =
      Math.max(lms[LM.ANKLE_L].y, lms[LM.ANKLE_R].y) * vh +
      state.calibVideo.personH * 0.05;
  }
}

// Timer bookkeeping so pause / restart / menu can cancel anything pending.
function scheduleTimer(fn, ms) {
  const id = setTimeout(() => {
    state.pendingTimers = state.pendingTimers.filter((t) => t !== id);
    fn();
  }, ms);
  state.pendingTimers.push(id);
  return id;
}

function clearTimers() {
  state.pendingTimers.forEach(clearTimeout);
  state.pendingTimers = [];
}

function beginPosing(ms) {
  state.deadline = performance.now() + ms;
  setPhase('posing');
  startTension(ms, state.mode === 'elim');
}

function launchRound(pose, duration) {
  clearTimers();
  els.resultOverlay.classList.add('hidden');
  state.usedPoses.add(pose);
  reAnchor();
  prepareRoundArt(pose, currentShrink());
  state.roundDuration = duration;

  if (state.mode === 'elim') {
    els.roundLabel.textContent = `☠️ Level ${state.level}`;
    speak(`Level ${state.level}. ${pose.name}! ${pose.tip} Beat ${state.threshold}!`);
  } else {
    els.roundLabel.textContent = `Round ${state.round + 1}/${NORMAL_ROUNDS}`;
    speak(`${pose.name}! ${pose.tip}`);
  }
  els.poseLabel.textContent = `${pose.emoji} ${pose.name} — ${pose.tip}`;
  els.scoreLabel.textContent = `⭐ ${state.totalScore}`;

  setPhase('getready');
  state.getReadyUntil = performance.now() + GET_READY_MS;
  state.readyTick = -1;
  scheduleTimer(() => beginPosing(state.roundDuration * 1000), GET_READY_MS);
}

// ---- Pause / restart / menu ----------------------------------------------

function pauseGame() {
  if (!['getready', 'posing'].includes(state.phase)) return;
  const now = performance.now();
  state.pauseInfo = {
    phase: state.phase,
    remaining: (state.phase === 'posing' ? state.deadline : state.getReadyUntil) - now,
  };
  clearTimers();
  stopTension();
  try { speechSynthesis.cancel(); } catch (e) {}
  setPhase('paused');
  els.pauseOverlay.classList.remove('hidden');
}

function resumeGame() {
  els.pauseOverlay.classList.add('hidden');
  const info = state.pauseInfo;
  if (!info) return;
  const rem = Math.max(400, info.remaining);
  if (info.phase === 'getready') {
    setPhase('getready');
    state.getReadyUntil = performance.now() + rem;
    state.readyTick = -1;
    scheduleTimer(() => beginPosing(state.roundDuration * 1000), rem);
  } else {
    beginPosing(rem);
  }
  state.pauseInfo = null;
}

function restartRound() {
  els.pauseOverlay.classList.add('hidden');
  state.pauseInfo = null;
  launchRound(state.currentPose, state.roundDuration);
}

function quitToMenu() {
  els.pauseOverlay.classList.add('hidden');
  els.resultOverlay.classList.add('hidden');
  clearTimers();
  stopTension();
  try { speechSynthesis.cancel(); } catch (e) {}
  state.pauseInfo = null;
  setPhase('idle');
  els.startBtn.disabled = false;
  showScreen('start');
}

function nextRound() {
  launchRound(state.poses[state.round], NORMAL_SECONDS[state.round]);
}

function startElimination() {
  state.mode = 'elim';
  state.level = 1;
  els.resultOverlay.classList.add('hidden');
  setPhase('elim-intro');
  elimSting();
  speak('Elimination time! Beat the target score, or you are out!');
  scheduleTimer(() => {
    if (state.phase === 'elim-intro') nextElimLevel();
  }, 3600);
}

// Awkwardness ladder: levels 1-2 draw difficulty 2+, levels 3-6 draw only
// difficulty 3, and from level 7 the pool is exclusively extreme poses
// (side kicks, sky-high kicks, sprinter balances, airborne jumps).
function elimPool() {
  const lvl = state.level;
  const fits = lvl >= 7
    ? (p) => p.extreme
    : lvl >= 3
      ? (p) => p.difficulty >= 3
      : (p) => p.difficulty >= 2;
  let pool = POSES.filter((p) =>
    fits(p) && p !== state.currentPose && !state.usedPoses.has(p));
  if (!pool.length) pool = POSES.filter((p) => fits(p) && p !== state.currentPose);
  if (!pool.length) pool = POSES.filter((p) => p !== state.currentPose);
  return pool;
}

function nextElimLevel() {
  state.threshold = Math.min(80, 40 + 5 * state.level);
  const duration = Math.max(2, 4.5 - 0.3 * (state.level - 1));
  const pool = elimPool();
  const pose = pool[Math.floor(Math.random() * pool.length)];
  if (state.level >= 2) notice('⚠ The outline is shrinking…', 2500);
  launchRound(pose, duration);
}

async function captureAndScore() {
  stopTension();
  beep(300, 0.25, 'sawtooth', 0.12);

  const snap = mkCanvas(W, H);
  const sg = snap.getContext('2d');
  drawVideoFrame(sg);

  const det = Tracker.ready() ? Tracker.detect(video, true) : null;

  sg.drawImage(state.fillFrame, 0, 0);
  sg.drawImage(state.ringFrames[0], 0, 0);
  state.lastSnap = snap;

  if (det && det.maskCanvas) {
    const score = computeScore(det.maskCanvas);
    stampScore(snap, score);
    state.snapshotUrl = snap.toDataURL('image/png');
    resolveScore(score);
  } else {
    // Model unavailable: the one interaction we can't avoid — self-judging.
    state.snapshotUrl = snap.toDataURL('image/png');
    els.snapshotImg.src = state.snapshotUrl;
    els.resultOverlay.classList.remove('hidden');
    setPhase('judging');
  }
}

function stampScore(snapCanvas, score) {
  const g = snapCanvas.getContext('2d');
  const fs = Math.round(H * 0.06);
  g.font = `bold ${fs}px ${GAME_FONT}`;
  g.textAlign = 'right';
  g.lineWidth = Math.max(4, fs * 0.12);
  g.strokeStyle = 'rgba(0,0,0,0.8)';
  g.fillStyle = '#ffe14d';
  g.strokeText(`${score} pts`, W - fs * 0.4, H - fs * 0.5);
  g.fillText(`${score} pts`, W - fs * 0.4, H - fs * 0.5);
}

// Shared by auto-scoring and the self-judge buttons. Shows the big-text
// result on the frozen frame and auto-advances — no tapping required.
function resolveScore(score) {
  els.resultOverlay.classList.add('hidden');
  state.totalScore += score;
  els.scoreLabel.textContent = `⭐ ${state.totalScore}`;

  const pose = state.currentPose;
  state.shots.push({
    url: state.snapshotUrl,
    label: `${pose.emoji} ${pose.name}`,
    score,
  });

  const c = commentFor(score);
  const result = { headline: `${score} pts`, color: c.color, comment: c.text, sub: '' };

  if (state.mode === 'elim') {
    state.lastSurvived = score >= state.threshold;
    if (state.lastSurvived) {
      result.sub = `😅 SURVIVED — needed ${state.threshold}`;
      playFanfare(true);
      speak(`${score} points. ${c.text} Survived!`);
    } else {
      result.comment = 'ELIMINATED!';
      result.color = '#ff5c5c';
      result.sub = `☠️ Needed ${state.threshold} to survive`;
      sadTrombone();
      speak(`${score} points. Eliminated!`);
    }
  } else {
    playFanfare(score >= 55);
    speak(`${score} points. ${c.text}`);
  }

  state.result = result;
  state.resultUntil = performance.now() + RESULT_MS;
  setPhase('result');
}

function advance() {
  if (state.mode === 'normal') {
    state.round++;
    if (state.round >= NORMAL_ROUNDS) {
      startElimination();
    } else {
      nextRound();
    }
  } else if (state.lastSurvived) {
    state.level++;
    nextElimLevel();
  } else {
    showFinal();
  }
}

function rankForLevel(level) {
  if (level >= 8) return '🏆 Balance Deity';
  if (level >= 5) return '🥈 Shape Survivor';
  if (level >= 3) return '🥉 Wobbly Warrior';
  return '🧱 First-Round Faller';
}

function showFinal() {
  setPhase('final');
  els.resultOverlay.classList.add('hidden');
  els.finalScore.textContent = `${state.totalScore} pts`;
  els.finalRank.textContent =
    `☠️ Knocked out at Level ${state.level} — ${rankForLevel(state.level)}`;
  buildGallery();
  speak(`Game over! ${state.totalScore} points. Check out your photos!`);
  showScreen('final');
}

function showScreen(name) {
  els.startScreen.classList.toggle('hidden', name !== 'start');
  els.gameScreen.classList.toggle('hidden', name !== 'game');
  els.finalScreen.classList.toggle('hidden', name !== 'final');
}

// ---------------------------------------------------------------------------
// Photo wall — every round's snapshot, like the rollercoaster photo booth.
// ---------------------------------------------------------------------------

function downloadUrl(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

function buildGallery() {
  els.gallery.innerHTML = '';
  state.shots.forEach((s, i) => {
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = s.url;
    img.alt = `${s.label} — ${s.score} pts`;
    img.title = 'Tap to save this photo';
    img.addEventListener('click', () => downloadUrl(s.url, `outline-rush-${i + 1}.png`));
    const cap = document.createElement('figcaption');
    cap.textContent = `${s.label} · ${s.score}`;
    fig.appendChild(img);
    fig.appendChild(cap);
    els.gallery.appendChild(fig);
  });
  els.stripBtn.classList.toggle('hidden', !state.shots.length);
}

// Composes all shots into one downloadable photo-strip image.
async function composeStrip() {
  const shots = state.shots;
  if (!shots.length) return null;
  const imgs = await Promise.all(shots.map((s) => new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = s.url;
  })));

  const first = imgs.find(Boolean);
  if (!first) return null;
  const cellW = 480;
  const cellH = Math.round(cellW * (first.height / first.width));
  const cols = shots.length <= 4 ? 2 : 3;
  const rows = Math.ceil(shots.length / cols);
  const pad = 18;
  const header = 150;
  const labelH = 46;

  const c = mkCanvas(cols * (cellW + pad) + pad, header + rows * (cellH + labelH + pad) + pad);
  const g = c.getContext('2d');
  g.fillStyle = '#14121f';
  g.fillRect(0, 0, c.width, c.height);

  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.fillStyle = '#ffe14d';
  g.font = `bold 56px ${GAME_FONT}`;
  g.fillText('OUTLINE RUSH 🖍️', c.width / 2, 26);
  g.fillStyle = '#fff';
  g.font = `bold 30px ${GAME_FONT}`;
  g.fillText(`${state.totalScore} pts — ${rankForLevel(state.level)}`, c.width / 2, 96);

  imgs.forEach((im, i) => {
    if (!im) return;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = pad + col * (cellW + pad);
    const y = header + row * (cellH + labelH + pad);
    g.save();
    g.translate(x, y);
    g.beginPath();
    g.rect(0, 0, cellW, cellH);
    g.clip();
    drawCover(g, im, im.width, im.height, cellW, cellH, false);
    g.restore();
    g.strokeStyle = '#fff';
    g.lineWidth = 4;
    g.strokeRect(x, y, cellW, cellH);
    g.fillStyle = '#fff';
    g.font = `bold 26px ${GAME_FONT}`;
    g.fillText(`${shots[i].label} · ${shots[i].score} pts`, x + cellW / 2, y + cellH + 8);
  });

  return c.toDataURL('image/png');
}

async function saveStrip() {
  const url = await composeStrip();
  if (url) downloadUrl(url, 'outline-rush-photostrip.png');
  return url;
}

// ---------------------------------------------------------------------------
// Wire-up
// ---------------------------------------------------------------------------

els.startBtn.addEventListener('click', startGame);
els.skipScan.addEventListener('click', skipScan);
els.againBtn.addEventListener('click', beginRounds);
els.rescanBtn.addEventListener('click', () => {
  if (!Tracker.ready()) {
    beginRounds();
    return;
  }
  showScreen('game');
  startScan();
});
els.stripBtn.addEventListener('click', saveStrip);
els.pauseBtn.addEventListener('click', pauseGame);
els.resumeBtn.addEventListener('click', resumeGame);
els.restartBtn.addEventListener('click', restartRound);
els.menuBtn.addEventListener('click', quitToMenu);
els.judgeButtons.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => resolveScore(Number(btn.dataset.score)));
});

// Decorative hero art on the start screen: three tinted silhouettes from the
// pose library, drawn with the real in-game renderer.
(function heroArt() {
  const c = document.getElementById('hero-art');
  if (!c) return;
  const g = c.getContext('2d');
  const picks = [POSES[0], POSES[5], POSES[3]]; // Star Jump, Flamingo, Disco
  const colors = ['#ff4d8d', '#ffcf3f', '#59f7ff'];
  picks.forEach((p, i) => {
    const off = document.createElement('canvas');
    off.width = c.width;
    off.height = c.height;
    const og = off.getContext('2d');
    const calib = defaultCalib(c.width, c.height * 0.98);
    calib.anchorX = c.width * (0.24 + 0.26 * i);
    for (const k of CALIB_LENGTH_KEYS) calib[k] *= 0.62;
    calib.feetY = c.height * 0.97;
    og.save();
    og.translate(0, 0);
    drawSilhouette(og, buildJoints(calib, p, 0), calib);
    og.restore();
    og.globalCompositeOperation = 'source-in';
    og.fillStyle = colors[i];
    og.fillRect(0, 0, off.width, off.height);
    g.globalAlpha = 0.92;
    g.drawImage(off, 0, 0);
  });
})();

// Easy/Hard wall-arrival toggle on the start screen.
try {
  state.hardMode = localStorage.getItem('outlineRushHard') === '1';
} catch (e) {}
function refreshModeToggle() {
  els.modeToggle.querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', (b.dataset.hard === '1') === state.hardMode));
}
els.modeToggle.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.hardMode = btn.dataset.hard === '1';
    try { localStorage.setItem('outlineRushHard', state.hardMode ? '1' : '0'); } catch (e) {}
    refreshModeToggle();
  });
});
refreshModeToggle();
