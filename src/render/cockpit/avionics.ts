/**
 * src/render/cockpit/avionics.ts — the aircraft's "mission computer" for the cockpit displays.
 *
 * Turns the sim's state into what the instruments show: attitude and heading from the interpolated
 * orientation (so the HUD's horizon stays glued to the world the 3D view draws), the flight path in
 * the body frame, air data in cockpit units, and an engine model (spool-up lag, turbine temperature,
 * nozzle, oil) that follows the throttle the way an F404 does. Fuel flow is measured from the sim's
 * actual fuel burn. Pure maths plus a little smoothing state; no Three.js.
 */

import { AutopilotFlag, EntityFlag, MAX_STORE_SLOTS, SnapshotHud, SnapshotTrack, SNAPSHOT_TRACK_STRIDE, STORE_IDS, storeSlotAt, storeSlotCode, storeSlotCount, type QuatLike, type Vec3Like } from '../../contracts/core';
import { storeInfo, type StoreInfo } from '../../catalog';
import type { CockpitFlight } from './types';

export const MPS_TO_KT = 1.943844;
export const M_TO_FT = 3.280839;
export const MPS_TO_FPM = 196.8504;
const RAD = 180 / Math.PI;

export interface Avionics {
  // Attitude (deg), from the interpolated orientation.
  pitchDeg: number;
  rollDeg: number;
  headingDeg: number;
  /** Flight path: unit velocity in the body frame (x fwd, y up, z right); valid above ~15 m/s. */
  fpm: Vec3Like;
  fpmValid: boolean;
  /** Ground track, deg true. */
  trackDeg: number;
  gsKt: number;
  // Air data.
  iasKt: number;
  tasKt: number;
  mach: number;
  altFt: number;
  aglFt: number;
  vsFpm: number;
  aoaDeg: number;
  g: number;
  gMax: number;
  // Engine (F404-IN20-like).
  nhPct: number;
  nlPct: number;
  ftitC: number;
  nozzlePct: number;
  oilPsi: number;
  /** Fuel flow, kg/h (measured from the fuel burn). */
  ffKgH: number;
  /** Afterburner lit (0..1 as it lights). */
  ab: number;
  // Fuel.
  fuelKg: number;
  /** Fuel in drop tanks, kg (-1 = none carried). */
  tankKg: number;
  totalFuelKg: number;
  /** Minutes of fuel left at the current flow. */
  enduranceMin: number;
  // Configuration.
  gearPos: number;
  gearDownCmd: boolean;
  onGround: boolean;
  airbrake: boolean;
  warnings: number;
  // Weapons and radar.
  weaponIdx: number;
  targetId: number;
  targetRangeM: number;
  closureMps: number;
  lockState: number;
  radarMode: number;
  radarMaxRangeM: number;
  radarScanAzRad: number;
  trackCount: number;
  // Autopilot.
  apFlags: number;
  apHdgDeg: number;
  apAltFt: number;
  apVsFpm: number;
  apSpdKt: number;
  // Navigation.
  ilsLoc: number;
  ilsGs: number;
}

export function createAvionics(): Avionics {
  return {
    pitchDeg: 0, rollDeg: 0, headingDeg: 0, fpm: { x: 1, y: 0, z: 0 }, fpmValid: false, trackDeg: 0, gsKt: 0,
    iasKt: 0, tasKt: 0, mach: 0, altFt: 0, aglFt: 0, vsFpm: 0, aoaDeg: 0, g: 1, gMax: 1,
    nhPct: 0, nlPct: 0, ftitC: 0, nozzlePct: 0, oilPsi: 0, ffKgH: 0, ab: 0,
    fuelKg: 0, tankKg: -1, totalFuelKg: 0, enduranceMin: 0,
    gearPos: 1, gearDownCmd: true, onGround: true, airbrake: false, warnings: 0,
    weaponIdx: 0, targetId: -1, targetRangeM: 0, closureMps: 0, lockState: 0, radarMode: 0, radarMaxRangeM: 0, radarScanAzRad: 0, trackCount: 0,
    apFlags: 0, apHdgDeg: 0, apAltFt: 0, apVsFpm: 0, apSpdKt: 0, ilsLoc: 0, ilsGs: 0,
  };
}

/** Smoothing state carried between frames. */
export interface AvionicsState {
  started: boolean;
  nhPct: number;
  ftitC: number;
  nozzlePct: number;
  ab: number;
  lastFuelKg: number;
  lastFuelSec: number;
  ffKgH: number;
}

export function createAvionicsState(): AvionicsState {
  return { started: false, nhPct: 0, ftitC: 0, nozzlePct: 0, ab: 0, lastFuelKg: NaN, lastFuelSec: 0, ffKgH: 0 };
}

/** Rotates world vector v by the inverse of q (world -> body). */
export function toBody(q: Readonly<QuatLike>, v: Readonly<Vec3Like>, out: Vec3Like): Vec3Like {
  // Conjugate rotation: v' = q* v q.
  const x = -q.x;
  const y = -q.y;
  const z = -q.z;
  const w = q.w;
  const ix = w * v.x + y * v.z - z * v.y;
  const iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x;
  const iw = -x * v.x - y * v.y - z * v.z;
  out.x = ix * w + iw * -x + iy * -z - iz * -y;
  out.y = iy * w + iw * -y + iz * -x - ix * -z;
  out.z = iz * w + iw * -z + ix * -y - iy * -x;
  return out;
}

/** Rotates body vector v by q (body -> world). */
export function toWorld(q: Readonly<QuatLike>, v: Readonly<Vec3Like>, out: Vec3Like): Vec3Like {
  const { x, y, z, w } = q;
  const ix = w * v.x + y * v.z - z * v.y;
  const iy = w * v.y + z * v.x - x * v.z;
  const iz = w * v.z + x * v.y - y * v.x;
  const iw = -x * v.x - y * v.y - z * v.z;
  out.x = ix * w + iw * -x + iy * -z - iz * -y;
  out.y = iy * w + iw * -y + iz * -x - ix * -z;
  out.z = iz * w + iw * -z + ix * -y - iy * -x;
  return out;
}

const scratchF: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchR: Vec3Like = { x: 0, y: 0, z: 0 };
const BODY_X: Vec3Like = { x: 1, y: 0, z: 0 };
const BODY_Z: Vec3Like = { x: 0, y: 0, z: 1 };

/** Heading/pitch/roll (deg) the same way the sim computes them (src/core/hudTelemetry.ts). */
export function attitudeDeg(rot: Readonly<QuatLike>, out: { headingDeg: number; pitchDeg: number; rollDeg: number }): void {
  const fwd = toWorld(rot, BODY_X, scratchF);
  const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
  const heading = Math.atan2(fwd.x, -fwd.z);
  const right = toWorld(rot, BODY_Z, scratchR);
  const cp = Math.cos(pitch);
  const roll = Math.abs(cp) > 1e-6 ? Math.atan2(-right.y / cp, Math.cos(heading) * right.x + Math.sin(heading) * right.z) : 0;
  out.headingDeg = (((heading * RAD) % 360) + 360) % 360;
  out.pitchDeg = pitch * RAD;
  out.rollDeg = roll * RAD;
}

/** Engine schedule: steady-state NH (%), turbine temperature (C), nozzle opening (%) for a lever position. */
export function engineSchedule(throttle: number, ab: number): { nh: number; ftit: number; nozzle: number } {
  const t = Math.max(0, Math.min(1, throttle));
  // F404: ground idle ~70% NH, military 100%; FTIT ~450 C at idle, ~870 C at military, ~900 C in
  // reheat; the nozzle is wide open at idle (less idle thrust), closes towards military, and opens
  // again through the afterburner range.
  const nh = 70 + 30 * Math.pow(t, 0.8) + 1.5 * ab;
  const ftit = 450 + 420 * Math.pow(t, 1.6) + 30 * ab;
  const nozzle = ab > 0 ? 25 + 75 * ab : 80 - 62 * Math.pow(t, 0.7);
  return { nh, ftit, nozzle };
}

/** Updates `av` from this frame's flight data. */
export function updateAvionics(av: Avionics, st: AvionicsState, f: Readonly<CockpitFlight>, dtSec: number): void {
  const h = f.hud;
  attitudeDeg(f.rot, av);

  const speed = Math.hypot(f.vel.x, f.vel.y, f.vel.z);
  av.fpmValid = speed > 15;
  if (speed > 0.5) {
    toBody(f.rot, f.vel, av.fpm);
    av.fpm.x /= speed;
    av.fpm.y /= speed;
    av.fpm.z /= speed;
  } else {
    av.fpm.x = 1;
    av.fpm.y = 0;
    av.fpm.z = 0;
  }
  const gs = Math.hypot(f.vel.x, f.vel.z);
  av.gsKt = gs * MPS_TO_KT;
  if (gs > 2) av.trackDeg = (((Math.atan2(f.vel.x, -f.vel.z) * RAD) % 360) + 360) % 360;
  else av.trackDeg = av.headingDeg;

  av.iasKt = (h[SnapshotHud.IAS_MPS] ?? 0) * MPS_TO_KT;
  av.tasKt = (h[SnapshotHud.TAS_MPS] ?? 0) * MPS_TO_KT;
  av.mach = h[SnapshotHud.MACH] ?? 0;
  av.altFt = (h[SnapshotHud.ALT_MSL_M] ?? 0) * M_TO_FT;
  av.aglFt = (h[SnapshotHud.ALT_AGL_M] ?? 0) * M_TO_FT;
  av.vsFpm = f.vel.y * MPS_TO_FPM;
  // AoA is meaningless when (almost) stopped: the sim reports ~180 deg on the runway.
  av.aoaDeg = speed > 15 ? (h[SnapshotHud.AOA_RAD] ?? 0) * RAD : 0;
  av.g = h[SnapshotHud.G_LOAD] ?? 1;
  av.onGround = (f.flags & EntityFlag.OnGround) !== 0;
  if (!st.started || av.onGround) av.gMax = Math.max(1, av.g);
  else av.gMax = Math.max(av.gMax, av.g);

  // Engine: spool towards the schedule (slower from low power, as a turbofan does).
  const abTarget = f.afterburner ? 1 : 0;
  const k = (tau: number): number => 1 - Math.exp(-dtSec / tau);
  st.ab += (abTarget - st.ab) * k(abTarget > st.ab ? 0.6 : 0.3);
  const s = engineSchedule(f.throttle, st.ab);
  if (!st.started) {
    st.nhPct = s.nh;
    st.ftitC = s.ftit;
    st.nozzlePct = s.nozzle;
  } else {
    const up = s.nh > st.nhPct;
    st.nhPct += (s.nh - st.nhPct) * k(up ? (st.nhPct < 85 ? 1.6 : 0.8) : 0.9);
    st.ftitC += (s.ftit - st.ftitC) * k(up ? 1.2 : 1.8);
    st.nozzlePct += (s.nozzle - st.nozzlePct) * k(0.5);
  }
  av.nhPct = st.nhPct;
  // Fan speed trails the core at low power and matches it at the top.
  av.nlPct = Math.max(0, 100 - (100 - st.nhPct) * 1.9);
  av.ftitC = st.ftitC;
  av.nozzlePct = st.nozzlePct;
  av.oilPsi = 18 + (st.nhPct - 70) * 0.9;
  av.ab = st.ab;

  // Fuel, and fuel flow from its rate of change (smoothed over a couple of seconds).
  av.fuelKg = h[SnapshotHud.FUEL_KG] ?? 0;
  av.tankKg = h[SnapshotHud.TANK_FUEL_KG] ?? -1;
  av.totalFuelKg = av.fuelKg + Math.max(0, av.tankKg);
  const total = av.totalFuelKg;
  if (!Number.isFinite(st.lastFuelKg)) {
    st.lastFuelKg = total;
    st.lastFuelSec = f.simTimeSec;
  } else if (f.simTimeSec - st.lastFuelSec >= 0.5) {
    const burned = st.lastFuelKg - total;
    const dt = f.simTimeSec - st.lastFuelSec;
    // A refuel or a jettison is not flow.
    if (burned >= 0 && burned / dt < 8) st.ffKgH += ((burned / dt) * 3600 - st.ffKgH) * Math.min(1, dt / 2);
    st.lastFuelKg = total;
    st.lastFuelSec = f.simTimeSec;
  }
  av.ffKgH = st.ffKgH;
  av.enduranceMin = st.ffKgH > 1 ? (total / st.ffKgH) * 60 : 0;

  av.gearPos = f.gearPos;
  av.gearDownCmd = (f.flags & EntityFlag.GearDownCommanded) !== 0;
  av.airbrake = (f.flags & EntityFlag.AirbrakeOut) !== 0;
  av.warnings = h[SnapshotHud.WARNING_BITS] ?? 0;

  av.weaponIdx = h[SnapshotHud.WEAPON_IDX] ?? 0;
  av.targetId = h[SnapshotHud.TARGET_ID] ?? -1;
  av.targetRangeM = h[SnapshotHud.TARGET_RANGE_M] ?? 0;
  av.closureMps = h[SnapshotHud.CLOSURE_MPS] ?? 0;
  av.lockState = h[SnapshotHud.LOCK_STATE] ?? 0;
  av.radarMode = h[SnapshotHud.RADAR_MODE] ?? 0;
  av.radarMaxRangeM = h[SnapshotHud.RADAR_MAX_RANGE_M] ?? 0;
  av.radarScanAzRad = h[SnapshotHud.RADAR_SCAN_AZ_RAD] ?? 0;
  av.trackCount = h[SnapshotHud.TRACK_COUNT] ?? 0;

  av.apFlags = h[SnapshotHud.AP_FLAGS] ?? 0;
  av.apHdgDeg = ((((h[SnapshotHud.AP_HDG_RAD] ?? 0) * RAD) % 360) + 360) % 360;
  av.apAltFt = (h[SnapshotHud.AP_ALT_M] ?? 0) * M_TO_FT;
  av.apVsFpm = (h[SnapshotHud.AP_VS_MPS] ?? 0) * MPS_TO_FPM;
  av.apSpdKt = (h[SnapshotHud.AP_SPD_MPS] ?? 0) * MPS_TO_KT;
  av.ilsLoc = h[SnapshotHud.ILS_LOC] ?? 0;
  av.ilsGs = h[SnapshotHud.ILS_GS] ?? 0;
  st.started = true;
}

/** Autopilot engaged? */
export const apEngaged = (av: Avionics): boolean => (av.apFlags & AutopilotFlag.Engaged) !== 0;
export const atEngaged = (av: Avionics): boolean => (av.apFlags & AutopilotFlag.Autothrottle) !== 0;

/** One of the player's radar tracks from the HUD block. */
export interface TrackView {
  id: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  identity: number;
  flags: number;
}

export function readTrack(hud: Float64Array, i: number, out: TrackView): TrackView {
  const b = SnapshotHud.TRACKS_BASE + i * SNAPSHOT_TRACK_STRIDE;
  out.id = hud[b + SnapshotTrack.ID] ?? -1;
  out.x = hud[b + SnapshotTrack.X] ?? 0;
  out.y = hud[b + SnapshotTrack.Y] ?? 0;
  out.z = hud[b + SnapshotTrack.Z] ?? 0;
  out.vx = hud[b + SnapshotTrack.VX] ?? 0;
  out.vz = hud[b + SnapshotTrack.VZ] ?? 0;
  out.identity = hud[b + SnapshotTrack.IDENTITY] ?? 0;
  out.flags = hud[b + SnapshotTrack.FLAGS] ?? 0;
  return out;
}

/** Format helpers shared by the displays. */
export const pad = (n: number, width: number): string => String(Math.round(n)).padStart(width, '0');
export const fmtHdg = (deg: number): string => pad(((Math.round(deg) % 360) + 360) % 360 || 360, 3);

/** A store code's (contracts/core STORE_IDS) catalogue display info, or undefined for nothing/unknown. */
export function storeInfoByCode(code: number): StoreInfo | undefined {
  return code > 0 ? storeInfo(STORE_IDS[code] ?? '') : undefined;
}

export interface StoreInventory {
  ir: number;
  irName: string;
  radar: number;
  radarName: string;
  tanks: number;
  /** Per station slot: code and count (for the stores page). */
  slots: { code: number; count: number }[];
}

export function storeInventory(packedA: number, packedB: number, out: StoreInventory): StoreInventory {
  out.ir = 0;
  out.radar = 0;
  out.tanks = 0;
  out.irName = '';
  out.radarName = '';
  for (let k = 0; k < MAX_STORE_SLOTS; k++) {
    const slot = storeSlotAt(packedA, packedB, k);
    const code = storeSlotCode(slot);
    const count = storeSlotCount(slot);
    const s = out.slots[k] ?? (out.slots[k] = { code: 0, count: 0 });
    s.code = code;
    s.count = count;
    const info = storeInfoByCode(code);
    if (!info) continue;
    if (info.kind === 'ir_missile') {
      out.ir += count;
      if (count > 0 || !out.irName) out.irName ||= info.label;
    } else if (info.kind === 'radar_missile') {
      out.radar += count;
      if (count > 0 || !out.radarName) out.radarName ||= info.label;
    } else if (info.kind === 'fuel_tank') out.tanks += count;
  }
  return out;
}

export function createStoreInventory(): StoreInventory {
  return { ir: 0, irName: '', radar: 0, radarName: '', tanks: 0, slots: [] };
}
