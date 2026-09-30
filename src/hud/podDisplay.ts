/**
 * src/hud/podDisplay.ts — the targeting pod's picture symbology (drawn over the FLIR view,
 * CameraMode 'tgp'), from the snapshot's POD_* fields:
 *   - crosshair with a centre gap, and a track box when point-tracking;
 *   - top: track mode (PT point / AREA), field of view (WIDE / MED / NAR), polarity (WHT / BHT);
 *   - the laser cue "L" (flashing while lasing), "MASK" when the line of sight is blocked;
 *   - bottom: slant range (km), "DES" when the pod designates, the selected weapon and its launch
 *     zone (IN RNG / OUT RNG) or time of flight; key hints along the side.
 * Monochrome green like the Litening picture's overlay.
 */
import { DlzCode, PodFlag, SnapshotHud, STORE_IDS, WeaponKindByCode } from '../contracts/core';
import { storeInfo } from '../catalog';

const INK = '#e8ffe8';
const SHADOW = 'rgba(0,0,0,0.55)';

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, align: CanvasTextAlign = 'left'): void {
  ctx.textAlign = align;
  ctx.fillStyle = SHADOW;
  ctx.fillText(text, x + 1, y + 1);
  ctx.fillStyle = INK;
  ctx.fillText(text, x, y);
}

export function drawPodDisplay(ctx: CanvasRenderingContext2D, hud: Float64Array, w: number, h: number, nowMs: number, polarity: 1 | 2, keys: { track: string; zoom: string; laser: string; view: string }): void {
  const flags = hud[SnapshotHud.POD_FLAGS] ?? 0;
  const cx = w / 2;
  const cy = h / 2;
  ctx.save();
  ctx.font = '15px monospace';
  ctx.textBaseline = 'middle';
  if (!(flags & PodFlag.Carried)) {
    label(ctx, 'NO POD', cx, cy, 'center');
    ctx.restore();
    return;
  }
  const s = Math.min(w, h);
  // Crosshair: lines from the edges of a central gap out to a quarter of the picture.
  const gap = s * 0.03;
  const arm = s * 0.25;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - arm, cy);
  ctx.lineTo(cx - gap, cy);
  ctx.moveTo(cx + gap, cy);
  ctx.lineTo(cx + arm, cy);
  ctx.moveTo(cx, cy - arm);
  ctx.lineTo(cx, cy - gap);
  ctx.moveTo(cx, cy + gap);
  ctx.lineTo(cx, cy + arm);
  ctx.stroke();
  if (flags & PodFlag.PointTrack) ctx.strokeRect(cx - gap * 1.4, cy - gap * 1.4, gap * 2.8, gap * 2.8);

  const fov = hud[SnapshotHud.POD_FOV_DEG] ?? 0;
  const fovName = fov > 10 ? 'WIDE' : fov > 2 ? 'MED' : 'NAR';
  const top = h * 0.07;
  label(ctx, flags & PodFlag.PointTrack ? 'PT' : 'AREA', w * 0.06, top);
  label(ctx, `${fovName} ${fov.toFixed(1)}°`, cx, top, 'center');
  label(ctx, polarity === 1 ? 'WHT' : 'BHT', w * 0.94, top, 'right');
  if (flags & PodFlag.Laser && Math.floor(nowMs / 250) % 2 === 0) {
    ctx.font = 'bold 22px monospace';
    label(ctx, 'L', cx + gap * 3, cy - gap * 3, 'center');
    ctx.font = '15px monospace';
  }
  if (flags & PodFlag.Masked) label(ctx, 'MASK', cx, cy + gap * 4, 'center');

  const bottom = h * 0.93;
  const range = hud[SnapshotHud.POD_RANGE_M] ?? 0;
  label(ctx, `${(range / 1000).toFixed(1)} KM`, w * 0.06, bottom);
  if (flags & PodFlag.Designating) label(ctx, 'DES', w * 0.2, bottom);
  // Selected weapon, and its launch zone or the time of flight to the designated point.
  const code = hud[SnapshotHud.SELECTED_STORE] ?? 0;
  const kind = WeaponKindByCode[hud[SnapshotHud.WEAPON_IDX] ?? 0] ?? 'gun';
  const name = code > 0 ? (storeInfo(STORE_IDS[code] ?? '')?.label ?? '') : kind.toUpperCase();
  const dlz = hud[SnapshotHud.DLZ] ?? 0;
  const t = hud[SnapshotHud.AG_TIME_SEC] ?? 0;
  const status = dlz === DlzCode.InRange ? 'IN RNG' : dlz === DlzCode.OutOfRange ? 'OUT RNG' : t > 0 ? `REL ${t.toFixed(0)}` : '';
  label(ctx, `${name} ${Math.round(hud[SnapshotHud.SELECTED_COUNT] ?? 0)}  ${status}`, w * 0.94, bottom, 'right');

  ctx.font = '12px monospace';
  const kx = w * 0.94;
  label(ctx, `ARROWS SLEW`, kx, h * 0.3, 'right');
  label(ctx, `${keys.track} TRACK/DES`, kx, h * 0.3 + 18, 'right');
  label(ctx, `${keys.zoom} ZOOM`, kx, h * 0.3 + 36, 'right');
  label(ctx, `${keys.laser} LASE`, kx, h * 0.3 + 54, 'right');
  label(ctx, `${keys.view} EXIT`, kx, h * 0.3 + 72, 'right');
  ctx.restore();
}
