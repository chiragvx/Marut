/**
 * src/ui/audio/engineModel.ts — what a turbofan sounds like at each moment, as numbers (pure,
 * tested); src/ui/audio/engineVoice.ts turns them into sound. Modelled on how an F404-class
 * engine makes its noise, not on recordings:
 *
 * - RPM: the core (N2) from the sim's spooled throttle (SnapshotEntity.THROTTLE, already lagging
 *   the lever), so the sound always matches the thrust. Thrust grows much faster than RPM, so the
 *   RPM climbs steeply off idle and flattens near military power (half thrust is ~90% N2). Fuel
 *   gone: it runs down to a windmill.
 * - The fan's blade-pass whine: the fan shaft's frequency times its blades — the high scream of a
 *   jet at idle on the ramp.
 * - "Buzz-saw": above ~85% fan speed the blade tips go supersonic and the shaft's harmonics growl
 *   out of the intake.
 * - Jet mixing noise: the exhaust's roar, broadband, peaking near Strouhal 0.2 x jet speed / nozzle
 *   diameter and rising steeply with jet speed (Lighthill's eighth power, eased for a game).
 * - Core rumble; the afterburner's roar and crackle, which lights over LIGHT_SEC with a thump.
 * - A howl while the engine accelerates hard.
 */

/** Ground idle core speed, fraction of 100% N2. */
export const IDLE_N2 = 0.68;
/** Fan shaft at 100% N1, Hz (~13,270 rpm), and the fan's first-stage blades. */
export const FAN_SHAFT_HZ = 221;
export const FAN_BLADES = 18;
/** Fully-expanded jet speed at idle, military and in reheat, m/s; the nozzle's diameter, m. */
const VJ_IDLE = 190;
const VJ_MIL = 600;
const VJ_AB = 1000;
const NOZZLE_M = 0.7;
/** How steeply the jet noise rises with jet speed, dB per decade (Lighthill's 80, eased). */
const JET_DB_PER_DECADE = 50;
/** The afterburner lights over this long; goes out over OUT_SEC. */
export const LIGHT_SEC = 0.6;
const OUT_SEC = 0.25;
/** Run-down to a windmill with no fuel, s. */
const RUNDOWN_TAU_SEC = 4;

export interface EngineSoundState {
  /** Core speed, fraction of 100%. */
  n2: number;
  /** Afterburner, 0 out .. 1 fully lit. */
  ab: number;
  /** dN2/dt, per second (smoothed). */
  accel: number;
  initialised: boolean;
}

export interface EngineSoundInputs {
  /** The sim's spooled throttle, 0..1. */
  throttle: number;
  afterburner: boolean;
  /** False once the fuel is gone (or the jet is dead). */
  running: boolean;
  iasMps: number;
}

export interface EngineSoundEvents {
  abLit: boolean;
  abOut: boolean;
}

export const createEngineSoundState = (): EngineSoundState => ({ n2: IDLE_N2, ab: 0, accel: 0, initialised: false });

/** Core speed for a (spooled) throttle. */
export const n2ForThrottle = (throttle: number): number => IDLE_N2 + (1 - IDLE_N2) * Math.pow(Math.min(1, Math.max(0, throttle)), 0.45);
/** Fan speed from core speed (the fan sits lower at idle). */
export const n1ForN2 = (n2: number): number => Math.pow(Math.max(0, n2), 1.4);

export function stepEngineSound(st: EngineSoundState, inp: EngineSoundInputs, dt: number, ev: EngineSoundEvents): EngineSoundEvents {
  ev.abLit = false;
  ev.abOut = false;
  const windmill = Math.min(0.3, inp.iasMps / 900);
  const target = inp.running ? n2ForThrottle(inp.throttle) : windmill;
  if (!st.initialised) {
    st.initialised = true;
    st.n2 = target;
  }
  const was = st.n2;
  // The sim's throttle already lags the lever: only smooth it here; a dead engine runs down slowly.
  const tau = inp.running ? 0.15 : RUNDOWN_TAU_SEC;
  st.n2 += (target - st.n2) * (dt > 0 ? 1 - Math.exp(-dt / tau) : 0);
  const rate = dt > 0 ? (st.n2 - was) / dt : 0;
  st.accel += (rate - st.accel) * (dt > 0 ? 1 - Math.exp(-dt / 0.3) : 0);
  const abOn = inp.afterburner && inp.running;
  const abWas = st.ab;
  st.ab = abOn ? Math.min(1, st.ab + dt / LIGHT_SEC) : Math.max(0, st.ab - dt / OUT_SEC);
  if (abOn && abWas === 0 && st.ab > 0) ev.abLit = true;
  if (!abOn && abWas > 0 && st.ab === 0) ev.abOut = true;
  return ev;
}

/** Where the sound is heard from. */
export type EarPosition = 'cockpit' | 'outside';

export interface EngineVoiceParams {
  /** The fan's blade-pass whine and its second harmonic. */
  whineHz: number;
  whine: number;
  /** The fan shaft's harmonics (buzz-saw). */
  shaftHz: number;
  buzz: number;
  /** Jet noise: level and the roar's upper corner, Hz. */
  jet: number;
  jetHz: number;
  rumble: number;
  /** Afterburner roar and crackle. */
  ab: number;
  crackle: number;
  /** Everything above this is muffled (the canopy and helmet in the cockpit), Hz. */
  muffleHz: number;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function engineVoiceParams(st: EngineSoundState, ear: EarPosition, out: EngineVoiceParams): EngineVoiceParams {
  const n2 = st.n2;
  const n1 = n1ForN2(n2);
  const spin = smoothstep(0.05, IDLE_N2, n2); // 0 stopped .. 1 at idle and above
  const power = Math.min(1, Math.max(0, (n2 - IDLE_N2) / (1 - IDLE_N2)));
  const howl = Math.min(1, Math.max(0, st.accel) * 2.5);
  out.shaftHz = n1 * FAN_SHAFT_HZ;
  out.whineHz = out.shaftHz * FAN_BLADES;
  const vj = st.ab > 0 ? VJ_MIL + (VJ_AB - VJ_MIL) * st.ab : VJ_IDLE + (VJ_MIL - VJ_IDLE) * power * power;
  const jetDb = JET_DB_PER_DECADE * Math.log10(Math.max(1, vj) / VJ_MIL);
  const jetLevel = Math.pow(10, jetDb / 20) * spin;
  out.jetHz = Math.max(250, (0.2 * vj) / NOZZLE_M) * 10;
  const buzz = smoothstep(0.85, 0.97, n1);
  if (ear === 'cockpit') {
    // An F404 is quiet in the cockpit: the whine and a rumble through the airframe; the jet's
    // roar is behind and outrun; the air conditioning (src/ui/audio/ambience.ts) is louder.
    out.whine = (0.012 + 0.012 * power + 0.02 * howl) * spin;
    out.buzz = 0.012 * buzz;
    out.jet = 0.035 * jetLevel;
    out.rumble = (0.02 + 0.04 * power) * spin;
    out.ab = 0.09 * st.ab;
    out.crackle = 0.02 * st.ab;
    out.muffleHz = 2200;
  } else {
    out.whine = (0.05 + 0.03 * power + 0.05 * howl) * spin;
    out.buzz = 0.07 * buzz;
    out.jet = 0.28 * jetLevel;
    out.rumble = (0.03 + 0.06 * power) * spin;
    out.ab = 0.3 * st.ab;
    out.crackle = 0.12 * st.ab;
    out.muffleHz = 16000;
  }
  return out;
}
