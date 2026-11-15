/**
 * tools/audio/genRadio.mjs — renders the radio clips (public/audio/radio/<id>.mp3) from the line
 * table src/script/radioLines.json, and the mission-intro narration (public/audio/briefing/<id>.mp3)
 * from src/briefing/lines.json: Microsoft's Indian English neural voice en-IN-PrabhatNeural
 * through edge-tts, then ffmpeg trims the silence at both ends and normalises the loudness. The
 * radio sound (band-pass, a little drive, squelch) is added in the game (src/script/radioPlayer.ts),
 * so the files stay clean. The narration is never put through the radio: it plays clean
 * (src/briefing/briefingAudio.ts).
 *
 *   node tools/audio/genRadio.mjs           # the clips not rendered yet
 *   FORCE=1 node tools/audio/genRadio.mjs   # all of them
 *   ONLY=duel_splash,n9 node tools/audio/genRadio.mjs
 *   ONLY=br_ska_01 FORCE=1 node tools/audio/genRadio.mjs
 *
 * Ids starting p_ are the player's own calls: the same voice, lower and quicker (the game plays
 * them through an oxygen-mask mic, the controller through the radio). Ids starting tw_ are the
 * Simikot tower controller, a Nepalese voice (ne-NP-SagarNeural reading the English lines). Ids
 * starting br_ are the intro narrator: the same voice slower and lower, with a little room left at
 * the end of each line.
 *
 * Needs edge-tts (pip install edge-tts) and ffmpeg on the PATH. For a public release, render the
 * same voice through Azure Speech (licensed output), or replace the narration with recordings
 * (public/audio/briefing/README.md).
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
/** The Simikot tower controller (ids tw_*): a second person on the radio, with a Nepali accent. */
const TOWER_VOICE = 'ne-NP-SagarNeural';
const TOWER = { rate: '+4%', pitch: '+0Hz' };
/** The intro narrator (ids br_*): slower and lower, unhurried. */
const NARRATOR = { rate: '-6%', pitch: '-12Hz' };
const TABLES = [
  { lines: 'src/script/radioLines.json', out: 'public/audio/radio' },
  { lines: 'src/briefing/lines.json', out: 'public/audio/briefing' },
];

const only = process.env.ONLY?.split(',');
const todo = [];
for (const t of TABLES) {
  const lines = JSON.parse(readFileSync(t.lines, 'utf8'));
  mkdirSync(t.out, { recursive: true });
  for (const [id, text] of Object.entries(lines)) {
    if (only ? only.includes(id) : process.env.FORCE || !existsSync(join(t.out, `${id}.mp3`))) todo.push({ id, text, out: t.out });
  }
}
const tmp = join(tmpdir(), `marut-radio-${process.pid}`);
mkdirSync(tmp, { recursive: true });

// Trim leading/trailing silence (the reverse trick trims the tail), normalise, mono 44.1 kHz.
const TRIM = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02';
const AF = `${TRIM},areverse,${TRIM},areverse,loudnorm=I=-16:TP=-1.5:LRA=7`;
// The narration: trimmed the same, a quarter second of air after it, and a little quieter.
const AF_NARRATOR = `${TRIM},areverse,${TRIM},areverse,apad=pad_dur=0.25,loudnorm=I=-18:TP=-1.5:LRA=9`;

async function one({ id, text, out }) {
  const raw = join(tmp, `${id}.mp3`);
  const narrator = id.startsWith('br_');
  for (let attempt = 0; ; attempt++) {
    try {
      const tower = id.startsWith('tw_');
      const v = narrator ? NARRATOR : id.startsWith('p_') ? PILOT : tower ? TOWER : CONTROLLER;
      await run('edge-tts', ['--voice', tower ? TOWER_VOICE : VOICE, `--rate=${v.rate}`, `--pitch=${v.pitch}`, '--text', text, '--write-media', raw]);
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-af', narrator ? AF_NARRATOR : AF, '-ac', '1', '-ar', '44100', '-b:a', narrator ? '96k' : '64k', join(out, `${id}.mp3`)]);
  console.log('ok', id);
}

const queue = [...todo];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (queue.length) await one(queue.shift());
  })
);
rmSync(tmp, { recursive: true, force: true });
console.log(`${todo.length} clip(s) rendered`);
