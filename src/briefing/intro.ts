/**
 * src/briefing/intro.ts — plays a mission intro (a BriefingScript) over the loading mission: the
 * war room (room.ts) with the relief map on its table (tableMap.ts), the camera moves and the
 * transitions between them (a dip to black, a soft dark wipe), the cards, the subtitles, the
 * narration and the room's sound (briefingAudio.ts).
 *
 * The look is kept quiet: one accent colour (the UI's amber), thin rules, a light sans for titles
 * and a mono for data, nothing boxed; text fades in and out (no typewriter). The subtitles show a
 * sentence or two at a time: a narration recording's own cues, or a line clip's words paced to
 * its length.
 *
 * Sound: a score (if the script has one) from the start, ducked under the voice and faded out at
 * the end, all live (gain automation, the files raw); the narration as one recording or a clip a
 * line. While a narration recording plays the clock follows it, so the pictures stay on the words.
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
import { briefingSubtitle, scriptClips, type BriefingBeat, type BriefingScript, type CameraPose, type Ease } from './script';
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
  // Out: a quartic settle (no jolt at the start: it begins where the cut left it).
  if (e === 'out') return 1 - Math.pow(1 - x, 4);
  // In-out: smootherstep (zero speed and acceleration at both ends).
  return x * x * x * (x * (6 * x - 15) + 10);
};
const smooth = (v: number): number => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};
const lerp = (a: number, b: number, f: number): number => a + (b - a) * f;
/** A transition between two shots lasts this long, the cut in its middle, s. */
const TRANSITION_SEC = 1.3;
/** Subtitles: a chunk fades in over this, s; the last stays this long after the voice ends. */
const SUB_FADE_SEC = 0.35;
const SUB_HOLD_SEC = 1.6;
/** A chunk of subtitle at most this long (characters): a sentence or two, two lines on a phone. */
const SUB_CHUNK_CHARS = 96;
/** Narration pace when the recording's length is not known (no audio, or still loading), characters a second. */
const SPEECH_CPS = 12.5;

/** Splits a subtitle into chunks of whole sentences, each at most SUB_CHUNK_CHARS where it can be. */
export function subtitleChunks(text: string): string[] {
  const sentences = text.match(/[.!?]*[^.!?]+[.!?]+\s*|[.!?]*[^.!?]+$/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];
  const out: string[] = [];
  for (const sn of sentences) {
    const lastChunk = out[out.length - 1];
    if (lastChunk !== undefined && lastChunk.length + 1 + sn.length <= SUB_CHUNK_CHARS) out[out.length - 1] = `${lastChunk} ${sn}`;
    else out.push(sn);
  }
  return out;
}

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
  // --- DOM: canvas, vignette, bars, transitions, cards, stamp, subtitles, status, Continue. ---
  const root = el('div', 'tj-brief');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Mission briefing');
  const canvas = el('canvas', 'tj-brief-canvas');
  const vignette = el('div', 'tj-brief-vignette');
  const barTop = el('div', 'tj-brief-bar tj-brief-bar--top');
  const barBottom = el('div', 'tj-brief-bar tj-brief-bar--bottom');
  const fade = el('div', 'tj-brief-fade');
  const wipe = el('div', 'tj-brief-wipe');
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
  root.append(canvas, vignette, barTop, barBottom, fade, wipe, card, stamp, sub, status, skip, cont);
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
    // A held camera drifts, barely.
    az += Math.sin(t * 0.21) * 0.18;
    elev += Math.sin(t * 0.17 + 1) * 0.12;
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
  const narrations = script.beats.filter((b): b is Extract<BriefingBeat, { kind: 'narration' }> => b.kind === 'narration');
  const scores = script.beats.filter((b): b is Extract<BriefingBeat, { kind: 'score' }> => b.kind === 'score');
  const cuts = shots.filter((x) => x.transition && x.t > 0);
  /** A piece of subtitle on screen from `start` to `end` (intro time); `last`: the end of its line or cue (it may hold a little). */
  interface SubSeg {
    start: number;
    end: number;
    text: string;
    last: boolean;
  }
  /** A line's words in chunks, each starting at its share of [start, end] (by characters). */
  const pushChunks = (out: SubSeg[], text: string, start: number, end: number): void => {
    const chunks = subtitleChunks(text);
    const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
    let acc = 0;
    chunks.forEach((c, i) => {
      const a = start + ((end - start) * acc) / total;
      acc += c.length;
      out.push({ start: a, end: i === chunks.length - 1 ? end : start + ((end - start) * acc) / total, text: c, last: i === chunks.length - 1 });
    });
  };
  const cueSegs: SubSeg[] = [];
  for (const n of narrations) for (const c of n.cues) pushChunks(cueSegs, c.subtitle ?? briefingSubtitle(c.line), n.t + c.at, n.t + c.end);
  cueSegs.sort((x, y) => x.start - y.start);
  /** The subtitles: the cues, and the line clips paced to their recordings (or a reading pace while loading). */
  function subSegments(): SubSeg[] {
    if (lines.length === 0) return cueSegs;
    const out = cueSegs.slice();
    lines.forEach((li, i) => {
      const text = li.subtitle ?? briefingSubtitle(li.id);
      const next = lines[i + 1];
      const room = (next ? next.t : script.durationSec) - li.t;
      const spoken = audio?.duration(li.id) ?? Math.min(room - 0.6, text.length / SPEECH_CPS);
      pushChunks(out, text, li.t, li.t + spoken);
    });
    return out.sort((x, y) => x.start - y.start);
  }
  let cardKey = '';
  let stampKey = '';
  let subKey = '';
  function overlays(t: number): void {
    // Card: fades and rises in, a thin rule draws across, fades out.
    const c = cards.filter((x) => t >= x.t && t < x.t + x.dur).pop();
    const ck = c ? `${c.t}` : '';
    if (ck !== cardKey) {
      cardKey = ck;
      card.replaceChildren();
      card.className = `tj-brief-card${c ? ` tj-brief-card--${c.style}` : ''}`;
      if (c) {
        c.lines.forEach((line, i) => {
          card.append(el('div', `tj-brief-card-line tj-brief-card-line--${i}`, line));
          // The rule under the eyebrow (classified) or the title (mission).
          if ((c.style === 'classified' && i === 0) || (c.style === 'mission' && i === 1)) card.append(el('div', 'tj-brief-rule'));
        });
      }
    }
    if (c) {
      const k = t - c.t;
      card.style.opacity = String(Math.min(smooth(k / 0.9), smooth((c.t + c.dur - t) / 0.9)));
      card.style.setProperty('--tj-brief-in', clamp01(k / 1.4).toFixed(3));
      card.style.setProperty('--tj-brief-rule', smooth((k - 0.3) / 1.2).toFixed(3));
    } else card.style.opacity = '0';
    // Stamp: each line fades in after the one before.
    const st = stamps.filter((x) => t >= x.t && t < x.t + x.dur).pop();
    const sk = st ? `${st.t}` : '';
    if (sk !== stampKey) {
      stampKey = sk;
      stamp.replaceChildren(...(st ? st.lines.map((l, i) => el('div', `tj-brief-stamp-line tj-brief-stamp-line--${i}`, l)) : []));
    }
    if (st) {
      const k = t - st.t;
      stamp.style.opacity = String(smooth((st.t + st.dur - t) / 1));
      Array.from(stamp.children).forEach((n, i) => ((n as HTMLElement).style.opacity = smooth((k - i * 0.45) / 0.8).toFixed(3)));
    } else stamp.style.opacity = '0';
    // Subtitle: the latest piece, faded in; it fades just before the next, or a little after its line ends.
    const segs = subSegments();
    let idx = -1;
    for (let i = 0; i < segs.length; i++) if (segs[i]!.start <= t) idx = i;
    if (idx >= 0) {
      const sg = segs[idx]!;
      const next = segs[idx + 1];
      const holdEnd = sg.last ? Math.min(next ? next.start - 0.12 : Infinity, sg.end + SUB_HOLD_SEC) : sg.end;
      const a = t > holdEnd ? 0 : Math.min(smooth((t - sg.start) / SUB_FADE_SEC), smooth((holdEnd - t) / 0.25));
      const key = `${idx}`;
      if (key !== subKey) {
        subKey = key;
        sub.textContent = sg.text;
      }
      sub.style.opacity = a.toFixed(3);
    } else if (subKey !== '') {
      subKey = '';
      sub.textContent = '';
    }
    // In from black; the cuts hidden in a dip to black or a soft wipe.
    let dip = 1 - smooth(t / 2.2);
    let wipeAt = -1;
    for (const x of cuts) {
      const u = (t - x.t) / TRANSITION_SEC + 0.5;
      if (u <= 0 || u >= 1) continue;
      if (x.transition === 'fade') dip = Math.max(dip, 1 - Math.abs(u * 2 - 1) ** 2);
      else wipeAt = u;
    }
    fade.style.opacity = dip.toFixed(3);
    // The wipe: a dark band three screens wide (soft edges a screen wide each) sweeping left to
    // right; it covers the whole frame at the cut.
    wipe.style.visibility = wipeAt < 0 ? 'hidden' : 'visible';
    if (wipeAt >= 0) wipe.style.transform = `translate3d(${(-100 + (400 / 3) * wipeAt).toFixed(2)}%, 0, 0)`;
  }

  // --- Sound: the score, the narration, lines, pins' ticks and stings as the clock passes them. ---
  const audio: BriefingAudio | undefined = opts.audio && hold === undefined ? createBriefingAudio(opts.audio.bus, opts.audio.baseUrl) : undefined;
  audio?.preload(scriptClips(script));
  // Under a score the synthesised room and hits are left out.
  audio?.start(scores.length > 0);
  let lastT = -1;
  function sounds(t: number): void {
    if (!audio) return;
    for (const b of script.beats) {
      if (!(b.t > lastT && b.t <= t)) continue;
      if (b.kind === 'line') audio.line(b.id, t - b.t);
      else if (b.kind === 'narration') audio.track(b.clip, 'voice', t - b.t, b.gain ?? 1);
      else if (b.kind === 'score') audio.track(b.clip, 'music', t - b.t, b.gain ?? 0.5);
      else if (b.kind === 'sting') audio.sting();
      else if (b.kind === 'pin') audio.tick();
    }
    mix(t);
  }
  /** The score's level now: ducked under any voice (a little before it to a little after), faded out to the end. */
  const scoreGain = (sc: Extract<BriefingBeat, { kind: 'score' }>, t: number, segs: readonly SubSeg[]): number => {
    const voiced = segs.some((x) => t >= x.start - 0.25 && t <= x.end + 0.35);
    const duck = voiced ? Math.pow(10, (sc.duckDb ?? -9) / 20) : 1;
    const fadeSec = sc.fadeOutSec ?? 4;
    return (sc.gain ?? 0.5) * duck * (1 - smooth((t - (script.durationSec - fadeSec)) / fadeSec));
  };
  const lastScoreGain = new Map<string, number>();
  function mix(t: number): void {
    if (!audio || scores.length === 0) return;
    const segs = subSegments();
    for (const sc of scores) {
      if (t < sc.t) continue;
      const g = Math.round(scoreGain(sc, t, segs) * 200) / 200;
      if (lastScoreGain.get(sc.clip) === g) continue;
      lastScoreGain.set(sc.clip, g);
      audio.trackGain(sc.clip, g, 0.3);
    }
  }
  /** While a narration recording plays, the intro time it puts us at (undefined otherwise). */
  function narrationClock(t: number): number | undefined {
    if (!audio) return undefined;
    for (const n of narrations) {
      if (t < n.t) continue;
      const pos = audio.trackPosition(n.clip);
      if (pos !== undefined) return n.t + pos;
    }
    return undefined;
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
    else if (hold === undefined && (gridIn || t < 1.2)) t = narrationClock(t) ?? t + dt;
    if (!finished && t >= script.durationSec) {
      finished = true;
      if (ready) cont.hidden = false;
      skip.hidden = true;
    }
    sounds(t);
    // Never back over a beat already played (the narration's clock can step back a few ms).
    lastT = Math.max(lastT, t);
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

