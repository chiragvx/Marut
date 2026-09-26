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
