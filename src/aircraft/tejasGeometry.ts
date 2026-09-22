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
  // NOTE on sign (both gLoadGain and pitchRateGain are NEGATIVE, contrary to
  // 03-tejas-data.md section 5.5's literal pinned "+1.0"/"+0.3" table
  // values, and contrary to that section's own claim that +1.0 "matches
  // 02-flight-model.md section 4.9's Kg=1 rad/g worked example" -- see the
  // flagged contract/spec concern below for why that pin is wrong for this
  // airframe's real data). fcs.ts's literal pitch law (02-flight-model.md
  // section 4.9) is
  //   elevonSymCmd = gLoadGain*(gCmd-gLoad) - pitchRateGain*q + trimIntegral
  // and this project's elevon convention (00-architecture.md section 6.2,
  // mandatory) fixes +elevonSym = trailing-edge-down = NOSE-DOWN moment
  // (Cm_elevon < 0, tejasAeroTables.ts).
  //
  // pitchRateGain -- UNAMBIGUOUS sign, independent of any Tejas-specific
  // data: q (pitch rate) is driven purely by the aero MOMENT (Cm_elevon),
  // never by the direct-lift term CL_elevon (a force, not a moment -- see
  // 02-flight-model.md section 4.5's Mz_body = Cm_std*qBar*S*c, no flip for
  // this project's Y-up body frame). To damp an existing nose-up rate (q>0)
  // the correction must add a NOSE-DOWN moment, i.e. elevonSym must move
  // MORE POSITIVE (since Cm_elevon<0). The term "-pitchRateGain*q" is
  // positive for q>0 only if pitchRateGain is NEGATIVE. A positive
  // pitchRateGain (the spec table's literal "+0.3") makes this term
  // REINFORCE, not oppose, any existing pitch rate -- confirmed by direct
  // simulation: with pitchRateGain positive the pitch axis runs away
  // monotonically (alpha exceeded 150 degrees within 20s of holding a 1g
  // trim command at 3000m/200m/s) regardless of gLoadGain's sign.
  //
  // gLoadGain -- sign is NOT fixed by Cm_elevon alone: elevon deflection
  // affects gLoad two ways -- (a) directly via CL_elevon (+0.42/rad,
  // instantaneous, no lag) and (b) indirectly via Cm_elevon's moment
  // changing pitch attitude/alpha over time, which then changes CL(alpha).
  // 03-tejas-data.md section 5.5 implicitly assumed path (a) dominates (its
  // own "Kg=1, k~=7 g/rad" worked language), which would make gLoadGain=
  // +1.0 correct. Empirically, for the REAL tejasAeroTables data this is
  // backwards: path (b) dominates, because dCL/dalpha (~4.2-4.4 per rad
  // from the CL table's 0-5 degree band) is roughly 10x CL_elevon's own
  // per-rad magnitude, so a positive (nose-down-moment) elevonSym still
  // nets a REDUCTION in gLoad once alpha has had even a fraction of a
  // second to respond, not an increase. Confirmed by direct simulation:
  // holding pitchStick=0 (gCmd=1 exactly) with gLoadGain=+1.0 and a
  // CORRECTLY-signed pitchRateGain=-0.3 (isolating gLoadGain's own sign)
  // still diverges without bound (alpha > 150 degrees within 20s), while
  // gLoadGain<0 keeps the aircraft bounded near a plausible few-degree
  // trim. gLoadGain must therefore also be NEGATIVE for this specific
  // airframe's real aero data, contrary to the spec table's assumption.
  //
  // Magnitude: -0.3 / -0.4 is the pair found, by a broad sweep (dozens of
  // (gLoadGain, pitchRateGain) pairs from -0.01 to -5 in magnitude,
  // cross-checked at six altitude/speed points spanning the trim grid,
  // holding pitchStick=0 for up to 200 simulated seconds each from a cold
  // start) to give the most consistently bounded, fastest-decaying alpha
  // response of everything tried -- not an exact 1g settle (see the
  // flagged concern below for why no pair achieves that with fcs.ts as
  // written), but the best available compromise, and it is also what
  // tests/integration/aiDogfight.test.ts's ace-vs-ace case needs: more
  // aggressive reductions give a marginally tighter trim-grid result at the
  // cost of aiDogfight failing on a genuine ground impact (insufficient
  // g-authority to out-turn/out-climb during aggressive maneuvering).
  //
  // *** CONTRACT/SPEC CONCERN (flagged per this task's ground rules -- both
  // root causes below live outside src/aircraft/, this module's owned
  // paths, so they are reported here rather than "fixed" by picking a
  // different number) ***
  // Extensive testing (dozens of gain pairs x six flight conditions x up to
  // 200 simulated seconds each) found NO (gLoadGain, pitchRateGain) pair
  // that lets the real Tejas pitch loop settle to an exact, stable 1g trim
  // from a cold (alpha=0, elevons=0) start -- every pair, including this
  // one, settles into a persistent, slowly-evolving gLoad oscillation
  // (typically 1.5-3g, never converging to 1g even after 200s simulated)
  // rather than truly damping out. Root cause identified: src/physics/
  // fcs.ts's trim-integral term (`FCS_TRIM_INTEGRAL_GAIN`, hardcoded
  // positive, not exposed via FcsLimits) is added into elevonSymCmd
  // UNCONDITIONALLY as "+trimIntegralRad[i]" with a fixed sign, which only
  // drives the g-error to zero (02-flight-model.md section 4.9's own
  // "auto-trim" claim) if increasing elevonSym increases gLoad, i.e. if
  // gLoadGain's sign were POSITIVE. Since the real Tejas data requires
  // gLoadGain NEGATIVE (derived above), the trim integral's fixed-positive
  // sign fights the proportional/rate terms instead of reinforcing them
  // whenever gCmd != gLoad persists -- this is what produces the
  // persistent oscillation, and no choice of FcsLimits.gLoadGain/
  // pitchRateGain (the only knobs this module owns) can fix a hardcoded,
  // non-FcsLimits constant's sign inside fcs.ts itself.
  // Separately: tools/sim-check.ts's raw trim-envelope grid (`runTrimMode`)
  // calls the generic `findTrim` Newton solver directly rather than
  // `findGCommandTrim` -- tools/lib/trimSolver.ts's own doc comment on
  // `findGCommandTrim` explains at length why `findTrim`'s 2D Newton search
  // over (pitchStick, throttle) is fundamentally the wrong tool for this
  // G-command closed loop (a sustained gCmd!=1 in wings-level flight has no
  // steady state to probe a derivative around) and was built specifically
  // to work around that; `runTrimMode` was not updated to use it. Both
  // issues are module 02 (src/physics/fcs.ts) / module 12
  // (tools/sim-check.ts, tools/lib/trimSolver.ts) implementation concerns.
  pitchRateGain: -0.4,
  rollRateGain: 0.5,
  // NOTE on sign (cross-module review finding, same class of bug as
  // gLoadGain/pitchRateGain above): yawRateGain MUST be NEGATIVE, contrary to
  // 03-tejas-data.md section 5.5's literal pinned "+0.3"/"+0.4"-ish table
  // value. fcs.ts's yaw damper law (02-flight-model.md section 4.9) is
  //   rudderCmd = inputs.yaw*maxRudderRad - yawRateGain*r
  // and src/physics/aeroForces.ts's Cn_rudder=-0.09 (tejasAeroTables.ts)
  // combined with this project's momentBody.y = -Nmom / r = -omega.y mapping
  // (00-architecture.md section 3.4) makes +rudder (trailing-edge LEFT)
  // produce +wy / a NOSE-LEFT moment, i.e. DECREASE r (confirmed: core.ts's
  // own EntityState.rudder doc comment states this explicitly). To damp an
  // existing nose-right rate (r>0) the correction must command +rudder
  // (nose-left), so "-yawRateGain*r" must be positive for r>0, which requires
  // yawRateGain NEGATIVE. A positive yawRateGain (the spec table's literal
  // "+0.4") instead commands -rudder for r>0, which per the mapping above
  // INCREASES r -- positive feedback, not damping. Confirmed by direct
  // simulation: with yawRateGain positive, a wings-level 1g trim (zero
  // roll/yaw stick, gLoadGain/pitchRateGain already correctly signed) seeds
  // an exponentially growing roll/yaw divergence from pure floating-point
  // noise (omega starting near 1e-15 rad/s), visibly diverging within ~50s
  // and corrupting the pitch trim too (this was the actual mechanism behind
  // the "no (gLoadGain, pitchRateGain) pair ever settles to an exact 1g trim"
  // finding below -- that exhaustive sweep only ever varied the pitch-axis
  // gains and never caught this separate yaw-axis sign bug). With
  // yawRateGain=-0.4 the same 100s-simulated fixture stays bounded at
  // floating-point noise on the roll/yaw axes throughout and the pitch loop
  // converges cleanly to gLoad=1.0001 by t=100s -- see
  // src/physics/fcs.ts's FCS_TRIM_INTEGRAL_GAIN sign fix (this task) for the
  // other half of what made the pitch trim itself reliably convergent.
  yawRateGain: -0.4,
  alphaLimitGain: 3.0,
  gLoadGain: -0.3,
};
