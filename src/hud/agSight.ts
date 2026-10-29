/**
 * src/hud/agSight.ts — air-to-ground symbology on the game HUD (conformal with the 3D view, like the
 * target box), from the snapshot's AG_* fields (computed in the sim: src/combat/agSight.ts):
 *   - CCIP: the pipper on the predicted impact point and the bomb-fall line from the flight path
 *     marker to it; time of flight beside it.
 *   - CCRP: a target box on the designated point (SPI), the azimuth steering line (fly to put it
 *     through the flight path marker; dashed until inside the release window, solid on it) and the
 *     release cue sliding down it to the marker as the release point nears.
 *   - The release cue (SnapshotHudExt.AG_CUE, src/combat/weaponStation.ts updateAgCue): what to do
 *     next in large letters under the flight path marker (SELECT TARGET, STEER, HOLD <release key>,
 *     the seconds to release, RELEASE, BOMB AWAY, PASSED), with a one-line hint below it.
 */
import { AgCueCode, AgCueFlag, AgModeCode, HUD_EXT_BASE, SnapshotHud, SnapshotHudExt, type Vec3Like } from '../contracts/core';
import type { CameraState } from '../contracts/render';
import { createScreenProjection, projectWorldToScreen } from './targetBox';

const COLOR = '#40ff60';
const AMBER = '#ffc040';
/** Steering line: metres of cross-track error per pixel of offset, and how far it can move. */
const ASL_M_PER_PX = 2.5;
const ASL_MAX_PX = 140;
/** Release cue: pixels above the flight path marker per second to release (capped). */
const CUE_PX_PER_SEC = 9;
const CUE_MAX_PX = 170;
/** The CCRP release window across the track, m (src/combat CCRP_RELEASE_CROSS_M). */
const RELEASE_CROSS_M = 25;

const pFpm = createScreenProjection();
const pPt = createScreenProjection();
const fpmWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const ptWorld: Vec3Like = { x: 0, y: 0, z: 0 };

export interface AgKeys {
  target: string;
  launch: string;
}

export function drawAgSight(ctx: CanvasRenderingContext2D, camera: CameraState, hud: Float64Array, playerPos: Readonly<Vec3Like>, playerVel: Readonly<Vec3Like>, w: number, h: number, nowMs: number, keys: AgKeys): void {
  const mode = hud[SnapshotHud.AG_MODE] ?? 0;
  drawAgCue(ctx, hud, w, h, nowMs, keys);
  if (mode === AgModeCode.None) return;
  // Flight path marker: a point 2 km down the velocity vector.
  const sp = Math.hypot(playerVel.x, playerVel.y, playerVel.z);
  if (sp < 1) return;
  fpmWorld.x = playerPos.x + (playerVel.x / sp) * 2000;
  fpmWorld.y = playerPos.y + (playerVel.y / sp) * 2000;
  fpmWorld.z = playerPos.z + (playerVel.z / sp) * 2000;
  projectWorldToScreen(camera, fpmWorld, w, h, pFpm);
  const t = hud[SnapshotHud.AG_TIME_SEC] ?? 0;
  ctx.save();
  ctx.strokeStyle = COLOR;
  ctx.fillStyle = COLOR;
  ctx.lineWidth = 1.6;
  ctx.font = '13px monospace';

  if (mode === AgModeCode.Ccip) {
    ptWorld.x = hud[SnapshotHud.CCIP_X]!;
    ptWorld.y = hud[SnapshotHud.CCIP_Y]!;
    ptWorld.z = hud[SnapshotHud.CCIP_Z]!;
    projectWorldToScreen(camera, ptWorld, w, h, pPt);
    if (pPt.visible) {
      // Bomb-fall line from the flight path marker to the pipper.
      if (pFpm.visible) {
        ctx.beginPath();
        ctx.moveTo(pFpm.xPx, pFpm.yPx);
        ctx.lineTo(pPt.xPx, pPt.yPx);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(pPt.xPx, pPt.yPx, 11, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillRect(pPt.xPx - 1.5, pPt.yPx - 1.5, 3, 3);
      ctx.textAlign = 'left';
      ctx.fillText(`${t.toFixed(1)}`, pPt.xPx + 15, pPt.yPx + 4);
    }
  } else if (mode === AgModeCode.Ccrp) {
    ptWorld.x = hud[SnapshotHud.SPI_X]!;
    ptWorld.y = hud[SnapshotHud.SPI_Y]!;
    ptWorld.z = hud[SnapshotHud.SPI_Z]!;
    projectWorldToScreen(camera, ptWorld, w, h, pPt);
    if (pPt.visible) {
      // Target designator: a box with a centre dot.
      ctx.strokeRect(pPt.xPx - 9, pPt.yPx - 9, 18, 18);
      ctx.fillRect(pPt.xPx - 1.5, pPt.yPx - 1.5, 3, 3);
    }
    if (pFpm.visible) {
      const cross = hud[SnapshotHud.AG_CROSS_M] ?? 0;
      const x = pFpm.xPx + Math.max(-ASL_MAX_PX, Math.min(ASL_MAX_PX, cross / ASL_M_PER_PX));
      // Azimuth steering line: dashed while outside the release window.
      if (Math.abs(cross) > RELEASE_CROSS_M) ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(x, pFpm.yPx - CUE_MAX_PX - 20);
      ctx.lineTo(x, pFpm.yPx + 40);
      ctx.stroke();
      ctx.setLineDash([]);
      // Release cue: descends to the flight path marker as the release point nears.
      const cueY = pFpm.yPx - Math.max(0, Math.min(CUE_MAX_PX, t * CUE_PX_PER_SEC));
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x - 14, cueY);
      ctx.lineTo(x + 14, cueY);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Seconds to release, as the cue reads it. */
const secs = (t: number): string => (t >= 10 ? `${Math.round(t)}` : t.toFixed(1));

/** The release cue: what to do next, large, under the flight path marker; a hint line below it. */
export function drawAgCue(ctx: CanvasRenderingContext2D, hud: Float64Array, w: number, h: number, nowMs: number, keys: AgKeys): void {
  const cue = hud[HUD_EXT_BASE + SnapshotHudExt.AG_CUE] ?? 0;
  if (cue === AgCueCode.None) return;
  const flags = hud[HUD_EXT_BASE + SnapshotHudExt.AG_CUE_FLAGS] ?? 0;
  const t = hud[SnapshotHud.AG_TIME_SEC] ?? 0;
  const cross = hud[SnapshotHud.AG_CROSS_M] ?? 0;
  let big = '';
  let small = '';
  let color = COLOR;
  let arrow = 0;
  switch (cue) {
    case AgCueCode.Designate:
      big = 'SELECT TARGET';
      small = `${keys.target}: next target  ·  or dive until the pipper shows`;
      break;
    case AgCueCode.Ccip:
      big = 'CCIP';
      small = `pipper on the target  ·  ${keys.launch}: release`;
      break;
    case AgCueCode.Dive:
      big = 'DIVE';
      small = 'the pipper is below the HUD';
      break;
    case AgCueCode.Steer:
      big = `STEER ${cross > 0 ? 'RIGHT' : 'LEFT'} ${Math.round(Math.abs(cross))} M`;
      arrow = cross > 0 ? 1 : -1;
      small = t > 0 ? `release in ${secs(t)} s  ·  line through the flight path marker` : 'line through the flight path marker';
      break;
    case AgCueCode.Hold:
      big = `HOLD ${keys.launch}`;
      small = `release in ${secs(t)} s  ·  the bomb goes automatically`;
      break;
    case AgCueCode.Releasing:
      big = `RELEASE IN ${secs(t)}`;
      small = 'keep holding  ·  wings level';
      break;
    case AgCueCode.Release:
      big = Math.floor(nowMs / 150) % 2 === 0 ? 'RELEASE' : '';
      small = (flags & AgCueFlag.LaunchHeld) !== 0 ? '' : `${keys.launch}!`;
      break;
    case AgCueCode.Away:
      big = 'BOMB AWAY';
      break;
    case AgCueCode.Passed:
      big = 'PASSED';
      small = `turn back for another pass  ·  ${keys.target}: next target`;
      color = AMBER;
      break;
  }
  const cx = w * 0.5;
  const y = h * 0.7;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
  ctx.shadowBlur = 4;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (big) {
    ctx.font = 'bold 22px monospace';
    ctx.fillText(big, cx, y);
    if (arrow !== 0) {
      // A steering arrow on the side to turn to.
      const half = ctx.measureText(big).width / 2;
      const ax = cx + arrow * (half + 22);
      ctx.beginPath();
      ctx.moveTo(ax + arrow * 10, y);
      ctx.lineTo(ax - arrow * 6, y - 9);
      ctx.lineTo(ax - arrow * 6, y + 9);
      ctx.closePath();
      ctx.fill();
    }
  }
  if (small) {
    ctx.font = '13px monospace';
    ctx.globalAlpha = 0.9;
    ctx.fillText(small, cx, y + 22);
  }
  ctx.restore();
}
