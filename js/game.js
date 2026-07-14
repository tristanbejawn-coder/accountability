// Outline Rush — fit yourself inside the doodle outline before time runs out.

const W = 960;
const H = 720;
const ROUND_SECONDS = [6, 5, 5, 4, 4, 3];

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
canvas.width = W;
canvas.height = H;

const video = document.createElement('video');
video.playsInline = true;
video.muted = true;

const els = {
  startScreen: document.getElementById('start-screen'),
  gameScreen: document.getElementById('game-screen'),
  finalScreen: document.getElementById('final-screen'),
  resultOverlay: document.getElementById('result-overlay'),
  startBtn: document.getElementById('start-btn'),
  nextBtn: document.getElementById('next-btn'),
  againBtn: document.getElementById('again-btn'),
  saveBtn: document.getElementById('save-btn'),
  judgeButtons: document.getElementById('judge-buttons'),
  roundLabel: document.getElementById('round-label'),
  poseLabel: document.getElementById('pose-label'),
  scoreLabel: document.getElementById('score-label'),
  resultScore: document.getElementById('result-score'),
  resultVerdict: document.getElementById('result-verdict'),
  snapshotImg: document.getElementById('snapshot-img'),
  finalScore: document.getElementById('final-score'),
  finalRank: document.getElementById('final-rank'),
  startError: document.getElementById('start-error'),
};

const state = {
  phase: 'idle', // idle | getready | posing | scoring | result | final
  round: 0,
  poses: [],
  totalScore: 0,
  deadline: 0,
  lastTick: -1,
  ringFrames: [],
  fillFrame: null,
  targetMask: null,
  snapshotUrl: null,
};

// ---------------------------------------------------------------------------
// Audio — tiny WebAudio blips, created on first user gesture.
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

// ---------------------------------------------------------------------------
// Segmentation (MediaPipe Selfie Segmentation, loaded from CDN in index.html).
// Falls back to self-judged scoring when unavailable.
// ---------------------------------------------------------------------------

let segmenter = null;
let segReady = false;

function initSegmenter() {
  if (typeof SelfieSegmentation === 'undefined') return;
  try {
    segmenter = new SelfieSegmentation({
      locateFile: (f) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${f}`,
    });
    segmenter.setOptions({ modelSelection: 1 });
  } catch (e) {
    segmenter = null;
  }
}

// Runs segmentation on `image` and resolves with the person mask, or null.
function segmentFrame(image) {
  if (!segmenter) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 8000);
    segmenter.onResults((results) => {
      clearTimeout(timeout);
      resolve(results.segmentationMask || null);
    });
    segmenter.send({ image }).catch(() => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

// Warm the model up in the background so round 1 scoring is fast.
async function warmUpSegmenter() {
  const dummy = document.createElement('canvas');
  dummy.width = 64;
  dummy.height = 48;
  dummy.getContext('2d').fillRect(0, 0, 64, 48);
  const mask = await segmentFrame(dummy);
  segReady = mask !== null;
}

// ---------------------------------------------------------------------------
// Outline rendering — silhouette mask -> wobbly contour ring.
// ---------------------------------------------------------------------------

function buildMaskCanvas(p, jitter) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  drawPoseSilhouette(c.getContext('2d'), p, W, H, jitter);
  return c;
}

// Turns a filled silhouette into just its contour: dilate the mask in white,
// then punch the original silhouette back out, leaving a ring.
function buildRingCanvas(mask, thickness) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    g.drawImage(mask, Math.cos(a) * thickness, Math.sin(a) * thickness);
  }
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(mask, 0, 0);
  return c;
}

function prepareRoundArt(p) {
  state.targetMask = buildMaskCanvas(p, 0);
  // Three jittered variants cycled over time = animated hand-drawn wobble.
  state.ringFrames = [0, 1, 2].map(() =>
    buildRingCanvas(buildMaskCanvas(p, 0.012), 6));
  const fill = document.createElement('canvas');
  fill.width = W;
  fill.height = H;
  const g = fill.getContext('2d');
  g.drawImage(state.targetMask, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = 'rgba(255, 255, 255, 0.14)';
  g.fillRect(0, 0, W, H);
  state.fillFrame = fill;
}

// ---------------------------------------------------------------------------
// Scoring — compare the player's segmentation mask with the target outline.
// ---------------------------------------------------------------------------

const SCORE_W = 160;
const SCORE_H = 120;

function toScoreData(source) {
  const c = document.createElement('canvas');
  c.width = SCORE_W;
  c.height = SCORE_H;
  const g = c.getContext('2d');
  g.drawImage(source, 0, 0, SCORE_W, SCORE_H);
  return g.getImageData(0, 0, SCORE_W, SCORE_H).data;
}

function computeScore(personMask) {
  const target = toScoreData(state.targetMask);
  const person = toScoreData(personMask);
  let tCount = 0;
  let pCount = 0;
  let both = 0;
  for (let i = 0; i < target.length; i += 4) {
    // Target silhouette is opaque black -> use alpha; person mask is
    // white-on-black -> use the red channel.
    const t = target[i + 3] > 128;
    const p = person[i] > 128;
    if (t) tCount++;
    if (p) pCount++;
    if (t && p) both++;
  }
  if (!pCount || !tCount) return 0;
  const coverage = both / tCount;  // how much of the outline you filled
  const precision = both / pCount; // how much of you stayed inside
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

// Draws the current video frame mirrored and cover-fitted onto ctx.
function drawVideoFrame(g) {
  const vw = video.videoWidth || W;
  const vh = video.videoHeight || H;
  const scale = Math.max(W / vw, H / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  g.save();
  g.translate(W, 0);
  g.scale(-1, 1); // selfie mirror
  g.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
  g.restore();
}

function render(now) {
  ctx.clearRect(0, 0, W, H);
  if (video.readyState >= 2) drawVideoFrame(ctx);

  if (state.phase === 'posing' || state.phase === 'getready') {
    if (state.fillFrame) ctx.drawImage(state.fillFrame, 0, 0);
    if (state.ringFrames.length) {
      const frame = state.ringFrames[Math.floor(now / 160) % state.ringFrames.length];
      ctx.drawImage(frame, 0, 0);
    }
  }

  if (state.phase === 'getready') {
    drawBigText('GET READY!', '#ffe14d');
  } else if (state.phase === 'posing') {
    const remaining = Math.max(0, state.deadline - now);
    const secs = Math.ceil(remaining / 1000);
    if (secs !== state.lastTick) {
      state.lastTick = secs;
      if (secs > 0) beep(secs <= 1 ? 1320 : 880, 0.09);
    }
    drawBigText(String(secs), remaining < 1500 ? '#ff5c5c' : '#ffffff');
    if (remaining <= 0) {
      state.phase = 'scoring';
      captureAndScore();
    }
  } else if (state.phase === 'scoring') {
    drawBigText('📸', '#ffffff');
  }

  requestAnimationFrame(render);
}

function drawBigText(text, color) {
  ctx.save();
  ctx.font = 'bold 110px "Comic Sans MS", "Chalkboard SE", cursive, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.fillStyle = color;
  ctx.strokeText(text, W / 2, 18);
  ctx.fillText(text, W / 2, 18);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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

  initSegmenter();
  warmUpSegmenter(); // fire and forget

  state.poses = shuffled(POSES);
  state.round = 0;
  state.totalScore = 0;
  showScreen('game');
  requestAnimationFrame(render);
  nextRound();
}

function nextRound() {
  els.resultOverlay.classList.add('hidden');
  const p = state.poses[state.round];
  prepareRoundArt(p);
  els.roundLabel.textContent = `Round ${state.round + 1} / ${state.poses.length}`;
  els.poseLabel.textContent = `${p.emoji} ${p.name} — ${p.tip}`;
  els.scoreLabel.textContent = `Score: ${state.totalScore}`;

  state.phase = 'getready';
  setTimeout(() => {
    state.lastTick = -1;
    state.deadline = performance.now() + ROUND_SECONDS[state.round % ROUND_SECONDS.length] * 1000;
    state.phase = 'posing';
  }, 2000);
}

async function captureAndScore() {
  beep(300, 0.25, 'sawtooth', 0.12); // shutter-ish buzz

  // Freeze the mirrored frame exactly as the player saw it.
  const snap = document.createElement('canvas');
  snap.width = W;
  snap.height = H;
  const sg = snap.getContext('2d');
  drawVideoFrame(sg);

  const personMask = await segmentFrame(snap);

  sg.drawImage(state.fillFrame, 0, 0);
  sg.drawImage(state.ringFrames[0], 0, 0);

  if (personMask) {
    const score = computeScore(personMask);
    finishRound(score, snap, false);
  } else {
    // Model unavailable: let the player judge themselves.
    finishRound(null, snap, true);
  }
}

function stampScore(snapCanvas, score) {
  const g = snapCanvas.getContext('2d');
  g.font = 'bold 64px "Comic Sans MS", "Chalkboard SE", cursive, sans-serif';
  g.textAlign = 'right';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(0,0,0,0.8)';
  g.fillStyle = '#ffe14d';
  g.strokeText(`${score} pts`, W - 24, H - 30);
  g.fillText(`${score} pts`, W - 24, H - 30);
}

function finishRound(score, snapCanvas, selfJudge) {
  state.phase = 'result';
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
  els.scoreLabel.textContent = `Score: ${state.totalScore}`;
}

function selfJudgeScore(score) {
  state.totalScore += score;
  els.resultScore.textContent = `${score} pts`;
  els.resultVerdict.textContent = verdictFor(score).text;
  els.judgeButtons.classList.add('hidden');
  els.nextBtn.classList.remove('hidden');
  els.scoreLabel.textContent = `Score: ${state.totalScore}`;
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
  state.phase = 'final';
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
els.nextBtn.addEventListener('click', advance);
els.againBtn.addEventListener('click', () => {
  els.startBtn.disabled = false;
  state.poses = shuffled(POSES);
  state.round = 0;
  state.totalScore = 0;
  showScreen('game');
  nextRound();
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
