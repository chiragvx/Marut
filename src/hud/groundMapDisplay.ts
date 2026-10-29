/**
 * src/hud/groundMapDisplay.ts — the radar page in ground-map mode (an air-to-ground store selected):
 * a plan view of the ground ahead, heading up, own aircraft at the bottom centre, from the snapshot's
 * ground-map list (SnapshotHudExt.GROUND_*; the sim's src/combat/groundMap.ts), never ground truth:
 *
 * - the briefed target (the route's target steerpoint aim points): a cyan cross in a circle;
 * - radar contacts: air defences red triangles, radars red diamonds, armour filled and other
 *   vehicles hollow amber squares, structures larger hollow squares;
 * - the designated point (SPI) boxed in green, with its range, bearing and what it is below;
 * - where the selected store would land now (the CCIP impact point): a small green ring;
 * - the scan sector, range marks, "GM", the range scale, and the target key that steps through them.
 */
import {
  AgModeCode,
  GroundMapKind,
  HUD_EXT_BASE,
  MAX_GROUND_CONTACTS,
  SNAPSHOT_GROUND_STRIDE,
  SnapshotGround,
  SnapshotGroundFlag,
  SnapshotHud,
  SnapshotHudExt,
} from '../contracts/core';

const GREEN = '#40ff60';
const AMBER = '#ffc040';
const RED = '#ff4a3a';
const CYAN = '#5ae0ff';
/** The ground map's scan, either side of the nose, and its furthest range, m. */
const SCAN_HALF_RAD = (60 * Math.PI) / 180;
export const GROUND_MAP_DISPLAY_MAX_M = 40000;

const KIND_NAME: Readonly<Record<number, string>> = {
  [GroundMapKind.Vehicle]: 'VEH',
  [GroundMapKind.Armor]: 'ARMR',
  [GroundMapKind.AirDefence]: 'SAM',
  [GroundMapKind.Radar]: 'RDR',
  [GroundMapKind.Structure]: 'BLDG',
  [GroundMapKind.Briefed]: 'TGT',
};

const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export function drawGroundMap(
  ctx: CanvasRenderingContext2D,
  hud: Float64Array,
  ownX: number,
  ownZ: number,
  ownHeadingRad: number,
  rangeScaleM: number,
  x0: number,
  y0: number,
  size: number,
  targetKey: string
): void {
  const scale = Math.min(rangeScaleM, GROUND_MAP_DISPLAY_MAX_M);
  const cx = x0 + size / 2;
  const by = y0 + size - 6;
  const pxPerM = (size - 12) / scale;
  // Ahead and right of the aircraft, m -> screen.
  const sin = Math.sin(ownHeadingRad), cos = Math.cos(ownHeadingRad);
  const toScreen = (x: number, z: number, out: { x: number; y: number }): boolean => {
    const dx = x - ownX, dz = z - ownZ;
    const ahead = dx * sin - dz * cos;
    const right = dx * cos + dz * sin;
    out.x = cx + right * pxPerM;
    out.y = by - ahead * pxPerM;
    return out.x >= x0 && out.x <= x0 + size && out.y >= y0 && out.y <= y0 + size;
  };
  const pt = { x: 0, y: 0 };

  ctx.save();
  ctx.fillStyle = 'rgba(0, 18, 6, 0.45)';
  ctx.fillRect(x0, y0, size, size);
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.9;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, size - 1, size - 1);
  ctx.beginPath();
  ctx.rect(x0, y0, size, size);
  ctx.clip();

  // Range arcs and the scan sector.
  ctx.globalAlpha = 0.25;
  ctx.beginPath();
  for (const f of [0.25, 0.5, 0.75, 1]) {
    const r = f * scale * pxPerM;
    ctx.moveTo(cx + Math.sin(-SCAN_HALF_RAD) * r, by - Math.cos(SCAN_HALF_RAD) * r);
    ctx.arc(cx, by, r, -Math.PI / 2 - SCAN_HALF_RAD, -Math.PI / 2 + SCAN_HALF_RAD);
  }
  ctx.moveTo(cx, by);
  ctx.lineTo(cx, y0);
  ctx.stroke();
  ctx.globalAlpha = 0.6;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  for (const s of [-1, 1]) {
    ctx.moveTo(cx, by);
    ctx.lineTo(cx + Math.sin(s * SCAN_HALF_RAD) * size * 1.5, by - Math.cos(SCAN_HALF_RAD) * size * 1.5);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // Where the bombs would land now.
  if (hud[SnapshotHud.AG_MODE] !== AgModeCode.None && toScreen(hud[SnapshotHud.CCIP_X]!, hud[SnapshotHud.CCIP_Z]!, pt)) {
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Contacts.
  const ext = HUD_EXT_BASE;
  const n = Math.min(hud[ext + SnapshotHudExt.GROUND_COUNT] ?? 0, MAX_GROUND_CONTACTS);
  let info: string | undefined;
  let designatedOnMap = false;
  for (let k = 0; k < n; k++) {
    const o = ext + SnapshotHudExt.GROUND_BASE + k * SNAPSHOT_GROUND_STRIDE;
    const x = hud[o + SnapshotGround.X]!;
    const z = hud[o + SnapshotGround.Z]!;
    const kind = hud[o + SnapshotGround.KIND]!;
    const flags = hud[o + SnapshotGround.FLAGS]!;
    const designated = (flags & SnapshotGroundFlag.Designated) !== 0;
    if (designated) {
      designatedOnMap = true;
      info = `${KIND_NAME[kind] ?? 'TGT'} ${k + 1}/${n}  ${rangeBearing(x, z, ownX, ownZ, ownHeadingRad)}`;
    }
    if (!toScreen(x, z, pt)) continue;
    drawSymbol(ctx, kind, pt.x, pt.y);
    if (designated) drawBox(ctx, pt.x, pt.y);
  }
  // A designated point that is none of them (at the pipper, or by the pod).
  if (hud[SnapshotHud.SPI_VALID] && !designatedOnMap) {
    const sx = hud[SnapshotHud.SPI_X]!, sz = hud[SnapshotHud.SPI_Z]!;
    info = `SPI  ${rangeBearing(sx, sz, ownX, ownZ, ownHeadingRad)}`;
    if (toScreen(sx, sz, pt)) drawBox(ctx, pt.x, pt.y);
  }

  // Own aircraft.
  ctx.fillStyle = GREEN;
  ctx.beginPath();
  ctx.moveTo(cx, by - 7);
  ctx.lineTo(cx - 5, by);
  ctx.lineTo(cx + 5, by);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Labels.
  ctx.save();
  ctx.fillStyle = GREEN;
  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('GM', x0 + 4, y0 + 12);
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(scale / 1000)}`, x0 + size - 4, y0 + 12);
  ctx.textAlign = 'left';
  ctx.fillText(info ?? (n > 0 ? `${n} TGT  ${targetKey}: SELECT` : 'NO TGT'), x0 + 4, y0 + size + 13);
  if (info && n > 1) {
    ctx.textAlign = 'right';
    ctx.fillText(`${targetKey}: NEXT`, x0 + size - 4, y0 + size + 13);
  }
  ctx.restore();
}

function rangeBearing(x: number, z: number, ownX: number, ownZ: number, ownHeadingRad: number): string {
  const dx = x - ownX, dz = z - ownZ;
  const brg = wrapPi(Math.atan2(dx, -dz) - ownHeadingRad);
  const deg = Math.round((brg * 180) / Math.PI);
  return `${(Math.hypot(dx, dz) / 1000).toFixed(1)} KM ${deg === 0 ? '0' : deg > 0 ? `${deg}R` : `${-deg}L`}`;
}

function drawSymbol(ctx: CanvasRenderingContext2D, kind: number, x: number, y: number): void {
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (kind === GroundMapKind.Briefed) {
    ctx.strokeStyle = CYAN;
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.moveTo(x - 9, y);
    ctx.lineTo(x + 9, y);
    ctx.moveTo(x, y - 9);
    ctx.lineTo(x, y + 9);
    ctx.stroke();
  } else if (kind === GroundMapKind.AirDefence) {
    ctx.fillStyle = RED;
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x + 5, y + 4);
    ctx.lineTo(x - 5, y + 4);
    ctx.closePath();
    ctx.fill();
  } else if (kind === GroundMapKind.Radar) {
    ctx.fillStyle = RED;
    ctx.moveTo(x, y - 5);
    ctx.lineTo(x + 5, y);
    ctx.lineTo(x, y + 5);
    ctx.lineTo(x - 5, y);
    ctx.closePath();
    ctx.fill();
  } else if (kind === GroundMapKind.Armor) {
    ctx.fillStyle = AMBER;
    ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
  } else if (kind === GroundMapKind.Structure) {
    ctx.strokeStyle = AMBER;
    ctx.strokeRect(x - 5, y - 5, 10, 10);
  } else {
    ctx.strokeStyle = AMBER;
    ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
  }
}

function drawBox(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = 1.5;
  const b = 10;
  ctx.beginPath();
  ctx.moveTo(x - b + 3, y - b);
  ctx.lineTo(x - b, y - b);
  ctx.lineTo(x - b, y + b);
  ctx.lineTo(x - b + 3, y + b);
  ctx.moveTo(x + b - 3, y - b);
  ctx.lineTo(x + b, y - b);
  ctx.lineTo(x + b, y + b);
  ctx.lineTo(x + b - 3, y + b);
  ctx.stroke();
}
