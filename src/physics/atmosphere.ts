/**
 * src/physics/atmosphere.ts — two-layer International Standard Atmosphere
 * model, 0-20000 m. Implements `SampleAtmosphere` (contracts/flight.ts).
 * See docs/spec/02-flight-model.md section 4.1.
 */
import type { AtmosphereSample, SampleAtmosphere } from '../contracts/flight';

const T0_K = 288.15;
const P0_PA = 101325.0;
const LAPSE_RATE_K_PER_M = 0.0065;
const G0_MPS2 = 9.80665;
const GAS_CONSTANT_J_PER_MOL_K = 8.3144598;
const MOLAR_MASS_AIR_KG_PER_MOL = 0.0289644;
const R_SPECIFIC_J_PER_KG_K = GAS_CONSTANT_J_PER_MOL_K / MOLAR_MASS_AIR_KG_PER_MOL;
const GAMMA = 1.4;
const T11_K = 216.65;
const TROPOPAUSE_M = 11000;
const MAX_TABLE_ALTITUDE_M = 20000;

/** Pressure-lapse exponent g0*M_air/(R*L) ≈ 5.25588. */
const PRESSURE_EXPONENT = (G0_MPS2 * MOLAR_MASS_AIR_KG_PER_MOL) / (GAS_CONSTANT_J_PER_MOL_K * LAPSE_RATE_K_PER_M);

/** Pressure at the tropopause (11000 m), computed once at module load. */
const P11_PA = P0_PA * Math.pow(T11_K / T0_K, PRESSURE_EXPONENT);

export const sampleAtmosphere: SampleAtmosphere = (altitudeMslM: number, out: AtmosphereSample): AtmosphereSample => {
  let temperatureK: number;
  let pressurePa: number;

  if (altitudeMslM <= TROPOPAUSE_M) {
    temperatureK = T0_K - LAPSE_RATE_K_PER_M * altitudeMslM;
    pressurePa = P0_PA * Math.pow(temperatureK / T0_K, PRESSURE_EXPONENT);
  } else {
    const clampedAlt = altitudeMslM > MAX_TABLE_ALTITUDE_M ? MAX_TABLE_ALTITUDE_M : altitudeMslM;
    const hPrime = clampedAlt - TROPOPAUSE_M;
    temperatureK = T11_K;
    pressurePa = P11_PA * Math.exp((-G0_MPS2 * MOLAR_MASS_AIR_KG_PER_MOL * hPrime) / (GAS_CONSTANT_J_PER_MOL_K * T11_K));
  }

  out.temperatureK = temperatureK;
  out.pressurePa = pressurePa;
  out.densityKgM3 = pressurePa / (R_SPECIFIC_J_PER_KG_K * temperatureK);
  out.soundSpeedMps = Math.sqrt(GAMMA * R_SPECIFIC_J_PER_KG_K * temperatureK);
  return out;
};
