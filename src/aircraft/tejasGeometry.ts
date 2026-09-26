/**
 * src/aircraft/tejasGeometry.ts — mass, inertia, CG offset, wing geometry,
 * the seven Hardpoints, the three GearDefinition legs, and FcsLimits for the
 * HAL Tejas Mk1. Pure data; see docs/spec/03-tejas-data.md section 5.1/5.4/5.5
 * for every value's source/justification. No runtime computation beyond
 * `meanChordM = wingAreaM2 / wingSpanM` (the exact formula the spec cites).
 */
import type { Vec3Like } from '../contracts/core';
import type { Hardpoint, GearDefinition, FcsLimits, StationDef, LoadoutPreset, AircraftSensors, AircraftSignature } from '../contracts/aircraft';
import { FUEL_TANKS, storeKind } from '../catalog/weapons';

// --- Mass / fuel (section 5.1) ---
export const emptyMassKg = 6560;
export const maxFuelKg = 2458;
/** Fixed reference combat weight the integrator treats as constant (02-flight-model.md section 9). */
export const massKg = 8500;

/**
 * Drop tank on each inboard wet pylon (hardpoints 'pylon-inner-l/r', type 'fuel_tank'): the Tejas's
 * 1200 L tank. 1200 L of Jet A-1/JP-5 at ~0.80 kg/L = 960 kg; ~140 kg empty; drag area ~0.12 m^2,
 * typical of a large fighter centreline/wing tank with pylon. Two full tanks add ~2200 kg.
 */
export const dropTank = { capacityKg: FUEL_TANKS['tank-1200l']!.capacityKg, emptyMassKg: FUEL_TANKS['tank-1200l']!.emptyMassKg, dragAreaM2: FUEL_TANKS['tank-1200l']!.dragAreaM2 } as const;

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

// --- Weapon stations: the Tejas's eight hardpoints (three under each wing, the centreline, one
// under the port intake for a pod) and the internal GSh-23. The Tejas has no wingtip rails: close-
// combat missiles go on the outboard pylons, BVR missiles on the middle ones, wing tanks on the wet
// inboard pylons, a 725 L tank on the (wet) centreline.
export const stations: readonly StationDef[] = [
  { id: 'gun', posBodyM: { x: 3.5, y: -0.2, z: 0.3 }, accepts: ['gsh-23'], maxCount: 220 },
  { id: 'wing-outer-l', posBodyM: { x: -0.9, y: -0.3, z: -3.3 }, accepts: ['r-73', 'derby'], maxCount: 2 },
  { id: 'wing-outer-r', posBodyM: { x: -0.9, y: -0.3, z: 3.3 }, accepts: ['r-73', 'derby'], maxCount: 2 },
  { id: 'wing-mid-l', posBodyM: { x: -0.5, y: -0.35, z: -2.5 }, accepts: ['derby', 'r-73'], maxCount: 2 },
  { id: 'wing-mid-r', posBodyM: { x: -0.5, y: -0.35, z: 2.5 }, accepts: ['derby', 'r-73'], maxCount: 2 },
  { id: 'wing-inner-l', posBodyM: { x: -0.1, y: -0.35, z: -1.8 }, accepts: ['tank-1200l', 'derby'], maxCount: 1 },
  { id: 'wing-inner-r', posBodyM: { x: -0.1, y: -0.35, z: 1.8 }, accepts: ['tank-1200l', 'derby'], maxCount: 1 },
  { id: 'centreline', posBodyM: { x: 0.2, y: -0.9, z: 0 }, accepts: ['tank-725l'], maxCount: 1 },
  { id: 'intake-pod', posBodyM: { x: 1.2, y: -0.8, z: -0.5 }, accepts: [], maxCount: 1 },
];

/**
 * Store fits. "CAP (legacy)" is the load the sim has always flown (R-73 and Derby on twin rails,
 * two wing tanks); realistic Mk1A fits (twin ASRAAM + Astra) arrive with the weapons work.
 */
export const loadouts: readonly LoadoutPreset[] = [
  {
    id: 'cap-legacy',
    name: 'CAP (legacy): 4x R-73, 4x Derby, 2x 1200 L',
    fit: {
      gun: { store: 'gsh-23', count: 220 },
      'wing-outer-l': { store: 'r-73', count: 2 },
      'wing-outer-r': { store: 'r-73', count: 2 },
      'wing-mid-l': { store: 'derby', count: 2 },
      'wing-mid-r': { store: 'derby', count: 2 },
      'wing-inner-l': { store: 'tank-1200l', count: 1 },
      'wing-inner-r': { store: 'tank-1200l', count: 1 },
    },
  },
];
export const defaultLoadoutId = 'cap-legacy';

/** The default loadout as the flight model's Hardpoint list (stores' kinds from the catalogue). */
export const hardpoints: readonly Hardpoint[] = hardpointsFor(stations, loadouts.find((l) => l.id === defaultLoadoutId)!);

export function hardpointsFor(st: readonly StationDef[], loadout: LoadoutPreset): Hardpoint[] {
  const out: Hardpoint[] = [];
  for (const s of st) {
    const fit = loadout.fit[s.id];
    if (!fit || fit.count <= 0) continue;
    const kind = storeKind(fit.store);
    if (kind) out.push({ id: s.id, posBodyM: s.posBodyM, type: kind });
  }
  return out;
}

/** Sensors and self-protection (public data: EL/M-2052 AESA, IFF, DARE Unified EW Suite). */
export const sensors: AircraftSensors = {
  radar: 'elm-2052',
  iff: true,
  rwr: 'dare-uews',
  maws: true,
  jammer: 'dare-uews-spj',
  countermeasures: { chaff: 60, flares: 30 },
};

/** Small single-engine delta: low frontal RCS; hit ellipsoid ~13.2 m long, 4.4 m tall, 8.2 m span. */
export const signature: AircraftSignature = { rcsNoseOnM2: 2.0, rcsBroadsideM2: 6.0, hitEllipsoidBodyM: { x: 6.6, y: 2.2, z: 4.1 } };

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
    // Cross-module fix (this pass; see tests/integration/trimAndPerformance.
    // test.ts's landing_roll failure): 0.6 is a realistic DRY-runway
    // locked-wheel/max-braking-effort friction coefficient, but combined
    // with the corrected (lower) touchdown speed this same pass's
    // stall_landing/CL fix produces (tejasAeroTables.ts), it stopped the
    // aircraft in under half the public-data landing-roll figure this
    // target is based on. Published Tejas landing-roll figures (module 12's
    // own sourceNote) implicitly include a realistic ANTI-SKID-modulated
    // mean braking coefficient plus the touchdown/derotation transient
    // before brakes are fully applied — well below the dry-runway
    // locked-wheel maximum — so 0.32 (a typical published mean effective
    // braking coefficient for a modulated anti-skid system) is used here
    // instead. This does not affect takeoff_roll (`computeGroundRollM`'s
    // 'takeoff' mode never applies brakes, so this field is never read
    // there — see src/physics/landingGear.ts's `longCoef` selection) or any
    // other target in this table.
    kineticFrictionCoefficient: 0.32,
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
    /** See 'mainLeft's identical field for the cross-module fix rationale. */
    kineticFrictionCoefficient: 0.32,
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
  // *** DOCUMENTATION DEBT -- STILL OPEN (review pass, "FcsLimits gain signs
  // ... now contradict docs/spec/03-tejas-data.md's pinned data" finding) ***
  // Everything below this line was independently re-verified against the
  // review finding: the sign analysis is sound, re-running tests/physics,
  // tests/aircraft, tests/integration/trimAndPerformance.test.ts and
  // tests/integration/aiDogfight.test.ts (this pass) confirms these NEGATIVE
  // values are what makes the closed loop converge, and reverting to
  // 03-tejas-data.md section 5.5's literal pinned positive values would
  // reintroduce the divergence this comment documents -- so no code change
  // was made here. What remains genuinely unresolved is that
  // docs/spec/03-tejas-data.md sections 5.2 (CD's Mach 0.2/0.6 +0.015
  // offset; CL's Mach-0.2-column landing-CLmax inflation, tejasAeroTables.ts)
  // and 5.5 (this gain-sign block) were never updated to state these actual
  // shipped values, so "the spec is law" and "the shipped code" now disagree
  // on record. That edit is out of this module's-fixer-pass file ownership
  // (docs/spec/03-tejas-data.md is not under src/aircraft/ or this module's
  // own test paths -- see 00-architecture.md section 11's module-03 file
  // list, which does not include the spec document itself) -- flagged here,
  // and in this pass's own returned review-concern note, for whoever owns
  // that document to reconcile.
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
  // response of everything tried, and it is also what
  // tests/integration/aiDogfight.test.ts's ace-vs-ace case needs: more
  // aggressive reductions give a marginally tighter trim-grid result at the
  // cost of aiDogfight failing on a genuine ground impact (insufficient
  // g-authority to out-turn/out-climb during aggressive maneuvering).
  //
  // *** CONTRACT/SPEC CONCERN -- RESOLVED (later cross-module pass) ***
  // An earlier pass here reported this magnitude as unable to reach an
  // exact 1g settle from a cold start (a "persistent, slowly-evolving gLoad
  // oscillation, typically 1.5-3g") and attributed it to two root causes
  // outside this module: (a) src/physics/fcs.ts's trim-integral term being
  // added with a fixed positive sign regardless of gLoadGain's own sign,
  // and (b) tools/sim-check.ts's `runTrimMode` calling the generic
  // `findTrim` Newton solver (wrong tool for this closed loop) instead of
  // `findGCommandTrim`. Both were real bugs, but BOTH were already fixed by
  // the time of this later pass: (a) src/physics/fcs.ts's `stepFcs` scales
  // the trim-integral accumulation by `Math.sign(fcsLimits.gLoadGain)` (see
  // that function's own "Sign fix" comment), and (b) `runTrimMode` now
  // calls `trimConverges` (tools/lib/trimSolver.ts), which wraps
  // `findGCommandTrim` with a full-power fallback for the
  // military/afterburner throttle discontinuity `findVmax`'s own doc
  // comment describes. With both fixes in place, this exact -0.3/-0.4 pair
  // (unchanged from the earlier pass — no gain retuning was needed) settles
  // cleanly: `tests/integration/trimAndPerformance.test.ts`'s full
  // performance-target suite and `tools/sim-check.ts`'s trim-envelope grid
  // both pass with it, confirmed by re-running the whole test suite
  // (including aiDogfight, which leans on this same gain pair) after both
  // fixes. The residual, non-decaying small ripple this earlier note
  // observed is real (a weakly damped short-period aero+actuator-delay
  // mode, see tools/lib/trimSolver.ts's own `probeAveraged`/`GCMD_SETTLE_
  // STABLE_GLOAD_DELTA` doc comments) but its MEAN matches the commanded g
  // exactly — it was the trim tooling's measurement method, not this
  // gain pair or fcs.ts's control law, that mis-read it as non-convergence.
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
  // UPDATE (later cross-module pass, airborne pitch law restructuring): this -0.3 value and its
  // sign derivation above remain exactly correct and unchanged (the underlying airframe relation
  // they document -- elevon's net effect on gLoad -- is a real-aero fact, independent of whatever
  // control-law structure src/physics/fcs.ts uses to act on it). What changed is HOW fcs.ts's
  // airborne law uses it: it is no longer the main formula's direct proportional multiplier on
  // (gCmd-gLoad) -- that role is now filled by a new outer-loop gain (fcs.ts's
  // FCS_PITCH_OUTER_LOOP_GAIN, see its own doc comment for the full restructuring rationale,
  // root-caused to actuator saturation this position-command formula was producing). gLoadGain is
  // kept, unchanged, specifically because its SIGN is still consulted (via Math.sign) to orient
  // the trim-integral's accumulation -- see fcs.ts's "Sign" comment at that call site.
  gLoadGain: -0.3,
};
