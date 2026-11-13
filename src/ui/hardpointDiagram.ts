/**
 * src/ui/hardpointDiagram.ts — the loadout's hardpoint diagram: the Tejas head-on in line art, each
 * pylon with what hangs on it drawn as its store would look from ahead (a missile as a body with
 * four fins, a tank as a big disc, a bomb with its tail fins, a laser-guided bomb with its seeker
 * cross, a rocket pod with its tubes, the targeting pod), and the stations' numbered badges in a row
 * under the wing, joined to their pylons. Click a pylon or a badge to choose what it carries.
 *
 * Station numbers as the aircraft's: 1/3/5 left wing inner to outer, 2/4/6 right, 7 the centreline,
 * L the targeting pod on the intake. Seen from ahead, so the left wing is on the right.
 *
 * Pure: builds SVG markup (`hardpointSvg`, `storeIconSvg`); the editor (loadoutEditor.ts) wires it.
 */
import { FUEL_TANKS, SENSOR_PODS, WEAPONS } from '../catalog';

export interface HardpointStation {
  id: string;
  /** The aircraft's station number ("1".."7", "L"). */
  num: string;
  label: string;
  /** Span position from the centreline, m (+ right wing). */
  spanM: number;
  /** Hangs under the fuselage or an intake (not the wing). */
  body?: boolean;
}

/** The Tejas's stations, in the badge row's order (as seen head-on: the right wing on the left). */
export const TEJAS_STATIONS: readonly HardpointStation[] = [
  { id: 'wing-outer-r', num: '6', label: 'Right outer', spanM: 3.42 },
  { id: 'wing-mid-r', num: '4', label: 'Right middle', spanM: 2.66 },
  { id: 'wing-inner-r', num: '2', label: 'Right inner', spanM: 1.68 },
  { id: 'centreline', num: '7', label: 'Centreline', spanM: 0, body: true },
  { id: 'intake-pod', num: 'L', label: 'Targeting pod', spanM: -0.74, body: true },
  { id: 'wing-inner-l', num: '1', label: 'Left inner', spanM: -1.68 },
  { id: 'wing-mid-l', num: '3', label: 'Left middle', spanM: -2.66 },
  { id: 'wing-outer-l', num: '5', label: 'Left outer', spanM: -3.42 },
];

export type StoreShape = 'ir' | 'radar' | 'tank' | 'bomb' | 'lgb' | 'rocket' | 'arm' | 'pod';

/** How a store is drawn. */
export function storeShape(id: string): StoreShape {
  if (FUEL_TANKS[id]) return 'tank';
  if (SENSOR_PODS[id]) return 'pod';
  switch (WEAPONS[id]?.kind) {
    case 'ir_missile':
      return 'ir';
    case 'radar_missile':
      return 'radar';
    case 'guided_bomb':
      return 'lgb';
    case 'rocket':
      return 'rocket';
    case 'arm':
      return 'arm';
    default:
      return 'bomb';
  }
}

/** Short name for a badge ("ASRAAM", "1200L"). */
export function storeShort(id: string): string {
  const t = FUEL_TANKS[id];
  if (t) return t.name.replace(/\s*tank$/i, '').replace(/\s+/g, '');
  if (SENSOR_PODS[id]) return SENSOR_PODS[id]!.name.split(' ')[0]!.toUpperCase();
  return (WEAPONS[id]?.label ?? id).toUpperCase();
}

const fins = (x: number, y: number, r: number, len: number, w = 1.6): string =>
  [45, 135, 225, 315]
    .map((a) => {
      const c = Math.cos((a * Math.PI) / 180);
      const s = Math.sin((a * Math.PI) / 180);
      return `<line x1="${(x + c * r).toFixed(1)}" y1="${(y + s * r).toFixed(1)}" x2="${(x + c * (r + len)).toFixed(1)}" y2="${(y + s * (r + len)).toFixed(1)}" stroke-width="${w}"/>`;
    })
    .join('');

/** A store seen from ahead, centred on (x, y), in SVG (class hp-store-<shape>). */
export function storeGlyph(shape: StoreShape, x: number, y: number, k = 1): string {
  const r = (v: number): string => (v * k).toFixed(1);
  const g = (inner: string): string => `<g class="hp-store hp-store-${shape}">${inner}</g>`;
  switch (shape) {
    case 'ir':
      return g(`<circle cx="${x}" cy="${y}" r="${r(3.6)}"/>${fins(x, y, 3.6 * k, 6 * k)}`);
    case 'radar':
      return g(`<circle cx="${x}" cy="${y}" r="${r(4.4)}"/>${fins(x, y, 4.4 * k, 7.5 * k)}<circle cx="${x}" cy="${y}" r="${r(1.4)}" class="hp-dot"/>`);
    case 'tank':
      return g(`<circle cx="${x}" cy="${y}" r="${r(12)}"/><circle cx="${x}" cy="${y}" r="${r(3)}" class="hp-dot"/>`);
    case 'bomb':
      return g(`<circle cx="${x}" cy="${y}" r="${r(7)}"/>${fins(x, y, 7 * k, 4.5 * k, 2.2)}`);
    case 'lgb':
      return g(`<circle cx="${x}" cy="${y}" r="${r(7)}"/>${fins(x, y, 7 * k, 4.5 * k, 2.2)}<line x1="${x - 7 * k}" y1="${y}" x2="${x + 7 * k}" y2="${y}" stroke-width="1.2"/><line x1="${x}" y1="${y - 7 * k}" x2="${x}" y2="${y + 7 * k}" stroke-width="1.2"/><circle cx="${x}" cy="${y}" r="${r(2.6)}"/>`);
    case 'rocket': {
      const tubes = [0, 60, 120, 180, 240, 300].map((a) => `<circle cx="${(x + Math.cos((a * Math.PI) / 180) * 4.6 * k).toFixed(1)}" cy="${(y + Math.sin((a * Math.PI) / 180) * 4.6 * k).toFixed(1)}" r="${r(1.5)}" class="hp-hole"/>`).join('');
      return g(`<circle cx="${x}" cy="${y}" r="${r(8.5)}"/>${tubes}<circle cx="${x}" cy="${y}" r="${r(1.5)}" class="hp-hole"/>`);
    }
    case 'arm':
      return g(`<circle cx="${x}" cy="${y}" r="${r(4.8)}"/>${fins(x, y, 4.8 * k, 8 * k)}<rect x="${x - 2 * k}" y="${y - 2 * k}" width="${r(4)}" height="${r(4)}" class="hp-dot" transform="rotate(45 ${x} ${y})"/>`);
    case 'pod':
      return g(`<circle cx="${x}" cy="${y}" r="${r(6)}"/><circle cx="${x}" cy="${y}" r="${r(2.6)}" class="hp-lens"/>`);
  }
}

/** A store's icon on its own (the picker's buttons). */
export function storeIconSvg(id: string, count = 1): string {
  const shape = storeShape(id);
  const body = count >= 2 ? storeGlyph(shape, 13, 17, 0.75) + storeGlyph(shape, 31, 17, 0.75) : storeGlyph(shape, 22, 17, shape === 'tank' ? 1.15 : 1.35);
  return `<svg class="hp-icon" viewBox="0 0 44 34" aria-hidden="true">${body}</svg>`;
}

const W = 600;
const CX = W / 2;
const PX_PER_M = 72;
const WING_ROOT_Y = 104;
const WING_TIP_Y = 116;
/** The wing's underside at x (a slight droop to the tips). */
const wingBottom = (x: number): number => {
  const u = Math.min(1, Math.abs(x - CX) / (4.1 * PX_PER_M));
  return WING_ROOT_Y + 14 + (WING_TIP_Y + 3 - WING_ROOT_Y - 14) * u;
};
const BADGE_Y = 214;
/** Stores drawn larger than life on the drawing (they read better). */
const SK = 1.45;
const BADGE_W = 64;
const BADGE_H = 42;

/**
 * The diagram for a fit: `fit` station id -> store and count, `selected` the station being edited,
 * `stations` those the aircraft has (others are left out).
 */
export function hardpointSvg(fit: Readonly<Record<string, { store: string; count: number } | undefined>>, selected: string | undefined, have: ReadonlySet<string>): string {
  const sts = TEJAS_STATIONS.filter((s) => have.has(s.id));
  const parts: string[] = [];
  // The airframe head-on: wings (thin, drooping a touch), fuselage and radome, intakes, canopy, fin.
  const tip = 4.1 * PX_PER_M;
  const wing = (dir: number): string => {
    const xr = CX + dir * 30;
    const xt = CX + dir * tip;
    return `<path d="M${xr} ${WING_ROOT_Y} L${xt} ${WING_TIP_Y} Q${xt + dir * 6} ${WING_TIP_Y + 2} ${xt} ${WING_TIP_Y + 4} L${xr} ${WING_ROOT_Y + 14} Z"/>`;
  };
  parts.push(`<g class="hp-air">`);
  parts.push(`<path class="hp-fin" d="M${CX - 5} 82 L${CX - 2.5} 14 L${CX + 2.5} 14 L${CX + 5} 82 Z"/><line x1="${CX}" y1="14" x2="${CX}" y2="4"/>`);
  parts.push(wing(-1), wing(1));
  parts.push(`<path d="M${CX - 18} 90 Q${CX} 64 ${CX + 18} 90 Z" class="hp-canopy"/>`);
  for (const d of [-1, 1]) {
    const x = CX + d * 44;
    parts.push(`<rect x="${x - 15}" y="104" width="30" height="40" rx="11"/><ellipse cx="${x}" cy="125" rx="9.5" ry="13" class="hp-intake"/>`);
  }
  parts.push(`<ellipse cx="${CX}" cy="112" rx="30" ry="32"/><circle cx="${CX}" cy="116" r="22" class="hp-radome"/>`);
  parts.push(`</g>`);
  // Pylons, stores, leader lines and badges.
  const step = (W - 40) / Math.max(1, sts.length);
  sts.forEach((st, i) => {
    const x = Math.round(CX - st.spanM * PX_PER_M * (st.body && st.id === 'intake-pod' ? 0.6 / 0.74 : 1));
    const top = st.body ? (st.id === 'centreline' ? 144 : 144) : wingBottom(x);
    const pyl = top + 8;
    const f = fit[st.id];
    const sel = st.id === selected;
    const bx = Math.round(20 + step * (i + 0.5));
    const cls = `hp-st${sel ? ' is-sel' : ''}${f ? ' is-full' : ''}`;
    parts.push(`<g class="${cls}" data-station="${st.id}" tabindex="0" role="button" aria-label="Station ${st.num}, ${st.label}: ${f ? storeShort(f.store) : 'empty'}">`);
    // Hit area round the pylon and its store.
    parts.push(`<rect class="hp-hit" x="${x - 18}" y="${top - 4}" width="36" height="${BADGE_Y - top + 4}"/>`);
    parts.push(`<rect class="hp-pylon" x="${x - 3}" y="${top}" width="6" height="8" rx="1"/>`);
    let storeY = pyl + 8;
    if (f) {
      const shape = storeShape(f.store);
      const r = (shape === 'tank' ? 12 : shape === 'rocket' ? 8.5 : shape === 'bomb' || shape === 'lgb' ? 7 : 5) * SK;
      storeY = pyl + r + 1;
      if (f.count >= 2) {
        const dx = shape === 'ir' || shape === 'radar' || shape === 'arm' ? 13 : 15;
        parts.push(`<line class="hp-rail" x1="${x - dx}" y1="${pyl}" x2="${x + dx}" y2="${pyl}"/>`);
        parts.push(storeGlyph(shape, x - dx, storeY + 2, SK * 0.85), storeGlyph(shape, x + dx, storeY + 2, SK * 0.85));
      } else parts.push(storeGlyph(shape, x, storeY, SK));
      storeY += r + 2;
    }
    parts.push(`<path class="hp-lead" d="M${x} ${storeY + 2} L${x} ${BADGE_Y - 18} L${bx} ${BADGE_Y - 6} L${bx} ${BADGE_Y}"/>`);
    parts.push(`<rect class="hp-badge" x="${bx - BADGE_W / 2}" y="${BADGE_Y}" width="${BADGE_W}" height="${BADGE_H}" rx="2"/>`);
    parts.push(`<text class="hp-num" x="${bx}" y="${BADGE_Y + 16}">${st.num}</text>`);
    parts.push(`<text class="hp-what" x="${bx}" y="${BADGE_Y + 34}">${f ? `${f.count >= 2 ? '2× ' : ''}${storeShort(f.store)}` : '—'}</text>`);
    parts.push(`</g>`);
  });
  return `<svg class="hp-svg" viewBox="0 0 ${W} ${BADGE_Y + BADGE_H + 4}" role="group" aria-label="Hardpoints, seen from ahead">${parts.join('')}</svg>`;
}
