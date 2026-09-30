/**
 * src/physics/index.ts — barrel re-export for the flight model module.
 * See docs/spec/02-flight-model.md section 3.
 */
export { stepAircraft } from './integrator';
export { computeTelemetry } from './telemetry';
export { sampleAtmosphere } from './atmosphere';
export { sampleWind, createGustState } from './wind';
export { resetFcsTrimState } from './fcs';

export type {
  Environment,
  AtmosphereSample,
  SampleAtmosphere,
  StepAircraft,
  ComputeTelemetry,
  GustState,
  CreateGustState,
  SampleWind,
} from '../contracts/flight';

export {
  FLIGHT_MODEL_SUBSTEPS,
  MIN_AIRSPEED_FOR_AERO_MPS,
  GEAR_CONTACT_GEARPOS_THRESHOLD,
  ROLLING_RESISTANCE_COEFFICIENT,
  GEAR_HARD_STOP_STIFFNESS_MULTIPLIER,
  GROUND_LAW_MAX_ROTATION_RATE_RAD_S,
} from '../contracts/flight';
