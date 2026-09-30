/**
 * src/hud/agSight.ts — air-to-ground symbology on the game HUD (conformal with the 3D view, like the
 * target box), from the snapshot's AG_* fields (computed in the sim: src/combat/agSight.ts):
 *   - CCIP: the pipper on the predicted impact point and the bomb-fall line from the flight path
 *     marker to it; time of flight beside it.
 *   - CCRP: a target box on the designated point (SPI), the azimuth steering line (fly to put it
 *     through the flight path marker) and the release cue sliding down it to the marker as the
 *     release point nears; seconds to release below. "REL" when the bomb will go (hold release).
 */
import { AgModeCode, SnapshotHud, type Vec3Like } from '../contracts/core';
import type { CameraState } from '../contracts/render';
import { createScreenProjection, projectWorldToScreen } from './targetBox';

const COLOR = '#40ff60';
/** Steering line: metres of cross-track error per pixel of offset, and how far it can move. */
const ASL_M_PER_PX = 2.5;
const ASL_MAX_PX = 140;
/** Release cue: pixels above the flight path marker per second to release (capped). */
const CUE_PX_PER_SEC = 9;
const CUE_MAX_PX = 170;

const pFpm = createScreenProjection();
const pPt = createScreenProjection();
const fpmWorld: Vec3Like = { x: 0, y: 0, z: 0 };
const ptWorld: Vec3Like = { x: 0, y: 0, z: 0 };

export function drawAgSight(ctx: CanvasRenderingContext2D, camera: CameraState, hud: Float64Array, playerPos: Readonly<Vec3Like>, playerVel: Readonly<Vec3Like>, w: number, h: number, nowMs: number): void {
  const mode = hud[SnapshotHud.AG_MODE] ?? 0;
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
    ctx.textAlign = 'center';
    ctx.fillText('CCIP', w * 0.5, h * 0.84);
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
      // Azimuth steering line.
      ctx.beginPath();
      ctx.moveTo(x, pFpm.yPx - CUE_MAX_PX - 20);
      ctx.lineTo(x, pFpm.yPx + 40);
      ctx.stroke();
      // Release cue: descends to the flight path marker as the release point nears.
      const cueY = pFpm.yPx - Math.max(0, Math.min(CUE_MAX_PX, t * CUE_PX_PER_SEC));
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x - 14, cueY);
      ctx.lineTo(x + 14, cueY);
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    const rel = t <= 0 && Math.floor(nowMs / 150) % 2 === 0;
    ctx.fillText(t > 0 ? `CCRP  REL ${t.toFixed(1)}` : rel ? 'CCRP  REL' : 'CCRP', w * 0.5, h * 0.84);
  }
  ctx.restore();
}
