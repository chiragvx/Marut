/**
 * src/core/autopilot.ts — the player's autopilot and autothrottle (a basic flight-sim autopilot).
 *
 * Modes:
 * - AP (lateral): HDG — turns onto the heading bug at a rate proportional to the error, bank limited
 *   to AP_MAX_BANK_RAD, then holds it.
 * - AP (vertical): ALT — holds the altitude bug; when it changes, climbs/descends to it at the
 *   vertical-speed bug's rate and levels off smoothly. VS — holds the vertical-speed bug, and
 *   captures the altitude bug (switching to ALT) if the aircraft is heading towards it.
 * - A/T: holds the speed bug (IAS) with the throttle (military power at most; afterburner stays the
 *   pilot's). The HUD's throttle lever follows it (main.ts), like motorised throttles.
 *
 * It flies through the fly-by-wire system like a pilot would: the FCS already holds the flight path
 * with the stick centred (fcs.ts neutralGReference), so the vertical channel commands a small load
 * factor increment to steer the flight-path angle, and the lateral channel a gentle roll rate.
 *
 * Disconnects: any real stick input (the pilot takes over), stall, or touching down. Moving the
 * throttle disconnects the A/T. Engaging needs the aircraft airborne.
 *
 * Pure state + functions (no allocation per tick); World owns one state for the player.
 */
import type { AircraftTelemetry, AutopilotAction, PilotInputs } from '../contracts/core';
import { AutopilotFlag } from '../contracts/core';

const G = 9.80665;
const DEG = Math.PI / 180;

/** Lateral: bank limit, the heading-error time constant (s) and the roll-rate limit. */
export const AP_MAX_BANK_RAD = 25 * DEG;
const AP_HDG_TAU_SEC = 8;
const AP_BANK_GAIN = 1.5; // (rad/s of roll rate) per rad of bank error
const AP_MAX_ROLL_RATE_RAD_S = 10 * DEG;
/** Vertical: altitude-capture time constant (s), flight-path gain (1/s), load-factor authority. */
const AP_ALT_TAU_SEC = 10;
const AP_GAMMA_GAIN = 0.8;
const AP_MAX_DELTA_G_UP = 0.7;
const AP_MAX_DELTA_G_DOWN = 0.5;
const AP_MAX_FPA_RAD = 20 * DEG;
/** ALT mode never changes altitude slower than this (m/s), whatever the VS bug says. */
const AP_MIN_ALT_CHANGE_RATE_MPS = 5;
export const AP_DEFAULT_VS_MPS = 10;
export const AP_MAX_VS_MPS = 60;
/** Below this IAS (m/s) the AP stops climbing; below AP_MIN_IAS - 10 it descends to regain speed. */
const AP_MIN_IAS_MPS = 85;
/** Stick deflection that counts as the pilot taking over. */
const AP_OVERRIDE_STICK = 0.3;
/** A/T: velocity-form PI on IAS (throttle per second per m/s of error, and per m/s^2 of acceleration). */
const AT_KI = 0.006;
const AT_KP = 0.08;
const AT_MAX_RATE_PER_SEC = 0.25;
/** Seconds the HUD flashes AP OFF / A/T OFF after a disconnect. */
const DISCONNECT_FLASH_SEC = 3;
export const AP_MIN_ENGAGE_AGL_M = 30;
export const AP_MAX_ALT_M = 15000;
export const AT_MIN_SPD_MPS = 60;
export const AT_MAX_SPD_MPS = 600;

export interface AutopilotState {
  engaged: boolean;
  autothrottle: boolean;
  verticalMode: 'alt' | 'vs';
  hdgRad: number;
  altM: number;
  vsMps: number;
  spdMps: number;
  /** Bugs the pilot has preset while disengaged (engaging then uses them instead of the current values). */
  hdgPreset: boolean;
  altPreset: boolean;
  spdPreset: boolean;
  /** A/T throttle lever position. */
  throttle: number;
  lastIasMps: number;
  apOffFlashSec: number;
  atOffFlashSec: number;
}

export function createAutopilotState(): AutopilotState {
  return {
    engaged: false,
    autothrottle: false,
    verticalMode: 'alt',
    hdgRad: 0,
    altM: 0,
    vsMps: AP_DEFAULT_VS_MPS,
    spdMps: 0,
    hdgPreset: false,
    altPreset: false,
    spdPreset: false,
    throttle: 0,
    lastIasMps: 0,
    apOffFlashSec: 0,
    atOffFlashSec: 0,
  };
}

const wrapPi = (a: number): number => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
const wrap2Pi = (a: number): number => a - 2 * Math.PI * Math.floor(a / (2 * Math.PI));
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

function disengageAp(ap: AutopilotState, flash: boolean): void {
  if (!ap.engaged) return;
  ap.engaged = false;
  ap.hdgPreset = false;
  ap.altPreset = false;
  if (flash) ap.apOffFlashSec = DISCONNECT_FLASH_SEC;
}

function disengageAt(ap: AutopilotState, flash: boolean): void {
  if (!ap.autothrottle) return;
  ap.autothrottle = false;
  ap.spdPreset = false;
  if (flash) ap.atOffFlashSec = DISCONNECT_FLASH_SEC;
}

/** Applies one pilot command (a key press) to the autopilot. */
export function applyAutopilotAction(ap: AutopilotState, action: AutopilotAction, t: Readonly<AircraftTelemetry>, pilotThrottle: number): void {
  const airborne = !t.onGround && t.altAglM > AP_MIN_ENGAGE_AGL_M;
  switch (action.type) {
    case 'toggleAp':
      if (ap.engaged) {
        disengageAp(ap, false);
        return;
      }
      if (!airborne) return;
      ap.engaged = true;
      ap.apOffFlashSec = 0;
      if (!ap.hdgPreset) ap.hdgRad = wrap2Pi(t.headingRad);
      if (ap.altPreset) {
        ap.verticalMode = 'alt';
      } else if (Math.abs(t.vspeedMps) < 2.5) {
        ap.verticalMode = 'alt';
        ap.altM = Math.round(t.altMslM / 10) * 10;
      } else {
        // Climbing or descending: hold that vertical speed (the altitude bug, left at the current
        // altitude, is behind the aircraft, so it is not captured until the pilot sets one ahead).
        ap.verticalMode = 'vs';
        ap.vsMps = Math.round(t.vspeedMps);
        ap.altM = Math.round(t.altMslM / 10) * 10;
      }
      return;
    case 'toggleAt':
      if (ap.autothrottle) {
        disengageAt(ap, false);
        return;
      }
      if (!airborne) return;
      ap.autothrottle = true;
      ap.atOffFlashSec = 0;
      if (!ap.spdPreset) ap.spdMps = Math.round(t.iasMps);
      ap.throttle = clamp(pilotThrottle, 0, 1);
      ap.lastIasMps = t.iasMps;
      return;
    case 'adjust': {
      const d = action.delta;
      if (action.target === 'hdg') {
        if (!ap.engaged && !ap.hdgPreset) ap.hdgRad = wrap2Pi(t.headingRad);
        ap.hdgRad = wrap2Pi(ap.hdgRad + d);
        ap.hdgPreset = true;
      } else if (action.target === 'alt') {
        if (!ap.engaged && !ap.altPreset) ap.altM = Math.round(t.altMslM / 100) * 100;
        ap.altM = clamp(ap.altM + d, 0, AP_MAX_ALT_M);
        ap.altPreset = true;
        // Setting an altitude means "go there".
        if (ap.engaged) ap.verticalMode = 'alt';
      } else if (action.target === 'vs') {
        // Setting a vertical speed means "fly this climb rate" (from the current one, if not already in VS).
        if (ap.engaged && ap.verticalMode !== 'vs') {
          ap.verticalMode = 'vs';
          ap.vsMps = Math.round(t.vspeedMps);
        }
        ap.vsMps = clamp(ap.vsMps + d, -AP_MAX_VS_MPS, AP_MAX_VS_MPS);
      } else {
        if (!ap.autothrottle && !ap.spdPreset) ap.spdMps = Math.round(t.iasMps);
        ap.spdMps = clamp(ap.spdMps + d, AT_MIN_SPD_MPS, AT_MAX_SPD_MPS);
        ap.spdPreset = true;
      }
      return;
    }
  }
}

/**
 * One tick. `pilot` is the pilot's own input this tick (read only: used to detect them taking
 * over); `out` must already hold a copy of it, and gets the autopilot's stick/throttle written over
 * it for the active modes. Returns true if anything was overridden.
 */
export function stepAutopilot(
  ap: AutopilotState,
  t: Readonly<AircraftTelemetry>,
  pilot: Readonly<PilotInputs>,
  maxRollRateRadS: number,
  maxGPos: number,
  maxGNeg: number,
  dt: number,
  out: PilotInputs
): boolean {
  ap.apOffFlashSec = Math.max(0, ap.apOffFlashSec - dt);
  ap.atOffFlashSec = Math.max(0, ap.atOffFlashSec - dt);

  // Disconnects.
  if (t.onGround) {
    disengageAp(ap, true);
    disengageAt(ap, true);
  }
  if (ap.engaged && (Math.abs(pilot.pitch) > AP_OVERRIDE_STICK || Math.abs(pilot.roll) > AP_OVERRIDE_STICK || t.stalled)) disengageAp(ap, true);
  if (ap.autothrottle && pilot.throttleActive === true) disengageAt(ap, true);

  if (ap.engaged) {
    const V = Math.max(t.tasMps, 30);
    // Lateral: heading error -> turn rate -> bank -> roll rate.
    const hdgErr = wrapPi(ap.hdgRad - t.headingRad);
    const turnRate = hdgErr / AP_HDG_TAU_SEC;
    const bankCmd = clamp(Math.atan((turnRate * V) / G), -AP_MAX_BANK_RAD, AP_MAX_BANK_RAD);
    const rollRate = clamp(AP_BANK_GAIN * wrapPi(bankCmd - t.rollRad), -AP_MAX_ROLL_RATE_RAD_S, AP_MAX_ROLL_RATE_RAD_S);
    out.roll = clamp(rollRate / maxRollRateRadS, -1, 1);

    // Vertical: target vertical speed -> flight-path angle -> load-factor increment.
    let vsCmd: number;
    const altLawVs = (ap.altM - t.altMslM) / AP_ALT_TAU_SEC;
    if (ap.verticalMode === 'vs') {
      vsCmd = ap.vsMps;
      // Capture the altitude bug when heading towards it and close enough to level off smoothly.
      if (ap.vsMps !== 0 && Math.sign(altLawVs) === Math.sign(ap.vsMps) && Math.abs(altLawVs) <= Math.abs(ap.vsMps)) {
        ap.verticalMode = 'alt';
        vsCmd = altLawVs;
      }
    } else {
      const rate = Math.max(Math.abs(ap.vsMps), AP_MIN_ALT_CHANGE_RATE_MPS);
      vsCmd = clamp(altLawVs, -rate, rate);
    }
    // Speed protection: never climb away the last of the airspeed.
    if (t.iasMps < AP_MIN_IAS_MPS) vsCmd = Math.min(vsCmd, ((t.iasMps - AP_MIN_IAS_MPS) / 10) * AP_MIN_ALT_CHANGE_RATE_MPS);
    const gammaCmd = Math.asin(clamp(vsCmd / V, -Math.sin(AP_MAX_FPA_RAD), Math.sin(AP_MAX_FPA_RAD)));
    const gamma = Math.asin(clamp(t.vspeedMps / V, -1, 1));
    const dG = clamp((AP_GAMMA_GAIN * (gammaCmd - gamma) * V) / G, -AP_MAX_DELTA_G_DOWN, AP_MAX_DELTA_G_UP);
    // FCS stick law (fcs.ts computeGCommand): stick 0 = the neutral (flight-path-holding) g,
    // +1 = maxGPos, -1 = maxGNeg. Neutral is about cos(gamma)/cos(bank) in a coordinated turn.
    const neutral = Math.cos(gamma) / Math.cos(Math.min(Math.abs(t.rollRad), 0.576));
    out.pitch = clamp(dG >= 0 ? dG / (maxGPos - neutral) : dG / (neutral - maxGNeg), -1, 1);
  }

  if (ap.autothrottle) {
    const err = ap.spdMps - t.iasMps;
    const accel = dt > 0 ? (t.iasMps - ap.lastIasMps) / dt : 0;
    const rate = clamp(AT_KI * err - AT_KP * accel, -AT_MAX_RATE_PER_SEC, AT_MAX_RATE_PER_SEC);
    ap.throttle = clamp(ap.throttle + rate * dt, 0, 1);
    out.throttle = ap.throttle;
  }
  ap.lastIasMps = t.iasMps;
  return ap.engaged || ap.autothrottle;
}

/** HUD bit flags (SnapshotHud.AP_FLAGS). */
export function autopilotFlags(ap: Readonly<AutopilotState>, t: Readonly<AircraftTelemetry>): number {
  let f = 0;
  if (ap.engaged) f |= AutopilotFlag.Engaged;
  if (ap.autothrottle) f |= AutopilotFlag.Autothrottle;
  if (ap.verticalMode === 'vs') {
    f |= AutopilotFlag.VsMode;
    const toward = (ap.altM - t.altMslM) * ap.vsMps > 0;
    if (toward) f |= AutopilotFlag.AltArmed;
  }
  if (ap.apOffFlashSec > 0) f |= AutopilotFlag.ApOffFlash;
  if (ap.atOffFlashSec > 0) f |= AutopilotFlag.AtOffFlash;
  if (ap.hdgPreset || ap.engaged) f |= AutopilotFlag.HdgBug;
  if (ap.altPreset || ap.engaged) f |= AutopilotFlag.AltBug;
  if (ap.spdPreset || ap.autothrottle) f |= AutopilotFlag.SpdBug;
  return f;
}
