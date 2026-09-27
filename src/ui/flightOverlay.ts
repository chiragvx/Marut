/**
 * src/ui/flightOverlay.ts — the thin layer over the HUD in flight: an objective tracker (top
 * left), short event messages (top right, ~3 s each, at most three), and first-flight hints
 * (lower centre). None of it takes pointer input.
 *
 * Hints are chosen by `pickHint` from the aircraft's state, most useful first; each one retires
 * for the rest of the flight once the pilot has done what it asks (taken off, raised the gear,
 * designated a target, fired...). Hints can be switched off in Settings -> Gameplay.
 */
import { h, keyCap } from './kit';

export type HintId = 'taxi' | 'throttle' | 'rotate' | 'gearUp' | 'designate' | 'fire' | 'gearDown';

export interface CoachState {
  /** Seconds since the flight started. */
  t: number;
  start: 'parked' | 'runway' | 'air';
  mission: boolean;
  onGround: boolean;
  speedMps: number;
  aglM: number;
  vsMps: number;
  gearPos: number;
  taxiGuideOn: boolean;
  hasTarget: boolean;
  locked: boolean;
  missileSelected: boolean;
  missilesFired: number;
}

export interface HintKeys {
  throttleUp: string;
  throttleDown: string;
  afterburner: string;
  noseUp: string;
  gear: string;
  taxiGuide: string;
  target: string;
  launch: string;
  weapon: string;
}

/** A hint's words, with key names marked as {key}. */
export function hintText(id: HintId, k: HintKeys): string {
  switch (id) {
    case 'taxi':
      return `Press {${k.taxiGuide}} for taxi guidance to the runway. {${k.throttleUp}} adds power.`;
    case 'throttle':
      return `Throttle up with {${k.throttleUp}} ({${k.throttleDown}} to slow). Hold {${k.afterburner}} for afterburner.`;
    case 'rotate':
      return `Past 250 km/h: hold {${k.noseUp}} to lift the nose and take off.`;
    case 'gearUp':
      return `Gear is down. Press {${k.gear}} to raise it.`;
    case 'designate':
      return `Press {${k.target}} to designate a target. Contacts show on the radar, bottom right.`;
    case 'fire':
      return `LOCK. Press {${k.launch}} to fire a missile.`;
    case 'gearDown':
      return `Landing? Press {${k.gear}} to lower the gear.`;
  }
}

/** Marks hints as done when their condition is met; returns the hint to show now, if any. */
export function pickHint(s: CoachState, done: Set<HintId>): HintId | undefined {
  // Retire hints whose job is done.
  if (s.taxiGuideOn || s.speedMps > 5 || s.start !== 'parked') done.add('taxi');
  if (s.speedMps > 45 || !s.onGround || s.start === 'air') done.add('throttle');
  if (!s.onGround || s.start === 'air') done.add('rotate');
  if (s.gearPos < 0.5 && !s.onGround) done.add('gearUp');
  if (s.hasTarget || !s.mission) done.add('designate');
  if (s.missilesFired > 0) done.add('fire');
  if (s.gearPos > 0.5 && !s.onGround && s.aglM < 300) done.add('gearDown');

  const want: [HintId, boolean][] = [
    ['taxi', s.onGround && s.speedMps < 3],
    ['throttle', s.start === 'runway' && s.onGround && s.speedMps < 25],
    ['rotate', s.onGround && s.speedMps > 65],
    ['gearUp', !s.onGround && s.gearPos > 0.9 && s.aglM > 40 && s.vsMps > 0],
    ['fire', s.locked && s.missileSelected],
    ['designate', !s.onGround && s.t > 20 && !s.hasTarget],
    ['gearDown', !s.onGround && s.gearPos < 0.1 && s.aglM < 250 && s.speedMps < 120 && s.vsMps < -1],
  ];
  for (const [id, cond] of want) if (cond && !done.has(id)) return id;
  return undefined;
}

export interface FlightOverlay {
  root: HTMLElement;
  setVisible(v: boolean): void;
  /** null hides the tracker. */
  setObjective(label: string, text: string, detail?: string): void;
  clearObjective(): void;
  message(text: string, warn?: boolean): void;
  /** Hint text with {key} markers, or undefined for none. */
  setHint(text: string | undefined): void;
  clear(): void;
}

const MESSAGE_MS = 3200;
const MAX_MESSAGES = 3;

export function createFlightOverlay(container: HTMLElement): FlightOverlay {
  const objLabel = h('span', { className: 'tj-label' });
  const objText = h('span');
  const objDetail = h('span', { className: 'tj-note', attrs: { style: 'color: inherit; opacity: 0.85' } });
  const objective = h('div', { className: 'tj-objective tj-hidden', attrs: { 'data-role': 'objective' } }, objLabel, objText, objDetail);
  const toasts = h('div', { className: 'tj-toasts', attrs: { 'aria-live': 'polite' } });
  const hint = h('div', { className: 'tj-hint tj-hidden', attrs: { 'data-role': 'hint' } });
  const root = h('div', { className: 'tj-flight tj-passive tj-hidden' }, objective, toasts, hint);
  container.appendChild(root);
  let hintNow: string | undefined;
  let objNow = '';

  return {
    root,
    setVisible(v) {
      root.classList.toggle('tj-hidden', !v);
    },
    setObjective(label, text, detail) {
      const key = `${label}|${text}|${detail ?? ''}`;
      if (key === objNow) return;
      objNow = key;
      objLabel.textContent = label;
      objText.textContent = text;
      objDetail.textContent = detail ?? '';
      objective.classList.remove('tj-hidden');
    },
    clearObjective() {
      objNow = '';
      objective.classList.add('tj-hidden');
    },
    message(text, warn = false) {
      const t = h('div', { className: `tj-toast${warn ? ' tj-toast--warn' : ''}`, text });
      toasts.prepend(t);
      while (toasts.childElementCount > MAX_MESSAGES) toasts.lastElementChild?.remove();
      setTimeout(() => t.remove(), MESSAGE_MS);
    },
    setHint(text) {
      if (text === hintNow) return;
      hintNow = text;
      if (!text) {
        hint.classList.add('tj-hidden');
        return;
      }
      // "{Z}" -> a key cap.
      const parts = text.split(/(\{[^}]+\})/g).filter((p) => p !== '');
      hint.replaceChildren(...parts.map((p) => (p.startsWith('{') ? keyCap(p.slice(1, -1)) : document.createTextNode(p))));
      hint.classList.remove('tj-hidden');
    },
    clear() {
      toasts.replaceChildren();
      this.setHint(undefined);
      this.clearObjective();
    },
  };
}
