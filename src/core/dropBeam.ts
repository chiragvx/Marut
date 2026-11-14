/**
 * src/core/dropBeam.ts — the guidance for an airdrop approach (Mission.dropApproach): a localiser
 * along the run-in course and a glidepath down to the drop height over the DZ, shown on the HUD's
 * ILS needles. Unlike a runway ILS the full-scale deflection never gets narrower than a few tens of
 * metres, so the needles stay flyable down to the release point instead of going twitchy.
 */
import { ILS_GS_FULL_SCALE_DEG, ILS_LOC_FULL_SCALE_DEG, type DropApproach, type Vec3Like } from '../contracts/core';

const DEG = Math.PI / 180;
/** Narrowest full-scale deflection: across the track, and of height, m. */
const LOC_MIN_FULL_M = 150;
const GS_MIN_FULL_M = 40;
/** Needles show inside this angle off the course, seen from the DZ. */
const VALID_AZ_RAD = 25 * DEG;

export interface DropBeamState {
  /** Normalised deviations, [-1, 1] (HUD ILS_LOC / ILS_GS convention: loc + = right of the course, gs + = high). 0, 0 when not valid. */
  loc: number;
  gs: number;
  valid: boolean;
  /** Distance back from the DZ along the course (+ = before the DZ), m. */
  alongM: number;
  /** Right of the course, m. */
  crossM: number;
  /** The glidepath's height here, m above sea level (the drop height inside the DZ). */
  pathAltM: number;
  /** Height above (+) or below the glidepath, m. */
  highM: number;
}

export const newDropBeamState = (): DropBeamState => ({ loc: 0, gs: 0, valid: false, alongM: 0, crossM: 0, pathAltM: 0, highM: 0 });

/** The glidepath's height at `alongM` before the DZ, m above sea level. */
export function dropPathAltM(a: DropApproach, alongM: number): number {
  return a.groundM + a.heightAglM + Math.max(0, alongM) * Math.tan(a.glideDeg * DEG);
}

export function dropBeamAt(pos: Readonly<Vec3Like>, a: DropApproach, out: DropBeamState): DropBeamState {
  const fx = Math.sin(a.courseRad), fz = -Math.cos(a.courseRad);
  const rx = Math.cos(a.courseRad), rz = Math.sin(a.courseRad);
  const dx = pos.x - a.pos.x, dz = pos.z - a.pos.z;
  out.alongM = -(dx * fx + dz * fz);
  out.crossM = dx * rx + dz * rz;
  out.pathAltM = dropPathAltM(a, out.alongM);
  out.highM = pos.y - out.pathAltM;
  const az = Math.atan2(Math.abs(out.crossM), Math.max(out.alongM, 1));
  out.valid = out.alongM > 200 && out.alongM <= a.rangeM && az <= VALID_AZ_RAD;
  if (!out.valid) {
    out.loc = 0;
    out.gs = 0;
    return out;
  }
  const locFull = Math.max(LOC_MIN_FULL_M, out.alongM * Math.tan(ILS_LOC_FULL_SCALE_DEG * DEG));
  const gsFull = Math.max(GS_MIN_FULL_M, out.alongM * Math.tan(ILS_GS_FULL_SCALE_DEG * DEG));
  // Never exactly 0: 0, 0 means "no beam" to the HUD.
  out.loc = Math.max(-1, Math.min(1, out.crossM / locFull)) || 1e-6;
  out.gs = Math.max(-1, Math.min(1, out.highM / gsFull)) || 1e-6;
  return out;
}
