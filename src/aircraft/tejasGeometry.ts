/**
 * src/aircraft/tejasGeometry.ts — mass, inertia, CG offset, wing geometry,
 * the seven Hardpoints, the three GearDefinition legs, and FcsLimits for the
 * HAL Tejas Mk1. Pure data; see docs/spec/03-tejas-data.md section 5.1/5.4/5.5
 * for every value's source/justification. No runtime computation beyond
 * `meanChordM = wingAreaM2 / wingSpanM` (the exact formula the spec cites).
 */
import type { Vec3Like } from '../contracts/core';
import type { Hardpoint, GearDefinition, FcsLimits } from '../contracts/aircraft';

// --- Mass / fuel (section 5.1) ---
export const emptyMassKg = 6560;
export const maxFuelKg = 2458;
/** Fixed reference combat weight the integrator treats as constant (02-flight-model.md section 9). */
export const massKg = 8500;

// --- Inertia tensor, body-frame about CG, kg*m^2 (section 5.1) ---
export const inertiaBodyKgM2 = {
  xx: 5700,
  yy: 38000,
  zz: 33000,
  xy: -300,
  xz: 0,
  yz: 0,
} as const;

// --- CG offset, body-frame, m (section 5.1) ---
export const cgOffsetBodyM: Vec3Like = { x: -0.15, y: 0.05, z: 0 };

// --- Wing geometry (section 5.1) ---
export const wingAreaM2 = 38.4;
export const wingSpanM = 8.2;
/** wingAreaM2 / wingSpanM, per section 5.1's simplified rectangular-reference MAC approximation. */
export const meanChordM = wingAreaM2 / wingSpanM;

// --- Hardpoints (section 5.1): seven total, all four Hardpoint.type values represented. ---
export const hardpoints: readonly Hardpoint[] = [
  { id: 'gun-1', posBodyM: { x: 3.5, y: -0.2, z: 0.3 }, type: 'gun' },
  { id: 'wingtip-l', posBodyM: { x: -0.5, y: 0, z: -4.0 }, type: 'ir_missile' },
  { id: 'wingtip-r', posBodyM: { x: -0.5, y: 0, z: 4.0 }, type: 'ir_missile' },
  { id: 'pylon-outer-l', posBodyM: { x: -0.3, y: -0.3, z: -3.0 }, type: 'radar_missile' },
  { id: 'pylon-outer-r', posBodyM: { x: -0.3, y: -0.3, z: 3.0 }, type: 'radar_missile' },
  { id: 'pylon-inner-l', posBodyM: { x: -0.1, y: -0.3, z: -1.8 }, type: 'fuel_tank' },
  { id: 'pylon-inner-r', posBodyM: { x: -0.1, y: -0.3, z: 1.8 }, type: 'fuel_tank' },
];

// --- Landing gear, three legs (section 5.4). ---
export const gear: readonly GearDefinition[] = [
  {
    id: 'nose',
    posBodyM: { x: 4.3, y: -1.1, z: 0 },
    maxCompressionM: 0.28,
    springNPerM: 250000,
    damperNPerMPerS: 26000,
    kineticFrictionCoefficient: 0.6,
    steerable: true,
    maxSteerAngleRad: 0.5236,
    brakeCapable: false,
  },
  {
    id: 'mainLeft',
    posBodyM: { x: -0.2, y: -1.1, z: -1.1 },
    maxCompressionM: 0.35,
    springNPerM: 450000,
    damperNPerMPerS: 35000,
    kineticFrictionCoefficient: 0.6,
    steerable: false,
    maxSteerAngleRad: 0,
    brakeCapable: true,
  },
  {
    id: 'mainRight',
    posBodyM: { x: -0.2, y: -1.1, z: 1.1 },
    maxCompressionM: 0.35,
    springNPerM: 450000,
    damperNPerMPerS: 35000,
    kineticFrictionCoefficient: 0.6,
    steerable: false,
    maxSteerAngleRad: 0,
    brakeCapable: true,
  },
];

// --- FCS limits (section 5.5). ---
export const fcsLimits: FcsLimits = {
  maxAlphaRad: 0.383972,
  minAlphaRad: -0.20944,
  maxGLoadPos: 8.0,
  maxGLoadNeg: -3.0,
  maxRollRateRadS: 5.236,
  maxElevonRad: 0.436332,
  maxRudderRad: 0.349066,
  maxElevonRateRadS: 3.0,
  maxRudderRateRadS: 3.0,
  // NOTE on sign: per this project's elevon convention (00-architecture.md
  // section 6.2), +elevonSym = trailing-edge-down = NOSE-DOWN moment
  // (Cm_elevon is negative, tejasAeroTables.ts). fcs.ts's literal pitch law
  // (02-flight-model.md section 4.9) is
  //   elevonSymCmd = gLoadGain*(gCmd-gLoad) - pitchRateGain*q + trimIntegral
  // For this to be a STABILIZING (not destabilizing) g-command/rate-damper
  // pair given that convention, both gains must be NEGATIVE: to gain MORE g
  // (gCmd>gLoad) the correction must command a NOSE-UP moment, i.e. a
  // NEGATIVE elevonSym; to damp an existing nose-up rate (q>0) the term
  // -pitchRateGain*q must be POSITIVE (nose-down), which also requires
  // pitchRateGain negative. With positive gains (the "natural" reading of
  // "Kg"/"Kq" as plain positive proportional/damping gains) this closed loop
  // is inverted: the g-loop fights itself and the rate term reinforces
  // rather than opposes pitch rate, which is exactly what
  // tests/physics/relaxedStability.test.ts's fixture already documents
  // (that file's own fixture uses gLoadGain=-1.0/pitchRateGain=-2.0 and
  // explains why in its file-level comment) — this was previously left
  // positive here, which made every trim search and any aggressive
  // (AI-commanded) pitch maneuver diverge instead of converge.
  //
  // NOTE on magnitude (pitchRateGain): -0.3 (the smallest magnitude that
  // still has the correct sign) leaves the closed loop only marginally
  // damped for this airframe's fast open-loop pitch instability (see
  // 03-tejas-data.md's own dCm/dalpha figure) -- tests/integration/
  // aiDogfight.test.ts's ace-vs-ace case (high commanded-G, aggressive AI
  // stick inputs) drives a sustained-enough oscillation to briefly depart
  // controlled flight. -0.4 is the smallest increase found (by comparing
  // against that test and tools/sim-check.ts's climb-rate target, which
  // both move in opposite directions as this magnitude grows) that keeps
  // aiDogfight passing without needlessly sacrificing climb performance;
  // see this module's contractConcerns for why a single fixed gain still
  // cannot cleanly stabilize the full low-speed part of the envelope (a
  // real gain-scheduled FCS would vary this with dynamic pressure, which
  // FcsLimits has no provision for).
  pitchRateGain: -0.4,
  rollRateGain: 0.5,
  yawRateGain: 0.4,
  alphaLimitGain: 3.0,
  gLoadGain: -1.0,
};
