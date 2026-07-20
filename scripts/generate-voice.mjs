#!/usr/bin/env node
// Pre-generate an ElevenLabs voice pack for Outline Rush.
//
// Produces one MP3 per fixed phrase in assets/voice/, plus manifest.json that
// the game loads at runtime (js/game.js -> loadVoicePack / say). Dynamic lines
// like "78 points" are composed at runtime from number + word clips, so this
// script also generates number clips 0..150 and a handful of connective words.
//
// Your API key is read from the environment and NEVER written to disk or the
// manifest. The generated audio files are safe to commit.
//
// Usage:
//   ELEVENLABS_API_KEY=sk_...  ELEVENLABS_VOICE_ID=<voice_id> \
//     node scripts/generate-voice.mjs
//
//   # optional: --force re-render everything, --model <id>
//
// After it finishes, commit assets/voice/. The game auto-detects the pack and
// defaults to it (players need no key). Re-run whenever pose text changes.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'assets', 'voice');

const KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const FORCE = process.argv.includes('--force');
const MODEL = (() => {
  const i = process.argv.indexOf('--model');
  return i >= 0 ? process.argv[i + 1] : 'eleven_turbo_v2_5';
})();

if (!KEY || !VOICE_ID) {
  console.error('Set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID environment variables.');
  process.exit(1);
}

// ---- Must stay identical to voiceSlug() in js/game.js ----------------------
function voiceSlug(text) {
  const s = text.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}…—]/gu, '')
    .trim().toLowerCase().replace(/\s+/g, ' ').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'v' + (h >>> 0).toString(16).padStart(8, '0');
}

// ---- Load poses from the generated library ---------------------------------
const libSrc = readFileSync(join(ROOT, 'js', 'poses-library.js'), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(libSrc + ';this.POSES = POSES;', ctx);
const POSES = ctx.POSES;

// ---- Every phrase the game can speak (keep in sync with say() call sites) ---
// Comment lines mirror COMMENTS in js/game.js.
const COMMENT_LINES = [
  'ARE YOU LIQUID?!', 'Absolute shapeshifter!', 'The outline never stood a chance!',
  'PERFECT FIT!', "Chef's kiss geometry!", 'Outline? Demolished!',
  'Nice squeeze!', 'The outline is mildly impressed.', 'So close to greatness!',
  'Half of you made it…', 'Your left leg missed the memo.', 'A bold interpretation!',
  'The outline wins!', 'Were you even trying?!', 'That was… certainly a shape.',
  'My grandma fits better!',
];

const phrases = new Set();
const add = (t) => { if (t && String(t).trim()) phrases.add(String(t).trim()); };

// Pose announcements (also used verbatim in elimination).
for (const p of POSES) add(`${p.name}! ${p.tip}`);
// Score commentary.
COMMENT_LINES.forEach(add);
// Numbers 0..150 (scores can reach 100 x 1.5) + connective words.
for (let n = 0; n <= 150; n++) add(String(n));
['points', 'Survived!', 'Eliminated!', 'Bonus!', 'With bonus!', 'Beat your target!']
  .forEach(add);
// Difficulty picker.
['Easy!', 'Medium!', 'Hard!', '1.25 times bonus!', '1.5 times bonus!'].forEach(add);
// Scan / framing / flow.
[
  "Body scan time! I'll measure you so the outlines fit your body. " +
    'Stand back so I can see all of you, spread your arms wide, and hold still.',
  'Step closer!', 'Step back a bit!', 'Move to the middle!', 'Perfect! Hold still!',
  "Calibrated! Let's play!",
  'Reach a hand up to pick your difficulty! Medium and hard score bonus points.',
  'Elimination time! Beat the target score, or you are out!',
  'Game over!', 'Check out your photos!',
].forEach(add);

const list = [...phrases];
console.log(`${list.length} phrases to synthesize (voice ${VOICE_ID}, model ${MODEL}).`);

mkdirSync(OUT_DIR, { recursive: true });

const entries = {};
let made = 0, skipped = 0, failed = 0;

async function synth(text, attempt = 0) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: MODEL,
        voice_settings: { stability: 0.45, similarity_boost: 0.8 },
      }),
    });
  if (res.status === 429 && attempt < 5) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return synth(text, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return Buffer.from(await res.arrayBuffer());
}

for (const text of list) {
  const slug = voiceSlug(text);
  const file = `${slug}.mp3`;
  const path = join(OUT_DIR, file);
  entries[slug] = file;
  if (!FORCE && existsSync(path)) { skipped++; continue; }
  try {
    const buf = await synth(text);
    writeFileSync(path, buf);
    made++;
    if (made % 20 === 0) console.log(`  …${made} generated`);
    await new Promise((r) => setTimeout(r, 120)); // be gentle on the API
  } catch (e) {
    failed++;
    console.error(`  ✗ "${text.slice(0, 40)}": ${e.message}`);
  }
}

writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify({
  voiceId: VOICE_ID, model: MODEL, count: list.length, entries,
}, null, 0));

console.log(`Done. ${made} made, ${skipped} skipped, ${failed} failed.`);
console.log('Commit assets/voice/ to ship the pack. (Your API key was never written.)');
if (failed) process.exit(1);
