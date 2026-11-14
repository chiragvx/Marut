/**
 * src/ui/audio/heavyEngineModel.ts — what a multi-engine aircraft's big high-bypass turbofans
 * sound like, as numbers (pure, tested); src/ui/audio/heavyEngineVoice.ts turns them into sound.
 * Used for any aircraft with `AircraftDefinition.engines` (the C-17's four F117s); the fighters
 * keep src/ui/audio/engineModel.ts. Everything comes from the aircraft's data, nothing from its id:
 *
 * - Each engine is its own voice, driven by its own N1 from the snapshot (SnapshotEntity.ENGINES,
 *   already spooled by src/physics/engines.ts — big engines are slow: seconds to spool up). A failed
 *   engine windmills (~8% N1) and falls silent, so an engine out is heard on its side.
 * - The fan: a big fan turns slowly (tip speed ~430 m/s over a ~2 m fan: ~69 Hz at 100% N1), so
 *   its blade-passing whine (`fanBlades` x shaft) is lower than a fighter's and its buzz-saw (the
 *   shaft's harmonics, once the blade tips go supersonic above ~85% N1) is a deep growl.
 * - Each engine's shaft is detuned by a few tenths of a percent from the others (no two engines
 *   ever run at exactly the same N1): their tones beat — the throb of a four-engine heavy.
 * - Jet noise: a broad, deep roar rising steeply with thrust (thrust ~ N1^2 here, as in the
 *   physics), its upper corner opening up with power; under it the rumble of the core and the jet.
 * - Thrust reversers: deployed, the fan stream is thrown forward through the cascades — a big
 *   broadband roar, loudest at reverse power.
 * - Directivity (outside): the fan's whine and buzz-saw radiate forward out of the intakes, the
 *   roar aft from the nozzles (`aspect`: +1 listener ahead of the aircraft, -1 behind).
 * - Size: the total thrust sets how loud it is at a distance and how far it is heard
 *   (`refM`/`hearM` for src/ui/audio/spatial.ts's distanceGain): a C-17 is far louder than a
 *   fighter at the same distance and heard ~12 km off.
 * - In the cockpit: muffled, the whine faint, the four engines a strong low rumble.
 */
import type { AircraftDefinition } from '../../contracts/aircraft';
import type { Vec3Like } from '../../contracts/core';
import { interpolate2D } from '../../math';
import { HEAR_ENGINE_M } from './spatial';
import type { EarPosition } from './engineModel';

/** Fan blade tip speed at 100% N1, m/s (a big high-bypass fan, subsonic-ish but relative-supersonic at the tips). */
export const FAN_TIP_MPS = 430;
/** The fighter-class thrust the base distance law was tuned for (an F404 in reheat), N. */
export const REF_THRUST_N = 85_000;
/** The furthest any engine is heard, m. */
export const MAX_HEAR_M = 12_000;
/** Shaft detune per engine (cycled): a few tenths of a percent, so the engines beat. */
export const ENGINE_DETUNE: readonly number[] = [-0.0035, 0.0015, -0.001, 0.003, -0.002, 0.0025];
/** N1 (fraction) at which an engine is silent (a failed engine windmills at 0.08) and fully running. */
export const SILENT_N1 = 0.09;
export const RUNNING_N1 = 0.17;
/** Smoothing of the snapshot's N1 (6-bit: 1.6% steps) and reverser, s. */
const N1_TAU_SEC = 0.3;
const REV_TAU_SEC = 0.25;

export interface HeavyEngineProfile {
  count: number;
  /** Each engine's place on the airframe (body frame, m). */
  positions: readonly Vec3Like[];
  /** Fan shaft at 100% N1, Hz, and the blade count (whine = blades x shaft). */
  shaftHz: number;
  blades: number;
  /** Per-engine shaft detune factor (1 + d). */
  detune: readonly number[];
  /** Flight idle N1 (fraction). */
  idleN1: number;
  /** Total sea-level static thrust, N. */
  totalThrustN: number;
  /** distanceGain's reference radius and audible range for this aircraft, m. */
  refM: number;
  hearM: number;
}

/** Audible range for a total thrust, m: grows with thrust^0.4 from the fighter's 5 km, capped at MAX_HEAR_M. */
export const hearDistanceM = (totalThrustN: number): number =>
  Math.min(MAX_HEAR_M, Math.max(HEAR_ENGINE_M, HEAR_ENGINE_M * Math.pow(Math.max(0, totalThrustN) / REF_THRUST_N, 0.4)));
/** distanceGain's reference radius for a total thrust, m: 20 m for a fighter, x sqrt(thrust ratio), at most 60 m. */
export const loudRefM = (totalThrustN: number): number => Math.min(60, Math.max(20, 20 * Math.sqrt(Math.max(0, totalThrustN) / REF_THRUST_N)));

/** The heavy engine sound for an aircraft, or null when it has no `engines` (a fighter: engineModel.ts). */
export function heavyEngineProfile(def: AircraftDefinition): HeavyEngineProfile | null {
  const engines = def.engines;
  if (!engines || engines.length === 0) return null;
  const tables = def.engine;
  const fanAreaM2 = tables.reverser?.fanAreaM2;
  const fanD = tables.sound?.fanDiameterM ?? (fanAreaM2 ? Math.sqrt((4 * fanAreaM2) / Math.PI) : 1);
  const totalThrustN = interpolate2D(tables.militaryThrustN, 0, 0) * engines.length;
  return {
    count: engines.length,
    positions: engines.map((e) => ({ ...e.posBodyM })),
    shaftHz: FAN_TIP_MPS / (Math.PI * fanD),
    blades: tables.sound?.fanBlades ?? 24,
    detune: engines.map((_, i) => 1 + ENGINE_DETUNE[i % ENGINE_DETUNE.length]!),
    idleN1: Math.sqrt(tables.idleThrustFrac ?? 0.07),
    totalThrustN,
    refM: loudRefM(totalThrustN),
    hearM: hearDistanceM(totalThrustN),
  };
}

/** One engine's sound state. */
export interface HeavyEngineState {
  n1: number;
  rev: number;
  /** dN1/dt, per second (smoothed): the howl of a spool-up. */
  accel: number;
  initialised: boolean;
}

export const createHeavyEngineStates = (count: number): HeavyEngineState[] =>
  Array.from({ length: count }, () => ({ n1: 0, rev: 0, accel: 0, initialised: false }));

/** Follows the snapshot's N1 and reverser position (0..1) for one engine; `alive` false winds it down. */
export function stepHeavyEngine(st: HeavyEngineState, n1In: number, revIn: number, alive: boolean, dt: number): void {
  const n1Target = alive ? Math.min(1.1, Math.max(0, n1In)) : 0;
  const revTarget = alive ? Math.min(1, Math.max(0, revIn)) : 0;
  if (!st.initialised) {
    st.initialised = true;
    st.n1 = n1Target;
    st.rev = revTarget;
    st.accel = 0;
    return;
  }
  if (dt <= 0) return;
  const was = st.n1;
  st.n1 += (n1Target - st.n1) * (1 - Math.exp(-dt / (alive ? N1_TAU_SEC : 3))); // a dead aircraft's engines run down slowly
  st.rev += (revTarget - st.rev) * (1 - Math.exp(-dt / REV_TAU_SEC));
  st.accel += ((st.n1 - was) / dt - st.accel) * (1 - Math.exp(-dt / 0.4));
}

export interface HeavyVoiceParams {
  /** Blade-pass whine, Hz, and level. */
  whineHz: number;
  whine: number;
  /** Fan shaft (buzz-saw fundamental), Hz, and buzz-saw level. */
  shaftHz: number;
  buzz: number;
  /** Jet roar level and its upper corner, Hz. */
  jet: number;
  jetHz: number;
  rumble: number;
  /** Thrust-reverser roar. */
  reverse: number;
  /** Everything above this is muffled (the cockpit), Hz. */
  muffleHz: number;
}

export const createHeavyVoiceParams = (): HeavyVoiceParams => ({ whineHz: 0, whine: 0, shaftHz: 0, buzz: 0, jet: 0, jetHz: 0, rumble: 0, reverse: 0, muffleHz: 0 });

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Engine `i`'s voice. `aspect`: where the listener is, +1 straight ahead of the aircraft .. -1
 * straight behind (ignored in the cockpit).
 */
export function heavyEngineParams(prof: HeavyEngineProfile, i: number, st: HeavyEngineState, ear: EarPosition, aspect: number, out: HeavyVoiceParams): HeavyVoiceParams {
  const n1 = Math.max(0, st.n1);
  const spin = smoothstep(SILENT_N1, RUNNING_N1, n1); // 0 windmilling/stopped .. 1 running
  const thrust = Math.min(1.2, n1 * n1); // thrust fraction, as src/physics/engines.ts
  const power = Math.min(1, Math.max(0, (n1 - prof.idleN1) / (1 - prof.idleN1)));
  const howl = Math.min(1, Math.max(0, st.accel) * 4);
  out.shaftHz = prof.shaftHz * n1 * (prof.detune[i] ?? 1);
  out.whineHz = out.shaftHz * prof.blades;
  const buzz = smoothstep(0.8, 0.96, n1);
  // Jet noise rises steeply with thrust (eased from Lighthill's V^8 for a game): ~-20 dB at ground idle.
  const jetLevel = spin * (0.06 + 0.94 * Math.pow(thrust, 0.8));
  out.jetHz = 450 + 1600 * Math.sqrt(thrust);
  const rumbleLevel = spin * (0.3 + 0.7 * Math.pow(thrust, 0.6));
  // The reverser's roar: the fan stream thrown forward, loudest at reverse power.
  const rev = st.rev * spin * (0.25 + 0.75 * thrust);
  if (ear === 'cockpit') {
    // Far behind the flight deck: the whine faint, the roar dulled, a strong low rumble through the airframe.
    out.whine = (0.004 + 0.004 * power + 0.006 * howl) * spin;
    out.buzz = 0.025 * buzz * spin;
    out.jet = 0.07 * jetLevel;
    out.rumble = 0.24 * rumbleLevel;
    out.reverse = 0.1 * rev;
    out.muffleHz = 750;
  } else {
    const fwd = Math.max(0, Math.min(1, aspect));
    const aft = Math.max(0, Math.min(1, -aspect));
    out.whine = (0.022 + 0.018 * power + 0.03 * howl) * spin * (0.55 + 0.9 * fwd);
    out.buzz = 0.16 * buzz * spin * (0.4 + 1.2 * fwd);
    out.jet = 0.4 * jetLevel * (0.65 + 0.7 * aft);
    out.rumble = 0.45 * rumbleLevel * (0.85 + 0.3 * aft);
    out.reverse = 0.4 * rev * (0.8 + 0.5 * fwd);
    out.muffleHz = 16000;
  }
  return out;
}
