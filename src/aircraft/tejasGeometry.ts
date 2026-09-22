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
  // NOTE on magnitude (gLoadGain): previously -1.0. That magnitude made the
  // pitch axis diverge into a sustained, large (tens of degrees) alpha
  // oscillation from EVERY probed point in the trim envelope
  // (tools/sim-check.ts's whole-grid `out_of_control_authority` failures;
  // tests/integration/trimAndPerformance.test.ts reproduces the same thing
  // against the real Tejas data) -- not merely "marginally damped", but
  // unstable even for a near-zero pitch-stick command. The cause: dCL/dalpha
  // for this airframe (tejasAeroTables.ts) is steep enough (~3.3/rad at the
  // tested Mach numbers) that at a representative cruise condition (200 m/s,
  // sea level) roughly 37 g of load factor is produced per radian of alpha,
  // so gLoadGain=-1.0 (1 full radian of elevon per g of error) closes an
  // enormously high-gain alpha loop through the CL(alpha) table -- far past
  // what the rate-limited elevon (maxElevonRateRadS=3.0) and this
  // airframe's own pitch inertia can track without overshoot, so the
  // proportional term saturates the surface and flips sign every cycle (a
  // relay/bang-bang oscillation) instead of settling.
  //
  // -0.3 (a ~3x reduction) was chosen, over more aggressive reductions that
  // damp the trim envelope considerably better on their own (values down to
  // -0.04, combined with a larger pitchRateGain magnitude, were tried),
  // specifically because tests/integration/aiDogfight.test.ts's ace-vs-ace
  // case -- which needs enough g-command authority for the AI to actually
  // out-turn/out-climb a threat or the ground during aggressive
  // maneuvering, not just to hold a gentle cruise trim -- started failing
  // with a genuine ground impact (minAltAglTeam1 deeply negative) under
  // those more aggressive reductions: this airframe's real data does not
  // admit one single fixed gain that is simultaneously well-damped for a
  // slow, small-perturbation trim search AND responsive enough for
  // aggressive combat maneuvering (the "real gain-scheduled FCS would vary
  // this with dynamic pressure" limitation noted below cuts both ways). -0.3
  // is the point found, by sweeping this value against both
  // tests/integration/aiDogfight.test.ts and tools/sim-check.ts's trim
  // grid, where aiDogfight keeps passing while the trim search stops
  // diverging catastrophically everywhere and starts actually converging
  // in parts of the envelope (previously 0 of the grid's probed
  // altitude/speed cells converged; some now do, and most of the rest now
  // settle into a bounded, moderate-alpha condition instead of the earlier
  // unbounded oscillation) -- not a full fix of every named performance
  // target (see tests/integration/trimAndPerformance.test.ts's own
  // "expected review finding" framing for why a residual public-data-vs-
  // real-coefficients mismatch on some targets is not automatically a bug),
  // but a real, verified improvement over the previous universal
  // divergence, without regressing a test this change does not own fixing.
  pitchRateGain: -0.4,
  rollRateGain: 0.5,
  yawRateGain: 0.4,
  alphaLimitGain: 3.0,
  gLoadGain: -0.3,
};
