/**
 * src/render/aircraftModels/tejasLivery.ts — the Tejas Mk1A's markings and panel lines, painted
 * into one texture the aircraft shader projects onto the airframe.
 *
 * Four tiles: starboard side and port side (projected along z: fuselage flanks, fin, intakes), top
 * and bottom (projected along y: wings, spine, belly). The shader picks a tile by the surface
 * normal (aircraftMaterial.ts). Markings after ADA's 3-view artwork and photographs of Mk1A LA-5033
 * and FOC LA-5021: the fin serial above the tricolour fin flash (saffron at the viewer's left on
 * both sides), roundels under the windscreen and on the outer wings, the "Tejas" script, the RESCUE
 * arrow and ejection-seat warning triangle, DANGER INTAKE stencils, the red walkway lines on the
 * wings, NO STEP, and the panel lines. Colours are display values (sRGB); alpha is coverage. Panel
 * lines are near-black so a hostile aircraft (no markings) can keep just them.
 */
import * as THREE from 'three';
import { XREF, YREF } from './tejasModel';

/** How body positions map onto the tiles (the shader gets the same numbers). */
export const LIVERY_MAP = {
  /** Body x range covered by every tile (tail to beyond the pitot). */
  x0: -5.9,
  x1: 7.9,
  /** Side tiles: body y range. */
  y0: -1.0,
  y1: 3.2,
  /** Top/bottom tiles: body |z| range. */
  halfZ: 4.3,
} as const;

const W = 4096;
const H = 2048;
const TW = W / 2;
const TH = H / 2;

type Tile = 'right' | 'left' | 'top' | 'bottom';

const st2x = (st: number): number => XREF - st;
const h2y = (h: number): number => h + YREF;

/** Canvas px for a body point on a tile. Side tiles: (x, y); top/bottom: (x, z). */
function px(tile: Tile, x: number, b: number): [number, number] {
  const u = (x - LIVERY_MAP.x0) / (LIVERY_MAP.x1 - LIVERY_MAP.x0);
  if (tile === 'right' || tile === 'left') {
    const v = (b - LIVERY_MAP.y0) / (LIVERY_MAP.y1 - LIVERY_MAP.y0);
    // The port tile is mirrored (nose on the left), as it is seen.
    return [tile === 'right' ? u * TW : TW + (1 - u) * TW, (1 - v) * TH];
  }
  const v = (b + LIVERY_MAP.halfZ) / (2 * LIVERY_MAP.halfZ);
  return [(tile === 'top' ? 0 : TW) + u * TW, TH + (1 - v) * TH];
}
/** Canvas px per metre along x on a tile (same along the other axis for side tiles). */
const pxPerM = (tile: Tile): number => TW / (LIVERY_MAP.x1 - LIVERY_MAP.x0) * (tile === 'right' || tile === 'left' ? 1 : 1);
const pxPerMb = (tile: Tile): number => (tile === 'right' || tile === 'left' ? TH / (LIVERY_MAP.y1 - LIVERY_MAP.y0) : TH / (2 * LIVERY_MAP.halfZ));

const SAFFRON = '#ff8f2e';
const WHITE = '#f1f1ec';
const GREEN = '#138a36';
const LINE = 'rgba(8,10,12,0.42)';
const LINE_FAINT = 'rgba(8,10,12,0.22)';
const STENCIL = '#1a1c1e';
const RED = '#c8261c';
const YELLOW = '#f2c21a';

export function paintTejasLivery(serial = 'LA-5033'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);

  /**
   * Draws in a tile with metres, at station/height (side) or station/span (top, bottom); on the
   * port tile the view is mirrored (nose on the left) so text still reads left to right.
   */
  const at = (tile: Tile, draw: (m: { p: (st: number, b: number) => [number, number]; k: number; kb: number; mirror: boolean }) => void): void => {
    g.save();
    const x0 = tile === 'right' || tile === 'top' ? 0 : TW;
    const y0 = tile === 'right' || tile === 'left' ? 0 : TH;
    g.beginPath();
    g.rect(x0, y0, TW, TH);
    g.clip();
    const side = tile === 'right' || tile === 'left';
    draw({ p: (st, b) => px(tile, st2x(st), side ? h2y(b) : b), k: pxPerM(tile), kb: pxPerMb(tile), mirror: tile === 'left' });
    g.restore();
  };
  const line = (a: [number, number], b: [number, number], width: number, style = LINE): void => {
    g.strokeStyle = style;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(a[0], a[1]);
    g.lineTo(b[0], b[1]);
    g.stroke();
  };
  /** Text centred at a point, `hM` metres tall, reading left to right as seen from its tile's side. */
  const text = (m: { k: number; kb: number }, at0: [number, number], s: string, hM: number, color: string, fontStyle = 'bold', family = 'Arial Narrow, Arial, sans-serif', angle = 0): void => {
    g.save();
    g.translate(at0[0], at0[1]);
    // Side tiles squash vertically (kb != k): undo it so letters keep their shape.
    g.scale(1, m.kb / m.k);
    g.rotate(angle);
    g.font = `${fontStyle} ${hM * m.k}px ${family}`;
    g.fillStyle = color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(s, 0, 0);
    g.restore();
  };
  const roundel = (centre: [number, number], rM: number, k: number, kb: number): void => {
    for (const [r, col] of [
      [1, SAFFRON],
      [0.667, WHITE],
      [0.333, GREEN],
    ] as const) {
      g.fillStyle = col;
      g.beginPath();
      g.ellipse(centre[0], centre[1], rM * r * k, rM * r * kb, 0, 0, Math.PI * 2);
      g.fill();
    }
  };

  // --- Sides (both). ---
  for (const tile of ['right', 'left'] as const) {
    at(tile, ({ p, k, kb, mirror }) => {
      const lw = Math.max(1.5, k * 0.008);
      // Vertical panel seams along the fuselage (the radome joint strongest).
      line(p(1.96, 0.6), p(1.96, -0.36), lw * 1.6);
      for (const st of [2.95, 4.95, 6.15, 7.35, 8.55, 9.75, 10.95, 12.15]) line(p(st, 1.3), p(st, -0.5), lw);
      // Horizontal: the longeron line along the flank, and the spine seam.
      for (const [a, b, h] of [
        [1.96, 4.9, 0.05],
        [4.9, 12.9, 0.62],
        [4.9, 12.2, 0.95],
        [4.9, 11.6, -0.2],
      ] as const) line(p(a, h), p(b, h), lw, LINE_FAINT);
      // Access panels: small rectangles and hatches.
      g.strokeStyle = LINE;
      g.lineWidth = lw;
      for (const [s0, h0, s1, h1] of [
        [2.2, 0.25, 2.65, 0.0],
        [3.55, -0.05, 4.1, -0.25],
        [5.3, 0.85, 5.8, 0.72],
        [6.6, 0.8, 7.2, 0.68],
        [8.0, 0.55, 8.8, 0.35],
        [10.1, 0.85, 10.7, 0.7],
        [11.3, 0.4, 11.8, 0.2],
        [12.25, 0.95, 12.75, 0.8],
      ] as const) {
        const a = p(s0, h0);
        const b = p(s1, h1);
        g.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      }
      // Rivet rows (faint dots) along the seams.
      g.fillStyle = 'rgba(8,10,12,0.18)';
      for (let st = 5.0; st < 12.8; st += 0.08) {
        const q = p(st, 0.62);
        g.fillRect(q[0], q[1] - 3, 2, 2);
      }

      // --- Markings. ---
      // Fin: serial above the tricolour flash; saffron at the viewer's left.
      const finSt = 12.2;
      text({ k, kb }, p(finSt + 0.03, 2.28), serial, 0.2, STENCIL);
      const bandW = 0.19;
      const cols = [SAFFRON, WHITE, GREEN];
      for (let i = 0; i < 3; i++) {
        // Order along the aircraft: seen from starboard (nose right) the viewer's left is aft.
        const idx = mirror ? i : 2 - i;
        const s0 = finSt - 0.3 + i * bandW;
        const a = p(s0 + bandW, 1.98);
        const b = p(s0, 1.62);
        g.fillStyle = cols[idx]!;
        g.fillRect(Math.min(a[0], b[0]), a[1], Math.abs(b[0] - a[0]), b[1] - a[1]);
      }
      // Small yellow "2" servicing numerals either side of the serial.
      text({ k, kb }, p(finSt + 0.62, 2.3), '2', 0.1, YELLOW);
      text({ k, kb }, p(finSt - 0.55, 2.3), '2', 0.1, YELLOW);
      // Forward fuselage: roundel below the windscreen, the Tejas script ahead of it.
      roundel(p(3.35, 0.28), 0.17, k, kb);
      text({ k, kb }, p(2.72, 0.46), 'Tejas', 0.13, STENCIL, 'italic', 'Georgia, "Times New Roman", serif');
      // Ejection-seat warning triangle (red, point down) behind the roundel.
      const tri = p(3.78, 0.5);
      const t = 0.075;
      g.fillStyle = RED;
      g.beginPath();
      g.moveTo(tri[0] - t * k, tri[1] - t * kb * 0.6);
      g.lineTo(tri[0] + t * k, tri[1] - t * kb * 0.6);
      g.lineTo(tri[0], tri[1] + t * kb);
      g.closePath();
      g.fill();
      g.fillStyle = WHITE;
      g.beginPath();
      g.moveTo(tri[0] - t * 0.55 * k, tri[1] - t * kb * 0.35);
      g.lineTo(tri[0] + t * 0.55 * k, tri[1] - t * kb * 0.35);
      g.lineTo(tri[0], tri[1] + t * kb * 0.55);
      g.closePath();
      g.fill();
      // RESCUE: yellow arrow with black letters, pointing at the canopy release.
      const r0 = p(3.05, 0.0);
      const r1 = p(3.55, 0.0);
      const dir = r1[0] > r0[0] ? 1 : -1;
      g.fillStyle = YELLOW;
      g.beginPath();
      g.moveTo(r0[0], r0[1] - 0.045 * kb);
      g.lineTo(r1[0], r1[1] - 0.045 * kb);
      g.lineTo(r1[0] + dir * 0.06 * k, r1[1]);
      g.lineTo(r1[0], r1[1] + 0.045 * kb);
      g.lineTo(r0[0], r0[1] + 0.045 * kb);
      g.closePath();
      g.fill();
      text({ k, kb }, [(r0[0] + r1[0]) / 2, r0[1]], 'RESCUE', 0.06, STENCIL);
      // DANGER INTAKE on the intake flank.
      text({ k, kb }, p(5.25, 0.15), 'DANGER', 0.065, RED);
      text({ k, kb }, p(5.25, 0.05), 'INTAKE', 0.065, RED);
      // Canopy jettison stencil and small data blocks.
      text({ k, kb }, p(2.35, -0.12), 'NO PUSH', 0.045, STENCIL);
      text({ k, kb }, p(11.6, 0.95), 'NO STEP', 0.045, STENCIL);
    });
  }

  // --- Top: wings and spine. ---
  at('top', ({ p, k, kb }) => {
    const lw = Math.max(1.5, k * 0.01);
    for (const s of [-1, 1]) {
      // Roundels on the outer wings.
      roundel(p(10.1, s * 2.95), 0.2, k, kb);
      // Red walkway lines: along the inner wing parallel to the fuselage, then out along the leading edge.
      g.setLineDash([k * 0.1, k * 0.07]);
      line(p(7.1, s * 1.05), p(10.4, s * 1.05), lw * 1.2, RED);
      line(p(6.7, s * 1.3), p(9.0, s * 2.45), lw * 1.2, RED);
      line(p(10.4, s * 1.05), p(10.4, s * 2.45), lw * 1.2, RED);
      g.setLineDash([]);
      // Ground-point dots.
      g.fillStyle = RED;
      for (const [st, z] of [
        [9.4, 2.1],
        [8.2, 1.25],
      ] as const) {
        const q = p(st, s * z);
        g.beginPath();
        g.arc(q[0], q[1], 0.035 * k, 0, Math.PI * 2);
        g.fill();
      }
      // Panel lines on the wing: spar lines and access panels.
      for (const [a, b] of [
        [[6.4, 1.2], [10.1, 1.2]],
        [[8.6, 2.9], [10.4, 2.9]],
        [[7.2, 1.6], [7.2, 0.9]],
      ] as const) line(p(a[0], s * a[1]), p(b[0], s * b[1]), lw * 0.7, LINE_FAINT);
      g.strokeStyle = LINE;
      g.lineWidth = lw * 0.8;
      for (const [st, z, w, d] of [
        [8.4, 1.9, 0.5, 0.3],
        [9.6, 3.35, 0.35, 0.2],
        [7.6, 1.45, 0.3, 0.22],
      ] as const) {
        const a = p(st, s * (z - d / 2));
        const b = p(st + w, s * (z + d / 2));
        g.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      }
      text({ k, kb }, p(8.1, s * 2.25), 'NO STEP', 0.07, STENCIL, 'bold', 'Arial Narrow, Arial, sans-serif', s > 0 ? Math.atan(1 / 1.92) : -Math.atan(1 / 1.92));
      // Spine and fuselage-top seams.
      line(p(4.9, s * 0.22), p(12.9, s * 0.22), lw * 0.7, LINE_FAINT);
    }
    for (const st of [1.96, 6.15, 7.35, 8.55, 9.75, 10.95, 12.15]) line(p(st, -0.45), p(st, 0.45), lw * (st === 1.96 ? 1.4 : 0.8));
  });

  // --- Bottom: belly and wing undersides. ---
  at('bottom', ({ p, k, kb }) => {
    const lw = Math.max(1.5, k * 0.01);
    for (const s of [-1, 1]) {
      roundel(p(10.2, s * 2.9), 0.19, k, kb);
      line(p(6.4, s * 1.25), p(10.4, s * 1.25), lw * 0.7, LINE_FAINT);
      g.strokeStyle = LINE;
      g.lineWidth = lw * 0.9;
      for (const [st, z, w, d] of [
        [7.7, 0.6, 1.05, 0.34],
        [8.9, 1.9, 0.45, 0.3],
        [9.8, 3.0, 0.3, 0.22],
        [2.75, 0.0, 1.2, 0.34],
      ] as const) {
        const a = p(st, s * (z - d / 2));
        const b = p(st + w, s * (z + d / 2));
        g.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      }
    }
    for (const st of [1.96, 4.95, 6.15, 7.35, 9.75, 10.95, 12.15]) line(p(st, -0.5), p(st, 0.5), lw * 0.8);
  });
  return c;
}

let shared: THREE.CanvasTexture | null = null;

/** The livery texture (one for every Tejas; painted on first use). */
export function tejasLiveryTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  if (!shared) {
    shared = new THREE.CanvasTexture(paintTejasLivery());
    shared.colorSpace = THREE.NoColorSpace;
    shared.anisotropy = 8;
    shared.generateMipmaps = true;
    shared.minFilter = THREE.LinearMipmapLinearFilter;
  }
  return shared;
}
