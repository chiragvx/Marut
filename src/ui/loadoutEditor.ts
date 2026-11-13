/**
 * src/ui/loadoutEditor.ts — choose what hangs on each pylon.
 *
 * One slot per store station, laid out as on the aircraft from the left wingtip to the right.
 * Each slot offers only the stores that station accepts and the game has built, up to its count
 * (two on twin-rail pylons). "Same on both wings" (on by default) mirrors every change to the other
 * wing. Presets fill every slot at once; any edit that no longer matches a preset makes it Custom.
 *
 * With a 3D view (`LoadoutView`, the jet in its hangar: src/ui/hangarView.ts) the panel sits on the
 * left, the pylons paired left and right wing, and the rest of the screen is the view: every change
 * shows on the jet at once; drag to walk round it, scroll (or pinch) to close in.
 */
import type { AircraftDefinition } from '../contracts/aircraft';
import { WEAPONS, FUEL_TANKS } from '../catalog';
import { loadoutMassKg, loadoutTanks, resolveLoadout, stationChoices, storeName, type LoadoutFit } from '../aircraft/loadout';
import { mountScreen } from './screenHandle';
import { button, checkbox, h, menuKeys, select, shell } from './kit';
import type { ScreenHandle } from '../contracts/ui';

/** A preset by id, or a custom fit. */
export interface LoadoutSelection {
  presetId?: string;
  fit?: LoadoutFit;
}

type Fit = Record<string, { store: string; count: number }>;

/** The stations' order across the aircraft, left wingtip to right. */
const SPAN_ORDER = ['wing-outer-l', 'wing-mid-l', 'wing-inner-l', 'centreline', 'wing-inner-r', 'wing-mid-r', 'wing-outer-r'];
const SLOT_LABEL: Record<string, string> = {
  'wing-outer-l': 'Left outer',
  'wing-mid-l': 'Left middle',
  'wing-inner-l': 'Left inner',
  centreline: 'Centre',
  'wing-inner-r': 'Right inner',
  'wing-mid-r': 'Right middle',
  'wing-outer-r': 'Right outer',
};

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

/** Missiles by kind, tanks, added mass and total fuel. */
export function fitSummary(def: AircraftDefinition, fit: LoadoutFit): string {
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
  const fuel = Math.round(def.maxFuelKg + tanks.fuelKg);
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

function optionLabel(store: string, count: number): string {
  if (FUEL_TANKS[store]) return storeName(store);
  return count >= 2 ? `${storeName(store)} ×2 (twin rail)` : `${storeName(store)} ×1`;
}

/** The 3D view of the jet with its fit (the hangar), while the editor is open. */
export interface LoadoutView {
  setFit(fit: LoadoutFit): void;
  /** Turn round the jet and up/down (rad); zoom: distance factor (< 1 closer). */
  orbitBy(dYaw: number, dPitch: number, zoom: number): void;
  close(): void;
}

/** The pylons' order in the paired layout: each row a left and a right station, the centreline last. */
const PAIR_ORDER = ['wing-outer-l', 'wing-outer-r', 'wing-mid-l', 'wing-mid-r', 'wing-inner-l', 'wing-inner-r', 'centreline'];

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
    view.orbitBy(-dx * 0.008, dy * 0.006, 1);
  };
  const up = (e: PointerEvent): void => {
    pts.delete(e.pointerId);
    pinch = 0;
    if (pts.size === 0) el.classList.remove('tj-orbiting');
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
  const presets = def.loadouts ?? [];
  let fit = selectionFit(def, initial);
  let mirror = true;

  const s = shell({
    title: 'Loadout',
    eyebrow: def.displayName ?? def.id,
    sub: 'Pick what hangs on each pylon. Each pylon lists only what it can carry.',
    back: { label: 'Cancel', onClick: () => cb.onCancel() },
    ...(view ? { clear: true } : {}),
  });
  s.root.classList.add('tj-loadout');
  if (view) s.root.classList.add('tj-loadout--3d');

  const presetRow = h('div', { className: 'tj-row' });
  const presetButtons = presets.map((p) =>
    button(p.name.split(':')[0]!, () => {
      fit = selectionFit(def, { presetId: p.id });
      render();
    }, 'default', { 'data-preset': p.id })
  );
  const customTag = h('span', { className: 'tj-badge', text: 'Custom' });
  presetRow.append(h('span', { className: 'tj-label', text: 'Presets' }), ...presetButtons, customTag);

  const pylons = h('div', { className: 'tj-pylons' });
  const summary = h('p', { className: 'tj-note', attrs: { 'data-role': 'summary' } });
  const described = h('p', { attrs: { 'data-role': 'described' } });
  const mirrorBox = checkbox('Same on both wings', mirror, (v) => (mirror = v), { 'data-role': 'mirror' });

  function slotSelect(stationId: string): HTMLElement {
    const c = choices.get(stationId);
    const opts: { value: string; label: string }[] = [{ value: '', label: 'Empty' }];
    for (const store of c?.stores ?? []) {
      const max = FUEL_TANKS[store] ? 1 : Math.max(1, c!.maxCount);
      for (let n = 1; n <= max; n++) opts.push({ value: `${store}:${n}`, label: optionLabel(store, n) });
    }
    const cur = fit[stationId];
    const value = cur ? `${cur.store}:${cur.count}` : '';
    const sel = select(opts, value, (v) => {
      const next = v ? { store: v.split(':')[0]!, count: Number(v.split(':')[1]) } : undefined;
      const set = (id: string): void => {
        if (next) fit[id] = { ...next };
        else delete fit[id];
      };
      set(stationId);
      const m = mirrorOf(stationId);
      if (mirror && m && choices.has(m)) set(m);
      render();
    }, { 'data-station': stationId, 'aria-label': SLOT_LABEL[stationId] ?? stationId });
    return h('div', { className: `tj-pylon${stationId === 'centreline' ? ' tj-pylon--centre' : ''}` }, h('span', { className: 'tj-label', text: SLOT_LABEL[stationId] ?? stationId }), sel);
  }

  function render(): void {
    const focused = (document.activeElement as HTMLElement | null)?.getAttribute('data-station');
    pylons.replaceChildren(...(view ? PAIR_ORDER : SPAN_ORDER).filter((id) => choices.has(id)).map(slotSelect));
    if (focused) pylons.querySelector<HTMLElement>(`[data-station="${focused}"]`)?.focus();
    const match = presets.find((p) => sameFit(selectionFit(def, { presetId: p.id }), fit));
    for (const b of presetButtons) b.setAttribute('aria-pressed', String(b.getAttribute('data-preset') === match?.id));
    customTag.classList.toggle('tj-hidden', !!match);
    described.textContent = describeFit(fit);
    summary.textContent = fitSummary(def, fit);
    view?.setFit({ ...fit });
  }
  render();

  s.body.append(
    presetRow,
    view
      ? h('div', { className: 'tj-planform', text: 'LEFT WING  |  RIGHT WING   (as the pilot sees them)' })
      : h('div', { className: 'tj-planform', text: 'LEFT WING  ◂  outer · middle · inner  |  centre  |  inner · middle · outer  ▸  RIGHT WING   (seen from behind the aircraft)' }),
    pylons,
    h('div', { className: 'tj-row', attrs: { style: 'justify-content: space-between' } }, mirrorBox, h('div', { className: 'tj-stack', attrs: { style: 'justify-items: end; gap: 2px' } }, described, summary))
  );
  s.actions.append(
    button('Done', () => {
      const match = presets.find((p) => sameFit(selectionFit(def, { presetId: p.id }), fit));
      cb.onDone(match ? { presetId: match.id } : { fit: { ...fit } });
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
