/**
 * tools/promo/capturePromo.mjs — renders the promotional B-roll (src/ui/promo.ts) to video, no UI.
 *
 * Needs the dev server (npx vite --port 5199), Playwright and ffmpeg on the PATH. Each clip of the
 * cut (CUT below) is a promo shot played through the menu cinematic's dev hold (?showcase=p<shot>,<t>):
 * the page is loaded once per clip, the shot is stepped from its start (so its events, the launches,
 * flares and hits, play in order), and frames are taken at 60 fps through a speed ramp mapping
 * output time to the shot's time (shallow = slow motion). Frames are piped as JPEGs straight into
 * ffmpeg (no files), blended in pairs to 30 fps (a little motion blur) and encoded per clip
 * (H.264, 1920x1080, near-lossless); WORKERS clips render at once; then they're joined as one cut.
 *
 *   node tools/promo/capturePromo.mjs             # render every clip + encode
 *   PREVIEW=1 SHOTS=3,8 node tools/promo/capturePromo.mjs   # contact sheets (.scratch/promo/preview-*.jpg)
 *   ONLY=2,5 node tools/promo/capturePromo.mjs    # re-render those clips (CUT indexes), re-join
 *   ENCODE=1 node tools/promo/capturePromo.mjs    # only re-join the clips into the cut
 */
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const URL0 = process.env.URL ?? 'http://localhost:5199/play/';
const W = Number(process.env.W ?? 1920);
const H = Number(process.env.H ?? 1080);
const FPS = 60;
const WORK = '.scratch/promo';
const OUT = process.env.OUT ?? 'promo';

/** The cut: [name, shot, knots [output s, shot s]] (linear between knots; the clip ends at the last). */
export const CUT = [
  { name: '01-scramble', shot: 0, knots: [[0, 0.2], [3.2, 2.4], [5.2, 6.5]] },
  { name: '02-weapons-close', shot: 1, knots: [[0, 0], [6, 8]] },
  { name: '03-strike-close', shot: 2, knots: [[0, 0], [5, 7]] },
  { name: '04-afterburner', shot: 11, knots: [[0, 0], [4.5, 5]] },
  { name: '05-off-the-rail', shot: 4, knots: [[0, 0.5], [0.5, 0.95], [2.4, 1.6], [3.0, 2.6]] },
  { name: '06-fox-two', shot: 3, knots: [[0, 0.6], [2.0, 2.6], [3.6, 3.4], [5.0, 6.0]] },
  { name: '07-astra', shot: 5, knots: [[0, 0.6], [1.2, 1.2], [2.6, 1.9], [4.4, 4.2]] },
  { name: '08-guns', shot: 6, knots: [[0, 0.4], [4.4, 4.8]] },
  { name: '09-guns-night', shot: 7, knots: [[0, 0.5], [4.2, 4.7]] },
  { name: '10-bombs-release', shot: 8, knots: [[0, 1.0], [1.0, 1.5], [2.4, 1.9], [4.8, 4.6]] },
  { name: '11-bombs-impact', shot: 9, knots: [[0, 1.2], [1.8, 3.0], [4.6, 8.4], [6.8, 11.6]] },
  { name: '12-flares', shot: 10, knots: [[0, 0.5], [6, 6.8]] },
  { name: '13-transonic', shot: 12, knots: [[0, 1.85], [0.8, 2.2], [2.4, 2.6], [3.4, 3.4]] },
];

const sceneT = (knots, u) => {
  for (let i = 1; i < knots.length; i++) {
    const [a0, b0] = knots[i - 1];
    const [a1, b1] = knots[i];
    if (u <= a1) return b0 + ((b1 - b0) * (u - a0)) / (a1 - a0);
  }
  return knots[knots.length - 1][1];
};

async function openShot(browser, shot, w, h) {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.addInitScript(() => localStorage.setItem('tejas.settings.v1', JSON.stringify({ qualityTierOverride: 'high', version: 1 })));
  await p.goto(`${URL0}?showcase=p${shot},0`);
  await p.waitForSelector('[data-action="free-flight"]', { timeout: 90000 });
  // No UI at all: only the 3D view (and the fade, kept clear).
  await p.addStyleTag({ content: '#ui-root > *{display:none!important} .tj-fade{display:none!important}' });
  await p.waitForTimeout(7000);
  return p;
}

async function setT(p, t) {
  await p.evaluate((tt) => new Promise((res) => {
    globalThis.__showcaseT = tt;
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res)));
  }), t);
}

/** Steps the shot from 0 to t (its events and effects play in order on the way). */
async function preroll(p, t) {
  await setT(p, 0);
  for (let s = 0; s < t; s += 1 / 30) await setT(p, s);
}

const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
mkdirSync(WORK, { recursive: true });

if (process.env.PREVIEW) {
  const shots = process.env.SHOTS ? process.env.SHOTS.split(',').map(Number) : [...new Set(CUT.map((c) => c.shot))];
  for (const shot of shots) {
    const clip = CUT.find((c) => c.shot === shot);
    const t0 = clip.knots[0][1];
    const t1 = clip.knots[clip.knots.length - 1][1];
    const p = await openShot(browser, shot, 960, 540);
    await preroll(p, t0);
    let k = 0;
    for (let t = t0; t <= t1 + 1e-6; t += 1 / 30) {
      await setT(p, t);
      const want = t0 + ((t1 - t0) * k) / 5;
      if (k <= 5 && t >= want - 1e-6) {
        await p.screenshot({ path: join(WORK, `pv-${shot}-${k}.jpg`), type: 'jpeg', quality: 85 });
        k++;
      }
    }
    await p.close();
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(WORK, `pv-${shot}-%d.jpg`), '-vf', 'tile=3x2', '-frames:v', '1', join(WORK, `preview-${shot}.jpg`)]);
    console.log('preview', shot);
  }
  await browser.close();
  process.exit(0);
}

const only = process.env.ONLY ? process.env.ONLY.split(',').map(Number) : undefined;
mkdirSync(OUT, { recursive: true });
const grade = 'tmix=frames=2,fps=30,eq=contrast=1.05:saturation=1.1,colorbalance=rh=0.02:bh=-0.02';

/** Renders a clip straight to MP4: each frame is grabbed as a JPEG in memory and piped into ffmpeg. */
async function renderClip(clip) {
  const out = join(OUT, `${clip.name}.mp4`);
  const dur = clip.knots[clip.knots.length - 1][0];
  const n = Math.round(dur * FPS);
  const p = await openShot(browser, clip.shot, W, H);
  await preroll(p, clip.knots[0][1]);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', '-', '-vf', `${grade},format=yuv420p`, '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg ${clip.name} exited ${c}`)))));
  for (let i = 0; i < n; i++) {
    await setT(p, sceneT(clip.knots, i / FPS));
    const buf = await p.screenshot({ type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await done;
  await p.close();
  console.log(`${clip.name} (shot ${clip.shot}): ${n} frames -> ${out}`);
}

// Clips render on WORKERS pages at once.
const queue = process.env.ENCODE ? [] : CUT.filter((_, ci) => !only || only.includes(ci));
const worker = async () => {
  for (let clip = queue.shift(); clip; clip = queue.shift()) await renderClip(clip);
};
await Promise.all(Array.from({ length: Number(process.env.WORKERS ?? 4) }, worker));
await browser.close();

// The whole cut, in order.
const list = [];
for (const clip of CUT) {
  const out = join(OUT, `${clip.name}.mp4`);
  if (!existsSync(out)) {
    console.log('missing', clip.name);
    continue;
  }
  list.push(`file '${resolve(out).replace(/\\/g, '/')}'`);
}
writeFileSync(join(WORK, 'list.txt'), list.join('\n'));
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(WORK, 'list.txt'), '-c', 'copy', join(OUT, 'promo-broll-cut.mp4')], { stdio: 'inherit' });
console.log('cut', join(OUT, 'promo-broll-cut.mp4'));
