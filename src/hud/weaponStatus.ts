/**
 * src/hud/weaponStatus.ts
 *
 * Selected-weapon readout: the selected store and how many are left, from the
 * snapshot's HUD block (SELECTED_STORE / SELECTED_COUNT / GUN_ROUNDS).
 */

import { LockStateByCode, NO_ENTITY_ID, STORE_IDS, SnapshotHud, WeaponKind, WeaponKindByCode, type LockState } from '../contracts/core';
import { WEAPON_DISPLAY_LABEL } from '../contracts/render';
import { storeInfo } from '../catalog';

/** The selected store's label and count, straight from the snapshot (SELECTED_STORE / SELECTED_COUNT). */
export function drawWeaponStatus(ctx: CanvasRenderingContext2D, hud: Float64Array, xPx: number, yPx: number): void {
  const weaponIdx = hud[SnapshotHud.WEAPON_IDX]!;
  const kind = WeaponKindByCode[weaponIdx] ?? WeaponKind.Gun;
  const code = hud[SnapshotHud.SELECTED_STORE] ?? 0;
  const label = (code > 0 ? storeInfo(STORE_IDS[code] ?? '')?.label : undefined) ?? WEAPON_DISPLAY_LABEL[kind];
  const ammoText = `${Math.round(kind === WeaponKind.Gun ? hud[SnapshotHud.GUN_ROUNDS] ?? 0 : hud[SnapshotHud.SELECTED_COUNT] ?? 0)}`;

  ctx.save();
  ctx.fillStyle = '#40ff60';
  ctx.font = '13px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(label, xPx, yPx);
  ctx.fillText(ammoText, xPx, yPx + 16);
  ctx.fillText(`C ${Math.round(hud[SnapshotHud.CHAFF] ?? 0)}  F ${Math.round(hud[SnapshotHud.FLARES] ?? 0)}`, xPx, yPx + 32);
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
