/**
 * src/briefing/intro.ts — plays a mission intro (a BriefingScript) over the loading mission: the
 * war room (room.ts) with the relief map on its table (tableMap.ts), the camera moves, the cards,
 * the typed subtitles, the narration and the room's sound (briefingAudio.ts).
 *
 * Its own small WebGL canvas over everything, at a reduced resolution on a slow PC (the mission is
 * loading underneath: src/main.ts draws its world less often while the intro covers it). Until the
 * mission has loaded there is nothing to skip to; once it has, Esc / Enter / Space / a tap skips.
 * At the end the picture holds and a Continue prompt shows (or straight on, if loading is done and
 * the player skipped).
 */
import * as THREE from 'three';
import type { QualityTier } from '../contracts/core';
import type { AudioBus } from '../ui/audio/audioBus';
import { createBriefingAudio, type BriefingAudio } from './briefingAudio';
import { roomY, TABLE_TOP_Y, type MapGrid } from './mapData';
import { createRoom } from './room';
import { scriptLineIds, type BriefingBeat, type BriefingScript, type CameraPose, type Ease } from './script';
import { createTableMap } from './tableMap';

export interface BriefingIntro {
  /** The mission's loading progress, 0..1, with what it is doing. */
  setProgress(fraction: number, label: string): void;
  /** The mission has loaded: skipping is allowed, and Continue calls `onContinue` (once). */
  setReady(onContinue: () => void): void;
  /** True while the intro covers the screen (main.ts draws the world less often then). */
  covering(): boolean;
  destroy(): void;
}

export interface BriefingIntroOptions {
  tier: QualityTier;
  /** Narration and room sound; absent: silent (subtitles only). */
  audio?: { bus: AudioBus; baseUrl: string };
  /** The height grid (the worker's), or a promise of it. */
  grid: Promise<MapGrid>;
  /** Dev hold: show this moment, frozen (no sound). */
  holdAtSec?: number;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const ease = (e: Ease | undefined, v: number): number => {
  const x = clamp01(v);
  if (e === 'linear') return x;
  if (e === 'out') return 1 - (1 - x) * (1 - x) * (1 - x);
  return x * x * (3 - 2 * x);
};
const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;
/** Characters a second the subtitles type at. */
const TYPE_CPS = 42;
/** A subtitle stays this long past the next line's start at most, s; it clears this long after its own typing ends if no line follows. */
const SUB_HOLD_SEC = 3.2;

/** Starts loading the table map's grid in a worker; resolves with it (or a synchronous fallback). */
export function loadBriefingGrid(): Promise<MapGrid> {
  return new Promise<MapGrid>((resolve, reject) => {
    try {
      const w = new Worker(new URL('./map.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<MapGrid>) => {
        resolve(e.data);
        w.terminate();
      };
      w.onerror = (err) => {
        w.terminate();
        reject(err);
      };
      w.postMessage({});
    } catch (err) {
      reject(err);
    }
  }).catch(async () => {
    const [{ buildMapGrid }, { heightAt, waterLevelAt }] = await Promise.all([import('./mapData'), import('../terrain/himalaya/height')]);
    return buildMapGrid(heightAt, waterLevelAt, 128);
  });
}

let gridCache: Promise<MapGrid> | undefined;
/** The grid, built once a session (the briefing screen starts it so it is ready by Start). */
export function briefingGrid(): Promise<MapGrid> {
  return (gridCache ??= loadBriefingGrid());
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createBriefingIntro(host: HTMLElement, script: BriefingScript, opts: BriefingIntroOptions): BriefingIntro {
  const hold = opts.holdAtSec;
  // --- DOM: canvas, film grain and vignette, bars, cards, stamp, subtitles, status, Continue. ---
  const root = el('div', 'tj-brief');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Mission briefing');
  const canvas = el('canvas', 'tj-brief-canvas');
  const grain = el('div', 'tj-brief-grain');
  const vignette = el('div', 'tj-brief-vignette');
  const barTop = el('div', 'tj-brief-bar tj-brief-bar--top');
  const barBottom = el('div', 'tj-brief-bar tj-brief-bar--bottom');
  const fade = el('div', 'tj-brief-fade');
  const card = el('div', 'tj-brief-card');
  const stamp = el('div', 'tj-brief-stamp');
  const sub = el('p', 'tj-brief-sub');
  sub.setAttribute('aria-live', 'polite');
  const status = el('div', 'tj-brief-status');
  const statusBar = el('span', 'tj-brief-status-bar');
  const statusText = el('span', 'tj-brief-status-text', 'Loading mission…');
  const statusBarWrap = el('span', 'tj-brief-status-track');
  statusBarWrap.append(statusBar);
  status.append(statusText, statusBarWrap);
  const skip = el('button', 'tj-brief-skip', 'Skip ›');
  skip.type = 'button';
  skip.hidden = true;
  const cont = el('button', 'tj-brief-continue', 'Continue');
  cont.type = 'button';
  cont.hidden = true;
  // The fade from black sits under the cards: the opening card shows over black.
  root.append(canvas, vignette, grain, barTop, barBottom, fade, card, stamp, sub, status, skip, cont);
  host.append(root);

  // --- three.js ---
  const scale = opts.tier === 'low' ? 0.6 : opts.tier === 'medium' ? 0.8 : 1;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: opts.tier !== 'low', powerPreference: 'default', alpha: false });
  renderer.setClearColor(0x020304, 1);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x030405, 0.075);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.02, 40);
  const room = createRoom();
  scene.add(room.group);
  const map = createTableMap(script);
  scene.add(map.group);
  let gridIn = false;
  void opts.grid.then((g) => {
    if (disposed) return;
    map.setGrid(g);
    gridIn = true;
  });

  let w = 1, h = 1;
  const resize = (): void => {
    w = Math.max(1, host.clientWidth || window.innerWidth);
    h = Math.max(1, host.clientHeight || window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25) * scale);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Letterbox on a wide screen only (a phone held upright needs the height).
    const bar = w / h > 1.5 ? Math.max(0, (h - w / 2.35) / 2) : 0;
    barTop.style.height = barBottom.style.height = `${Math.round(bar)}px`;
  };
  resize();
  window.addEventListener('resize', resize);

  // --- The camera, from the shot beats. ---
  const shots = script.beats.filter((b): b is Extract<BriefingBeat, { kind: 'shot' }> => b.kind === 'shot');
  const lookA = new THREE.Vector3(), lookB = new THREE.Vector3(), look = new THREE.Vector3();
  const lookPoint = (p: CameraPose, out: THREE.Vector3): THREE.Vector3 => {
    if (p.look === 'table') return out.set(0, TABLE_TOP_Y + (p.lift ?? 0), 0.15);
    return map.surface(p.look, p.lift ?? 0, out);
  };
  function placeCamera(t: number): void {
    let s = shots[0]!;
    for (const x of shots) if (x.t <= t) s = x;
    const f = ease(s.ease, (t - s.t) / s.dur);
    lookPoint(s.from, lookA);
    lookPoint(s.to, lookB);
    look.lerpVectors(lookA, lookB, f);
    // Push-ins feel even when the distance changes by a lot: interpolate it on a log scale.
    let dist = Math.exp(lerp(Math.log(s.from.dist), Math.log(s.to.dist), f));
    let az = lerp(s.from.az, s.to.az, f);
    let elev = lerp(s.from.el, s.to.el, f);
    const fov = lerp(s.from.fov ?? 40, s.to.fov ?? 40, f);
    // A held camera breathes a little.
    az += Math.sin(t * 0.31) * 0.35 + Math.sin(t * 0.83) * 0.12;
    elev += Math.sin(t * 0.27 + 1) * 0.25;
    // A narrow (upright) screen: stand back so the frame still holds the subject's width.
    const aspect = w / h;
    if (aspect < 1.45) dist *= Math.pow(1.45 / aspect, 0.8);
    const azr = (az * Math.PI) / 180, er = (elev * Math.PI) / 180;
    camera.position.set(look.x + Math.sin(azr) * Math.cos(er) * dist, look.y + Math.sin(er) * dist, look.z - Math.cos(azr) * Math.cos(er) * dist);
    // Never inside the table or the relief.
    camera.position.y = Math.max(camera.position.y, TABLE_TOP_Y + 0.05, roomY(0) + 0.02);
    camera.fov = fov;
    camera.near = Math.max(0.004, dist * 0.05);
    camera.updateProjectionMatrix();
    camera.lookAt(look);
  }

  // --- Overlays from the beats (all functions of t). ---
  const cards = script.beats.filter((b): b is Extract<BriefingBeat, { kind: 'card' }> => b.kind === 'card');
  const stamps = script.beats.filter((b): b is Extract<BriefingBeat, { kind: 'stamp' }> => b.kind === 'stamp');
  const lines = script.beats.filter((b): b is Extract<BriefingBeat, { kind: 'line' }> => b.kind === 'line');
  let cardKey = '';
  let stampKey = '';
  let subKey = '';
  function overlays(t: number): void {
    // Card.
    const c = cards.filter((x) => t >= x.t && t < x.t + x.dur).pop();
    const ck = c ? `${c.t}` : '';
    if (ck !== cardKey) {
      cardKey = ck;
      card.replaceChildren();
      card.className = `tj-brief-card${c ? ` tj-brief-card--${c.style}` : ''}`;
      if (c) {
        c.lines.forEach((line, i) => card.append(el('div', `tj-brief-card-line tj-brief-card-line--${i}`, line)));
      }
    }
    if (c) {
      const k = t - c.t;
      const a = Math.min(clamp01(k / 0.5), clamp01((c.t + c.dur - t) / 0.6));
      card.style.opacity = String(a);
      card.style.setProperty('--tj-brief-reveal', String(clamp01(k / 0.9)));
    } else card.style.opacity = '0';
    // Stamp: typed in, line by line.
    const st = stamps.filter((x) => t >= x.t && t < x.t + x.dur).pop();
    if (st) {
      const k = t - st.t;
      const full = st.lines.join('\n');
      const n = Math.floor(k * 30);
      const key = `${st.t}:${Math.min(n, full.length)}`;
      if (key !== stampKey) {
        stampKey = key;
        stamp.textContent = full.slice(0, n) + (n < full.length && Math.floor(k * 4) % 2 === 0 ? '▍' : '');
      }
      stamp.style.opacity = String(clamp01((st.t + st.dur - t) / 0.8));
    } else if (stampKey !== '') {
      stampKey = '';
      stamp.textContent = '';
    }
    // Subtitle: the latest line, typed out; cleared after it has had time to be read.
    const li = lines.filter((x) => x.t <= t).pop();
    if (li) {
      const next = lines[lines.indexOf(li) + 1];
      const typedEnd = li.t + li.subtitle.length / TYPE_CPS;
      const clearAt = next ? Math.min(next.t, typedEnd + 8) : typedEnd + SUB_HOLD_SEC + 2;
      const n = Math.floor((t - li.t) * TYPE_CPS);
      const shown = t < clearAt ? li.subtitle.slice(0, n) : '';
      const key = `${li.t}:${shown.length}`;
      if (key !== subKey) {
        subKey = key;
        sub.textContent = shown;
      }
    } else if (subKey !== '') {
      subKey = '';
      sub.textContent = '';
    }
    // In from black, and the last line's fade.
    fade.style.opacity = String(Math.max(1 - clamp01(t / 1.8), 0));
  }

  // --- Sound: lines, pins' ticks and stings as the clock passes them. ---
  const audio: BriefingAudio | undefined = opts.audio && hold === undefined ? createBriefingAudio(opts.audio.bus, opts.audio.baseUrl) : undefined;
  audio?.preload(scriptLineIds(script));
  audio?.start();
  let lastT = -1;
  function sounds(t: number): void {
    if (!audio) return;
    for (const b of script.beats) {
      if (!(b.t > lastT && b.t <= t)) continue;
      if (b.kind === 'line') audio.line(b.id, t - b.t);
      else if (b.kind === 'sting') audio.sting();
      else if (b.kind === 'pin') audio.tick();
    }
  }

  // --- Clock, loading, skip, Continue. ---
  let t = hold ?? 0;
  let ready = false;
  let finished = false;
  let disposed = false;
  let onContinue: (() => void) | undefined;
  let continued = false;
  const labelScaleFor = (): number => {
    // About 3.6% of the screen's height, capped on a narrow screen so a long name fits.
    const fovK = 1 / Math.tan(((camera.fov * Math.PI) / 180) / 2);
    const base = (0.036 * 2) / fovK;
    const aspect = w / h;
    return aspect < 1 ? base * Math.max(0.55, aspect * 1.1) : base;
  };
  const go = (): void => {
    if (continued || !ready || !onContinue) return;
    continued = true;
    audio?.stop(0.5);
    root.classList.add('tj-brief--out');
    const cb = onContinue;
    setTimeout(cb, 380);
  };
  const skipNow = (): void => {
    if (!ready) return;
    go();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (disposed) return;
    if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
      // Ours: the game under the intro never sees these (the release starts the flight, so a
      // held Enter is not also the C-17's drop key).
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'keyup') {
        if (finished) go();
        else skipNow();
      }
    }
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  canvas.addEventListener('pointerup', () => (finished ? go() : skipNow()));
  skip.addEventListener('click', skipNow);
  cont.addEventListener('click', go);

  let raf = 0;
  let last = performance.now();
  /** On a slow PC, ~30 frames a second is plenty for slow camera moves (and leaves the loading time). */
  const minFrameMs = opts.tier === 'low' ? 30 : 0;
  let lastDraw = 0;
  const frame = (now: number): void => {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (now - lastDraw < minFrameMs) return;
    lastDraw = now;
    const devT = (globalThis as { __briefingT?: number }).__briefingT;
    if (devT !== undefined) t = devT;
    // The opening (black, the first card) runs at once; the map shots wait for the map's grid.
    else if (hold === undefined && (gridIn || t < 1.2)) t += dt;
    if (!finished && t >= script.durationSec) {
      finished = true;
      if (ready) cont.hidden = false;
      skip.hidden = true;
    }
    sounds(t);
    lastT = t;
    placeCamera(t);
    room.update(t, dt);
    map.update(t, labelScaleFor());
    overlays(t);
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(frame);

  return {
    setProgress(fraction, label) {
      const f = clamp01(fraction);
      statusBar.style.width = `${Math.round(f * 100)}%`;
      statusText.textContent = label;
    },
    setReady(cb) {
      ready = true;
      onContinue = cb;
      status.classList.add('tj-brief-status--ready');
      statusText.textContent = 'Ready';
      statusBar.style.width = '100%';
      if (finished) cont.hidden = false;
      else skip.hidden = false;
    },
    covering: () => !disposed && !continued,
    destroy() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      audio?.stop(0.3);
      map.dispose();
      room.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      root.remove();
    },
  };
}

