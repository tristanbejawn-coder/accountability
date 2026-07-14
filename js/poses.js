// Pose definitions for Outline Rush.
//
// Coordinates are relative: `x` is the offset from the horizontal centre of
// the canvas and `y` is the offset from the top, both expressed as fractions
// of the canvas HEIGHT so bodies keep their proportions at any canvas size.

const BODY = {
  headRadius: 0.062,
  torsoWidth: 0.17,
  armWidth: 0.062,
  legWidth: 0.08,
};

// Shared joints for an upright body; poses override what they need.
const BASE_JOINTS = {
  head: { x: 0, y: 0.145 },
  neck: { x: 0, y: 0.225 },
  pelvis: { x: 0, y: 0.55 },
  shoulderL: { x: -0.075, y: 0.245 },
  shoulderR: { x: 0.075, y: 0.245 },
  hipL: { x: -0.05, y: 0.56 },
  hipR: { x: 0.05, y: 0.56 },
};

function pose(name, emoji, tip, joints) {
  return { name, emoji, tip, joints: Object.assign({}, BASE_JOINTS, joints) };
}

const POSES = [
  pose('Star Jump', '⭐', 'Arms up and out, legs wide!', {
    elbowL: { x: -0.185, y: 0.135 }, wristL: { x: -0.295, y: 0.035 },
    elbowR: { x: 0.185, y: 0.135 }, wristR: { x: 0.295, y: 0.035 },
    kneeL: { x: -0.125, y: 0.74 }, ankleL: { x: -0.2, y: 0.91 },
    kneeR: { x: 0.125, y: 0.74 }, ankleR: { x: 0.2, y: 0.91 },
  }),

  pose('T-Pose', '✈️', 'Arms straight out, feet together.', {
    elbowL: { x: -0.215, y: 0.245 }, wristL: { x: -0.36, y: 0.245 },
    elbowR: { x: 0.215, y: 0.245 }, wristR: { x: 0.36, y: 0.245 },
    kneeL: { x: -0.045, y: 0.745 }, ankleL: { x: -0.045, y: 0.925 },
    kneeR: { x: 0.045, y: 0.745 }, ankleR: { x: 0.045, y: 0.925 },
  }),

  pose('Muscle Flex', '💪', 'Flex both arms like a strongman!', {
    elbowL: { x: -0.2, y: 0.27 }, wristL: { x: -0.215, y: 0.115 },
    elbowR: { x: 0.2, y: 0.27 }, wristR: { x: 0.215, y: 0.115 },
    kneeL: { x: -0.07, y: 0.745 }, ankleL: { x: -0.08, y: 0.925 },
    kneeR: { x: 0.07, y: 0.745 }, ankleR: { x: 0.08, y: 0.925 },
  }),

  pose('Disco Fever', '🕺', 'Point to the sky, hand on hip!', {
    elbowR: { x: 0.155, y: 0.13 }, wristR: { x: 0.245, y: 0.02 },
    elbowL: { x: -0.17, y: 0.38 }, wristL: { x: -0.06, y: 0.49 },
    kneeL: { x: -0.09, y: 0.74 }, ankleL: { x: -0.12, y: 0.92 },
    kneeR: { x: 0.03, y: 0.745 }, ankleR: { x: 0.03, y: 0.925 },
  }),

  pose('Flamingo', '🦩', 'Stand on one leg, foot tucked in, arms up!', {
    elbowL: { x: -0.14, y: 0.13 }, wristL: { x: -0.19, y: 0.025 },
    elbowR: { x: 0.14, y: 0.13 }, wristR: { x: 0.19, y: 0.025 },
    kneeL: { x: -0.03, y: 0.75 }, ankleL: { x: -0.03, y: 0.93 },
    kneeR: { x: 0.13, y: 0.63 }, ankleR: { x: 0.015, y: 0.6 },
  }),

  pose('Invisible Chair', '🪑', 'Squat like you are sitting, arms out!', {
    pelvis: { x: 0, y: 0.62 },
    hipL: { x: -0.06, y: 0.63 }, hipR: { x: 0.06, y: 0.63 },
    elbowL: { x: -0.215, y: 0.25 }, wristL: { x: -0.36, y: 0.25 },
    elbowR: { x: 0.215, y: 0.25 }, wristR: { x: 0.36, y: 0.25 },
    kneeL: { x: -0.16, y: 0.72 }, ankleL: { x: -0.15, y: 0.92 },
    kneeR: { x: 0.16, y: 0.72 }, ankleR: { x: 0.15, y: 0.92 },
  }),
];

// Draws the pose as a filled silhouette (head + capsule limbs) onto ctx.
// `jitter` nudges every joint a little so cycling variants gives the outline
// a hand-drawn wobble.
function drawPoseSilhouette(ctx, p, W, H, jitter = 0) {
  const cx = W / 2;
  const J = {};
  for (const [k, v] of Object.entries(p.joints)) {
    J[k] = {
      x: cx + (v.x + (Math.random() - 0.5) * jitter) * H,
      y: (v.y + (Math.random() - 0.5) * jitter) * H,
    };
  }

  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const capsule = (a, b, w) => {
    ctx.lineWidth = w * H;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  };

  ctx.beginPath();
  ctx.arc(J.head.x, J.head.y, BODY.headRadius * H, 0, Math.PI * 2);
  ctx.fill();

  capsule(J.neck, J.pelvis, BODY.torsoWidth);
  capsule(J.shoulderL, J.elbowL, BODY.armWidth);
  capsule(J.elbowL, J.wristL, BODY.armWidth);
  capsule(J.shoulderR, J.elbowR, BODY.armWidth);
  capsule(J.elbowR, J.wristR, BODY.armWidth);
  capsule(J.hipL, J.kneeL, BODY.legWidth);
  capsule(J.kneeL, J.ankleL, BODY.legWidth);
  capsule(J.hipR, J.kneeR, BODY.legWidth);
  capsule(J.kneeR, J.ankleR, BODY.legWidth);
}
