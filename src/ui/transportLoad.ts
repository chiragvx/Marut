/**
 * src/ui/transportLoad.ts — the C-17's load planner (Free Flight): how much fuel and cargo to take.
 *
 * Presets for the usual loads (a light training sortie, troops, a heavy airdrop platform, container
 * airdrop bundles, the full payload, a ferry with full tanks), two sliders, fuel and cargo, and the
 * airdrop rig (the cargo as 1 t CDS bundles that the Drop key releases off the open ramp,
 * src/core/airdrop.ts). It shows what the load does:
 * the fuel in kg and %, the cargo, the take-off weight against MTOW, the CG against the envelope
 * (fraction of MAC), and the speeds a pilot cares about for turning: the clean 1 g stall and the
 * speed from which the full 2.5 g is there (above it the turn is g-limited, below it the alpha
 * limiter gives less). The choice reaches the sim as MissionPlayerStart.fuelFrac / cargoKg, which
 * set the mass, CG and inertia (physics/integrator.ts mass model).
 *
 * With a 3D view (the aircraft in a hangar: src/ui/hangarView.ts) the panel sits on the left and
 * the rest of the screen is the view, as the Tejas's loadout editor has it.
 */
import type { AircraftDefinition } from '../contracts/aircraft';
import type { AirdropLoad, Mission } from '../contracts/core';
import type { ScreenHandle } from '../contracts/ui';
import { cgMacFraction } from '../aircraft/massModel';
import { mountScreen } from './screenHandle';
import { button, h, menuKeys, shell } from './kit';
import { attachOrbit, type LoadoutView } from './loadoutEditor';

/** A transport's load: fuel 0..1 of maxFuelKg and cargo kg (presetId: the preset it was picked from). */
export interface TransportLoad {
  presetId?: string;
  fuelFrac: number;
  cargoKg: number;
  /** The cargo rigged for airdrop as CDS bundles (airdropRig). */
  airdrop?: boolean;
}

/** A CDS bundle's mass, kg (an A-22 container), and the bundles one release drops (a stick). */
export const CDS_BUNDLE_KG = 1000;
export const CDS_STICK = 4;

/** The airdrop rig for `cargoKg` of bundles: whole 1 t bundles (the rest is ballast), 4 to a stick, light reserve bundles after. */
export function airdropRig(cargoKg: number): AirdropLoad | undefined {
  const bundles = Math.floor(cargoKg / CDS_BUNDLE_KG);
  return bundles > 0 ? { bundles, bundleKg: CDS_BUNDLE_KG, stick: CDS_STICK, reserve: true } : undefined;
}

/** The lightest fuel the slider offers. */
export const MIN_TRANSPORT_FUEL_FRAC = 0.1;

/**
 * The preset loads [E] (docs/spec/c17-data.md 1.2: 102 troops with kit ~12 t; a 60,000 lb
 * platform at about 200 t AUW; the full 77.5 t payload with fuel up to MTOW; a ferry on full ER
 * tanks). Training is the default: light enough to turn hard.
 */
export const TRANSPORT_PRESETS: readonly { id: string; label: string; fuelFrac: number; cargoKg: number; airdrop?: boolean }[] = [
  { id: 'training', label: 'Training', fuelFrac: 0.4, cargoKg: 0 },
  { id: 'display', label: 'Display', fuelFrac: 0.15, cargoKg: 0 },
  { id: 'troops', label: 'Troops', fuelFrac: 0.6, cargoKg: 12240 },
  { id: 'airdrop', label: 'Heavy drop', fuelFrac: 0.4, cargoKg: 27200 },
  { id: 'cds', label: 'Airdrop (CDS)', fuelFrac: 0.4, cargoKg: 16000, airdrop: true },
  { id: 'max', label: 'Max payload', fuelFrac: 0.53, cargoKg: 77519 },
  { id: 'ferry', label: 'Ferry', fuelFrac: 1, cargoKg: 0 },
];

export const DEFAULT_TRANSPORT_LOAD: TransportLoad = { presetId: 'training', fuelFrac: 0.4, cargoKg: 0 };

/** A saved load made safe: fuel within the slider's range, cargo within the hold's limit (default if unusable). */
export function normalizeTransportLoad(def: AircraftDefinition, raw: unknown): TransportLoad {
  const r = raw && typeof raw === 'object' ? (raw as Partial<TransportLoad>) : undefined;
  if (!r || typeof r.fuelFrac !== 'number' || !Number.isFinite(r.fuelFrac)) return { ...DEFAULT_TRANSPORT_LOAD };
  const maxCargo = def.massModel?.maxCargoKg ?? 0;
  const cargo = typeof r.cargoKg === 'number' && Number.isFinite(r.cargoKg) ? Math.min(maxCargo, Math.max(0, r.cargoKg)) : 0;
  const out: TransportLoad = { fuelFrac: Math.min(1, Math.max(MIN_TRANSPORT_FUEL_FRAC, r.fuelFrac)), cargoKg: cargo };
  if (r.airdrop === true && cargo >= CDS_BUNDLE_KG) out.airdrop = true;
  const p = TRANSPORT_PRESETS.find((x) => x.id === r.presetId);
  if (p && p.fuelFrac === out.fuelFrac && p.cargoKg === out.cargoKg && !!p.airdrop === !!out.airdrop) out.presetId = p.id;
  return out;
}

/** The load on the mission's player start (the sim sets mass, CG and inertia from it). */
export function withTransportLoad(m: Mission, load: TransportLoad): Mission {
  const { airdrop: _a, ...ps } = m.playerStart;
  void _a;
  const rig = load.airdrop ? airdropRig(load.cargoKg) : undefined;
  return { ...m, playerStart: { ...ps, fuelFrac: load.fuelFrac, cargoKg: load.cargoKg, ...(rig ? { airdrop: rig } : {}) } };
}

export interface TransportWeight {
  fuelKg: number;
  cargoKg: number;
  kg: number;
  mtowKg: number | undefined;
  overKg: number;
  /** CG, fraction of MAC (undefined: no mass model). */
  cgMac: number | undefined;
  cgRangeMac: readonly [number, number] | undefined;
  /** Clean 1 g stall and the lowest speed with the full positive g limit (sea level, IAS), m/s. */
  stallMps: number;
  fullGMps: number;
}

const G = 9.80665;
const RHO0 = 1.225;

/** The clean CL at Mach 0.2 (the table's first column) at `alpha`, rad. */
function cleanCl(def: AircraftDefinition, alpha: number): number {
  const t = def.aero.CL;
  const xs = t.xs;
  let i = 0;
  while (i < xs.length - 2 && alpha > xs[i + 1]!) i++;
  const f = Math.min(1, Math.max(0, (alpha - xs[i]!) / (xs[i + 1]! - xs[i]!)));
  return t.zs[i]![0]! + (t.zs[i + 1]![0]! - t.zs[i]![0]!) * f;
}

export function transportWeight(def: AircraftDefinition, load: TransportLoad): TransportWeight {
  const fuelKg = def.maxFuelKg * Math.min(1, Math.max(0, load.fuelFrac));
  const cargoKg = Math.min(def.massModel?.maxCargoKg ?? 0, Math.max(0, load.cargoKg));
  const kg = def.emptyMassKg + fuelKg + cargoKg;
  const mtowKg = def.maxTakeoffMassKg;
  // Clean stall and the alpha limiter's CL (alphaLimitStallFrac of the stall alpha), Mach 0.2.
  const stallAlpha = def.aero.stallAlphaRad;
  const clMax = cleanCl(def, stallAlpha);
  const clLimit = cleanCl(def, (def.fcsLimits.alphaLimitStallFrac ?? 1) * stallAlpha);
  const wS = (kg * G) / def.wingAreaM2;
  return {
    fuelKg,
    cargoKg,
    kg,
    mtowKg,
    overKg: mtowKg ? Math.max(0, kg - mtowKg) : 0,
    cgMac: cgMacFraction(def, fuelKg, cargoKg),
    cgRangeMac: def.massModel?.cgRangeMac,
    stallMps: Math.sqrt((2 * wS) / (RHO0 * clMax)),
    fullGMps: Math.sqrt((2 * wS * def.fcsLimits.maxGLoadPos) / (RHO0 * clLimit)),
  };
}

const kgText = (n: number): string => Math.round(n).toLocaleString('en-US');
const tText = (n: number): string => `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} t`;
const KT = 0.514444;

/** "Training · 40% fuel · no cargo · 173 t". */
export function describeTransportLoad(def: AircraftDefinition, load: TransportLoad): string {
  const w = transportWeight(def, load);
  const name = TRANSPORT_PRESETS.find((p) => p.id === load.presetId)?.label ?? 'Custom';
  const rig = load.airdrop ? airdropRig(w.cargoKg) : undefined;
  return `${name} · ${Math.round(load.fuelFrac * 100)}% fuel · ${rig ? `${rig.bundles} CDS bundles` : w.cargoKg > 0 ? `${tText(w.cargoKg)} cargo` : 'no cargo'} · ${tText(w.kg)}`;
}

/** The 3D view of the aircraft (the hangar) while the planner is open. */
export type TransportLoadView = Omit<LoadoutView, 'setFit'>;

export interface TransportLoadCallbacks {
  onDone(load: TransportLoad): void;
  onCancel(): void;
}

export function createTransportLoadEditor(container: HTMLElement, def: AircraftDefinition, initial: TransportLoad, cb: TransportLoadCallbacks, view?: TransportLoadView): ScreenHandle {
  const load: TransportLoad = normalizeTransportLoad(def, initial);
  const maxCargo = def.massModel?.maxCargoKg ?? 0;
  const s = shell({ title: 'Load', eyebrow: def.displayName ?? def.id, back: { label: 'Cancel', onClick: () => cb.onCancel() }, ...(view ? { clear: true } : {}) });
  s.root.classList.add('tj-loadout', 'tj-transport-load');
  if (view) s.root.classList.add('tj-loadout--3d');
  s.panel.querySelector('.tj-title')?.remove();

  const presetRow = h('div', { className: 'tj-missions', attrs: { role: 'group', 'aria-label': 'Preset loads' } });
  const presetButtons = TRANSPORT_PRESETS.map((p) => {
    const b = h(
      'button',
      { className: 'tj-mission tj-mission--text', attrs: { type: 'button', 'data-preset': p.id, 'aria-pressed': 'false' } },
      h('span', { className: 'tj-mission-name', text: p.label }),
      h('span', { className: 'tj-mission-fit', text: `${p.airdrop ? `${Math.floor(p.cargoKg / CDS_BUNDLE_KG)} bundles` : `${p.cargoKg > 0 ? tText(p.cargoKg) : 'No'} cargo`} · ${Math.round(p.fuelFrac * 100)}% fuel` })
    );
    b.addEventListener('click', () => {
      load.fuelFrac = p.fuelFrac;
      load.cargoKg = p.cargoKg;
      if (p.airdrop) load.airdrop = true;
      else delete load.airdrop;
      fuelInput.value = String(Math.round(p.fuelFrac * 100));
      cargoInput.value = String(p.cargoKg);
      rigInput.checked = !!load.airdrop;
      render();
    });
    return b;
  });
  const customTag = h('span', { className: 'tj-mission tj-mission--custom', attrs: { 'aria-hidden': 'true' } }, h('span', { className: 'tj-mission-name', text: 'Custom' }), h('span', { className: 'tj-mission-fit', text: 'Your own load' }));
  presetRow.append(...presetButtons, customTag);

  const fuelInput = h('input', { className: 'tj-range', attrs: { type: 'range', min: String(MIN_TRANSPORT_FUEL_FRAC * 100), max: '100', step: '1', 'data-role': 'fuel', 'aria-label': 'Fuel' } });
  fuelInput.value = String(Math.round(load.fuelFrac * 100));
  fuelInput.addEventListener('input', () => {
    load.fuelFrac = Number(fuelInput.value) / 100;
    render();
  });
  const cargoInput = h('input', { className: 'tj-range', attrs: { type: 'range', min: '0', max: String(maxCargo), step: '500', 'data-role': 'cargo', 'aria-label': 'Cargo' } });
  cargoInput.value = String(load.cargoKg);
  cargoInput.addEventListener('input', () => {
    // The slider's top end is the exact limit (it is not a multiple of the step).
    const v = Number(cargoInput.value);
    load.cargoKg = v >= maxCargo - 250 ? maxCargo : v;
    render();
  });
  const rigInput = h('input', { attrs: { type: 'checkbox', 'data-role': 'airdrop-rig' } });
  rigInput.checked = !!load.airdrop;
  rigInput.addEventListener('change', () => {
    if (rigInput.checked) load.airdrop = true;
    else delete load.airdrop;
    render();
  });
  const rigOut = h('span', { className: 'tj-wt-val', attrs: { 'data-role': 'airdrop-value' } });
  const fuelOut = h('span', { className: 'tj-wt-val', attrs: { 'data-role': 'fuel-value' } });
  const cargoOut = h('span', { className: 'tj-wt-val', attrs: { 'data-role': 'cargo-value' } });
  const wtVal = h('span', { className: 'tj-wt-val', attrs: { 'data-role': 'weight' } });
  const wtFill = h('div', { className: 'tj-wt-fill' });
  const wtMark = h('div', { className: 'tj-wt-mtow' });
  const wtNote = h('p', { className: 'tj-wt-note', attrs: { 'data-role': 'overweight', 'aria-live': 'polite' } });
  const weightBox = h(
    'div',
    { className: 'tj-weight', attrs: { 'data-role': 'weight-box' } },
    h('div', { className: 'tj-wt-row' }, h('span', { className: 'tj-label', text: 'Fuel' }), fuelOut),
    fuelInput,
    h('div', { className: 'tj-wt-row' }, h('span', { className: 'tj-label', text: 'Cargo' }), cargoOut),
    cargoInput,
    h('label', { className: 'tj-wt-row', attrs: { style: 'cursor:pointer' } }, h('span', { className: 'tj-label' }, rigInput, ' Rig for airdrop (CDS)'), rigOut),
    h('div', { className: 'tj-wt-row' }, h('span', { className: 'tj-label', text: 'Take-off weight' }), wtVal),
    h('div', { className: 'tj-wt-bar' }, wtFill, wtMark),
    wtNote
  );
  const cgVal = h('span', { className: 'tj-wt-val', attrs: { 'data-role': 'cg' } });
  const cgBand = h('div', { className: 'tj-cg-band' });
  const cgMark = h('div', { className: 'tj-cg-mark' });
  const cgNote = h('p', { className: 'tj-wt-note', attrs: { 'data-role': 'cg-note' } });
  const cgBox = h(
    'div',
    { className: 'tj-weight tj-cg', attrs: { 'data-role': 'cg-box' } },
    h('div', { className: 'tj-wt-row' }, h('span', { className: 'tj-label', text: 'Centre of gravity' }), cgVal),
    h('div', { className: 'tj-wt-bar' }, cgBand, cgMark),
    cgNote
  );
  const perf = h('p', { className: 'tj-note', attrs: { 'data-role': 'performance' } });

  // The CG bar spans 10-50% MAC with the envelope shaded.
  const CG_LO = 0.1;
  const CG_HI = 0.5;
  const cgPct = (x: number): string => `${(((x - CG_LO) / (CG_HI - CG_LO)) * 100).toFixed(1)}%`;

  function render(): void {
    const match = TRANSPORT_PRESETS.find((p) => Math.abs(p.fuelFrac - load.fuelFrac) < 0.001 && Math.abs(p.cargoKg - load.cargoKg) < 1 && !!p.airdrop === !!load.airdrop);
    if (match) load.presetId = match.id;
    else delete load.presetId;
    for (const b of presetButtons) b.setAttribute('aria-pressed', String(b.getAttribute('data-preset') === match?.id));
    customTag.classList.toggle('tj-hidden', !!match);

    const w = transportWeight(def, load);
    fuelOut.textContent = `${Math.round(load.fuelFrac * 100)}% · ${kgText(w.fuelKg)} kg`;
    cargoOut.textContent = w.cargoKg > 0 ? `${kgText(w.cargoKg)} kg` : 'Empty hold';
    const rig = load.airdrop ? airdropRig(w.cargoKg) : undefined;
    rigOut.textContent = rig ? `${rig.bundles} × 1 t, ${rig.stick} a pass` : load.airdrop ? 'needs 1 t of cargo' : 'Off';
    wtVal.textContent = w.mtowKg ? `${kgText(w.kg)} / ${kgText(w.mtowKg)} kg` : `${kgText(w.kg)} kg`;
    const scale = w.mtowKg ? Math.max(w.mtowKg * 1.1, w.kg) : w.kg;
    wtFill.style.width = `${((w.kg / scale) * 100).toFixed(1)}%`;
    wtMark.style.left = w.mtowKg ? `${((w.mtowKg / scale) * 100).toFixed(1)}%` : '100%';
    weightBox.classList.toggle('is-over', w.overKg > 0);
    wtNote.textContent = !w.mtowKg
      ? ''
      : w.overKg > 0
        ? `Over MTOW by ${kgText(w.overKg)} kg: a longer take-off run, a slower climb, less turn.`
        : `${kgText(w.mtowKg - w.kg)} kg under MTOW.`;

    if (w.cgMac !== undefined && w.cgRangeMac) {
      const [lo, hi] = w.cgRangeMac;
      cgBox.classList.remove('tj-hidden');
      cgVal.textContent = `${(w.cgMac * 100).toFixed(1)}% MAC`;
      cgBand.style.left = cgPct(lo);
      cgBand.style.width = `${(((hi - lo) / (CG_HI - CG_LO)) * 100).toFixed(1)}%`;
      cgMark.style.left = cgPct(Math.min(CG_HI, Math.max(CG_LO, w.cgMac)));
      const out = w.cgMac < lo || w.cgMac > hi;
      cgBox.classList.toggle('is-over', out);
      cgNote.textContent = out
        ? `Outside the ${Math.round(lo * 100)}-${Math.round(hi * 100)}% envelope.`
        : `Inside the ${Math.round(lo * 100)}-${Math.round(hi * 100)}% envelope. Cargo is loaded at the CG; the wing fuel sits a little aft of it.`;
    } else cgBox.classList.add('tj-hidden');

    perf.textContent = `Clean stall at 1 g about ${Math.round(w.stallMps / KT)} kt; the full ${def.fcsLimits.maxGLoadPos} g from about ${Math.round(w.fullGMps / KT)} kt (sea level). Lighter turns harder.`;
  }
  render();

  s.body.append(presetRow, weightBox, cgBox, perf);
  s.actions.append(button('Done', () => cb.onDone({ ...load }), 'primary', { 'data-action': 'done' }));

  if (view) s.root.append(h('div', { className: 'tj-orbit-hint', text: 'Drag to walk round the aircraft · scroll or pinch to zoom' }));
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
