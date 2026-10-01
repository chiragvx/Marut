/**
 * src/core/gcas.ts — predictive ground-collision warning. Flies a standard recovery from the
 * aircraft's current state over the terrain ahead: the pilot reacts (GCAS_REACTION_SEC), rolls wings
 * level, pulls GCAS_PULL_G into a GCAS_END_GAMMA_RAD climb and holds it (so rising ground ahead
 * warns only when even a full pull-up into a climb would not clear it). The least clearance along
 * that path says whether a pull-up is due: PULL UP when even an immediate recovery would pass
 * closer than GCAS_WARN_CLEARANCE_M.
 * Pure (a HeightSampler and plain numbers), allocation-free.
 */
import type { HeightSampler, Vec3Like } from '../contracts/core';
import { GCAS_NO_THREAT_M } from '../contracts/core';

export const GCAS_REACTION_SEC = 0.8;
export const GCAS_ROLL_RATE_RAD_S = (150 * Math.PI) / 180;
export const GCAS_PULL_G = 5;
/** The recovery ends climbing at this flight-path angle, held for GCAS_HOLD_SEC. */
export const GCAS_END_GAMMA_RAD = (20 * Math.PI) / 180;
export const GCAS_HOLD_SEC = 8;
/** PULL UP when the recovery would pass closer to the ground than this, m. */
export const GCAS_WARN_CLEARANCE_M = 30;
/** Above this height over the ground below and ahead, nothing is checked (cheap at altitude), m. */
const GCAS_CEILING_AGL_M = 3000;
const STEP_SEC = 0.2;
const MAX_SEC = 40;
const G = 9.80665;

/**
 * The least clearance over the terrain, m, of a recovery begun now from position `pos`, velocity
 * `vel` and bank `bankRad`; GCAS_NO_THREAT_M when the path never comes near the ground.
 */
export function gcasClearanceM(pos: Vec3Like, vel: Vec3Like, bankRad: number, sampler: HeightSampler): number {
  const vh = Math.hypot(vel.x, vel.z);
  const v = Math.max(60, Math.hypot(vel.x, vel.y, vel.z));
  const hx = vh > 1 ? vel.x / vh : 0;
  const hz = vh > 1 ? vel.z / vh : 0;
  let gamma = Math.atan2(vel.y, Math.max(vh, 1e-6));
  const ground0 = sampler.heightAt(pos.x, pos.z);
  // High above the ground and not diving steeply: no threat.
  if (pos.y - ground0 > GCAS_CEILING_AGL_M && pos.y - ground0 > -vel.y * 20) return GCAS_NO_THREAT_M;
  const straightSec = GCAS_REACTION_SEC + Math.abs(bankRad) / GCAS_ROLL_RATE_RAD_S;
  let x = pos.x, y = pos.y, z = pos.z;
  let min = GCAS_NO_THREAT_M;
  let holdLeft = GCAS_HOLD_SEC;
  for (let t = 0; t < MAX_SEC; t += STEP_SEC) {
    if (t >= straightSec && gamma < GCAS_END_GAMMA_RAD) {
      gamma = Math.min(GCAS_END_GAMMA_RAD, gamma + (G * (GCAS_PULL_G - Math.cos(gamma)) / v) * STEP_SEC);
    } else if (t >= straightSec) {
      holdLeft -= STEP_SEC;
      if (holdLeft < 0) break;
    }
    const d = v * Math.cos(gamma) * STEP_SEC;
    x += hx * d;
    z += hz * d;
    y += v * Math.sin(gamma) * STEP_SEC;
    const c = y - sampler.heightAt(x, z);
    if (c < min) min = c;
    if (min < -100) break;
  }
  return min > GCAS_CEILING_AGL_M ? GCAS_NO_THREAT_M : min;
}
