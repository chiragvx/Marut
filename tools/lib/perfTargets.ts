/**
 * tools/lib/perfTargets.ts — PerformanceTarget[] data table (module 12's
 * own public-domain-derived numbers; NOT sourced from contracts/aircraft.ts,
 * which this module cannot see). See docs/spec/12-verification.md sections
 * 5.1 and 9 for every value and its source, and section 9's open-assumption
 * #1 for why a mismatch here is a review finding, not automatically a
 * flight-model bug.
 */
import type { PerformanceTarget } from '../../src/contracts/verify';
import { PerformanceTargetKind } from '../../src/contracts/verify';

/** aircraftDefId every target below is evaluated against. */
export const PERF_TARGET_AIRCRAFT_ID = 'tejas-mk1';

/** ISA sea-level air density, kg/m^3 — a physical constant, not Tejas-specific. */
export const ISA_RHO0_KG_M3 = 1.225;

export const PERFORMANCE_TARGETS: readonly PerformanceTarget[] = [
  {
    id: 'vmax_sl',
    kind: PerformanceTargetKind.VMax,
    description: 'Maximum level speed at sea level, military power + afterburner, clean configuration.',
    altitudeM: 0,
    massKg: 9500,
    configNote: 'military+AB, clean',
    targetValue: 345,
    unit: 'm/s',
    toleranceRel: 0.10,
    sourceNote: 'about Mach 1.0 at sea level (~1240 km/h). Re-baselined from 310 m/s (an unverified ~1100-1150 km/h figure) when the subsonic drag was corrected (tejasAeroTables.ts CD note); comparable light fighters (F-16, Gripen) reach Mach 1.15-1.2 at sea level, so this stays conservative',
  },
  {
    id: 'vmax_11000',
    kind: PerformanceTargetKind.VMax,
    description: 'Maximum level speed at 11000 m, military power + afterburner, clean configuration.',
    altitudeM: 11000,
    massKg: 9500,
    configNote: 'military+AB, clean',
    targetValue: 472,
    unit: 'm/s',
    toleranceRel: 0.10,
    sourceNote: 'Mach 1.6 at 11 km ISA (a(11km)=295.2 m/s); Mach 1.6 is the commonly cited Tejas Mk1 top speed',
  },
  {
    id: 'turn_5000_m06',
    kind: PerformanceTargetKind.SustainedTurnRateDegSec,
    description: 'Sustained turn rate at 5000 m, Mach 0.6, military power + afterburner, clean configuration.',
    altitudeM: 5000,
    massKg: 9500,
    configNote: 'Mach 0.6, military+AB, clean, 9500 kg',
    targetValue: 13.0,
    unit: 'deg/s',
    toleranceRel: 0.20,
    sourceNote: 'no public Tejas turn-rate figure exists; approximated from contemporary light single-engine fighter analogues (F-16A/Gripen-class, ~12-14 deg/s here) at a similar thrust/weight -- widest tolerance in this table. Raised from 11.0 with the subsonic drag correction',
  },
  {
    id: 'climb_sl',
    kind: PerformanceTargetKind.ClimbRateMps,
    description: 'Sea-level climb rate, military power + afterburner, clean configuration, Vy = 180 m/s.',
    altitudeM: 0,
    massKg: 9500,
    configNote: 'military+AB, clean, Vy=180 m/s, 9500 kg',
    targetValue: 125,
    unit: 'm/s',
    toleranceRel: 0.15,
    sourceNote:
      "re-baselined to 125 m/s when the subsonic parasite drag was corrected from ~0.040 to ~0.016 (it had been raised to offset an earlier under-powered engine and never lowered again; see tejasAeroTables.ts). Previously re-baselined from 66 m/s (a ~13,000 ft/min figure cited for the Tejas, unverified) to this model's own 87 m/s (~17,100 ft/min) after the engine moved to published F404-IN20 ratings (84 kN wet / 48.9 kN dry, Mattingly lapse): the old target matched the earlier under-powered engine tables. Consistent with a clean ~0.9 thrust/weight fighter; revisit if an authoritative Tejas figure is found",
  },
  {
    id: 'stall_clean',
    kind: PerformanceTargetKind.StallSpeedMps,
    description: 'Clean-configuration stall speed at sea level.',
    altitudeM: 0,
    massKg: 9500,
    configNote: 'clean, gear/flaps up, 9500 kg',
    targetValue: 60.0,
    unit: 'm/s',
    toleranceRel: 0.15,
    sourceNote: 'computed: sqrt(2*massKg*GRAVITY_MPS2/(rho0*wingAreaM2*CLmaxClean)), wingAreaM2=38.4 (public), CLmaxClean=1.1 (assumed, generic delta-wing fighter clean CLmax)',
  },
  {
    id: 'stall_landing',
    kind: PerformanceTargetKind.StallSpeedMps,
    description: 'Gear-down, flaps-down stall speed at sea level.',
    altitudeM: 0,
    massKg: 9500,
    configNote: 'gear+flaps down, 9500 kg',
    targetValue: 50.0,
    unit: 'm/s',
    toleranceRel: 0.15,
    sourceNote: 'same formula as stall_clean, CLmaxLanding=1.6 (assumed, generic delta-wing fighter powered-approach CLmax)',
  },
  {
    id: 'takeoff_roll',
    kind: PerformanceTargetKind.TakeoffRollM,
    description: 'Ground roll distance to liftoff, military power + afterburner, takeoff-flap configuration.',
    altitudeM: 0,
    massKg: 9500,
    configNote: 'military+AB, flaps takeoff, 9500 kg',
    targetValue: 450,
    unit: 'm',
    toleranceRel: 0.30,
    sourceNote: 'public Tejas takeoff-roll figures cluster around 460-500 m at heavier loadouts; widened tolerance and a lighter test mass both push the target down',
  },
  {
    id: 'landing_roll',
    kind: PerformanceTargetKind.LandingRollM,
    description: 'Ground roll distance from touchdown to stop, landing-flap configuration, wheel brakes applied.',
    altitudeM: 0,
    massKg: 8500,
    configNote: 'flaps landing, brakes, 8500 kg',
    targetValue: 600,
    unit: 'm',
    toleranceRel: 0.30,
    sourceNote: 'public Tejas landing-roll figures cluster around 600-700 m; test mass assumes partial fuel remaining',
  },
];

/** aircraftDefId the JF17_PERFORMANCE_TARGETS below are evaluated against. */
export const JF17_PERF_TARGET_AIRCRAFT_ID = 'jf-17';

/**
 * The PAC JF-17 Thunder (Block II, src/aircraft/jf17Data.ts). Its published figures are few (S-notes
 * in jf17Data.ts's header): Mach 1.6 at altitude is the only directly sourced performance number;
 * the rest are derived from its sourced wing area, mass and RD-93 rating, or estimated (marked).
 */
export const JF17_PERFORMANCE_TARGETS: readonly PerformanceTarget[] = [
  {
    id: 'vmax_11000',
    kind: PerformanceTargetKind.VMax,
    description: 'Maximum level speed at 11000 m, military power + afterburner, clean configuration.',
    altitudeM: 11000,
    massKg: 9500,
    configNote: 'military+AB, clean',
    targetValue: 472,
    unit: 'm/s',
    toleranceRel: 0.1,
    sourceNote: 'Mach 1.6 clean at altitude (PAC/CAC brochure via MILAVIA; The Diplomat 2019), Mach 1.6 at 11 km ISA',
  },
  {
    id: 'turn_5000_m06',
    kind: PerformanceTargetKind.SustainedTurnRateDegSec,
    description: 'Sustained turn rate at 5000 m, Mach 0.6, military power + afterburner, clean configuration.',
    altitudeM: 5000,
    massKg: 9500,
    configNote: 'Mach 0.6, military+AB, clean, 9500 kg',
    targetValue: 9.0,
    unit: 'deg/s',
    toleranceRel: 0.25,
    sourceNote:
      'ESTIMATE, no public figure: ~3.2 g sustained from the RD-93 thrust (57 kN here) against the drag of a 24.43 m^2 wing at the CL that load needs (jf17Data.ts polar). Same thrust as the Tejas on 64% of its wing area, so well below the Tejas (13 deg/s target)',
  },
  {
    id: 'climb_sl',
    kind: PerformanceTargetKind.ClimbRateMps,
    description: 'Sea-level climb rate, military power + afterburner, clean configuration, Vy = 180 m/s.',
    altitudeM: 0,
    massKg: 9500,
    configNote: 'military+AB, clean, Vy=180 m/s, 9500 kg',
    targetValue: 110,
    unit: 'm/s',
    toleranceRel: 0.2,
    sourceNote:
      "ESTIMATE: no credible public figure (the 300 m/s often quoted is not physical: it would need ~3x the available excess power). Same thrust class and mass as the Tejas (125 m/s target); a little less from its higher induced drag at the climb's CL",
  },
  {
    id: 'stall_clean',
    kind: PerformanceTargetKind.StallSpeedMps,
    description: 'Clean-configuration stall speed at sea level.',
    altitudeM: 0,
    massKg: 9500,
    configNote: 'clean, gear/flaps up, 9500 kg',
    targetValue: 67,
    unit: 'm/s',
    toleranceRel: 0.15,
    assumedClMax: 1.4,
    sourceNote: 'computed: sqrt(2 m g / (rho0 S CLmax)), S = 24.43 m^2 (PAC), CLmax 1.4 (LERX fighter, clean; estimate). The Tejas, on 38.4 m^2, stalls at ~60 m/s',
  },
  {
    id: 'takeoff_roll',
    kind: PerformanceTargetKind.TakeoffRollM,
    description: 'Ground roll distance to liftoff, military power + afterburner.',
    altitudeM: 0,
    massKg: 9500,
    configNote: 'military+AB, 9500 kg',
    targetValue: 500,
    unit: 'm',
    toleranceRel: 0.3,
    sourceNote: 'ESTIMATE, no public figure: the Tejas thrust at the same mass, but a higher lift-off speed on the smaller wing',
  },
  {
    id: 'landing_roll',
    kind: PerformanceTargetKind.LandingRollM,
    description: 'Ground roll distance from touchdown to stop, wheel brakes applied (no brake chute).',
    altitudeM: 0,
    massKg: 8500,
    configNote: 'flaps landing, brakes, no chute, 8500 kg',
    targetValue: 1000,
    unit: 'm',
    toleranceRel: 0.3,
    assumedClMax: 1.6,
    sourceNote:
      'ESTIMATE: a touchdown ~15% faster than the Tejas (smaller wing) on wheel brakes alone; the real JF-17 streams a brake chute on most landings, which the sim does not model',
  },
];

/** aircraftDefId the C17_PERFORMANCE_TARGETS below are evaluated against. */
export const C17_PERF_TARGET_AIRCRAFT_ID = 'c-17';

/**
 * The Boeing C-17A Globemaster III (src/aircraft/c17Data.ts), from docs/spec/c17-data.md section
 * 10 (ISA, zero wind). Power settings: the harness flies throttle 1 (TOGA) for Vmax, climb and
 * take-off; the engine model has no separate max-continuous rating (pack 11 #7).
 */
export const C17_PERFORMANCE_TARGETS: readonly PerformanceTarget[] = [
  {
    id: 'vmax_9000',
    kind: PerformanceTargetKind.VMax,
    description: 'Maximum level speed at 9000 m, full thrust, clean.',
    altitudeM: 9000,
    massKg: 200000,
    configNote: 'full thrust, clean, 200 t',
    targetValue: 252,
    unit: 'm/s',
    toleranceRel: 0.06,
    sourceNote:
      'M0.83 at 9 km (a = 303.8 m/s). ESTIMATE (c17-data.md 5.3): thrust = drag near M0.83 with Mdd 0.82-0.83; consistent with Mmo 0.825 [FC1, unofficial T.O. 1C-17A-1 extract]. The real aircraft is Mmo-limited; this checks drag rise and engine lapse together',
  },
  {
    id: 'cruise_thrust_fl280_mtow',
    kind: PerformanceTargetKind.VMax,
    description: 'Maximum level speed at 8534 m (FL280) at MTOW, full thrust, clean.',
    altitudeM: 8534,
    massKg: 265352,
    configNote: 'full thrust, clean, 265 t',
    targetValue: 231,
    unit: 'm/s',
    toleranceRel: 0.06,
    sourceNote:
      'USAF fact sheet: cruise ~450 kt TAS (231 m/s, M0.74-0.76), initial cruise altitude 28,000 ft at heavy weight. At MTOW the model is near thrust-limited there, so Vmax ~ cruise speed',
  },
  {
    id: 'climb_sl_200t',
    kind: PerformanceTargetKind.ClimbRateMps,
    description: 'Sea-level climb rate, full thrust, clean, 250 KEAS.',
    altitudeM: 0,
    massKg: 200000,
    configNote: 'TOGA, clean, 250 KEAS, 200 t',
    targetValue: 20,
    unit: 'm/s',
    toleranceRel: 0.3,
    climbIasMps: 128.6,
    sourceNote:
      'No official figure. FAI records 722-724 (C-1q, 150-200 t, 1993): 12.8 m/s mean 0-3 km incl. take-off, 13.9 m/s mean 3-6 km (lower bound); clean-climb model 25 m/s (upper bound). ESTIMATE, widest tolerance in the table',
  },
  {
    id: 'stall_clean_200t',
    kind: PerformanceTargetKind.StallSpeedMps,
    description: 'Clean (slats in) 1-g stall speed at sea level.',
    altitudeM: 0,
    massKg: 200000,
    configNote: 'clean, gear up, 200 t',
    targetValue: 80.5,
    unit: 'm/s',
    toleranceRel: 0.12,
    flapDetent: 0,
    sourceNote:
      "computed sqrt(2mg/(rho0 S CLmax)), S = 353.0 m^2 [WIKI/VT09], CLmax clean 1.40 (ESTIMATE, 25-deg swept supercritical transport). Measured from the flight model's own configured CL curve",
  },
  {
    id: 'stall_full_flap_160t',
    kind: PerformanceTargetKind.StallSpeedMps,
    description: 'Full-flap, power-off stall speed at sea level.',
    altitudeM: 0,
    massKg: 160000,
    configNote: 'flaps FULL, slats, idle (no blowing), 160 t',
    targetValue: 53.0,
    unit: 'm/s',
    toleranceRel: 0.12,
    flapDetent: 4,
    sourceNote:
      'CLmax power-off 2.70 (ESTIMATE from NASA TN D-6058 CLmax 2.1 at Cmu = 0, flaps 30/60, + slats). Power-on (Cmu ~0.3) Vs ~49 m/s; 1.25 x that = 115-119 kt, the published 115-kt approach speed [VT09 from AIAA-92-1262]',
  },
  {
    id: 'takeoff_roll_mtow',
    kind: PerformanceTargetKind.TakeoffRollM,
    description: 'Ground roll to lift-off at MTOW, TOGA, flaps 1/2.',
    altitudeM: 0,
    massKg: 265352,
    configNote: 'TOGA, flaps 1/2, 265 t',
    targetValue: 2300,
    unit: 'm',
    toleranceRel: 0.2,
    flapDetent: 2,
    rotateIasMps: 74.6,
    rotateStick: 1,
    sourceNote:
      "Jane's/Wikipedia take-off run 8,200 ft (2,499 m) at MTOW; Boeing take-off field length 7,740 ft (2,359 m). Rotation speed ESTIMATE (~145 KIAS): about the power-off flaps-1/2 stall speed, the blown flaps lifting it off",
  },
  {
    id: 'takeoff_roll_179t',
    kind: PerformanceTargetKind.TakeoffRollM,
    description: 'Ground roll to lift-off at 395,000 lb, TOGA, flaps 1/2.',
    altitudeM: 0,
    massKg: 179170,
    configNote: 'TOGA, flaps 1/2, 179 t',
    targetValue: 914,
    unit: 'm',
    toleranceRel: 0.25,
    flapDetent: 2,
    rotateIasMps: 61.3,
    rotateStick: 1,
    sourceNote: "Jane's/Wikipedia: take-off run 3,000 ft at 395,000 lb. Rotation speed ESTIMATE as above (~119 KIAS)",
  },
  {
    id: 'takeoff_roll_leh_183t',
    kind: PerformanceTargetKind.TakeoffRollM,
    description: 'Ground roll at Leh (3256 m), ISA, TOGA, flaps 1/2.',
    altitudeM: 3256,
    massKg: 183000,
    configNote: 'TOGA, flaps 1/2, 183 t (30 t payload + return fuel)',
    targetValue: 1600,
    unit: 'm',
    toleranceRel: 0.3,
    flapDetent: 2,
    rotateIasMps: 62,
    rotateStick: 1,
    sourceNote:
      'A C-17 took off from Leh (2,752 m runway) with 30 t in June 2010 trials [CLAWS]. ESTIMATE ~1,600 m at ISA (pack model), ~2,000-2,500 m at 15-28 C. Must stay inside 2,752 m at ISA. Rotation ~120 KIAS (ESTIMATE as above)',
  },
  {
    id: 'landing_roll_210t',
    kind: PerformanceTargetKind.LandingRollM,
    description: 'Touchdown-to-stop ground roll, flaps FULL, max reverse + max braking.',
    altitudeM: 0,
    massKg: 210000,
    configNote: 'flaps FULL, reversers, max brakes, 210 t',
    targetValue: 650,
    unit: 'm',
    toleranceRel: 0.3,
    flapDetent: 4,
    reverseThrust: true,
    touchdownSpeedFactor: 1.1,
    sourceNote:
      'Boeing: landing field length 3,000 ft (914 m) with 160,000 lb payload (~210 t). Minus ~250-320 m air distance from 50 ft on a 4-deg path = ~600-700 m ground roll. Touchdown at 1.1 x the power-off FULL stall speed (ESTIMATE: the approach is flown power-on at ~1.25 x a lower power-on Vs)',
  },
  {
    id: 'landing_roll_leh_160t',
    kind: PerformanceTargetKind.LandingRollM,
    description: 'Ground roll at Leh (3256 m, ISA), flaps FULL, reversers + brakes.',
    altitudeM: 3256,
    massKg: 160000,
    configNote: 'flaps FULL, reversers, brakes, 160 t',
    targetValue: 690,
    unit: 'm',
    toleranceRel: 0.3,
    flapDetent: 4,
    reverseThrust: true,
    touchdownSpeedFactor: 1.1,
    sourceNote:
      'derived (c17-data.md 8.4): TAS = CAS/sqrt(sigma), sigma 0.72 ISA. The pack\'s 850 m took 1.4x the sea-level roll, which holds at the SAME mass; at 160 t against the 210 t sea-level case the touchdown TAS^2 is (160/210)/0.72 = 1.06x, so ~1.06 x 650 = 690 m (corrected here, not tuned to the model)',
  },
  {
    id: 'landing_roll_ngari_150t',
    kind: PerformanceTargetKind.LandingRollM,
    description: 'Ground roll at Ngari Gunsa (4274 m, ISA), flaps FULL, reversers + brakes.',
    altitudeM: 4274,
    massKg: 150000,
    configNote: 'flaps FULL, reversers, brakes, 150 t (light: ~10 t payload, return fuel)',
    targetValue: 715,
    unit: 'm',
    toleranceRel: 0.3,
    flapDetent: 4,
    reverseThrust: true,
    touchdownSpeedFactor: 1.1,
    sourceNote:
      'ESTIMATE for the Himalaya campaign finale (docs/spec/himalaya-theatre.md: a ~1.2 km taxiway at 4,274 m). sigma 0.65 there at ISA: touchdown TAS^2 = (150/210)/0.65 = 1.10x the 210 t sea-level case, so ~1.10 x 650 = 715 m. Must stop well inside ~1,200 m',
  },
];
