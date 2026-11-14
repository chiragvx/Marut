/**
 * src/physics/highLift.ts — slats, flap detents, externally blown flap (EBF) powered lift and
 * spoilers, for aircraft with `AircraftDefinition.highLift` / `spoilers` (the C-17). The fighters
 * never reach this file: aeroForces.ts keeps their original table-only path.
 *
 * Configured lift curve (docs/spec/c17-data.md 3.2-3.4). The clean CL table is shifted right by the
 * detent's stall-alpha shift dA and up by dCL0 + a(M) dA, where a(M) is the clean table's lift-curve
 * slope: in the linear range CL = CL_clean(alpha) + dCL0, and the stall (and the T-tail pitch-up
 * after it) moves dA later, so CLmax = CLmax_clean + dCL0 + a dA. The clean Cm table is shifted the
 * same way with the static-margin moment of the a dA lift removed again, plus the detent's dCm0.
 * Drag: the shifted clean CD, plus dCD0, plus K (CL^2 - CL_shifted^2) so the induced drag follows
 * the real lift.
 *
 * Powered lift: per wing half, Cmu = T_half / (q S/2); dCL_half = eta x F(Cmu) (NASA TN D-6058
 * curve, pack 3.3). The aircraft's dCL_EBF is the mean of the halves; their difference rolls the
 * jet (an engine out loses blown lift on that wing). dCL_EBF also delays the stall a little, adds
 * a nose-down moment and fades ground effect.
 *
 * Allocation-free.
 */
import type { AircraftDefinition, FlapDetentDefinition, HighLiftDefinition } from '../contracts/aircraft';
import { clamp, interpolate1D, interpolate2D, lerp, rateLimitStep } from '../math';

const ALPHA_SLOPE_PROBE_RAD = (3 * Math.PI) / 180;

/** Inputs to the configured-aero build, refreshed each substep by the integrator. */
export interface AeroConfig {
  /** Flap position in detent units (EntityState.flapPos). */
  flapPos: number;
  /** Symmetric spoiler panel position 0..1. */
  spoilerPos: number;
  /** Thrust coefficient of each wing half (0 when no engines blow the flaps). */
  cmuLeft: number;
  cmuRight: number;
  /** Cargo ramp 0..1. */
  rampPos: number;
}

export interface ConfiguredCoefficients {
  /** Lift coefficient before the elevon term and ground effect. */
  CL: number;
  /** Drag coefficient before the elevon term and the configuration drag (gear etc.). */
  CD: number;
  /** Pitching moment before the elevon and pitch-damping terms. */
  Cm: number;
  /** Rolling moment from asymmetric blown lift. */
  Cl: number;
  /** Ground-effect scale (1 = the full groundEffectMaxDeltaCL). */
  groundEffectScale: number;
}

/** Interpolated detent increments at a fractional flap position. */
export interface DetentBlend {
  dCL0: number;
  dAlphaStallRad: number;
  dCD0: number;
  dCm0: number;
  ebfEta: number;
  flapDeg: number;
}

function detentAt(hl: HighLiftDefinition, i: number): FlapDetentDefinition {
  const n = hl.detents.length;
  return hl.detents[i < 0 ? 0 : i >= n ? n - 1 : i]!;
}

/** Blends the two detents either side of `flapPos` (allocation-free into `out`). */
export function blendDetent(hl: HighLiftDefinition, flapPos: number, out: DetentBlend): DetentBlend {
  const pos = clamp(flapPos, 0, hl.detents.length - 1);
  const i0 = Math.floor(pos);
  const t = pos - i0;
  const a = detentAt(hl, i0);
  const b = detentAt(hl, i0 + 1);
  out.dCL0 = lerp(a.dCL0, b.dCL0, t);
  out.dAlphaStallRad = lerp(a.dAlphaStallRad, b.dAlphaStallRad, t);
  out.dCD0 = lerp(a.dCD0, b.dCD0, t);
  out.dCm0 = lerp(a.dCm0, b.dCm0, t);
  out.ebfEta = lerp(a.ebfEta, b.ebfEta, t);
  out.flapDeg = lerp(a.flapDeg, b.flapDeg, t);
  return out;
}

const scratchBlend: DetentBlend = { dCL0: 0, dAlphaStallRad: 0, dCD0: 0, dCm0: 0, ebfEta: 0, flapDeg: 0 };

/** Aft-flap angle, deg, at a flap position (for the renderer). */
export function flapAngleDeg(def: Pick<AircraftDefinition, 'highLift'>, flapPos: number): number {
  return def.highLift ? blendDetent(def.highLift, flapPos, scratchBlend).flapDeg : 0;
}

/** The clean table's lift-curve slope at a Mach, per rad (secant 0..3 deg). */
export function cleanLiftSlope(def: AircraftDefinition, mach: number): number {
  return (interpolate2D(def.aero.CL, ALPHA_SLOPE_PROBE_RAD, mach) - interpolate2D(def.aero.CL, 0, mach)) / ALPHA_SLOPE_PROBE_RAD;
}

/** Blown-lift increment of one wing half at its thrust coefficient, for a flap efficiency. */
export function ebfLiftIncrement(hl: HighLiftDefinition, eta: number, cmu: number): number {
  if (!hl.ebf || eta <= 0 || cmu <= 0) return 0;
  return eta * interpolate1D(hl.ebf.lift, cmu);
}

/**
 * Stall alpha for a configuration, rad: the clean stall alpha at this Mach, plus the detent's
 * shift, plus the powered-lift delay.
 */
export function configuredStallAlphaRad(def: AircraftDefinition, mach: number, flapPos: number, cmuLeft: number, cmuRight: number): number {
  const hl = def.highLift;
  if (!hl) return def.aero.stallAlphaRad;
  const d = blendDetent(hl, flapPos, scratchBlend);
  const dEbf = 0.5 * (ebfLiftIncrement(hl, d.ebfEta, cmuLeft) + ebfLiftIncrement(hl, d.ebfEta, cmuRight));
  return interpolate1D(hl.cleanStallAlpha, mach) + d.dAlphaStallRad + (hl.ebf ? hl.ebf.stallAlphaRadPerDCL * dEbf : 0);
}

/**
 * Lift, drag, pitching and rolling moment for the configured wing (header comment). `def` must
 * have `highLift` (spoilers optional).
 */
export function configuredCoefficients(def: AircraftDefinition, alpha: number, mach: number, cfg: Readonly<AeroConfig>, out: ConfiguredCoefficients): ConfiguredCoefficients {
  const hl = def.highLift!;
  const aero = def.aero;
  const d = blendDetent(hl, cfg.flapPos, scratchBlend);
  const ebf = hl.ebf;
  const dL = ebfLiftIncrement(hl, d.ebfEta, cfg.cmuLeft);
  const dR = ebfLiftIncrement(hl, d.ebfEta, cfg.cmuRight);
  const dEbf = 0.5 * (dL + dR);
  const shift = d.dAlphaStallRad + (ebf ? ebf.stallAlphaRadPerDCL * dEbf : 0);
  const a = cleanLiftSlope(def, mach);
  const alphaS = alpha - shift;
  const clShifted = interpolate2D(aero.CL, alphaS, mach);
  let CL = clShifted + d.dCL0 + a * shift + dEbf;
  let CD = interpolate2D(aero.CD, alphaS, mach) + d.dCD0;
  let Cm = interpolate2D(aero.Cm, alphaS, mach) - hl.staticMargin * a * shift + d.dCm0 + (ebf ? ebf.cmPerDCL * dEbf : 0);
  out.Cl = ebf ? (-(dR - dL) * ebf.rollArmM) / (2 * def.wingSpanM) : 0;

  // Spoilers: in-flight speedbrake up to speedbrakeFrac of travel, blending into the full lift dump.
  const sp = def.spoilers;
  if (sp && cfg.spoilerPos > 0) {
    const pos = clamp(cfg.spoilerPos, 0, 1);
    if (pos <= sp.speedbrakeFrac) {
      const k = pos / sp.speedbrakeFrac;
      CL += k * sp.speedbrake.dCL;
      CD += k * sp.speedbrake.dCD;
      Cm += k * sp.speedbrake.dCm;
    } else {
      const t = (pos - sp.speedbrakeFrac) / (1 - sp.speedbrakeFrac);
      const dumpCL = cfg.flapPos >= sp.liftDump.liftDumpFlapsFromDetent ? sp.liftDump.dCLFlaps : lerp(sp.liftDump.dCLClean, sp.liftDump.dCLFlaps, clamp(cfg.flapPos / sp.liftDump.liftDumpFlapsFromDetent, 0, 1));
      CL += lerp(sp.speedbrake.dCL, dumpCL, t);
      CD += lerp(sp.speedbrake.dCD, sp.liftDump.dCD, t);
      Cm += lerp(sp.speedbrake.dCm, sp.liftDump.dCm, t);
    }
  }
  // Induced drag follows the actual lift (the shifted clean table only carries K CL_shifted^2).
  CD += hl.inducedDragK * (CL * CL - clShifted * clShifted);
  CD += cfg.rampPos * (aero.CD_ramp ?? 0);
  Cm += cfg.rampPos * (aero.Cm_ramp ?? 0);

  out.CL = CL;
  out.CD = CD;
  out.Cm = Cm;
  const cmuMean = 0.5 * (cfg.cmuLeft + cfg.cmuRight);
  out.groundEffectScale = ebf && d.ebfEta > 0 ? clamp(1 - cmuMean / ebf.groundEffectZeroCmu, 0, 1) : 1;
  return out;
}

/** Moves the flaps (one detent per flapSecPerDetent) and slats toward the lever, in place. */
export function stepFlapsAndSlats(
  state: { flapDetent?: number; flapPos?: number; slatPos?: number },
  hl: HighLiftDefinition,
  flapLever: number | undefined,
  hydraulicsOk: boolean,
  dtSub: number
): void {
  const maxDetent = hl.detents.length - 1;
  const lever = Math.round(clamp(flapLever ?? 0, 0, maxDetent));
  state.flapDetent = lever;
  if (!hydraulicsOk) return;
  state.flapPos = rateLimitStep(state.flapPos ?? 0, lever, 1 / hl.flapSecPerDetent, dtSub);
  const slatTarget = detentAt(hl, lever).slats || detentAt(hl, Math.ceil(state.flapPos - 1e-9)).slats ? 1 : 0;
  state.slatPos = rateLimitStep(state.slatPos ?? 0, slatTarget, 1 / hl.slatTransitSec, dtSub);
}
