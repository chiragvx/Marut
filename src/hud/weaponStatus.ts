/**
 * src/hud/weaponStatus.ts
 *
 * Selected-weapon readout + locally-tracked ammo counters, event-driven
 * decrement. 08-render.md section 4.9 / section 6.3 (SimEvent-driven, not
 * carried in the 60 Hz snapshot).
 */

import { LockStateByCode, NO_ENTITY_ID, SnapshotHud, WeaponKind, WeaponKindByCode, type EntityId, type LockState, type SimEvent } from '../contracts/core';
import { WEAPON_DISPLAY_LABEL } from '../contracts/render';

export interface WeaponStatusState {
  ammoGun: number;
  missilesIr: number;
  missilesRadar: number;
  /** Missile type labels (undefined = the generic IR / RDR). */
  irName: string | undefined;
  radarName: string | undefined;
}

export function createWeaponStatusState(): WeaponStatusState {
  return { ammoGun: 0, missilesIr: 0, missilesRadar: 0, irName: undefined, radarName: undefined };
}

export function setWeaponLoadout(state: WeaponStatusState, ammoGun: number, missilesIr: number, missilesRadar: number, names?: { ir?: string; radar?: string }): void {
  state.ammoGun = ammoGun;
  state.missilesIr = missilesIr;
  state.missilesRadar = missilesRadar;
  state.irName = names?.ir;
  state.radarName = names?.radar;
}

/** Only events whose shooter id matches the player's own EntityId decrement the player's ammo display. */
export function ingestWeaponEvents(state: WeaponStatusState, events: readonly SimEvent[], playerId: EntityId): void {
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.type === 'gunFire' && ev.shooterId === playerId) {
      state.ammoGun = Math.max(0, state.ammoGun - 1);
    } else if (ev.type === 'missileLaunch' && ev.shooterId === playerId) {
      if (ev.weapon === WeaponKind.IrMissile) state.missilesIr = Math.max(0, state.missilesIr - 1);
      else if (ev.weapon === WeaponKind.RadarMissile) state.missilesRadar = Math.max(0, state.missilesRadar - 1);
    }
  }
}

export function drawWeaponStatus(ctx: CanvasRenderingContext2D, hud: Float64Array, state: WeaponStatusState, xPx: number, yPx: number): void {
  const weaponIdx = hud[SnapshotHud.WEAPON_IDX]!;
  const kind = WeaponKindByCode[weaponIdx] ?? WeaponKind.Gun;
  const label = (kind === WeaponKind.IrMissile ? state.irName : kind === WeaponKind.RadarMissile ? state.radarName : undefined) ?? WEAPON_DISPLAY_LABEL[kind];
  const ammoText = kind === WeaponKind.Gun ? `${state.ammoGun}` : kind === WeaponKind.IrMissile ? `${state.missilesIr}` : `${state.missilesRadar}`;

  ctx.save();
  ctx.fillStyle = '#40ff60';
  ctx.font = '13px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(label, xPx, yPx);
  ctx.fillText(ammoText, xPx, yPx + 16);
  const lockState = LockStateByCode[hud[SnapshotHud.LOCK_STATE]!] ?? 'none';
  const cue = missileLockCue(kind, lockState, hud[SnapshotHud.TARGET_ID]! !== NO_ENTITY_ID);
  if (cue) {
    ctx.fillStyle = cue === 'LOCK' ? '#ff4040' : cue === 'TRK' ? '#ffc040' : '#40ff60';
    ctx.fillText(cue, xPx, yPx - 18);
  }
  ctx.restore();
}

/**
 * Missile lock cue shown above the weapon readout: 'T: TGT' when no target is designated (the
 * lock never starts without one), then SRCH / TRK / LOCK as the lock builds. Undefined for the
 * gun. Previously the HUD never showed lock state at all, so there was no way to tell when a
 * missile launch (Enter) would actually be accepted -- it is only accepted at LOCK.
 */
export function missileLockCue(kind: WeaponKind, lockState: LockState, hasTarget: boolean): string | undefined {
  if (kind === WeaponKind.Gun) return undefined;
  if (!hasTarget) return 'T: TGT';
  if (lockState === 'locked') return 'LOCK';
  if (lockState === 'tracking') return 'TRK';
  return 'SRCH';
}
