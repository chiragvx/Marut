/**
 * tools/audio/genRadio.mjs — renders the radio clips (public/audio/radio/<id>.mp3) from the line
 * table src/script/radioLines.json: Microsoft's Indian English neural voice en-IN-PrabhatNeural
 * through edge-tts, then ffmpeg trims the silence at both ends and normalises the loudness. The
 * radio sound (band-pass, a little drive, squelch) is added in the game (src/script/radioPlayer.ts),
 * so the files stay clean.
 *
 *   node tools/audio/genRadio.mjs           # the clips not rendered yet
 *   FORCE=1 node tools/audio/genRadio.mjs   # all of them
 *   ONLY=duel_splash,n9 node tools/audio/genRadio.mjs
 *
 * Ids starting p_ are the player's own calls: the same voice, lower and quicker (the game plays
 * them through an oxygen-mask mic, the controller through the radio).
 *
 * Needs edge-tts (pip install edge-tts) and ffmpeg on the PATH. For a public release, render the
 * same voice through Azure Speech (licensed output).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const VOICE = 'en-IN-PrabhatNeural';
/** The controller; the pilot's own calls (ids p_*) the same voice lower and quicker, so the two differ. */
const CONTROLLER = { rate: '+8%', pitch: '+0Hz' };
const PILOT = { rate: '+16%', pitch: '-14Hz' };
const OUT = 'public/audio/radio';
const lines = JSON.parse(readFileSync('src/script/radioLines.json', 'utf8'));
mkdirSync(OUT, { recursive: true });

const only = process.env.ONLY?.split(',');
const todo = Object.entries(lines).filter(([id]) => (only ? only.includes(id) : process.env.FORCE || !existsSync(join(OUT, `${id}.mp3`))));
const tmp = join(tmpdir(), `marut-radio-${process.pid}`);
mkdirSync(tmp, { recursive: true });

// Trim leading/trailing silence (the reverse trick trims the tail), normalise, mono 44.1 kHz.
const TRIM = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02';
const AF = `${TRIM},areverse,${TRIM},areverse,loudnorm=I=-16:TP=-1.5:LRA=7`;

async function one([id, text]) {
  const raw = join(tmp, `${id}.mp3`);
  for (let attempt = 0; ; attempt++) {
    try {
      const v = id.startsWith('p_') ? PILOT : CONTROLLER;
      await run('edge-tts', ['--voice', VOICE, `--rate=${v.rate}`, `--pitch=${v.pitch}`, '--text', text, '--write-media', raw]);
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-af', AF, '-ac', '1', '-ar', '44100', '-b:a', '64k', join(OUT, `${id}.mp3`)]);
  console.log('ok', id);
}

const queue = [...todo];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (queue.length) await one(queue.shift());
  })
);
rmSync(tmp, { recursive: true, force: true });
console.log(`${todo.length} clip(s) rendered to ${OUT}`);
