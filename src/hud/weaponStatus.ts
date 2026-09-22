/**
 * src/hud/weaponStatus.ts
 *
 * Selected-weapon readout + locally-tracked ammo counters, event-driven
 * decrement. 08-render.md section 4.9 / section 6.3 (SimEvent-driven, not
 * carried in the 60 Hz snapshot).
 */

import { SnapshotHud, WeaponKind, WeaponKindByCode, type EntityId, type SimEvent } from '../contracts/core';
import { WEAPON_DISPLAY_LABEL } from '../contracts/render';

export interface WeaponStatusState {
  ammoGun: number;
  missilesIr: number;
  missilesRadar: number;
}

export function createWeaponStatusState(): WeaponStatusState {
  return { ammoGun: 0, missilesIr: 0, missilesRadar: 0 };
}

export function setWeaponLoadout(state: WeaponStatusState, ammoGun: number, missilesIr: number, missilesRadar: number): void {
  state.ammoGun = ammoGun;
  state.missilesIr = missilesIr;
  state.missilesRadar = missilesRadar;
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
  const label = WEAPON_DISPLAY_LABEL[kind];
  const ammoText = kind === WeaponKind.Gun ? `${state.ammoGun}` : kind === WeaponKind.IrMissile ? `${state.missilesIr}` : `${state.missilesRadar}`;

  ctx.save();
  ctx.fillStyle = '#40ff60';
  ctx.font = '13px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(label, xPx, yPx);
  ctx.fillText(ammoText, xPx, yPx + 16);
  ctx.restore();
}
