// Calibrated skeleton model: body measurement from pose landmarks, forward
// kinematics, and silhouette drawing. Canvas-space pixels unless noted.

const LM = {
  NOSE: 0, EAR_L: 7, EAR_R: 8,
  SHOULDER_L: 11, SHOULDER_R: 12, ELBOW_L: 13, ELBOW_R: 14,
  WRIST_L: 15, WRIST_R: 16, HIP_L: 23, HIP_R: 24,
  KNEE_L: 25, KNEE_R: 26, ANKLE_L: 27, ANKLE_R: 28,
};

const SCAN_LANDMARKS = [
  LM.NOSE, LM.SHOULDER_L, LM.SHOULDER_R, LM.ELBOW_L, LM.ELBOW_R,
  LM.WRIST_L, LM.WRIST_R, LM.HIP_L, LM.HIP_R,
  LM.KNEE_L, LM.KNEE_R, LM.ANKLE_L, LM.ANKLE_R,
];

// Canonical proportions as fractions of person height, used when no scan is
// available (and for the scan-pose ghost before anyone is measured).
const CANON = {
  shoulderHalf: 0.105, hipHalf: 0.075, torsoLen: 0.30,
  upperArm: 0.16, foreArm: 0.15, thigh: 0.24, shin: 0.22,
  headR: 0.066, neckToHead: 0.115,
};

const CALIB_LENGTH_KEYS = Object.keys(CANON).concat(['personH']);

function defaultCalib(W, H) {
  const personH = H * 0.78;
  const c = { scanned: false, personH, anchorX: W / 2, feetY: H * 0.94 };
  for (const [k, v] of Object.entries(CANON)) c[k] = v * personH;
  return c;
}

// Measure the player from normalized landmarks. Returns a calibration in
// UNMIRRORED VIDEO PIXELS (calibToCanvas converts per-frame).
function measureBody(lms, vw, vh) {
  const P = (i) => ({ x: lms[i].x * vw, y: lms[i].y * vh });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const shL = P(LM.SHOULDER_L), shR = P(LM.SHOULDER_R);
  const hipL = P(LM.HIP_L), hipR = P(LM.HIP_R);
  const midShoulder = mid(shL, shR);
  const midHip = mid(hipL, hipR);

  const earL = P(LM.EAR_L), earR = P(LM.EAR_R);
  const earsVisible =
    lms[LM.EAR_L].visibility > 0.5 && lms[LM.EAR_R].visibility > 0.5;
  const headC = earsVisible ? mid(earL, earR) : P(LM.NOSE);

  const avgSide = (li, ri) => (dist(P(li[0]), P(li[1])) + dist(P(ri[0]), P(ri[1]))) / 2;
  const upperArm = avgSide([LM.SHOULDER_L, LM.ELBOW_L], [LM.SHOULDER_R, LM.ELBOW_R]);
  const foreArm = avgSide([LM.ELBOW_L, LM.WRIST_L], [LM.ELBOW_R, LM.WRIST_R]);
  const thigh = avgSide([LM.HIP_L, LM.KNEE_L], [LM.HIP_R, LM.KNEE_R]);
  const shin = avgSide([LM.KNEE_L, LM.ANKLE_L], [LM.KNEE_R, LM.ANKLE_R]);

  const maxAnkleY = Math.max(P(LM.ANKLE_L).y, P(LM.ANKLE_R).y);
  const shoulderHalf = dist(shL, shR) / 2;
  const headR = Math.max(earsVisible ? dist(earL, earR) * 0.75 : 0, shoulderHalf * 0.55);
  const rawH = maxAnkleY - (headC.y - headR);
  const footPad = rawH * 0.05;
  const personH = rawH + footPad;

  return {
    scanned: true, vw, vh,
    personH,
    anchorX: midHip.x,
    feetY: maxAnkleY + footPad,
    shoulderHalf,
    hipHalf: dist(hipL, hipR) / 2,
    torsoLen: dist(midShoulder, midHip),
    upperArm, foreArm, thigh, shin, headR,
    neckToHead: Math.max(dist(midShoulder, headC), headR * 1.2),
  };
}

// Video-pixel calibration -> canvas space under the mirrored cover-crop the
// game uses to display the camera.
function calibToCanvas(vc, video, W, H) {
  const vw = video.videoWidth || vc.vw;
  const vh = video.videoHeight || vc.vh;
  const s = Math.max(W / vw, H / vh);
  const dx = (W - vw * s) / 2;
  const dy = (H - vh * s) / 2;
  const out = { scanned: true };
  for (const k of CALIB_LENGTH_KEYS) out[k] = vc[k] * s;
  out.anchorX = W - (dx + vc.anchorX * s);
  out.feetY = Math.min(dy + vc.feetY * s, H * 0.99);
  return out;
}

// Limb direction: 0deg = straight down, 90deg = straight out to the side,
// 180deg = straight up. `side` is -1 for the left limb, +1 for the right.
function limbDir(side, deg) {
  const r = (deg * Math.PI) / 180;
  return { x: side * Math.sin(r), y: Math.cos(r) };
}

// Forward kinematics: pose angles + calibrated segment lengths -> joint
// positions, grounded so the lowest sole sits on the calibrated feet line.
function buildJoints(c, pose, jitter = 0) {
  const J = {};
  const reach = (p, len, side, deg) => {
    const d = limbDir(side, deg);
    return { x: p.x + len * d.x, y: p.y + len * d.y };
  };

  J.midHip = { x: 0, y: 0 };
  J.midShoulder = { x: 0, y: -c.torsoLen };
  J.head = { x: 0, y: J.midShoulder.y - c.neckToHead };
  J.shoulderL = { x: -c.shoulderHalf, y: J.midShoulder.y };
  J.shoulderR = { x: c.shoulderHalf, y: J.midShoulder.y };
  J.hipL = { x: -c.hipHalf, y: 0 };
  J.hipR = { x: c.hipHalf, y: 0 };

  J.elbowL = reach(J.shoulderL, c.upperArm, -1, pose.arms.L[0]);
  J.wristL = reach(J.elbowL, c.foreArm, -1, pose.arms.L[1]);
  J.elbowR = reach(J.shoulderR, c.upperArm, 1, pose.arms.R[0]);
  J.wristR = reach(J.elbowR, c.foreArm, 1, pose.arms.R[1]);
  J.kneeL = reach(J.hipL, c.thigh, -1, pose.legs.L[0]);
  J.ankleL = reach(J.kneeL, c.shin, -1, pose.legs.L[1]);
  J.kneeR = reach(J.hipR, c.thigh, 1, pose.legs.R[0]);
  J.ankleR = reach(J.kneeR, c.shin, 1, pose.legs.R[1]);

  const lowestSole = Math.max(J.ankleL.y, J.ankleR.y) + c.personH * 0.04;
  const ox = c.anchorX;
  const oy = c.feetY - lowestSole;
  for (const k in J) {
    J[k].x += ox + (jitter ? (Math.random() - 0.5) * jitter * c.personH : 0);
    J[k].y += oy + (jitter ? (Math.random() - 0.5) * jitter * c.personH : 0);
  }
  return J;
}

function drawSilhouette(ctx, J, c) {
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const cap = (a, b, w) => {
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  };

  const armW = c.personH * 0.085;
  const legW = c.personH * 0.105;

  ctx.beginPath();
  ctx.arc(J.head.x, J.head.y, c.headR * 1.15, 0, Math.PI * 2);
  ctx.fill();

  cap(J.head, J.midShoulder, c.headR);
  cap(J.midShoulder, J.midHip, c.shoulderHalf * 2.1);
  cap(J.shoulderL, J.shoulderR, armW);
  cap(J.hipL, J.hipR, legW);
  cap(J.shoulderL, J.elbowL, armW);
  cap(J.elbowL, J.wristL, armW);
  cap(J.shoulderR, J.elbowR, armW);
  cap(J.elbowR, J.wristR, armW);
  cap(J.hipL, J.kneeL, legW);
  cap(J.kneeL, J.ankleL, legW);
  cap(J.hipR, J.kneeR, legW);
  cap(J.kneeR, J.ankleR, legW);
}

// The calibration pose the scanner asks for and validates against.
const SCAN_POSE = {
  arms: { L: [115, 118], R: [115, 118] },
  legs: { L: [14, 15], R: [14, 15] },
};

// Is the player roughly in the scan pose (arms out wide and raised, standing)?
function isScanPose(lms, vw, vh) {
  for (const i of SCAN_LANDMARKS) {
    if (!lms[i] || (lms[i].visibility ?? 1) < 0.5) return false;
  }
  const P = (i) => ({ x: lms[i].x * vw, y: lms[i].y * vh });
  const shL = P(LM.SHOULDER_L), shR = P(LM.SHOULDER_R);
  const midX = (shL.x + shR.x) / 2;
  const shoulderHalf = Math.hypot(shL.x - shR.x, shL.y - shR.y) / 2;
  const midHipY = (P(LM.HIP_L).y + P(LM.HIP_R).y) / 2;
  const torsoLen = midHipY - (shL.y + shR.y) / 2;

  for (const side of [[LM.WRIST_L, LM.HIP_L, LM.KNEE_L, LM.ANKLE_L],
                      [LM.WRIST_R, LM.HIP_R, LM.KNEE_R, LM.ANKLE_R]]) {
    const [wi, hi, ki, ai] = side;
    const wrist = P(wi), hip = P(hi), knee = P(ki), ankle = P(ai);
    // Arm extended well out from the body and raised above the waist.
    if (Math.abs(wrist.x - midX) < shoulderHalf * 2.4) return false;
    if (wrist.y > midHipY - torsoLen * 0.45) return false;
    // Standing upright.
    if (!(ankle.y > knee.y && knee.y > hip.y)) return false;
  }
  return true;
}
