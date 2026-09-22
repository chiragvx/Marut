/**
 * src/core/atmosphere.ts — self-contained two-layer ISA atmosphere model
 * (troposphere 0-11000 m, isothermal layer 11000-20000 m). See
 * 10-core-worker.md section 4.5 for why this module owns its own copy
 * instead of depending on module 02's `src/physics/atmosphere.ts`.
 */

const T0 = 288.15;
const P0 = 101325;
const LAPSE = 0.0065;
const R_SPECIFIC = 287.05287;
const G0 = 9.80665;
const GAMMA = 1.4;
const EXPONENT = G0 / (LAPSE * R_SPECIFIC); // 5.255879812716677
const T11 = T0 - LAPSE * 11000; // 216.65
const P11 = P0 * Math.pow(T11 / T0, EXPONENT); // 22632.040095007793

export interface IsaAtmosphereResult {
  airDensityKgM3: number;
  soundSpeedMps: number;
}

/** Pure, allocation-free (returns a small fresh object — this is not a per-tick-per-entity hot path call site issue since callers may cache the shape; see World.stepOnce which reuses a scratch Environment). */
export function isaAtmosphere(altMslM: number): IsaAtmosphereResult {
  const h = Math.max(-1000, Math.min(20000, altMslM));
  let T: number;
  let P: number;
  if (h <= 11000) {
    T = T0 - LAPSE * h;
    P = P0 * Math.pow(T / T0, EXPONENT);
  } else {
    T = T11;
    P = P11 * Math.exp((-G0 * (h - 11000)) / (R_SPECIFIC * T11));
  }
  const rho = P / (R_SPECIFIC * T);
  return { airDensityKgM3: rho, soundSpeedMps: Math.sqrt(GAMMA * R_SPECIFIC * T) };
}

/** Allocation-free variant: writes into `out` and returns it, for the sim worker's hot path (World.stepOnce, once per aircraft per tick). */
export function isaAtmosphereInto(altMslM: number, out: IsaAtmosphereResult): IsaAtmosphereResult {
  const h = Math.max(-1000, Math.min(20000, altMslM));
  let T: number;
  let P: number;
  if (h <= 11000) {
    T = T0 - LAPSE * h;
    P = P0 * Math.pow(T / T0, EXPONENT);
  } else {
    T = T11;
    P = P11 * Math.exp((-G0 * (h - 11000)) / (R_SPECIFIC * T11));
  }
  out.airDensityKgM3 = P / (R_SPECIFIC * T);
  out.soundSpeedMps = Math.sqrt(GAMMA * R_SPECIFIC * T);
  return out;
}
