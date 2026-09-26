/**
 * src/hud/radarDisplay.ts — the air-to-air radar page (a B-scope): azimuth across, range up, own
 * aircraft at the bottom centre. It shows only the player's own tracks (the sim's track file via
 * the snapshot, SnapshotHud.TRACKS_BASE), never ground truth:
 *
 * - hostile: red diamond; unknown: yellow square; friend: green circle. Hollow and dim while a
 *   track coasts on memory. A short stub shows each track's heading relative to the nose, and its
 *   altitude is written beside it in thousands of metres.
 * - the designated target sits in brackets; a radar lock adds a ring and "LOCK".
 * - scan limits, range marks, the mode (RWS / ACM, with the ACM field drawn), the range scale, and
 *   the designated target's range, altitude and closure.
 */
import { MAX_SNAPSHOT_TRACKS, RadarModeCode, SNAPSHOT_TRACK_STRIDE, SnapshotHud, SnapshotTrack, SnapshotTrackFlag, TrackIdentityCode } from '../contracts/core';

/** Range scales the [ and ] keys step through, km. */
export const RADAR_RANGE_SCALES_KM: readonly number[] = [10, 20, 40, 80, 160];

const GREEN = '#40ff60';
const COLORS: Readonly<Record<number, string>> = {
  [TrackIdentityCode.hostile]: '#ff4a3a',
  [TrackIdentityCode.unknown]: '#ffd23a',
  [TrackIdentityCode.friend]: '#40ff60',
};
const ACM_AZ_HALF_DEG = 15;
const ACM_RANGE_M = 18000;

const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export function drawRadarDisplay(
  ctx: CanvasRenderingContext2D,
  hud: Float64Array,
  ownX: number,
  ownY: number,
  ownZ: number,
  ownHeadingRad: number,
  rangeScaleM: number,
  x0: number,
  y0: number,
  size: number
): void {
  const maxRange = hud[SnapshotHud.RADAR_MAX_RANGE_M]!;
  const scanAz = hud[SnapshotHud.RADAR_SCAN_AZ_RAD]! || Math.PI / 3;
  const mode = hud[SnapshotHud.RADAR_MODE]!;
  const scale = Math.min(rangeScaleM, maxRange > 0 ? maxRange : rangeScaleM);
  const azSpan = Math.max(scanAz, (60 * Math.PI) / 180);
  const cx = x0 + size / 2;
  const toX = (az: number): number => cx + (az / azSpan) * (size / 2);
  const toY = (r: number): number => y0 + size - (r / scale) * size;

  ctx.save();
  ctx.fillStyle = 'rgba(0, 18, 6, 0.45)';
  ctx.fillRect(x0, y0, size, size);
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.9;
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, size - 1, size - 1);

  // Range marks and the azimuth grid.
  ctx.globalAlpha = 0.25;
  ctx.beginPath();
  for (const f of [0.25, 0.5, 0.75]) {
    ctx.moveTo(x0, y0 + size * f);
    ctx.lineTo(x0 + size, y0 + size * f);
  }
  for (const deg of [-30, 0, 30]) {
    const x = toX((deg * Math.PI) / 180);
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y0 + size);
  }
  ctx.stroke();
  // Scan limits.
  ctx.globalAlpha = 0.6;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  for (const s of [-1, 1]) {
    const x = toX(s * scanAz);
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y0 + size);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  // ACM field.
  if (mode === RadarModeCode.acm) {
    ctx.globalAlpha = 0.8;
    const ax = (ACM_AZ_HALF_DEG * Math.PI) / 180;
    const top = Math.max(y0, toY(ACM_RANGE_M));
    ctx.strokeRect(toX(-ax), top, toX(ax) - toX(-ax), y0 + size - top);
  }

  // Labels.
  ctx.globalAlpha = 1;
  ctx.fillStyle = GREEN;
  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(mode === RadarModeCode.acm ? 'ACM' : 'RWS', x0 + 4, y0 + 12);
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(scale / 1000)}`, x0 + size - 4, y0 + 12);
  ctx.fillText(`${Math.round(scale / 2000)}`, x0 + size - 4, y0 + size / 2 - 3);
  // Own aircraft.
  ctx.beginPath();
  ctx.moveTo(cx, y0 + size - 9);
  ctx.lineTo(cx - 5, y0 + size - 2);
  ctx.lineTo(cx + 5, y0 + size - 2);
  ctx.closePath();
  ctx.fill();

  // Tracks.
  const n = Math.min(hud[SnapshotHud.TRACK_COUNT]!, MAX_SNAPSHOT_TRACKS);
  let designatedInfo: string | undefined;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, size, size);
  ctx.clip();
  for (let k = 0; k < n; k++) {
    const o = SnapshotHud.TRACKS_BASE + k * SNAPSHOT_TRACK_STRIDE;
    const tx = hud[o + SnapshotTrack.X]!;
    const ty = hud[o + SnapshotTrack.Y]!;
    const tz = hud[o + SnapshotTrack.Z]!;
    const vx = hud[o + SnapshotTrack.VX]!;
    const vz = hud[o + SnapshotTrack.VZ]!;
    const identity = hud[o + SnapshotTrack.IDENTITY]!;
    const flags = hud[o + SnapshotTrack.FLAGS]!;
    const dx = tx - ownX;
    const dz = tz - ownZ;
    const range = Math.hypot(dx, ty - ownY, dz);
    const az = wrapPi(Math.atan2(dx, -dz) - ownHeadingRad);
    const memory = (flags & SnapshotTrackFlag.Memory) !== 0;
    const designated = (flags & SnapshotTrackFlag.Designated) !== 0;
    const locked = (flags & SnapshotTrackFlag.Locked) !== 0;
    if (designated) {
      const closure = -(vx * dx + vz * dz) / Math.max(1, Math.hypot(dx, dz));
      designatedInfo = `${(range / 1000).toFixed(1)} KM  ${(ty / 1000).toFixed(1)}K  ${closure >= 0 ? '+' : ''}${Math.round(closure)}`;
    }
    if (range > scale || Math.abs(az) > azSpan) continue;
    const px = toX(az);
    const py = toY(range);
    const col = COLORS[identity] ?? COLORS[TrackIdentityCode.unknown]!;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.globalAlpha = memory ? 0.5 : 1;
    ctx.lineWidth = 1.5;
    const r = 5;
    ctx.beginPath();
    if (identity === TrackIdentityCode.hostile) {
      ctx.moveTo(px, py - r);
      ctx.lineTo(px + r, py);
      ctx.lineTo(px, py + r);
      ctx.lineTo(px - r, py);
      ctx.closePath();
    } else if (identity === TrackIdentityCode.friend) {
      ctx.arc(px, py, r - 0.5, 0, Math.PI * 2);
    } else {
      ctx.rect(px - r + 1, py - r + 1, 2 * r - 2, 2 * r - 2);
    }
    if (memory) ctx.stroke();
    else ctx.fill();
    // Heading stub relative to the nose (up = same way as us).
    if (Math.hypot(vx, vz) > 5) {
      const rel = Math.atan2(vx, -vz) - ownHeadingRad;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.sin(rel) * 12, py - Math.cos(rel) * 12);
      ctx.stroke();
    }
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText((ty / 1000).toFixed(1), px + 7, py + 11);
    if (designated) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = GREEN;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const b = 9;
      ctx.moveTo(px - b + 3, py - b);
      ctx.lineTo(px - b, py - b);
      ctx.lineTo(px - b, py + b);
      ctx.lineTo(px - b + 3, py + b);
      ctx.moveTo(px + b - 3, py - b);
      ctx.lineTo(px + b, py - b);
      ctx.lineTo(px + b, py + b);
      ctx.lineTo(px + b - 3, py + b);
      ctx.stroke();
      if (locked) {
        ctx.beginPath();
        ctx.arc(px, py, 12, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
  ctx.restore();

  // The designated target's range / altitude / closure; LOCK when locked.
  if (designatedInfo) {
    ctx.fillStyle = GREEN;
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(designatedInfo, x0 + 4, y0 + size + 13);
  }
  ctx.restore();
}
