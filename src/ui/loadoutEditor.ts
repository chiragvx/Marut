/**
 * src/ui/loadoutEditor.ts — choose what hangs on each pylon.
 *
 * The hardpoints are drawn head-on (src/ui/hardpointDiagram.ts): the Tejas in line art, each pylon
 * with its store drawn on it and a numbered badge under the wing. Pick a station (the pylon or its
 * badge) and the picker under the drawing lists what that station can carry: only the stores it
 * accepts and the game has built, singly or two on a twin rail. "Same on both wings" (on by default)
 * mirrors every change to the other wing. The presets are the missions' own fits; any edit that no
 * longer matches one makes it Custom.
 *
 * With a 3D view (`LoadoutView`, the jet in its hangar: src/ui/hangarView.ts) the panel sits on the
 * left and the rest of the screen is the view: every change shows on the jet at once; drag to walk
 * round it, scroll (or pinch) to close in.
 */
import type { AircraftDefinition } from '../contracts/aircraft';
import { WEAPONS, FUEL_TANKS } from '../catalog';
import { loadoutMassKg, loadoutTanks, resolveLoadout, stationChoices, storeName, type LoadoutFit } from '../aircraft/loadout';
import { mountScreen } from './screenHandle';
import { button, checkbox, h, menuKeys, shell } from './kit';
import { hardpointSvg, storeIconSvg, storeShape, TEJAS_STATIONS } from './hardpointDiagram';
import type { ScreenHandle } from '../contracts/ui';

/** A preset by id, or a custom fit. */
export interface LoadoutSelection {
  presetId?: string;
  fit?: LoadoutFit;
  /** Internal fuel at the start, 0..1 (absent = full; drop tanks always start full). */
  fuelFrac?: number;
}

/** The lightest internal fuel the slider offers. */
export const MIN_FUEL_FRAC = 0.1;

/**
 * The take-off weight of a fit, kg: the empty jet, the internal fuel taken, the stores (tanks full).
 * Nothing stops an overweight fit (the jet just flies heavy); `overKg` is how far past MTOW it is.
 */
export function takeoffWeight(def: AircraftDefinition, fit: LoadoutFit, fuelFrac = 1): { kg: number; fuelKg: number; storesKg: number; mtowKg: number | undefined; overKg: number } {
  const fuelKg = def.maxFuelKg * Math.min(1, Math.max(0, fuelFrac));
  const storesKg = loadoutMassKg({ id: 'x', name: 'x', fit });
  const kg = def.emptyMassKg + fuelKg + storesKg;
  const mtowKg = def.maxTakeoffMassKg;
  return { kg, fuelKg, storesKg, mtowKg, overKg: mtowKg ? Math.max(0, kg - mtowKg) : 0 };
}

type Fit = Record<string, { store: string; count: number }>;

/**
 * The presets offered: the fits the missions fly (named for the mission's role), in the missions'
 * order. Other presets still resolve (a saved selection, an AI flight's); they are just not listed.
 */
export const MISSION_PRESETS: readonly { id: string; label: string }[] = [
  { id: 'cap', label: 'Air defence' },
  { id: 'precision', label: 'Precision strike' },
  { id: 'lowlevel', label: 'Low level' },
  { id: 'sead', label: 'SEAD' },
  { id: 'runway-denial', label: 'Runway denial' },
  { id: 'cas', label: 'Close support' },
  { id: 'clean', label: 'Clean' },
];

const mirrorOf = (id: string): string | undefined => (id.endsWith('-l') ? id.slice(0, -2) + '-r' : id.endsWith('-r') ? id.slice(0, -2) + '-l' : undefined);

/** The fit a selection stands for (custom fits validated). */
export function selectionFit(def: AircraftDefinition, sel: LoadoutSelection): Fit {
  const p = resolveLoadout(def, sel.presetId, sel.fit);
  const out: Fit = {};
  for (const [k, v] of Object.entries(p?.fit ?? {})) if (v) out[k] = { ...v };
  return out;
}

/** "4× ASRAAM, 2× Astra Mk1, 2× 1200 L tank" (the gun left out). */
export function describeFit(fit: LoadoutFit): string {
  const counts = new Map<string, number>();
  for (const f of Object.values(fit)) {
    if (!f || WEAPONS[f.store]?.kind === 'gun') continue;
    counts.set(f.store, (counts.get(f.store) ?? 0) + f.count);
  }
  if (counts.size === 0) return 'Gun only';
  return [...counts].map(([s, n]) => `${n}× ${storeName(s)}`).join(', ');
}

/** The selection's name: the preset's, or "Custom". */
export function selectionName(def: AircraftDefinition, sel: LoadoutSelection): string {
  if (sel.fit) return 'Custom';
  return (def.loadouts ?? []).find((l) => l.id === (sel.presetId ?? def.defaultLoadoutId))?.name.split(':')[0] ?? 'Default';
}

/** Missiles by kind, tanks, added mass and total fuel (internal at `fuelFrac`, tanks full). */
export function fitSummary(def: AircraftDefinition, fit: LoadoutFit, fuelFrac = 1): string {
  let ir = 0;
  let radar = 0;
  for (const f of Object.values(fit)) {
    const k = f ? WEAPONS[f.store]?.kind : undefined;
    if (k === 'ir_missile') ir += f!.count;
    if (k === 'radar_missile') radar += f!.count;
  }
  const preset = { id: 'x', name: 'x', fit };
  const tanks = loadoutTanks(preset);
  const kg = Math.round(loadoutMassKg(preset));
  const fuel = Math.round(def.maxFuelKg * Math.min(1, Math.max(0, fuelFrac)) + tanks.fuelKg);
  return `${ir} heat-seeking · ${radar} radar-guided · ${tanks.count} tank${tanks.count === 1 ? '' : 's'} · +${kg.toLocaleString('en-US')} kg · fuel ${fuel.toLocaleString('en-US')} kg`;
}

function sameFit(a: Fit, b: Fit): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (!x || !y) {
      if (x || y) return false;
      continue;
    }
    if (x.store !== y.store || x.count !== y.count) return false;
  }
  return true;
}

/** The store a fit is about (what to draw on its tile): its weapon for the ground, else its biggest missile. */
function signatureStore(fit: Fit): { store: string; count: number } | undefined {
  const order = ['arm', 'lgb', 'rocket', 'bomb', 'radar', 'ir', 'jammer', 'pod', 'tank'];
  let best: { store: string; count: number } | undefined;
  let rank = order.length;
  for (const f of Object.values(fit)) {
    if (!f || WEAPONS[f.store]?.kind === 'gun') continue;
    const r = order.indexOf(storeShape(f.store));
    if (r >= 0 && r < rank) {
      rank = r;
      best = f;
    }
  }
  return best;
}

/** "4 AAM · 2 LGB · POD · 1 TANK": what a fit carries, by kind. */
export function briefFit(fit: Fit): string {
  const names: Record<string, string> = { ir: 'AAM', radar: 'AAM', lgb: 'GUIDED', bomb: 'BOMB', rocket: 'RKT POD', arm: 'ARM', tank: 'TANK', pod: 'POD', jammer: 'JAMMER' };
  const n = new Map<string, number>();
  for (const f of Object.values(fit)) {
    if (!f || WEAPONS[f.store]?.kind === 'gun') continue;
    const k = names[storeShape(f.store)]!;
    n.set(k, (n.get(k) ?? 0) + f.count);
  }
  if (n.size === 0) return 'Gun only';
  return [...n].map(([k, c]) => (k === 'POD' || k === 'JAMMER' ? k : `${c} ${k}`)).join(' · ');
}

/** The 3D view of the jet with its fit (the hangar), while the editor is open. */
export interface LoadoutView {
  setFit(fit: LoadoutFit): void;
  /** Turn round the jet and up/down (rad); zoom: distance factor (< 1 closer). */
  orbitBy(dYaw: number, dPitch: number, zoom: number): void;
  /** A finger or button is down on the view (the turn carries on, slowing, once let go). */
  setDragging(on: boolean): void;
  close(): void;
}

/** Drag (and pinch) on `el`, away from `panel`: turns and zooms the view. Returns the remover. */
function attachOrbit(el: HTMLElement, panel: HTMLElement, view: LoadoutView): () => void {
  const pts = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  const outside = (t: EventTarget | null): boolean => !(t instanceof Node && panel.contains(t));
  const down = (e: PointerEvent): void => {
    if (!outside(e.target)) return;
    e.preventDefault();
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    el.setPointerCapture?.(e.pointerId);
    el.classList.add('tj-orbiting');
    view.setDragging(true);
    pinch = 0;
  };
  const move = (e: PointerEvent): void => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinch > 0 && d > 0) view.orbitBy(0, 0, pinch / d);
      pinch = d;
      return;
    }
    // The jet turns the way it is dragged.
    view.orbitBy(dx * 0.006, dy * 0.005, 1);
  };
  const up = (e: PointerEvent): void => {
    pts.delete(e.pointerId);
    pinch = 0;
    if (pts.size === 0) {
      el.classList.remove('tj-orbiting');
      view.setDragging(false);
    }
  };
  const wheel = (e: WheelEvent): void => {
    if (!outside(e.target)) return;
    e.preventDefault();
    view.orbitBy(0, 0, Math.exp(Math.max(-200, Math.min(200, e.deltaY)) * 0.0015));
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', wheel, { passive: false });
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('wheel', wheel);
  };
}

export interface LoadoutEditorCallbacks {
  onDone(sel: LoadoutSelection): void;
  onCancel(): void;
}

export function createLoadoutEditor(container: HTMLElement, def: AircraftDefinition, initial: LoadoutSelection, cb: LoadoutEditorCallbacks, view?: LoadoutView): ScreenHandle {
  const choices = new Map(stationChoices(def).map((c) => [c.stationId, c]));
  const all = def.loadouts ?? [];
  const presets = MISSION_PRESETS.filter((m) => all.some((l) => l.id === m.id));
  let fit = selectionFit(def, initial);
  let fuelFrac = Math.min(1, Math.max(MIN_FUEL_FRAC, initial.fuelFrac ?? 1));
  let mirror = true;
  const have = new Set(TEJAS_STATIONS.map((t) => t.id).filter((id) => choices.has(id)));
  let selected = ['wing-outer-l', ...have].find((id) => have.has(id));

  const s = shell({
    title: 'Loadout',
    eyebrow: def.displayName ?? def.id,
    back: { label: 'Cancel', onClick: () => cb.onCancel() },
    ...(view ? { clear: true } : {}),
  });
  s.root.classList.add('tj-loadout');
  if (view) s.root.classList.add('tj-loadout--3d');
  // No title or subtitle: the breadcrumb names the screen; the aircraft's name stays as the eyebrow.
  s.panel.querySelector('.tj-title')?.remove();

  // The mission fits as tiles: the fit's signature store drawn, the role, what it carries in brief.
  const presetRow = h('div', { className: 'tj-missions', attrs: { role: 'group', 'aria-label': 'Mission fits' } });
  const presetButtons = presets.map((p) => {
    const pf = selectionFit(def, { presetId: p.id });
    const b = h('button', { className: 'tj-mission', attrs: { type: 'button', 'data-preset': p.id, 'aria-pressed': 'false' } });
    const sig = signatureStore(pf);
    b.innerHTML = sig ? storeIconSvg(sig.store, sig.count >= 2 ? 2 : 1) : '<svg class="hp-icon" viewBox="0 0 44 34" aria-hidden="true"><circle cx="22" cy="17" r="7" class="hp-empty"/></svg>';
    b.append(h('span', { className: 'tj-mission-name', text: p.label }), h('span', { className: 'tj-mission-fit', text: briefFit(pf) }));
    b.addEventListener('click', () => {
      fit = selectionFit(def, { presetId: p.id });
      render();
    });
    return b;
  });
  const customTag = h('span', { className: 'tj-mission tj-mission--custom', attrs: { 'aria-hidden': 'true' } }, h('span', { className: 'tj-mission-name', text: 'Custom' }), h('span', { className: 'tj-mission-fit', text: 'Your own fit' }));
  presetRow.append(...presetButtons, customTag);

  const diagram = h('div', { className: 'tj-hardpoints', attrs: { 'data-role': 'hardpoints' } });
  const pickHead = h('div', { className: 'tj-pick-head' });
  const picker = h('div', { className: 'tj-picker', attrs: { role: 'radiogroup', 'data-role': 'picker' } });
  const summary = h('p', { className: 'tj-note', attrs: { 'data-role': 'summary' } });
  const described = h('p', { attrs: { 'data-role': 'described' } });
  // Internal fuel to take, and the take-off weight against MTOW: an overweight fit is allowed
  // (each pylon only takes what it is rated for, but the heavy pylons together can overload the jet).
  const fuelInput = h('input', { className: 'tj-range', attrs: { type: 'range', min: String(MIN_FUEL_FRAC * 100), max: '100', step: '5', 'data-role': 'fuel', 'aria-label': 'Internal fuel' } });
  fuelInput.value = String(Math.round(fuelFrac * 100));
  const fuelOut = h('span', { className: 'tj-wt-val', attrs: { 'data-role': 'fuel-value' } });
  fuelInput.addEventListener('input', () => {
    fuelFrac = Number(fuelInput.value) / 100;
    renderWeight();
  });
  const wtVal = h('span', { className: 'tj-wt-val', attrs: { 'data-role': 'weight' } });
  const wtFill = h('div', { className: 'tj-wt-fill' });
  const wtMark = h('div', { className: 'tj-wt-mtow' });
  const wtNote = h('p', { className: 'tj-wt-note', attrs: { 'data-role': 'overweight', 'aria-live': 'polite' } });
  const weightBox = h('div', { className: 'tj-weight', attrs: { 'data-role': 'weight-box' } },
    h('div', { className: 'tj-wt-row' }, h('span', { className: 'tj-label', text: 'Internal fuel' }), fuelOut),
    fuelInput,
    h('div', { className: 'tj-wt-row' }, h('span', { className: 'tj-label', text: 'Take-off weight' }), wtVal),
    h('div', { className: 'tj-wt-bar' }, wtFill, wtMark),
    wtNote
  );
  function renderWeight(): void {
    const w = takeoffWeight(def, fit, fuelFrac);
    const kg = (n: number): string => Math.round(n).toLocaleString('en-US');
    fuelOut.textContent = `${Math.round(fuelFrac * 100)}% · ${kg(w.fuelKg)} kg`;
    wtVal.textContent = w.mtowKg ? `${kg(w.kg)} / ${kg(w.mtowKg)} kg` : `${kg(w.kg)} kg`;
    // The bar runs to 125% of MTOW (further if heavier), MTOW marked.
    const scale = w.mtowKg ? Math.max(w.mtowKg * 1.25, w.kg) : w.kg;
    wtFill.style.width = `${((w.kg / scale) * 100).toFixed(1)}%`;
    wtMark.style.left = w.mtowKg ? `${((w.mtowKg / scale) * 100).toFixed(1)}%` : '100%';
    wtMark.classList.toggle('tj-hidden', !w.mtowKg);
    weightBox.classList.toggle('is-over', w.overKg > 0);
    wtNote.textContent = !w.mtowKg
      ? ''
      : w.overKg > 0
        ? `Over MTOW by ${kg(w.overKg)} kg (+${((w.overKg / w.mtowKg) * 100).toFixed(1)}%): longer take-off run, slower climb, less g in hand.`
        : `${kg(w.mtowKg - w.kg)} kg under MTOW.`;
    summary.textContent = fitSummary(def, fit, fuelFrac);
  }

  const mirrorBox = checkbox('Same on both wings', mirror, (v) => (mirror = v), { 'data-role': 'mirror' });

  const setStation = (stationId: string, next: { store: string; count: number } | undefined): void => {
    const put = (id: string): void => {
      if (next) fit[id] = { ...next };
      else delete fit[id];
    };
    put(stationId);
    const m = mirrorOf(stationId);
    // The mirror station only if it takes the same store (the jammer goes on one wing only).
    if (mirror && m && choices.has(m) && (!next || choices.get(m)!.stores.includes(next.store))) put(m);
    render();
    picker.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  };

  const choose = (id: string): void => {
    selected = id;
    render();
    diagram.querySelector<SVGElement>(`[data-station="${id}"]`)?.focus();
  };
  diagram.addEventListener('click', (e) => {
    const g = (e.target as Element).closest?.('[data-station]');
    if (g) choose(g.getAttribute('data-station')!);
  });
  diagram.addEventListener('keydown', (e) => {
    const g = (e.target as Element).closest?.('[data-station]');
    if (g && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      choose(g.getAttribute('data-station')!);
    }
  });

  function renderPicker(): void {
    const st = TEJAS_STATIONS.find((t) => t.id === selected);
    const c = selected ? choices.get(selected) : undefined;
    if (!st || !c) {
      pickHead.replaceChildren();
      picker.replaceChildren();
      return;
    }
    pickHead.replaceChildren(h('span', { className: 'tj-pick-num', text: st.num }), h('span', { className: 'tj-label', text: `Station ${st.num} · ${st.label}` }));
    const cur = fit[st.id];
    const curValue = cur ? `${cur.store}:${cur.count}` : '';
    const opt = (value: string, label: string, icon: string, next: { store: string; count: number } | undefined): HTMLElement => {
      const b = h('button', { className: 'tj-pick', attrs: { type: 'button', role: 'radio', 'aria-checked': String(value === curValue), 'data-store': value, title: label } });
      b.innerHTML = icon;
      b.append(h('span', { text: label }));
      b.addEventListener('click', () => setStation(st.id, next));
      return b;
    };
    const opts = [opt('', 'Empty', '<svg class="hp-icon" viewBox="0 0 44 34" aria-hidden="true"><circle cx="22" cy="17" r="7" class="hp-empty"/></svg>', undefined)];
    for (const store of c.stores) {
      const max = FUEL_TANKS[store] || !WEAPONS[store] ? 1 : Math.max(1, c.maxCount);
      for (let n = 1; n <= max; n++) opts.push(opt(`${store}:${n}`, n >= 2 ? `2× ${storeName(store)}` : storeName(store), storeIconSvg(store, n), { store, count: n }));
    }
    picker.replaceChildren(...opts);
  }

  function render(): void {
    diagram.innerHTML = hardpointSvg(fit, selected, have);
    renderPicker();
    const match = presets.find((p) => sameFit(selectionFit(def, { presetId: p.id }), fit));
    for (const b of presetButtons) b.setAttribute('aria-pressed', String(b.getAttribute('data-preset') === match?.id));
    customTag.classList.toggle('tj-hidden', !!match);
    described.textContent = describeFit(fit);
    renderWeight();
    view?.setFit({ ...fit });
  }
  render();

  s.body.append(
    presetRow,
    diagram,
    h('div', { className: 'tj-row tj-pick-bar' }, pickHead, mirrorBox),
    picker,
    weightBox,
    h('div', { className: 'tj-stack tj-fit-sum' }, described, summary)
  );
  s.actions.append(
    button('Done', () => {
      const match = presets.find((p) => sameFit(selectionFit(def, { presetId: p.id }), fit));
      const fuel = fuelFrac < 1 ? { fuelFrac } : {};
      cb.onDone(match ? { presetId: match.id, ...fuel } : { fit: { ...fit }, ...fuel });
    }, 'primary', { 'data-action': 'done' })
  );

  if (view) s.root.append(h('div', { className: 'tj-orbit-hint', text: 'Drag to walk round the jet · scroll or pinch to zoom' }));
  const handle = mountScreen(container, s.root);
  const release = menuKeys(s.root, () => cb.onCancel());
  const releaseOrbit = view ? attachOrbit(s.root, s.panel, view) : () => {};
  return {
    ...handle,
    destroy: () => {
      releaseOrbit();
      view?.close();
      release();
      handle.destroy();
    },
  };
}
