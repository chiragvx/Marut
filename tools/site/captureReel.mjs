/**
 * tools/site/captureReel.mjs — renders the landing page's hero reel (src/site/media/reel-*.{webm,mp4}).
 *
 * Needs the dev server (npx vite --port 5199), Playwright and ffmpeg on the PATH. Each clip of the
 * cut (CUT below) is a reel shot (src/ui/reel.ts) played through the menu cinematic's dev hold
 * (?showcase=r<shot>,<t>): the page is loaded once per clip, then stepped frame by frame at 60 fps
 * by setting globalThis.__showcaseT, with a speed ramp mapping output time to the shot's time. The
 * frames are blended in pairs to 30 fps (a little motion blur) and encoded twice: VP9 WebM and H.264
 * MP4, at 1600x900 and 960x540.
 *
 *   node tools/site/captureReel.mjs            # render + encode
 *   PREVIEW=1 node tools/site/captureReel.mjs  # a contact sheet of every shot (.scratch/reel/preview-*.jpg)
 *   ONLY=2 node tools/site/captureReel.mjs     # re-render clip 2 only, then re-encode
 *   ENCODE=1 node tools/site/captureReel.mjs   # re-encode the frames already rendered
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const URL0 = process.env.URL ?? 'http://localhost:5199/play/';
const W = 1600;
const H = 900;
const FPS = 60;
const OUT = 'src/site/media';
const WORK = '.scratch/reel';

/**
 * The cut: shot index and the speed ramp as [output s, shot s] knots (linear between; the clip lasts
 * until the last knot). Shallow slopes are slow motion, steep ones fast.
 */
const CUT = [
  { shot: 0, knots: [[0, 0.9], [0.55, 1.75], [1.25, 2.1], [1.7, 2.9]] }, // blast: overhead, slow-mo at the pass
  { shot: 1, knots: [[0, 0.3], [0.5, 0.75], [1.5, 1.6], [2.0, 2.4]] }, // aileron roll
  { shot: 2, knots: [[0, 0.1], [0.6, 0.65], [1.6, 1.35], [2.3, 2.9]] }, // break turn, rolling camera
  { shot: 5, knots: [[0, 11.2], [1.6, 13.4]] }, // night afterburner take-off
  { shot: 3, knots: [[0, 0], [2.0, 2.6]] }, // vertical roll
  { shot: 4, knots: [[0, 0.4], [0.7, 1.0], [1.7, 1.6], [2.3, 2.8]] }, // pair, wingman breaks
  { shot: 7, knots: [[0, 3.0], [1.6, 4.6]] }, // air-to-air, close
  { shot: 6, knots: [[0, 5.6], [0.8, 6.6], [1.3, 7.0], [2.6, 9.6]] }, // low pass and pull-up
];

const sceneT = (knots, u) => {
  for (let i = 1; i < knots.length; i++) {
    const [a0, b0] = knots[i - 1];
    const [a1, b1] = knots[i];
    if (u <= a1) return b0 + ((b1 - b0) * (u - a0)) / (a1 - a0);
  }
  return knots[knots.length - 1][1];
};

async function openShot(browser, shot, t, w, h) {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  p.on('pageerror', (e) => console.log('pageerror', e.message));
  await p.addInitScript(() => localStorage.setItem('tejas.settings.v1', JSON.stringify({ qualityTierOverride: 'high', version: 1 })));
  await p.goto(`${URL0}?showcase=r${shot},${t}`);
  await p.waitForSelector('[data-action="free-flight"]', { timeout: 90000 });
  await p.addStyleTag({ content: '#ui-root > :not(.tj-fade){display:none!important}' });
  await p.waitForTimeout(6000);
  return p;
}

async function setT(p, t) {
  await p.evaluate((tt) => new Promise((res) => {
    globalThis.__showcaseT = tt;
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res)));
  }), t);
}

const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
mkdirSync(WORK, { recursive: true });

if (process.env.PREVIEW) {
  const shots = process.env.SHOTS ? process.env.SHOTS.split(',').map(Number) : [...new Set(CUT.map((c) => c.shot))];
  for (const shot of shots) {
    const clip = CUT.find((c) => c.shot === shot);
    const t0 = clip.knots[0][1];
    const t1 = clip.knots[clip.knots.length - 1][1];
    const p = await openShot(browser, shot, t0, 800, 450);
    for (let i = 0; i < 6; i++) {
      const t = t0 + ((t1 - t0) * i) / 5;
      await setT(p, t);
      await p.waitForTimeout(250);
      await p.screenshot({ path: join(WORK, `pv-${shot}-${i}.jpg`), type: 'jpeg', quality: 85 });
    }
    await p.close();
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(WORK, `pv-${shot}-%d.jpg`), '-vf', 'tile=3x2', '-frames:v', '1', join(WORK, `preview-${shot}.jpg`)]);
    console.log('preview', shot);
  }
  await browser.close();
  process.exit(0);
}

const only = process.env.ONLY !== undefined ? Number(process.env.ONLY) : undefined;
for (const [ci, clip] of CUT.entries()) {
  if (process.env.ENCODE || (only !== undefined && only !== ci)) continue;
  const dir = join(WORK, `clip-${ci}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const dur = clip.knots[clip.knots.length - 1][0];
  const n = Math.round(dur * FPS);
  const p = await openShot(browser, clip.shot, clip.knots[0][1], W, H);
  for (let i = 0; i < n; i++) {
    await setT(p, sceneT(clip.knots, i / FPS));
    await p.screenshot({ path: join(dir, `${String(i).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 94 });
  }
  await p.close();
  console.log(`clip ${ci} (shot ${clip.shot}): ${n} frames`);
}
await browser.close();

// One numbered sequence across the clips, in order.
const seq = join(WORK, 'seq');
rmSync(seq, { recursive: true, force: true });
mkdirSync(seq);
let k = 0;
for (let ci = 0; ci < CUT.length; ci++) {
  const dir = join(WORK, `clip-${ci}`);
  if (!existsSync(dir)) throw new Error(`missing ${dir}: render it first`);
  for (const f of readdirSync(dir).sort()) renameSync(join(dir, f), join(seq, `${String(k++).padStart(5, '0')}.jpg`)) ;
}
// Put the frames back where they came from afterwards (so ONLY= re-renders keep the rest).
const restore = () => {
  let j = 0;
  for (let ci = 0; ci < CUT.length; ci++) {
    const dir = join(WORK, `clip-${ci}`);
    const n = Math.round(CUT[ci].knots[CUT[ci].knots.length - 1][0] * FPS);
    for (let i = 0; i < n; i++) renameSync(join(seq, `${String(j++).padStart(5, '0')}.jpg`), join(dir, `${String(i).padStart(4, '0')}.jpg`));
  }
};

try {
  // Pairs of 60 fps frames blended to 30 fps; a slight grade (contrast, warmth).
  const grade = 'tmix=frames=2,fps=30,eq=contrast=1.06:saturation=1.08,colorbalance=rh=0.03:bh=-0.03';
  const input = ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(seq, '%05d.jpg')];
  for (const [w, h, crf, br] of [[1600, 900, 36, '1.5M'], [960, 540, 38, '0.7M']]) {
    const vf = `${grade},scale=${w}:${h}:flags=lanczos`;
    execFileSync('ffmpeg', [...input, '-vf', vf, '-an', '-c:v', 'libvpx-vp9', '-b:v', br, '-crf', String(crf), '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', join(OUT, `reel-${h}.webm`)], { stdio: 'inherit' });
    execFileSync('ffmpeg', [...input, '-vf', `${vf},format=yuv420p`, '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf - 12), '-maxrate', br, '-bufsize', '3M', '-movflags', '+faststart', join(OUT, `reel-${h}.mp4`)], { stdio: 'inherit' });
  }
  console.log('encoded', readdirSync(OUT).filter((f) => f.startsWith('reel-')).join(' '));
} finally {
  restore();
}
