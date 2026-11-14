/**
 * src/physics/cargo.ts — the airdrop hook: cargo on and off an aircraft with
 * AircraftDefinition.massModel (the C-17). The flight model reads EntityState.cargoMassKg and
 * cargoCgBodyX every substep (mass, CG offset and inertia: integrator.ts), so changing them here is
 * all a drop needs; moving the CG aft first (the load rolling down the ramp) and then releasing it
 * gives the real pitch-up-then-recover response. Extraction itself (parachutes, platform
 * trajectories) belongs to the mission/script layer and is not modelled here.
 */
import type { AircraftDefinition } from '../contracts/aircraft';
import type { EntityState } from '../contracts/core';
import { clamp } from '../math';

/** Loads `massKg` of cargo (held to massModel.maxCargoKg) at `cgBodyX` (default: the hold's centroid). */
export function loadCargo(state: EntityState, def: Pick<AircraftDefinition, 'massModel'>, massKg: number, cgBodyX?: number): void {
  const mm = def.massModel;
  if (!mm) return;
  state.cargoMassKg = clamp(massKg, 0, mm.maxCargoKg);
  state.cargoCgBodyX = cgBodyX ?? mm.cargoCgBodyX;
}

/**
 * Moves the cargo's centre of gravity (body x, m; negative = aft), e.g. while a load rolls toward
 * the ramp before it leaves.
 */
export function moveCargo(state: EntityState, cgBodyX: number): void {
  if ((state.cargoMassKg ?? 0) > 0) state.cargoCgBodyX = cgBodyX;
}

/**
 * Releases up to `massKg` of cargo (all of it when omitted) and returns how much left the
 * aircraft. Only through an open ramp (EntityState.rampPos fully open); returns 0 otherwise.
 */
export function releaseCargo(state: EntityState, massKg?: number): number {
  const onboard = state.cargoMassKg ?? 0;
  if (onboard <= 0 || (state.rampPos ?? 0) < 1) return 0;
  const released = clamp(massKg ?? onboard, 0, onboard);
  state.cargoMassKg = onboard - released;
  return released;
}
