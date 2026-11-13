/**
 * src/ui/hardpointDiagram.ts — the loadout's hardpoint diagram: the Tejas head-on in line art, each
 * pylon with what hangs on it drawn as its store would look from ahead (a missile as a body with
 * four fins, a tank as a big disc, a bomb with its tail fins, a laser-guided bomb with its seeker
 * cross, a rocket pod with its tubes, the targeting pod), and the stations' numbered badges in a row
 * under the wing, joined to their pylons. Click a pylon or a badge to choose what it carries.
 *
 * Station numbers as the aircraft's: 1/3/5 left wing inner to outer, 2/4/6 right, 7 the centreline,
 * L the targeting pod on the intake. Seen from ahead, so the left wing is on the right. The airframe
 * is traced from the Tejas weapon-stations drawing (see `ref` below).
 *
 * Pure: builds SVG markup (`hardpointSvg`, `storeIconSvg`); the editor (loadoutEditor.ts) wires it.
 */
import { FUEL_TANKS, JAMMER_PODS, SENSOR_PODS, WEAPONS } from '../catalog';

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

export type StoreShape = 'ir' | 'radar' | 'tank' | 'bomb' | 'lgb' | 'rocket' | 'arm' | 'pod' | 'jammer';

/** How a store is drawn. */
export function storeShape(id: string): StoreShape {
  if (FUEL_TANKS[id]) return 'tank';
  if (SENSOR_PODS[id]) return 'pod';
  if (JAMMER_PODS[id]) return 'jammer';
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
  if (JAMMER_PODS[id]) return JAMMER_PODS[id]!.label;
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
    case 'jammer': {
      // The pod head-on, its dark radome, and radiating arcs either side.
      const arc = (d: number, s: number): string => `<path class="hp-wave" d="M${(x + s * d * k).toFixed(1)} ${(y - d * 0.8 * k).toFixed(1)} Q${(x + s * (d + 2.2) * k).toFixed(1)} ${y} ${(x + s * d * k).toFixed(1)} ${(y + d * 0.8 * k).toFixed(1)}"/>`;
      return g(`<circle cx="${x}" cy="${y}" r="${r(5)}"/><circle cx="${x}" cy="${y}" r="${r(3)}" class="hp-dot"/>${arc(7.5, 1)}${arc(7.5, -1)}${arc(10.5, 1)}${arc(10.5, -1)}`);
    }
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
/**
 * The airframe is traced from the Tejas weapon-stations drawing (Wikimedia Commons, "HAL Tejas
 * weapon stations", A. Shukla, CC BY-SA 3.0, after tejas.gov.in): its outlines are written below in
 * that drawing's pixels (centreline x = 490, wingtip x = 120) and mapped onto this one by `ref`.
 */
const REF_CX = 490;
const REF_K = 0.8;
const refX = (x: number): number => CX + (x - REF_CX) * REF_K;
const refY = (y: number): number => (y - 8) * REF_K + 4;
/** A path in the reference drawing's pixels ("x,y" pairs), mapped here; `mirror` for the other side. */
const ref = (d: string, mirror = false): string =>
  d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, x: string, y: string) => `${refX(mirror ? 2 * REF_CX - Number(x) : Number(x)).toFixed(1)},${refY(Number(y)).toFixed(1)}`);
/** Span scale: the reference's half-span (370 px) is 4.1 m. */
const PX_PER_M = (370 * REF_K) / 4.1;

/** One side of the airframe (the left of the drawing: the aircraft's right). */
const SIDE = [
  // The wing: the upper surface sweeping up into the fuselage (the blended root), the lower nearly flat.
  `<path class="hp-wing" d="M457,226 C432,240 408,247 380,251 C330,256 220,259 126,261 Q112,263 126,266 L142,268 C230,268 330,269 404,270 L448,262 L452,236 Z"/>`,
  `<path class="hp-thin" d="M330,268 C380,265 420,262 448,259"/>`,
  // The intake: its outer wall, and the D-shaped mouth beside the splitter.
  `<path d="M404,262 L404,300 C404,322 420,333 440,334 L449,329 L449,258 Z"/>`,
  `<path class="hp-intake" d="M441,277 C424,277 410,288 410,304 C410,320 424,330 441,330 Z"/>`,
];

/** The airframe head-on, as SVG. */
function airframe(): string {
  const p: string[] = ['<g class="hp-air">'];
  // The fin: its root fairing, the tapering fin, the tip with its crossbar and the pitot.
  p.push(ref(`<path d="M476,188 L482,178 L498,178 L504,188 Z"/>`));
  p.push(ref(`<path class="hp-fin" d="M481,178 L487,36 L493,36 L499,178 Z"/>`));
  p.push(ref(`<path class="hp-fin" d="M486,37 L488,25 L491,22 L495,30 L494,37 Z"/>`));
  p.push(ref(`<path class="hp-line" d="M476,31 L506,31 M491,23 L491,9"/>`));
  for (const s of SIDE) p.push(ref(s), ref(s, true));
  // The fuselage: the cheeks either side down to the belly, the radome between them.
  p.push(ref(`<path d="M455,228 C449,236 448,245 448,252 L448,328 C450,334 458,338 468,338 L512,338 C522,338 530,334 532,328 L532,252 C532,245 531,236 525,228 Z"/>`));
  p.push(`<circle class="hp-radome" cx="${refX(490)}" cy="${refY(293)}" r="${(37 * REF_K).toFixed(1)}"/>`);
  // The canopy: the dome, its frame arcs, the nose below it.
  p.push(ref(`<path class="hp-canopy" d="M456,226 C455,200 470,184 490,183 C510,184 525,200 524,226 Z"/>`));
  p.push(ref(`<path class="hp-thin" d="M459,226 C462,206 476,197 490,197 C504,197 518,206 521,226 M462,228 C465,210 478,202 490,202 C502,202 515,210 518,228"/>`));
  p.push(ref(`<path d="M459,226 L460,247 C462,253 470,254 480,254 C486,254 488,251 490,251 C492,251 494,254 500,254 C510,254 518,253 520,247 L521,226 Z"/>`));
  p.push('</g>');
  return p.join('');
}
const AIRFRAME = airframe();

/** Where each station's pylon hangs from (the reference's pixels): under the wing, the belly, the left intake. */
const WING_UNDER_Y = 269;
const BELLY_Y = 338;
const INTAKE_UNDER_Y = 334;
const INTAKE_X = 2 * REF_CX - 425;
const BADGE_Y = 326;
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
  const parts: string[] = [AIRFRAME];
  // Pylons, stores, leader lines and badges.
  const step = (W - 40) / Math.max(1, sts.length);
  sts.forEach((st, i) => {
    const x = st.id === 'intake-pod' ? Math.round(refX(INTAKE_X)) : Math.round(CX - st.spanM * PX_PER_M);
    const top = refY(st.id === 'centreline' ? BELLY_Y : st.id === 'intake-pod' ? INTAKE_UNDER_Y : WING_UNDER_Y);
    const pylH = st.body ? 6 : 10;
    const pyl = top + pylH;
    const f = fit[st.id];
    const sel = st.id === selected;
    const bx = Math.round(20 + step * (i + 0.5));
    const cls = `hp-st${sel ? ' is-sel' : ''}${f ? ' is-full' : ''}`;
    parts.push(`<g class="${cls}" data-station="${st.id}" tabindex="0" role="button" aria-label="Station ${st.num}, ${st.label}: ${f ? storeShort(f.store) : 'empty'}">`);
    // Hit area round the pylon and its store.
    parts.push(`<rect class="hp-hit" x="${x - 18}" y="${top - 4}" width="36" height="${BADGE_Y - top + 4}"/>`);
    // The pylon: a short open-topped bracket, as drawn on the reference.
    parts.push(`<path class="hp-pylon" d="M${x - 4} ${top} L${x - 4} ${pyl} L${x + 4} ${pyl} L${x + 4} ${top}"/>`);
    let storeY = pyl + 6;
    if (f) {
      const shape = storeShape(f.store);
      const r = (shape === 'tank' ? 12 : shape === 'rocket' ? 8.5 : shape === 'bomb' || shape === 'lgb' ? 7 : shape === 'jammer' ? 5.5 : 5) * SK;
      storeY = pyl + r + 1;
      if (f.count >= 2) {
        const dx = shape === 'ir' || shape === 'radar' || shape === 'arm' ? 13 : 15;
        parts.push(`<line class="hp-rail" x1="${x - dx}" y1="${pyl}" x2="${x + dx}" y2="${pyl}"/>`);
        parts.push(storeGlyph(shape, x - dx, storeY + 2, SK * 0.85), storeGlyph(shape, x + dx, storeY + 2, SK * 0.85));
      } else parts.push(storeGlyph(shape, x, storeY, SK));
      storeY += r + 2;
    }
    parts.push(`<path class="hp-lead" d="M${x} ${storeY + 2} L${x} ${Math.max(storeY + 4, BADGE_Y - 18)} L${bx} ${BADGE_Y - 6} L${bx} ${BADGE_Y}"/>`);
    parts.push(`<rect class="hp-badge" x="${bx - BADGE_W / 2}" y="${BADGE_Y}" width="${BADGE_W}" height="${BADGE_H}" rx="2"/>`);
    parts.push(`<text class="hp-num" x="${bx}" y="${BADGE_Y + 16}">${st.num}</text>`);
    parts.push(`<text class="hp-what" x="${bx}" y="${BADGE_Y + 34}">${f ? `${f.count >= 2 ? '2× ' : ''}${storeShort(f.store)}` : '—'}</text>`);
    parts.push(`</g>`);
  });
  return `<svg class="hp-svg" viewBox="0 0 ${W} ${BADGE_Y + BADGE_H + 4}" role="group" aria-label="Hardpoints, seen from ahead">${parts.join('')}</svg>`;
}
