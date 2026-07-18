#!/usr/bin/env node
// Generates js/poses-library.js: 11 hand-made classics + 89 procedurally
// generated poses (deterministic seed, so re-running reproduces the library).
//
// Pose format (see js/skeleton.js): limb angles in degrees — 0 = down,
// 90 = straight out, 180 = up, >180 or negative = crossing inward.
// Only one leg is ever off the ground, and lean is capped while balancing.
//
//   node scripts/generate-poses.mjs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Deterministic RNG ------------------------------------------------------

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(20260717);
const R = (a, b) => a + rnd() * (b - a);
const RI = (a, b) => Math.round(R(a, b));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

// --- Hand-made classics -----------------------------------------------------

const CLASSICS = [
  { name: 'Star Jump', emoji: '⭐', tip: 'Arms up and out, legs wide!', difficulty: 1,
    arms: { L: [135, 140], R: [135, 140] }, legs: { L: [20, 22], R: [20, 22] } },
  { name: 'T-Pose', emoji: '✈️', tip: 'Arms straight out, feet together.', difficulty: 1,
    arms: { L: [90, 90], R: [90, 90] }, legs: { L: [4, 4], R: [4, 4] } },
  { name: 'Muscle Flex', emoji: '💪', tip: 'Flex both arms like a strongman!', difficulty: 1,
    arms: { L: [95, 205], R: [95, 205] }, legs: { L: [10, 10], R: [10, 10] } },
  { name: 'Disco Fever', emoji: '🕺', tip: 'Point to the sky, hand on hip!', difficulty: 2,
    arms: { L: [55, -35], R: [150, 155] }, legs: { L: [18, 20], R: [4, 4] } },
  { name: 'Invisible Chair', emoji: '🪑', tip: 'Squat like you are sitting, arms out!', difficulty: 2,
    arms: { L: [90, 90], R: [90, 90] }, legs: { L: [38, -12], R: [38, -12] } },
  { name: 'Flamingo', emoji: '🦩', tip: 'One leg tucked in, arms up in a V!', difficulty: 2,
    arms: { L: [140, 145], R: [140, 145] }, legs: { L: [2, 2], R: [62, -58] } },
  { name: 'The Egyptian', emoji: '🏺', tip: 'Arms in a zigzag — walk like an Egyptian!', difficulty: 2,
    arms: { L: [90, 170], R: [90, 10] }, legs: { L: [14, 15], R: [4, 4] } },
  { name: 'Teapot', emoji: '🫖', tip: 'Handle on the hip, spout out — and TIP!', difficulty: 2,
    arms: { L: [55, -35], R: [120, 55] }, legs: { L: [8, 8], R: [8, 8] }, lean: 12 },
  { name: 'Karate Crane', emoji: '🥋', tip: 'Hands high, knee up — hii-ya!', difficulty: 3,
    arms: { L: [155, 160], R: [155, 160] }, legs: { L: [3, 3], R: [85, 8] } },
  { name: 'Tipsy Tightrope', emoji: '🎪', tip: 'Cross those legs, arms out, don\'t fall!', difficulty: 3,
    arms: { L: [90, 90], R: [90, 90] }, legs: { L: [-14, -16], R: [-24, -26] }, lean: 7 },
  { name: 'Leaning Tower', emoji: '🗼', tip: 'Arms up, tilt over… don\'t topple!', difficulty: 3,
    arms: { L: [168, 170], R: [168, 170] }, legs: { L: [2, 2], R: [2, 2] }, lean: 14 },
];

// --- Archetypes -------------------------------------------------------------

const ARMS = [
  () => { const a = [RI(130, 160), RI(135, 165)]; return { L: a, R: a.slice(), tip: 'arms up in a V', d: 0 }; },
  () => { const a = [RI(88, 92), RI(88, 92)]; return { L: a, R: a.slice(), tip: 'arms straight out', d: 0 }; },
  () => { const a = [RI(88, 95), RI(162, 175)]; return { L: a, R: a.slice(), tip: 'goalpost arms', d: 0 }; },
  () => { const a = [RI(92, 100), RI(200, 215)]; return { L: a, R: a.slice(), tip: 'flex those biceps', d: 0 }; },
  () => { const a = [RI(50, 60), RI(-40, -30)]; return { L: a, R: a.slice(), tip: 'hands on hips', d: 0 }; },
  () => ({ L: [RI(50, 60), RI(-40, -30)], R: [RI(148, 158), RI(152, 165)], tip: 'point to the sky, hand on hip', d: 0.5 }),
  () => ({ L: [RI(88, 92), RI(165, 175)], R: [RI(88, 92), RI(5, 15)], tip: 'zigzag arms', d: 0.5 }),
  () => { const a = [RI(35, 50), RI(40, 55)]; return { L: a, R: a.slice(), tip: 'arms low and wide', d: 0 }; },
  () => { const a = [RI(168, 176), RI(170, 178)]; return { L: a, R: a.slice(), tip: 'reach for the stars', d: 0 }; },
  () => { const a = [RI(198, 212), RI(205, 220)]; return { L: a, R: a.slice(), tip: 'cross your arms overhead', d: 0.5 }; },
  () => ({ L: [RI(162, 170), RI(166, 174)], R: [RI(88, 92), RI(88, 92)], tip: 'one arm up, one out', d: 0.5 }),
  () => ({ L: [RI(105, 118), RI(108, 120)], R: [RI(60, 72), RI(62, 75)], tip: 'tilt your wings', d: 0.5 }),
  () => ({ L: [RI(88, 95), RI(200, 215)], R: [RI(148, 160), RI(152, 165)], tip: 'one flex, one sky-point', d: 0.5 }),
  () => { const a = [RI(178, 184), RI(179, 185)]; return { L: a, R: a.slice(), tip: 'palms together overhead like a prayer', d: 0 }; },
  () => ({ L: [RI(22, 30), RI(18, 26)], R: [RI(166, 172), RI(168, 175)], tip: 'one hand to the sky, one to the floor', d: 0.5 }),
  () => { const a = [RI(14, 22), RI(-18, -8)]; return { L: a, R: a.slice(), tip: 'hands down between your knees', d: 0 }; },
];

// Each leg archetype: angles, tip, difficulty score, and kind:
//   ground  — both feet planted
//   squat   — crouching, both feet planted
//   cross   — scissored stance
//   raised  — one foot off the ground (yoga balance!)
//   air     — BOTH feet off the ground; the outline floats and the player
//             has to time a jump for the snap. extreme sets the L7+ pool.
const LEGS = [
  { n: 6, gen: () => { const a = [RI(2, 6), RI(2, 6)]; return { L: a, R: a.slice(), tip: 'feet together', d: 0, kind: 'ground' }; } },
  { n: 6, gen: () => { const a = [RI(16, 26), RI(17, 27)]; return { L: a, R: a.slice(), tip: 'legs wide', d: 0, kind: 'ground' }; } },
  { n: 8, gen: () => ({ L: [RI(36, 44), RI(-22, -14)], R: [RI(12, 16), RI(10, 14)], tip: 'deep warrior lunge', d: 1, kind: 'ground' }) },
  { n: 8, gen: () => { const a = [RI(32, 44), RI(-18, -8)]; return { L: a, R: a.slice(), tip: 'squat down', d: 0.5, kind: 'squat' }; } },
  { n: 8, gen: () => { const a = [RI(48, 60), RI(-32, -18)]; return { L: a, R: a.slice(), tip: 'goddess squat, knees way out', d: 1, kind: 'squat' }; } },
  { n: 6, gen: () => { const a = [RI(58, 66), RI(-40, -28)]; return { L: a, R: a.slice(), tip: 'crouch right down like a frog', d: 1.5, kind: 'squat' }; } },
  { n: 7, gen: () => ({ L: [RI(-16, -12), RI(-18, -14)], R: [RI(-28, -22), RI(-30, -24)], tip: 'cross your legs', d: 1, kind: 'cross' }) },
  { n: 10, gen: () => ({ L: [RI(0, 4), RI(0, 4)], R: [RI(58, 68), RI(-62, -48)], tip: 'foot tucked to your knee', d: 1, kind: 'raised' }) },
  { n: 10, gen: () => ({ L: [RI(2, 5), RI(2, 5)], R: [RI(82, 95), RI(4, 14)], tip: 'knee up high', d: 1, kind: 'raised' }) },
  { n: 6, gen: () => ({ L: [RI(2, 6), RI(2, 6)], R: [RI(72, 88), RI(70, 88)], tip: 'kick a leg out to the side', d: 2, kind: 'raised', extreme: true }) },
  { n: 5, gen: () => ({ L: [RI(2, 5), RI(2, 5)], R: [RI(98, 112), RI(96, 112)], tip: 'kick your leg sky-high', d: 2.5, kind: 'raised', extreme: true }) },
  { n: 4, gen: () => ({ L: [RI(3, 6), RI(3, 6)], R: [RI(76, 86), RI(-30, -18)], tip: 'turn sideways, sprinter knee drive', d: 2, kind: 'raised', extreme: true }) },
  { n: 3, gen: () => { const a = [RI(52, 62), RI(-38, -26)]; return { L: a, R: a.slice(), tip: 'JUMP and tuck as the timer hits zero', d: 3, kind: 'air', extreme: true, air: R(0.05, 0.08) }; } },
  { n: 2, gen: () => { const a = [RI(24, 30), RI(26, 32)]; return { L: a, R: a.slice(), tip: 'JUMP into a star as the timer hits zero', d: 3, kind: 'air', extreme: true, air: R(0.06, 0.09) }; } },
];

// --- Names ------------------------------------------------------------------

const ADJECTIVES = [
  'Sleepy', 'Wonky', 'Haunted', 'Spicy', 'Tipsy', 'Cosmic', 'Electric',
  'Majestic', 'Sneaky', 'Wobbly', 'Funky', 'Grumpy', 'Turbo', 'Mystic',
  'Disco', 'Royal', 'Angry', 'Confused', 'Slippery', 'Dramatic', 'Heroic',
  'Lazy', 'Chaotic', 'Spooky', 'Glorious', 'Awkward', 'Legendary', 'Bendy',
  'Crispy', 'Suspicious', 'Galactic', 'Feral',
];

const NOUNS = [
  ['Flamingo', '🦩'], ['Pretzel', '🥨'], ['Cactus', '🌵'], ['Scarecrow', '🎃'],
  ['Ostrich', '🪶'], ['Kettle', '☕'], ['Windmill', '🌀'], ['Starfish', '⭐'],
  ['Crab', '🦀'], ['Broccoli', '🥦'], ['Goose', '🪿'], ['Ninja', '🥷'],
  ['Pirate', '🏴‍☠️'], ['Wizard', '🧙'], ['Robot', '🤖'], ['Banana', '🍌'],
  ['Noodle', '🍜'], ['Giraffe', '🦒'], ['Lobster', '🦞'], ['Penguin', '🐧'],
  ['Toad', '🐸'], ['Gremlin', '👹'], ['Yeti', '❄️'], ['Mantis', '🦗'],
  ['Heron', '🐦'], ['Tornado', '🌪️'], ['Jellyfish', '🪼'], ['Meerkat', '🐿️'],
  ['Llama', '🦙'], ['Sasquatch', '🦶'], ['Disco Ball', '🪩'], ['Traffic Cone', '🚧'],
];

// --- Generation -------------------------------------------------------------

const mirror = (side) => ({ L: side.R, R: side.L });
const usedNames = new Set(CLASSICS.map((p) => p.name));
const usedSignatures = new Set();

function signature(pose) {
  const q = (a) => a.map((v) => Math.round(v / 8)).join(',');
  return [q(pose.arms.L), q(pose.arms.R), q(pose.legs.L), q(pose.legs.R),
    Math.round((pose.lean || 0) / 4), pose.air ? 'air' : ''].join('|');
}

function makeName() {
  for (let i = 0; i < 100; i++) {
    const adj = pick(ADJECTIVES);
    const [noun, emoji] = pick(NOUNS);
    const name = `The ${adj} ${noun}`;
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return { name, emoji };
    }
  }
  throw new Error('name bank exhausted');
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const generated = [];

for (const { n, gen } of LEGS) {
  for (let i = 0; i < n; i++) {
    for (let attempt = 0; attempt < 50; attempt++) {
      let legs = gen();
      const legTip = legs.tip;
      const legD = legs.d;
      const kind = legs.kind;
      const extreme = !!legs.extreme;
      const air = legs.air;
      if ((kind === 'raised' || legs.L.join() !== legs.R.join()) && rnd() < 0.5) {
        legs = mirror(legs);
      }

      const armSpec = pick(ARMS)();
      const armTip = armSpec.tip;
      const armD = armSpec.d;
      let arms = { L: armSpec.L, R: armSpec.R };
      if (rnd() < 0.5 && arms.L.join() !== arms.R.join()) arms = mirror(arms);

      // Lean: capped while balancing, forbidden on the extreme tiers.
      let lean = 0;
      let leanD = 0;
      if (rnd() < 0.35 && legD < 2 && !extreme) {
        const cap = kind === 'raised' ? 8 : kind === 'squat' ? 10 : 15;
        lean = Math.round(R(6, cap)) * (rnd() < 0.5 ? -1 : 1);
        leanD = Math.abs(lean) > 10 ? 1 : 0.5;
      }

      // Awkwardness ladder: one foot off the ground is never difficulty 1,
      // and extreme poses (side kicks, splits, sprinter, airborne) are max.
      let difficulty = Math.round(1 + armD + legD + leanD);
      if (kind === 'raised') difficulty = Math.max(difficulty, 2);
      if (extreme) difficulty = 3;
      difficulty = Math.max(1, Math.min(3, difficulty));

      const pose = {
        arms: { L: arms.L, R: arms.R },
        legs: { L: legs.L, R: legs.R },
      };
      if (lean) pose.lean = lean;
      if (air) pose.air = Math.round(air * 100) / 100;
      if (extreme) pose.extreme = true;

      const sig = signature(pose);
      if (usedSignatures.has(sig)) continue;
      usedSignatures.add(sig);

      const { name, emoji } = makeName();
      let tip = `${capitalize(legTip)}, ${armTip}!`;
      if (lean) tip = tip.replace('!', `, and lean ${lean > 0 ? 'right' : 'left'}!`);
      generated.push({ name, emoji, tip, difficulty, ...pose });
      break;
    }
  }
}

const all = [...CLASSICS, ...generated];
if (all.length !== 100) throw new Error(`expected 100 poses, got ${all.length}`);

const counts = { 1: 0, 2: 0, 3: 0 };
let raised = 0;
let extreme = 0;
let air = 0;
for (const p of all) {
  counts[p.difficulty]++;
  const flat = [...p.legs.L, ...p.legs.R];
  if (flat.some((a) => a >= 55) || p.air) raised++;
  if (p.extreme) extreme++;
  if (p.air) air++;
}
console.log(`100 poses: difficulty 1/2/3 = ${counts[1]}/${counts[2]}/${counts[3]}, ` +
  `legs-off-ground = ${raised}, extreme = ${extreme}, airborne = ${air}`);

// --- Emit -------------------------------------------------------------------

const lines = all.map((p) => '  ' + JSON.stringify(p)
  .replace(/"([a-zA-Z]+)":/g, '$1: ')
  .replace(/,(?=\S)/g, ', ') + ',');

const out = `// 100-pose library for Outline Rush — 11 hand-made classics followed by
// procedurally generated poses. DO NOT EDIT BY HAND: regenerate with
//   node scripts/generate-poses.mjs
// Angles per skeleton.js: 0 = down, 90 = out, 180 = up, negative/>180 = inward.

const POSES = [
${lines.join('\n')}
];
`;

const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'poses-library.js');
writeFileSync(dest, out);
console.log(`wrote ${dest}`);
