/**
 * src/render/cockpit/components/hudSymbology.ts — HUD symbology, drawn in angular space.
 *
 * The picture is a gnomonic projection about the HUD's optical axis: a direction d (cockpit frame)
 * lands at (d.r / d.c, d.u / d.c) * scale, so great circles (the horizon, ladder bars) stay
 * straight lines and world-referenced symbols are exactly conformal once the HUD projects the
 * picture at infinity (hud.ts). Drawn white on black; the HUD tints it and adds the glow.
 *
 * Layout follows a Western fighter HUD like the Tejas's CSIO unit: heading tape at the top,
 * airspeed box left and altitude box right, Mach/G/AoA under the airspeed, radar altitude and
 * vertical speed under the altitude, a pitch ladder centred on the flight path marker, a bank
 * scale at the bottom, weapon cues (target box, missile steering circle, gun pipper) and warning
 * cues (breakaway cross). Units: knots and feet.
 */

import { LockStateCode, SnapshotHud, WarningBit, WeaponKindCode, type Vec3Like } from '../../../contracts/core';
import { GUN_MAX_EFFECTIVE_RANGE_M } from '../../../contracts/render';
import { fmtHdg, storeInfoByCode, toBody, type StoreInventory } from '../avionics';
import { DISPLAY_FONT } from '../screen';
import type { CockpitContext } from '../types';

const DEG = Math.PI / 180;

/** Maps cockpit-frame directions to picture pixels. */
export class HudProjector {
  /** Optical axis, right and up (unit, cockpit frame). */
  readonly c = { x: 1, y: 0, z: 0 };
  readonly r = { x: 0, y: 0, z: 1 };
  readonly u = { x: 0, y: 1, z: 0 };
  /** Pixels per unit tangent; picture centre. */
  readonly scale: number;
  readonly cx: number;
  readonly cy: number;
  /** Last projection. */
  x = 0;
  y = 0;

  constructor(
    readonly sizePx: number,
    /** Half-width of the picture as a tangent. */
    readonly halfTan: number,
    axisElevationRad: number
  ) {
    this.scale = sizePx / 2 / halfTan;
    this.cx = sizePx / 2;
    this.cy = sizePx / 2;
    const ce = Math.cos(axisElevationRad);
    const se = Math.sin(axisElevationRad);
    this.c.x = ce;
    this.c.y = se;
    this.u.x = -se;
    this.u.y = ce;
  }

  /** Projects direction d; false if it is behind or far outside (x/y not meaningful then). */
  project(d: Readonly<Vec3Like>): boolean {
    const dc = d.x * this.c.x + d.y * this.c.y + d.z * this.c.z;
    if (dc < 0.2) return false;
    this.x = this.cx + ((d.x * this.r.x + d.y * this.r.y + d.z * this.r.z) / dc) * this.scale;
    this.y = this.cy - ((d.x * this.u.x + d.y * this.u.y + d.z * this.u.z) / dc) * this.scale;
    return true;
  }

  /** Pixels for an angle offset from the centre (for fixed, non-conformal symbols). */
  px(deg: number): number {
    return Math.tan(deg * DEG) * this.scale;
  }
}

const vW: Vec3Like = { x: 0, y: 0, z: 0 };
const vB: Vec3Like = { x: 0, y: 0, z: 0 };
const vT: Vec3Like = { x: 0, y: 0, z: 0 };

export interface HudDrawExtras {
  inv: StoreInventory;
  gunRounds: number;
}

export function drawHud(g: CanvasRenderingContext2D, P: HudProjector, ctx: CockpitContext, ex: HudDrawExtras): void {
  const S = P.sizePx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  const { av, f, aux, local } = ctx;
  if (!f.valid) return;
  const t = ctx.timeSec;
  const declutter = local.hudDeclutter > 0;
  const lw = S / 420;
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineWidth = lw;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const fontPx = (px: number): void => {
    g.font = `${px}px ${DISPLAY_FONT}`;
  };
  const cx = P.cx;
  const cy = P.cy;
  const u = (deg: number): number => P.px(deg);
  const txt = S * 0.024;
  const small = S * 0.019;

  // --- Flight path marker (conformal: where the aircraft is actually going). ---
  let fx = cx;
  let fy = cy + u(3);
  const fpmOk = av.fpmValid && P.project(av.fpm);
  if (fpmOk) {
    fx = P.x;
    fy = P.y;
  }
  // Keep it inside the display (a caged-at-the-edge FPM flashes in real HUDs; here it just stops).
  const lim = u(9.5);
  const fxC = Math.max(cx - lim, Math.min(cx + lim, fx));
  const fyC = Math.max(cy - lim, Math.min(cy + lim, fy));
  const fpmLimited = fxC !== fx || fyC !== fy;

  // --- Pitch ladder, centred on the flight path's azimuth. ---
  const psi = av.fpmValid ? Math.atan2(f.vel.x, -f.vel.z) : av.headingDeg * DEG;
  const sinP = Math.sin(psi);
  const cosP = Math.cos(psi);
  const ex0 = cosP; // horizontal right (east when heading north)
  const ez0 = sinP;
  const pt = (theta: number, a: number): boolean => {
    const ct = Math.cos(theta);
    vW.x = ct * sinP + ex0 * a;
    vW.y = Math.sin(theta);
    vW.z = -ct * cosP + ez0 * a;
    toBody(f.rot, vW, vB);
    return P.project(vB);
  };
  g.save();
  // The ladder lives inside the display's field of view.
  g.beginPath();
  g.arc(cx, cy, u(11.5), 0, Math.PI * 2);
  g.clip();
  fontPx(small);
  for (let deg = -90; deg <= 90; deg += 5) {
    const th = deg * DEG;
    if (!pt(th, 0)) continue;
    if (Math.abs(P.x - cx) > S || Math.abs(P.y - cy) > S) continue;
    if (deg === 0) {
      // Horizon: a long line with a gap round the FPM.
      const segs: [number, number][] = [
        [-0.5, -0.03],
        [0.03, 0.5],
      ];
      for (const [a0, a1] of segs) {
        pt(0, a0);
        const x0 = P.x;
        const y0 = P.y;
        pt(0, a1);
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(P.x, P.y);
        g.stroke();
      }
      continue;
    }
    if (declutter && Math.abs(deg) % 10 !== 0) continue;
    const inner = 0.022;
    const outer = 0.07;
    for (const side of [-1, 1]) {
      pt(th, side * inner);
      const x0 = P.x;
      const y0 = P.y;
      pt(th, side * outer);
      const x1 = P.x;
      const y1 = P.y;
      g.beginPath();
      if (deg > 0) {
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
      } else {
        // Below the horizon: dashed.
        const dx = x1 - x0;
        const dy = y1 - y0;
        for (let k = 0; k < 3; k++) {
          g.moveTo(x0 + (dx * k) / 3, y0 + (dy * k) / 3);
          g.lineTo(x0 + (dx * (k + 0.6)) / 3, y0 + (dy * (k + 0.6)) / 3);
        }
      }
      g.stroke();
      // Inner end tick pointing at the horizon, and the number at the outer end.
      const barAng = Math.atan2(y1 - y0, x1 - x0);
      const tick = u(0.55) * (deg > 0 ? 1 : -1) * side;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x0 - Math.sin(barAng) * tick, y0 + Math.cos(barAng) * tick);
      g.stroke();
      g.save();
      g.translate(x1 + (x1 - x0) * 0.22, y1 + (y1 - y0) * 0.22);
      g.rotate(Math.atan2(y1 - y0, x1 - x0) + (side < 0 ? Math.PI : 0));
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(Math.abs(deg)), 0, 0);
      g.restore();
    }
  }
  g.restore();

  // --- Waterline (the aircraft's nose, body x): a "W". ---
  if (P.project({ x: 1, y: 0, z: 0 })) {
    const w = u(0.9);
    const h = u(0.45);
    g.beginPath();
    g.moveTo(P.x - w * 1.6, P.y);
    g.lineTo(P.x - w, P.y);
    g.lineTo(P.x - w * 0.5, P.y + h);
    g.lineTo(P.x, P.y);
    g.lineTo(P.x + w * 0.5, P.y + h);
    g.lineTo(P.x + w, P.y);
    g.lineTo(P.x + w * 1.6, P.y);
    g.stroke();
  }

  // --- Flight path marker. ---
  if (!(fpmLimited && Math.floor(t * 3) % 2 === 0)) {
    const r = u(0.42);
    g.beginPath();
    g.arc(fxC, fyC, r, 0, Math.PI * 2);
    g.moveTo(fxC - r, fyC);
    g.lineTo(fxC - r * 2.6, fyC);
    g.moveTo(fxC + r, fyC);
    g.lineTo(fxC + r * 2.6, fyC);
    g.moveTo(fxC, fyC - r);
    g.lineTo(fxC, fyC - r * 2);
    g.stroke();
  }

  // --- Landing: AoA bracket (on-speed at 12 deg) and ILS deviation bars round the FPM. ---
  if (av.gearDownCmd && !av.onGround && av.fpmValid) {
    const dy = u(av.aoaDeg - 12);
    const bx = fxC - u(1.6);
    const half = u(2);
    g.beginPath();
    g.moveTo(bx + u(0.35), fyC + dy - half);
    g.lineTo(bx, fyC + dy - half);
    g.lineTo(bx, fyC + dy + half);
    g.lineTo(bx + u(0.35), fyC + dy + half);
    g.moveTo(bx, fyC + dy);
    g.lineTo(bx + u(0.5), fyC + dy);
    g.stroke();
    if (av.ilsLoc !== 0 || av.ilsGs !== 0) {
      const lx = fxC - av.ilsLoc * u(4);
      const gy = fyC + av.ilsGs * u(4);
      g.setLineDash([u(0.4), u(0.3)]);
      g.beginPath();
      g.moveTo(lx, fyC - u(3.5));
      g.lineTo(lx, fyC + u(3.5));
      g.moveTo(fxC - u(3.5), gy);
      g.lineTo(fxC + u(3.5), gy);
      g.stroke();
      g.setLineDash([]);
    }
  }

  // --- Heading tape (top). ---
  const tapeY = cy - u(8.2);
  const tapeHalf = u(5.5);
  const pxPerDeg = tapeHalf / 15;
  const hdg = av.headingDeg;
  fontPx(small);
  g.textAlign = 'center';
  g.textBaseline = 'bottom';
  g.save();
  g.beginPath();
  g.rect(cx - tapeHalf, tapeY - u(2), tapeHalf * 2, u(3));
  g.clip();
  const first = Math.floor((hdg - 16) / 5) * 5;
  for (let d = first; d <= hdg + 16; d += 5) {
    const x = cx + (d - hdg) * pxPerDeg;
    const major = ((d % 10) + 10) % 10 === 0;
    g.beginPath();
    g.moveTo(x, tapeY);
    g.lineTo(x, tapeY - u(major ? 0.5 : 0.28));
    g.stroke();
    if (major) {
      const n = (((d % 360) + 360) % 360) / 10;
      g.fillText(String(n).padStart(2, '0'), x, tapeY - u(0.62));
    }
  }
  // Autopilot heading bug.
  if (av.apFlags & 64) {
    let dh = ((av.apHdgDeg - hdg + 540) % 360) - 180;
    dh = Math.max(-15, Math.min(15, dh));
    const x = cx + dh * pxPerDeg;
    g.beginPath();
    g.moveTo(x - u(0.25), tapeY + u(0.05));
    g.lineTo(x, tapeY - u(0.25));
    g.lineTo(x + u(0.25), tapeY + u(0.05));
    g.stroke();
  }
  g.restore();
  // Caret and digital heading.
  g.beginPath();
  g.moveTo(cx - u(0.3), tapeY + u(0.55));
  g.lineTo(cx, tapeY + u(0.12));
  g.lineTo(cx + u(0.3), tapeY + u(0.55));
  g.stroke();
  fontPx(txt);
  g.textBaseline = 'top';
  g.fillText(fmtHdg(hdg), cx, tapeY + u(0.65));

  // --- Airspeed (left) and altitude (right) boxes. ---
  const boxY = cy - u(1.5);
  const sx = cx - u(7.2);
  const ax = cx + u(7.2);
  const boxW = u(2.6);
  const boxH = u(1.15);
  const speedKt = Math.max(0, av.iasKt);
  g.strokeRect(sx - boxW / 2, boxY - boxH / 2, boxW, boxH);
  g.strokeRect(ax - boxW / 2 - u(0.3), boxY - boxH / 2, boxW + u(0.6), boxH);
  fontPx(txt * 1.1);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(Math.round(speedKt)), sx, boxY + 1);
  const altFt = Math.round(av.altFt / 10) * 10;
  const thousands = Math.floor(Math.abs(altFt) / 1000);
  const rest = String(Math.abs(altFt) % 1000).padStart(3, '0');
  const altStr = altFt < 0 ? `-${thousands},${rest}` : thousands > 0 ? `${thousands},${rest}` : rest;
  g.fillText(altStr, ax, boxY + 1);
  // Speed and altitude scales beside the boxes (vertical, moving).
  if (!declutter) {
    const scaleH = u(3.4);
    g.lineWidth = lw * 0.8;
    g.save();
    g.beginPath();
    g.rect(sx - boxW, boxY - scaleH - boxH / 2, boxW * 2, scaleH * 2 + boxH);
    g.clip();
    const spPx = scaleH / 50;
    for (let v = Math.floor((speedKt - 60) / 10) * 10; v <= speedKt + 60; v += 10) {
      if (v < 0) continue;
      const y = boxY - (v - speedKt) * spPx;
      if (Math.abs(y - boxY) < boxH * 0.7) continue;
      const major = v % 50 === 0;
      g.beginPath();
      g.moveTo(sx + boxW / 2, y);
      g.lineTo(sx + boxW / 2 - u(major ? 0.5 : 0.25), y);
      g.stroke();
      if (major) {
        fontPx(small * 0.9);
        g.textAlign = 'right';
        g.fillText(String(v), sx + boxW / 2 - u(0.65), y);
      }
    }
    g.restore();
    g.save();
    g.beginPath();
    g.rect(ax - boxW, boxY - scaleH - boxH / 2, boxW * 2, scaleH * 2 + boxH);
    g.clip();
    const alPx = scaleH / 500;
    for (let v = Math.floor((av.altFt - 600) / 100) * 100; v <= av.altFt + 600; v += 100) {
      const y = boxY - (v - av.altFt) * alPx;
      if (Math.abs(y - boxY) < boxH * 0.7) continue;
      const major = v % 500 === 0;
      g.beginPath();
      g.moveTo(ax - boxW / 2 - u(0.3), y);
      g.lineTo(ax - boxW / 2 - u(0.3) + u(major ? 0.5 : 0.25), y);
      g.stroke();
      if (major) {
        fontPx(small * 0.9);
        g.textAlign = 'left';
        g.fillText((v / 1000).toFixed(1), ax - boxW / 2 + u(0.35), y);
      }
    }
    g.restore();
    g.lineWidth = lw;
  }

  // Left column: AoA above, Mach / G / max G below.
  fontPx(small * 1.05);
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  const lx = sx - boxW / 2;
  g.fillText(`α ${av.aoaDeg.toFixed(1)}`, lx, boxY - boxH * 1.25);
  g.fillText(`M ${av.mach.toFixed(2)}`, lx, boxY + boxH * 1.35);
  g.fillText(`G ${av.g.toFixed(1)}`, lx, boxY + boxH * 2.15);
  if (!declutter) g.fillText(`${av.gMax.toFixed(1)}`, lx, boxY + boxH * 2.95);
  // Right column: radar altitude (low) and vertical speed.
  g.textAlign = 'right';
  const rx = ax + boxW / 2 + u(0.3);
  if (av.aglFt < 5000 && !av.onGround) g.fillText(`${Math.round(av.aglFt / 10) * 10}R`, rx, boxY + boxH * 1.35);
  if (!declutter) g.fillText(`${av.vsFpm >= 0 ? '+' : ''}${Math.round(av.vsFpm / 100) * 100}`, rx, boxY + boxH * 2.15);

  // --- Bank scale (bottom): ticks at 10/20/30/45/60, pointer at the bank. ---
  if (!declutter) {
    const bcY = cy + u(1.2);
    const R = u(7.4);
    for (const b of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const a = Math.PI / 2 + b * DEG;
      const len = b % 30 === 0 ? u(0.55) : u(0.3);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * R, bcY + Math.sin(a) * R);
      g.lineTo(cx + Math.cos(a) * (R + len), bcY + Math.sin(a) * (R + len));
      g.stroke();
    }
    const roll = Math.max(-62, Math.min(62, av.rollDeg));
    const a = Math.PI / 2 - roll * DEG;
    const px = cx + Math.cos(a) * (R - u(0.1));
    const py = bcY + Math.sin(a) * (R - u(0.1));
    const tx = -Math.sin(a);
    const ty = Math.cos(a);
    g.beginPath();
    g.moveTo(px, py);
    g.lineTo(px - Math.cos(a) * u(0.5) + tx * u(0.28), py - Math.sin(a) * u(0.5) + ty * u(0.28));
    g.lineTo(px - Math.cos(a) * u(0.5) - tx * u(0.28), py - Math.sin(a) * u(0.5) - ty * u(0.28));
    g.closePath();
    g.stroke();
  }

  // --- Autopilot modes (under the heading). ---
  if (av.apFlags & 1 || av.apFlags & 2 || av.apFlags & (16 | 32)) {
    fontPx(small);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const parts: string[] = [];
    if (av.apFlags & 1) parts.push('AP', 'HDG', av.apFlags & 4 ? 'VS' : 'ALT');
    if (av.apFlags & 2) parts.push(`A/T ${Math.round(av.apSpdKt)}`);
    if (av.apFlags & 16 && Math.floor(t * 2) % 2 === 0) parts.push('AP OFF');
    if (av.apFlags & 32 && Math.floor(t * 2) % 2 === 0) parts.push('A/T OFF');
    g.fillText(parts.join('  '), cx, tapeY + u(1.9));
  }

  // --- Weapons. ---
  const wpn = av.weaponIdx;
  fontPx(small * 1.05);
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  const wy = cy + u(6.3);
  const wx = cx - u(8.2);
  const wLabel = wpn === WeaponKindCode.gun ? 'GUN' : storeInfoByCode(av.selectedStore)?.label ?? 'WPN';
  const wCount = wpn === WeaponKindCode.gun ? ex.gunRounds : av.selectedCount;
  g.fillText(`${wLabel} ${wCount}`, wx, wy);
  g.fillText(aux.masterArm ? 'ARM' : 'SAFE', wx, wy + u(0.95));
  if (av.radarMode === 1) g.fillText('ACM', wx, wy - u(0.95));

  // Target designator box (conformal) or a locator line when it is outside the display.
  const locked = av.lockState === LockStateCode.locked;
  if (f.targetValid) {
    vT.x = f.targetPos.x - f.pos.x;
    vT.y = f.targetPos.y - f.pos.y;
    vT.z = f.targetPos.z - f.pos.z;
    const len = Math.hypot(vT.x, vT.y, vT.z) || 1;
    vT.x /= len;
    vT.y /= len;
    vT.z /= len;
    toBody(f.rot, vT, vB);
    const inView = P.project(vB) && Math.hypot(P.x - cx, P.y - cy) < u(11);
    if (inView) {
      const tx = P.x;
      const ty = P.y;
      const b = u(0.75);
      g.strokeRect(tx - b, ty - b, b * 2, b * 2);
      if (locked) {
        g.beginPath();
        g.moveTo(tx, ty - b * 1.5);
        g.lineTo(tx + b * 1.5, ty);
        g.lineTo(tx, ty + b * 1.5);
        g.lineTo(tx - b * 1.5, ty);
        g.closePath();
        g.stroke();
      }
      fontPx(small);
      g.textAlign = 'left';
      g.fillText(`${(av.targetRangeM / 1852).toFixed(1)}`, tx + b * 1.8, ty - b * 0.6);
      g.fillText(`${Math.round(av.closureMps * 1.943844)}`, tx + b * 1.8, ty + b * 0.7);
    } else {
      // Locator: a line from the centre pointing at the target, and the angle off the nose.
      const ang = Math.atan2(vB.y, vB.z);
      const off = Math.acos(Math.max(-1, Math.min(1, vB.x))) / DEG;
      const L = u(3.2);
      const dx = Math.cos(ang);
      const dy = -Math.sin(ang);
      g.beginPath();
      g.moveTo(cx + dx * u(0.8), cy + dy * u(0.8));
      g.lineTo(cx + dx * L, cy + dy * L);
      g.stroke();
      fontPx(small);
      g.textAlign = 'center';
      g.fillText(`${Math.round(off)}`, cx + dx * (L + u(0.8)), cy + dy * (L + u(0.8)));
    }
  }
  // Missile steering: allowable steering error circle for the radar missile, seeker cue for IR.
  if (wpn === WeaponKindCode.radar_missile && f.targetValid) {
    g.beginPath();
    g.arc(cx, cy, u(locked ? 2.5 : 4), 0, Math.PI * 2);
    g.stroke();
  } else if (wpn === WeaponKindCode.ir_missile) {
    // Uncaged seeker: a small circle on the target when locked, else boresight.
    let sxp = cx;
    let syp = cy;
    if (locked && f.targetValid && P.project(vB)) {
      sxp = P.x;
      syp = P.y;
    }
    g.beginPath();
    g.arc(sxp, syp, u(locked ? 1.1 : 1.6), 0, Math.PI * 2);
    g.stroke();
  }
  // Gun: lead-computing pipper with a range arc.
  if (wpn === WeaponKindCode.gun) {
    const h = f.hud;
    const valid = (h[SnapshotHud.PIPPER_VALID] ?? 0) > 0.5 && av.targetRangeM < GUN_MAX_EFFECTIVE_RANGE_M;
    if (valid) {
      vT.x = (h[SnapshotHud.PIPPER_X] ?? 0) - f.pos.x;
      vT.y = (h[SnapshotHud.PIPPER_Y] ?? 0) - f.pos.y;
      vT.z = (h[SnapshotHud.PIPPER_Z] ?? 0) - f.pos.z;
      const len = Math.hypot(vT.x, vT.y, vT.z) || 1;
      vT.x /= len;
      vT.y /= len;
      vT.z /= len;
      toBody(f.rot, vT, vB);
      if (P.project(vB)) {
        const r = u(1.25);
        g.beginPath();
        g.arc(P.x, P.y, u(0.08), 0, Math.PI * 2);
        g.fill();
        g.beginPath();
        g.arc(P.x, P.y, r, 0, Math.PI * 2);
        g.lineWidth = lw * 0.7;
        g.stroke();
        g.lineWidth = lw * 2;
        const frac = Math.max(0, Math.min(1, av.targetRangeM / 1800));
        g.beginPath();
        g.arc(P.x, P.y, r * 0.84, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        g.stroke();
        g.lineWidth = lw;
      }
    } else {
      // Gun cross at the boresight (fixed sight) with no target.
      if (P.project({ x: 1, y: -0.035, z: 0 })) {
        const r = u(0.6);
        g.beginPath();
        g.moveTo(P.x - r, P.y);
        g.lineTo(P.x + r, P.y);
        g.moveTo(P.x, P.y - r);
        g.lineTo(P.x, P.y + r);
        g.stroke();
      }
    }
  }

  // --- Warnings: breakaway cross, and the rest as flashing text. ---
  const w = av.warnings;
  if (w & WarningBit.TerrainPullUp) {
    if (Math.floor(t * 4) % 2 === 0) {
      const X = u(6);
      g.lineWidth = lw * 2;
      g.beginPath();
      g.moveTo(cx - X, cy - X);
      g.lineTo(cx + X, cy + X);
      g.moveTo(cx + X, cy - X);
      g.lineTo(cx - X, cy + X);
      g.stroke();
      g.lineWidth = lw;
    }
  }
  const flashing: string[] = [];
  if (w & WarningBit.Stall) flashing.push('AOA');
  if (w & WarningBit.OverG) flashing.push('G LIM');
  if (w & WarningBit.Overspeed) flashing.push('SPEED');
  if (w & WarningBit.GearUnsafe) flashing.push('GEAR');
  if (w & WarningBit.MissileLaunch) flashing.push('LAUNCH');
  if (flashing.length && Math.floor(t * 3) % 2 === 0) {
    fontPx(txt);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(flashing.join(' '), cx, cy + u(4.3));
  }
  if (w & WarningBit.LowFuel) {
    fontPx(small);
    g.textAlign = 'right';
    g.fillText('FUEL', cx + u(8.2), cy + u(6.3));
  }
  // Fuel state for landing (bottom right).
  if (!declutter) {
    fontPx(small);
    g.textAlign = 'right';
    g.fillText(`${Math.round(av.totalFuelKg / 10) * 10}`, cx + u(8.2), cy + u(7.25));
  }
}
