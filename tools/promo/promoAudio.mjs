/**
 * tools/promo/promoAudio.mjs — the promo B-roll's sound cues, for tools/promo/promoSfx.py.
 *
 * For each clip of the cut (cut.mjs) the shot is loaded in the dev hold and sampled directly
 * (scene.frame, no rendering) at 120 Hz of output time through the clip's speed ramp: the camera,
 * every aircraft (position, velocity, nose direction, throttle, afterburner) and every weapon in
 * flight, and the shot's events (launches, gun rounds, flares, explosions, impacts) at their output
 * times. Written to .scratch/promo/audio/<clip>.json. Needs the dev server (npx vite --port 5199).
 *
 *   node tools/promo/promoAudio.mjs            # every clip
 *   ONLY=5,7 node tools/promo/promoAudio.mjs   # those clips (CUT indexes)
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUT, openShot, outT, sceneT } from './cut.mjs';

const URL0 = process.env.URL ?? 'http://localhost:5199/play/';
const RATE = 120;
const DIR = '.scratch/promo/audio';
mkdirSync(DIR, { recursive: true });

const only = process.env.ONLY ? process.env.ONLY.split(',').map(Number) : undefined;
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const queue = CUT.map((c, i) => [c, i]).filter(([, i]) => !only || only.includes(i));

async function cues(clip) {
  const p = await openShot(browser, URL0, clip.shot, 640, 360);
  const dur = clip.knots[clip.knots.length - 1][0];
  const n = Math.round(dur * RATE) + 1;
  // Shot time for every sample, and the playback rate there (shot s per output s: < 1 = slow motion).
  const ts = [];
  const rate = [];
  for (let i = 0; i < n; i++) {
    const t = sceneT(clip.knots, i / RATE);
    ts.push(t);
    rate.push((sceneT(clip.knots, i / RATE + 1e-3) - t) / 1e-3);
  }
  const data = await p.evaluate((ts) => {
    const scene = globalThis.__showcaseScene;
    const v = (a) => [a.x, a.y, a.z];
    const fwdOf = (q) => [1 - 2 * (q.y * q.y + q.z * q.z), 2 * (q.x * q.y + q.w * q.z), 2 * (q.x * q.z - q.w * q.y)];
    const frames = [];
    let events = [];
    for (const t of ts) {
      const fr = scene.frame(t);
      if (fr.events && events.length === 0) events = fr.events.map((e) => ({ t: e.t, ev: JSON.parse(JSON.stringify(e.ev)) }));
      frames.push({
        cam: v(fr.camPos),
        look: v(fr.lookAt),
        up: fr.up ? v(fr.up) : [0, 1, 0],
        ac: fr.aircraft.map((a) => ({ id: a.id, pos: v(a.pos), vel: v(a.vel), fwd: fwdOf(a.rot), thr: a.throttle, ab: a.afterburner ? 1 : 0, gear: a.gearPos, team: a.team ?? 0 })),
        st: (fr.stores ?? []).map((s) => ({ id: s.id, code: s.code, pos: v(s.pos), vel: v(s.vel) })),
      });
    }
    return { frames, events };
  }, ts);
  await p.close();
  const t0 = clip.knots[0][1];
  const t1 = clip.knots[clip.knots.length - 1][1];
  // Events at their output times (those before the clip only matter if their sound is still ringing: kept 3 s back).
  const events = data.events
    .filter((e) => e.t >= t0 - 3 && e.t <= t1)
    .map((e) => ({ out: e.t >= t0 ? outT(clip.knots, e.t) : (e.t - t0), shotT: e.t, ev: e.ev }));
  writeFileSync(join(DIR, `${clip.name}.json`), JSON.stringify({ name: clip.name, rate: RATE, dur, shotT: ts, playRate: rate, frames: data.frames, events }));
  console.log(`${clip.name}: ${n} samples, ${events.length} events`);
}

await Promise.all(Array.from({ length: 4 }, async () => {
  for (let it = queue.shift(); it; it = queue.shift()) await cues(it[0]);
}));
await browser.close();
