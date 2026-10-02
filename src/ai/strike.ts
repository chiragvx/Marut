/**
 * src/ai/strike.ts — an AI strike or SEAD sortie: fly to the target (at an ingress altitude, or low
 * level over the terrain ahead), attack it, then hand back to the tactical FSM to go home.
 *
 * The weapons are the aircraft's own weapon system: src/core designates the target point (SPI) and
 * selects the air-to-ground store (CombatPortWithBriefing.armStrike), so the AI only flies and
 * presses the release button:
 *   - bombs: held over the run-in, the CCRP releases at the release point (alternate ticks, so each
 *     store goes on its own press: a stick in a fraction of a second);
 *   - stand-off weapons (anti-radiation missiles, GPS weapons): one press every STANDOFF_PRESS_SEC
 *     once inside `standoffM`.
 * Done when the air-to-ground stores are gone (or after overflying the target with bombs left).
 */
import type { PilotContext, Vec3Like } from '../contracts/core';
import { WeaponKind, isAirToGroundKind } from '../contracts/core';
import type { AiStrikeTask, FlightGoal } from '../contracts/ai';
import { ControlGains, PitchMode } from '../contracts/ai';
import { clamp } from '../math';

export const StrikePhase = { Ingress: 'ingress', Attack: 'attack', Done: 'done' } as const;
export type StrikePhase = (typeof StrikePhase)[keyof typeof StrikePhase];

export interface StrikeState {
  phase: StrikePhase;
  /** Seconds until the next stand-off release press. */
  pressTimerSec: number;
  pressTick: boolean;
  /** Closest the aircraft has come to the target in the attack (bombs), m. */
  closestM: number;
}

export function createStrikeState(): StrikeState {
  return { phase: StrikePhase.Ingress, pressTimerSec: 0, pressTick: false, closestM: Infinity };
}

/** Bomb attacks begin this far out (the run-in), m; stand-off releases are this many seconds apart. */
const BOMB_RUN_IN_M = 9000;
const STANDOFF_PRESS_SEC = 4;
/** Low-level ingress: the terrain ahead is sampled over this distance, m. */
const LOW_LEVEL_LOOKAHEAD_M = 4000;
const INGRESS_SPEED_MPS = 240;
const LOW_LEVEL_SPEED_MPS = 250;

/** The minimum terrain clearance the AI's ground-avoidance override should keep on this sortie, m (undefined = its default). */
export function strikeTerrainClearanceM(task: Readonly<AiStrikeTask>, st: Readonly<StrikeState>): number | undefined {
  return task.lowLevelAglM !== undefined && st.phase !== StrikePhase.Done ? Math.max(30, task.lowLevelAglM * 0.5) : undefined;
}

/**
 * Builds this tick's flight goal for the sortie and whether the release button is pressed. Returns
 * false once the sortie is done (the caller goes back to its own goals).
 */
export function buildStrikeGoal(ctx: PilotContext, task: Readonly<AiStrikeTask>, st: StrikeState, dtSec: number, goal: FlightGoal, out: { launch: boolean }): boolean {
  out.launch = false;
  if (st.phase === StrikePhase.Done) return false;
  const c = ctx.combat;
  const agLeft = isAirToGroundKind(c.selectedWeapon) && (c.selectedStoreCount ?? 0) > 0;
  const self = ctx.self.pos;
  const dx = task.target.x - self.x, dz = task.target.z - self.z;
  const d = Math.hypot(dx, dz);
  // Not yet armed by src/core (first ticks), keep flying in.
  const standoff = c.selectedWeapon === WeaponKind.Arm || c.selectedWeapon === WeaponKind.GuidedBomb || c.selectedWeapon === WeaponKind.Agm;

  if (st.phase === StrikePhase.Attack && !agLeft) {
    st.phase = StrikePhase.Done;
    return false;
  }
  if (st.phase === StrikePhase.Ingress && agLeft && d < (standoff ? (task.standoffM ?? 30000) : BOMB_RUN_IN_M)) st.phase = StrikePhase.Attack;

  // Steering: straight at the target.
  const bearing = Math.atan2(dx, -dz);
  let rel = bearing - ctx.telemetry.headingRad;
  rel = Math.atan2(Math.sin(rel), Math.cos(rel));
  goal.pitchMode = PitchMode.AltitudeHold;
  goal.desiredBankRad = clamp(ControlGains.HEADING_TO_BANK_KP * rel, -ControlGains.MAX_MANOEUVRE_BANK_RAD, ControlGains.MAX_MANOEUVRE_BANK_RAD);
  goal.desiredGLoad = 1;
  goal.throttleOverride = undefined;
  goal.afterburnerOverride = false;
  goal.gearDown = false;
  goal.airbrake = false;
  if (task.lowLevelAglM !== undefined) {
    goal.desiredAltitudeM = terrainAheadM(ctx, self) + task.lowLevelAglM;
    goal.desiredSpeedMps = LOW_LEVEL_SPEED_MPS;
  } else {
    goal.desiredAltitudeM = task.ingressAltM;
    goal.desiredSpeedMps = INGRESS_SPEED_MPS;
  }

  if (st.phase === StrikePhase.Attack) {
    if (standoff) {
      st.pressTimerSec -= dtSec;
      if (st.pressTimerSec <= 0) {
        st.pressTimerSec = STANDOFF_PRESS_SEC;
        out.launch = true;
      }
    } else {
      // Bombs: hold the button (pressing on alternate ticks) and let the CCRP release; past the
      // target with bombs still on (a bad run), give up rather than circle in the defences.
      st.pressTick = !st.pressTick;
      out.launch = st.pressTick;
      st.closestM = Math.min(st.closestM, d);
      if (d > st.closestM + 2500) {
        st.phase = StrikePhase.Done;
        return false;
      }
    }
  }
  return true;
}

/** The highest ground along the track ahead (and under the aircraft), m. */
function terrainAheadM(ctx: PilotContext, p: Readonly<Vec3Like>): number {
  const v = ctx.self.vel;
  const vh = Math.hypot(v.x, v.z) || 1;
  let h = ctx.sampler.heightAt(p.x, p.z);
  for (let s = 500; s <= LOW_LEVEL_LOOKAHEAD_M; s += 500) h = Math.max(h, ctx.sampler.heightAt(p.x + (v.x / vh) * s, p.z + (v.z / vh) * s));
  return h;
}
