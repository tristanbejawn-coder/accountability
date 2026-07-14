// Outline Rush — scan yourself, then fit inside the doodle outline before
// time runs out.

const ROUND_SECONDS = [6, 5, 5, 4, 4, 3];
const SCAN_HOLD_MS = 1400;
const SCAN_COLOR = '#59f7ff';

// Poses as limb angles (see limbDir in skeleton.js): 0 = down, 90 = out, 180 = up.
const POSES = [
  { name: 'Star Jump', emoji: '⭐', tip: 'Arms up and out, legs wide!',
    arms: { L: [135, 140], R: [135, 140] }, legs: { L: [20, 22], R: [20, 22] } },
  { name: 'T-Pose', emoji: '✈️', tip: 'Arms straight out, feet together.',
    arms: { L: [90, 90], R: [90, 90] }, legs: { L: [4, 4], R: [4, 4] } },
  { name: 'Muscle Flex', emoji: '💪', tip: 'Flex both arms like a strongman!',
    arms: { L: [95, 168], R: [95, 168] }, legs: { L: [10, 10], R: [10, 10] } },
  { name: 'Disco Fever', emoji: '🕺', tip: 'Point to the sky, hand on hip!',
    arms: { L: [55, -35], R: [150, 155] }, legs: { L: [18, 20], R: [4, 4] } },
  { name: 'Flamingo', emoji: '🦩', tip: 'One leg tucked in, arms up in a V!',
    arms: { L: [140, 145], R: [140, 145] }, legs: { L: [2, 2], R: [65, -75] } },
  { name: 'Invisible Chair', emoji: '🪑', tip: 'Squat like you are sitting, arms out!',
    arms: { L: [90, 90], R: [90, 90] }, legs: { L: [38, -12], R: [38, -12] } },
];

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
  'start-btn', 'next-btn', 'again-btn', 'rescan-btn', 'save-btn', 'skip-scan',
  'judge-buttons', 'hud', 'round-label', 'pose-label', 'score-label',
  'result-score', 'result-verdict', 'snapshot-img', 'final-score',
  'final-rank', 'start-error',
]) {
  els[id.replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = document.getElementById(id);
}

const state = {
  phase: 'idle', // idle | loading | scan | calibrated | getready | posing | scoring | result | final
  round: 0,
  poses: [],
  totalScore: 0,
  deadline: 0,
  lastTick: -1,
  currentPose: null,
  ringFrames: [],
  fillFrame: null,
  targetMask: null,
  snapshotUrl: null,
  calibVideo: null, // measured calibration in video pixels, null = defaults
  notice: '',
  noticeUntil: 0,
  scan: null,
  scanGhost: null,
  calibratedAt: 0,
};

// ---------------------------------------------------------------------------
// Audio
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
      ['getready', 'posing', 'scoring', 'result'].includes(state.phase)) {
    prepareRoundArt(state.currentPose);
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

function prepareRoundArt(pose) {
  state.currentPose = pose;
  const calib = currentCalib();
  const thickness = Math.max(4, H * 0.008);
  state.targetMask = silhouetteCanvas(calib, pose, 0);
  state.ringFrames = [0, 1, 2].map(() =>
    buildRingCanvas(silhouetteCanvas(calib, pose, 0.012), thickness, '#fff'));
  state.fillFrame = tintCanvas(state.targetMask, 'rgba(255, 255, 255, 0.14)');
}

// ---------------------------------------------------------------------------
// Scan mode — sci-fi calibration scanner
// ---------------------------------------------------------------------------

function resetScan() {
  state.scan = {
    holdMs: 0, samples: [], lastNose: null, lastDetectAt: 0,
    lastFrameAt: 0, det: null, inPose: false, ticks: 0,
  };
}

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

  // Status readout
  const pct = Math.min(100, Math.round((sc.holdMs / SCAN_HOLD_MS) * 100));
  let status;
  if (locked) status = `LOCK ✓  SUBJECT CALIBRATED`;
  else if (!lms) status = 'SEARCHING FOR SUBJECT…';
  else if (!sc.inPose) status = 'SUBJECT DETECTED — ARMS OUT WIDE, LEGS APART';
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

function verdictFor(score) {
  if (score >= 80) return { text: 'PERFECT FIT!', good: true };
  if (score >= 60) return { text: 'Nice squeeze!', good: true };
  if (score >= 35) return { text: 'Halfway in...', good: false };
  return { text: 'The outline wins!', good: false };
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

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
    case 'getready':
    case 'posing': {
      if (state.fillFrame) ctx.drawImage(state.fillFrame, 0, 0);
      if (state.ringFrames.length) {
        ctx.drawImage(state.ringFrames[Math.floor(now / 160) % state.ringFrames.length], 0, 0);
      }
      if (state.phase === 'getready') {
        drawBigText('GET READY!', '#ffe14d');
      } else {
        const remaining = Math.max(0, state.deadline - now);
        const secs = Math.ceil(remaining / 1000);
        if (secs !== state.lastTick) {
          state.lastTick = secs;
          if (secs > 0) beep(secs <= 1 ? 1320 : 880, 0.09);
        }
        drawBigText(String(secs), remaining < 1500 ? '#ff5c5c' : '#ffffff');
        if (remaining <= 0) {
          setPhase('scoring');
          captureAndScore();
        }
      }
      break;
    }
    case 'scoring':
      drawBigText('📸', '#ffffff');
      break;
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

function drawBigText(text, color) {
  ctx.save();
  const fs = Math.round(Math.min(H * 0.15, W * 0.18));
  ctx.font = `bold ${fs}px "Comic Sans MS", "Chalkboard SE", cursive, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineWidth = Math.max(4, fs * 0.09);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.fillStyle = color;
  ctx.strokeText(text, W / 2, H * 0.06);
  ctx.fillText(text, W / 2, H * 0.06);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

function setPhase(p) {
  state.phase = p;
  els.skipScan.classList.toggle('hidden', p !== 'scan');
  els.hud.classList.toggle('hidden', ['loading', 'scan', 'calibrated'].includes(p));
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
}

function skipScan() {
  state.calibVideo = null;
  notice('Scan skipped — using standard outline size', 4000);
  beginRounds();
}

function beginRounds() {
  state.poses = shuffled(POSES);
  state.round = 0;
  state.totalScore = 0;
  showScreen('game');
  nextRound();
}

function nextRound() {
  els.resultOverlay.classList.add('hidden');

  // Re-anchor the outline to wherever the player is standing right now.
  if (state.calibVideo && Tracker.ready()) {
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

  const p = state.poses[state.round];
  prepareRoundArt(p);
  els.roundLabel.textContent = `Round ${state.round + 1}/${state.poses.length}`;
  els.poseLabel.textContent = `${p.emoji} ${p.name} — ${p.tip}`;
  els.scoreLabel.textContent = `⭐ ${state.totalScore}`;

  setPhase('getready');
  setTimeout(() => {
    if (state.phase !== 'getready') return;
    state.lastTick = -1;
    state.deadline =
      performance.now() + ROUND_SECONDS[state.round % ROUND_SECONDS.length] * 1000;
    setPhase('posing');
  }, 2000);
}

async function captureAndScore() {
  beep(300, 0.25, 'sawtooth', 0.12);

  const snap = mkCanvas(W, H);
  const sg = snap.getContext('2d');
  drawVideoFrame(sg);

  const det = Tracker.ready() ? Tracker.detect(video, true) : null;

  sg.drawImage(state.fillFrame, 0, 0);
  sg.drawImage(state.ringFrames[0], 0, 0);

  if (det && det.maskCanvas) {
    finishRound(computeScore(det.maskCanvas), snap, false);
  } else {
    finishRound(null, snap, true);
  }
}

function stampScore(snapCanvas, score) {
  const g = snapCanvas.getContext('2d');
  const fs = Math.round(H * 0.06);
  g.font = `bold ${fs}px "Comic Sans MS", "Chalkboard SE", cursive, sans-serif`;
  g.textAlign = 'right';
  g.lineWidth = Math.max(4, fs * 0.12);
  g.strokeStyle = 'rgba(0,0,0,0.8)';
  g.fillStyle = '#ffe14d';
  g.strokeText(`${score} pts`, W - fs * 0.4, H - fs * 0.5);
  g.fillText(`${score} pts`, W - fs * 0.4, H - fs * 0.5);
}

function finishRound(score, snapCanvas, selfJudge) {
  setPhase('result');
  els.resultOverlay.classList.remove('hidden');

  if (selfJudge) {
    els.resultScore.textContent = '🤔';
    els.resultVerdict.textContent = 'Auto-scoring unavailable — how did you do?';
    els.judgeButtons.classList.remove('hidden');
    els.nextBtn.classList.add('hidden');
  } else {
    const verdict = verdictFor(score);
    stampScore(snapCanvas, score);
    state.totalScore += score;
    els.resultScore.textContent = `${score} pts`;
    els.resultVerdict.textContent = verdict.text;
    els.judgeButtons.classList.add('hidden');
    els.nextBtn.classList.remove('hidden');
    playFanfare(verdict.good);
  }

  state.snapshotUrl = snapCanvas.toDataURL('image/png');
  els.snapshotImg.src = state.snapshotUrl;
  els.scoreLabel.textContent = `⭐ ${state.totalScore}`;
}

function selfJudgeScore(score) {
  state.totalScore += score;
  els.resultScore.textContent = `${score} pts`;
  els.resultVerdict.textContent = verdictFor(score).text;
  els.judgeButtons.classList.add('hidden');
  els.nextBtn.classList.remove('hidden');
  els.scoreLabel.textContent = `⭐ ${state.totalScore}`;
  playFanfare(score >= 60);
}

function advance() {
  state.round++;
  if (state.round >= state.poses.length) {
    showFinal();
  } else {
    nextRound();
  }
}

function rankFor(total, max) {
  const pct = total / max;
  if (pct >= 0.8) return '🏆 Outline Legend';
  if (pct >= 0.6) return '🥈 Shape Shifter';
  if (pct >= 0.4) return '🥉 Bendy Beginner';
  return '🧱 The Wall Won';
}

function showFinal() {
  setPhase('final');
  els.resultOverlay.classList.add('hidden');
  els.finalScore.textContent = `${state.totalScore} / ${state.poses.length * 100}`;
  els.finalRank.textContent = rankFor(state.totalScore, state.poses.length * 100);
  showScreen('final');
}

function showScreen(name) {
  els.startScreen.classList.toggle('hidden', name !== 'start');
  els.gameScreen.classList.toggle('hidden', name !== 'game');
  els.finalScreen.classList.toggle('hidden', name !== 'final');
}

// ---------------------------------------------------------------------------
// Wire-up
// ---------------------------------------------------------------------------

els.startBtn.addEventListener('click', startGame);
els.skipScan.addEventListener('click', skipScan);
els.nextBtn.addEventListener('click', advance);
els.againBtn.addEventListener('click', beginRounds);
els.rescanBtn.addEventListener('click', () => {
  if (!Tracker.ready()) {
    beginRounds();
    return;
  }
  showScreen('game');
  startScan();
});
els.saveBtn.addEventListener('click', () => {
  if (!state.snapshotUrl) return;
  const a = document.createElement('a');
  a.href = state.snapshotUrl;
  a.download = `outline-rush-round-${state.round + 1}.png`;
  a.click();
});
els.judgeButtons.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => selfJudgeScore(Number(btn.dataset.score)));
});
