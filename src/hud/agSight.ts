/**
 * src/hud/agSight.ts — air-to-ground symbology on the game HUD (conformal with the 3D view, like the
 * target box), from the snapshot's AG_* fields (computed in the sim: src/combat/agSight.ts):
 *   - CCIP: the pipper on the predicted impact point and the bomb-fall line from the flight path
 *     marker to it; time of flight beside it. When the impact point is further below the flight path
 *     than the sight field (AG_SIGHT_FIELD_RAD), the pipper is pinned on the field's edge on the way
 *     to it (dashed, with a caret pointing on down): put it on the target and hold release to
 *     designate there (delayed release; the sim's src/combat/weaponStation.ts).
 *   - CCRP: a target box on the designated point (SPI), the azimuth steering line (fly to put it
 *     through the flight path marker; dashed until inside the release window, solid on it) and the
 *     release cue sliding down it to the marker as the release point nears.
 *   - The release cue (SnapshotHudExt.AG_CUE, src/combat/weaponStation.ts updateAgCue): what to do
 *     next in large letters low on the screen (SELECT TARGET, STEER, HOLD <release key>,
 *     the seconds to release, RELEASE, BOMB AWAY, PASSED), with a one-line hint below it.
 *   - Aiming help 'full' (AimingHelp): the predicted impact as a ring on the ground and, in CCIP, the
 *     bomb's fall from the aircraft to it (a curve through both with the time of flight).
 */
import { AG_SIGHT_FIELD_RAD, AgCueCode, AgCueFlag, AgModeCode, AimingHelp, HUD_EXT_BASE, SnapshotHud, SnapshotHudExt, type Vec3Like } from '../contracts/core';
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

/** The impact ring's radius on the ground, m, and the points drawn round it and along the fall. */
const RING_M = 15;
const RING_POINTS = 32;
const FALL_POINTS = 24;
const pRing = createScreenProjection();
const ringWorld: Vec3Like = { x: 0, y: 0, z: 0 };

/**
 * Aiming help 'full': the predicted impact as a ring on the ground, and in CCIP the bomb's fall: the
 * curve from the aircraft through the impact point with the release velocity and the time of flight
 * (p0 + v0 t + a t^2 / 2, with `a` making it arrive there; the sim flies the real one).
 */
export function drawAgAssist(ctx: CanvasRenderingContext2D, camera: CameraState, hud: Float64Array, playerPos: Readonly<Vec3Like>, playerVel: Readonly<Vec3Like>, w: number, h: number): void {
  const mode = hud[SnapshotHud.AG_MODE] ?? 0;
  if (mode === AgModeCode.None) return;
  const ix = hud[SnapshotHud.CCIP_X]!, iy = hud[SnapshotHud.CCIP_Y]!, iz = hud[SnapshotHud.CCIP_Z]!;
  ctx.save();
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 1.6;
  ctx.globalAlpha = 0.9;
  // The ring, where it is in view.
  ctx.beginPath();
  let pen = false;
  for (let k = 0; k <= RING_POINTS; k++) {
    const a = (k / RING_POINTS) * Math.PI * 2;
    ringWorld.x = ix + Math.cos(a) * RING_M;
    ringWorld.y = iy;
    ringWorld.z = iz + Math.sin(a) * RING_M;
    projectWorldToScreen(camera, ringWorld, w, h, pRing);
    if (!pRing.visible) {
      pen = false;
      continue;
    }
    if (pen) ctx.lineTo(pRing.xPx, pRing.yPx);
    else ctx.moveTo(pRing.xPx, pRing.yPx);
    pen = true;
  }
  ctx.stroke();
  // The fall (CCIP: the time figure is the time of flight).
  const tof = hud[SnapshotHud.AG_TIME_SEC] ?? 0;
  if (mode === AgModeCode.Ccip && tof > 0.2) {
    const ax = (2 * (ix - playerPos.x - playerVel.x * tof)) / (tof * tof);
    const ay = (2 * (iy - playerPos.y - playerVel.y * tof)) / (tof * tof);
    const az = (2 * (iz - playerPos.z - playerVel.z * tof)) / (tof * tof);
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    pen = false;
    for (let k = 1; k <= FALL_POINTS; k++) {
      const t = (k / FALL_POINTS) * tof;
      ringWorld.x = playerPos.x + playerVel.x * t + 0.5 * ax * t * t;
      ringWorld.y = playerPos.y + playerVel.y * t + 0.5 * ay * t * t;
      ringWorld.z = playerPos.z + playerVel.z * t + 0.5 * az * t * t;
      projectWorldToScreen(camera, ringWorld, w, h, pRing);
      if (!pRing.visible) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(pRing.xPx, pRing.yPx);
      else ctx.moveTo(pRing.xPx, pRing.yPx);
      pen = true;
    }
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Where the CCIP pipper is drawn: the impact point, or (further below the flight path than the sight
 * field) a point on the field's edge on the way to it, `PINNED_RANGE_M` out. True when pinned.
 */
const PINNED_RANGE_M = 2000;
export function ccipPipperWorld(playerPos: Readonly<Vec3Like>, playerVel: Readonly<Vec3Like>, impact: Readonly<Vec3Like>, out: Vec3Like): boolean {
  out.x = impact.x;
  out.y = impact.y;
  out.z = impact.z;
  const ix = impact.x - playerPos.x, iy = impact.y - playerPos.y, iz = impact.z - playerPos.z;
  const ir = Math.hypot(ix, iy, iz);
  const vs = Math.hypot(playerVel.x, playerVel.y, playerVel.z);
  if (ir < 1 || vs < 1) return false;
  const a = Math.acos(Math.max(-1, Math.min(1, (ix * playerVel.x + iy * playerVel.y + iz * playerVel.z) / (ir * vs))));
  if (a <= AG_SIGHT_FIELD_RAD) return false;
  // Slerp from the flight path towards the impact by the field angle (as the sim does).
  const sinA = Math.sin(a);
  const wv = Math.sin(a - AG_SIGHT_FIELD_RAD) / sinA / vs;
  const wi = Math.sin(AG_SIGHT_FIELD_RAD) / sinA / ir;
  out.x = playerPos.x + (playerVel.x * wv + ix * wi) * PINNED_RANGE_M;
  out.y = playerPos.y + (playerVel.y * wv + iy * wi) * PINNED_RANGE_M;
  out.z = playerPos.z + (playerVel.z * wv + iz * wi) * PINNED_RANGE_M;
  return true;
}

const impactWorld: Vec3Like = { x: 0, y: 0, z: 0 };

/** The CCIP pipper at `pt` (projected): a ring and centre dot, dashed with a caret pointing on down when pinned. */
function drawPipper(ctx: CanvasRenderingContext2D, x: number, y: number, pinned: boolean): void {
  if (pinned) ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(x, y, 11, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
  if (pinned) {
    ctx.beginPath();
    ctx.moveTo(x - 7, y + 16);
    ctx.lineTo(x, y + 23);
    ctx.lineTo(x + 7, y + 16);
    ctx.stroke();
  }
}

/**
 * The 3D cockpit's helmet display: the CCIP pipper where the cockpit HUD's glass does not show it
 * (`insideHud` false for its world point), and a pinned pipper always.
 */
export function drawCcipHelmet(ctx: CanvasRenderingContext2D, camera: CameraState, hud: Float64Array, playerPos: Readonly<Vec3Like>, playerVel: Readonly<Vec3Like>, w: number, h: number, insideHud: (p: Vec3Like) => boolean): void {
  if ((hud[SnapshotHud.AG_MODE] ?? 0) !== AgModeCode.Ccip) return;
  impactWorld.x = hud[SnapshotHud.CCIP_X]!;
  impactWorld.y = hud[SnapshotHud.CCIP_Y]!;
  impactWorld.z = hud[SnapshotHud.CCIP_Z]!;
  const pinned = ccipPipperWorld(playerPos, playerVel, impactWorld, ptWorld);
  // (The cockpit HUD draws only the impact point itself, never a pinned pipper.)
  if (!pinned && insideHud(ptWorld)) return;
  projectWorldToScreen(camera, ptWorld, w, h, pPt);
  if (!pPt.visible) return;
  ctx.save();
  ctx.strokeStyle = COLOR;
  ctx.fillStyle = COLOR;
  ctx.lineWidth = 1.6;
  drawPipper(ctx, pPt.xPx, pPt.yPx, pinned);
  ctx.restore();
}

export function drawAgSight(ctx: CanvasRenderingContext2D, camera: CameraState, hud: Float64Array, playerPos: Readonly<Vec3Like>, playerVel: Readonly<Vec3Like>, w: number, h: number, nowMs: number, keys: AgKeys, help: AimingHelp): void {
  const mode = hud[SnapshotHud.AG_MODE] ?? 0;
  drawAgCue(ctx, hud, w, h, nowMs, keys, help);
  if (help === AimingHelp.Full) drawAgAssist(ctx, camera, hud, playerPos, playerVel, w, h);
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
    impactWorld.x = hud[SnapshotHud.CCIP_X]!;
    impactWorld.y = hud[SnapshotHud.CCIP_Y]!;
    impactWorld.z = hud[SnapshotHud.CCIP_Z]!;
    const pinned = ccipPipperWorld(playerPos, playerVel, impactWorld, ptWorld);
    projectWorldToScreen(camera, ptWorld, w, h, pPt);
    if (pPt.visible) {
      // Bomb-fall line from the flight path marker to the pipper.
      if (pFpm.visible) {
        ctx.beginPath();
        ctx.moveTo(pFpm.xPx, pFpm.yPx);
        ctx.lineTo(pPt.xPx, pPt.yPx);
        ctx.stroke();
      }
      drawPipper(ctx, pPt.xPx, pPt.yPx, pinned);
      if (!pinned) {
        ctx.textAlign = 'left';
        ctx.fillText(`${t.toFixed(1)}`, pPt.xPx + 15, pPt.yPx + 4);
      }
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

/** The release cue: what to do next, large, low on the screen; a hint line below it. */
export function drawAgCue(ctx: CanvasRenderingContext2D, hud: Float64Array, w: number, h: number, nowMs: number, keys: AgKeys, help: AimingHelp): void {
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
      small =
        (flags & AgCueFlag.PipperLimited) !== 0
          ? `${keys.target}: next target  ·  or put the dashed pipper on it and hold ${keys.launch}`
          : `${keys.target}: next target`;
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
  // Low on the screen: clear of the flight path marker, the pinned pipper below it and the steering line above.
  const cx = w * 0.5;
  const y = h * 0.82;
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
  if (small && help !== AimingHelp.Off) {
    ctx.font = '13px monospace';
    ctx.globalAlpha = 0.9;
    ctx.fillText(small, cx, y + 22);
  }
  ctx.restore();
}
