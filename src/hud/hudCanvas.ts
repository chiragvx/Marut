/**
 * src/hud/hudCanvas.ts
 *
 * Canvas-2D root; implements `CreateHudRenderer`; owns the 2D draw-call
 * orchestration and the per-frame snapshot parse (reads the HUD block and
 * scans entity blocks for the target, directly — 08-render.md section 4.1).
 *
 * CONTRACT NOTE (see this agent's final report): 08-render.md section 4.9
 * says the ladder/tapes are "drawn only when the active camera mode is
 * Cockpit or Chase", but `contracts/render.ts`'s `HudRenderer` interface has
 * no method or `CameraState` field carrying the active `CameraMode` to this
 * module — `setCameraMode` exists only on `SceneRenderer`. Since the
 * contract is authoritative and read-only, this implementation draws the
 * ladder/tapes/AoA-G readout every frame regardless of camera mode; the
 * target box/lead-sight/warnings/weapon-status/ILS-needles/radar-scope are
 * unaffected (none of them depended on camera mode per that same section).
 */

import { NO_ENTITY_ID, SnapshotEntity, SnapshotHud, SpeedUnit, entityFieldOffset, type QualityTier } from '../contracts/core';
import { RENDER_QUALITY_TABLE, type CameraState, type CreateHudRenderer, type HudRenderer } from '../contracts/render';

import { drawLadder } from './ladder';
import { drawControlSurfaceDebug } from './controlSurfaceDebug';
import { drawIlsNeedles } from './ilsNeedles';
import { drawRadarScope } from './radarScope';
import {
  computeInterpFraction,
  createHudSnapshotDoubleBuffer,
  createInterpolatedHudEntity,
  findEntitySlotById,
  ingestSnapshotIntoHudBuffer,
  interpolateHudEntity,
} from './snapshotView';
import { drawAltitudeTape, drawAoaGReadout, drawGearIndicator, drawHeadingTape, drawPowerIndicator, drawSpeedTape } from './tapes';
import { createScreenProjection, drawLeadSight, drawTargetBox, hasTarget } from './targetBox';
import { createWeaponStatusState, drawWeaponStatus, ingestWeaponEvents, setWeaponLoadout as applyWeaponLoadout } from './weaponStatus';
import { drawWarnings } from './warnings';

export const createHudRenderer: CreateHudRenderer = (canvas, initialTier) => {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('hudCanvas: 2D rendering context unavailable');

  let tier: QualityTier = initialTier;
  let speedUnit: SpeedUnit = SpeedUnit.Mps;
  let widthPx = canvas.width;
  let heightPx = canvas.height;

  const buf = createHudSnapshotDoubleBuffer();
  const interpTarget = createInterpolatedHudEntity();
  const weaponState = createWeaponStatusState();
  const scratchProjection = createScreenProjection();

  // Player's own throttle/afterburner state, read straight off the per-entity snapshot block
  // (SnapshotEntity.THROTTLE/AFTERBURNER_ON) since the HUD block itself carries no afterburner
  // field — see drawPowerIndicator's doc comment in tapes.ts for why this exists.
  let playerThrottleFrac = 0;
  let playerAfterburnerOn = false;
  // Same pattern for the debug control-surface overlay (controlSurfaceDebug.ts): elevonL/elevonR/
  // rudder are 3D-wireframe-only fields per the HUD block's own design (see snapshotView.ts's
  // InterpolatedHudEntity comment), so this reads them directly off the player's raw entity block
  // rather than extending the shared HudSnapshotFrame parse every widget shares.
  let playerElevonLRad = 0;
  let playerElevonRRad = 0;
  let playerRudderRad = 0;
  let debugSurfacesEnabled = false;

  const api: HudRenderer = {
    resize(widthPxArg, heightPxArg, devicePixelRatio) {
      const cap = RENDER_QUALITY_TABLE[tier].pixelRatioCap;
      const dpr = Math.min(devicePixelRatio, cap);
      widthPx = widthPxArg;
      heightPx = heightPxArg;
      canvas.width = Math.round(widthPxArg * dpr);
      canvas.height = Math.round(heightPxArg * dpr);
      canvas.style.width = `${widthPxArg}px`;
      canvas.style.height = `${heightPxArg}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },

    setQualityTier(t) {
      tier = t;
    },

    setSpeedUnit(u) {
      speedUnit = u;
    },

    ingestSnapshot(view) {
      ingestSnapshotIntoHudBuffer(buf, view, performance.now());
      const pSlot = buf.curr.playerSlot;
      if (pSlot >= 0) {
        playerThrottleFrac = view[entityFieldOffset(pSlot, SnapshotEntity.THROTTLE)] ?? 0;
        playerAfterburnerOn = (view[entityFieldOffset(pSlot, SnapshotEntity.AFTERBURNER_ON)] ?? 0) !== 0;
        playerElevonLRad = view[entityFieldOffset(pSlot, SnapshotEntity.ELEVON_L)] ?? 0;
        playerElevonRRad = view[entityFieldOffset(pSlot, SnapshotEntity.ELEVON_R)] ?? 0;
        playerRudderRad = view[entityFieldOffset(pSlot, SnapshotEntity.RUDDER)] ?? 0;
      }
    },

    ingestEvents(events) {
      const playerId = buf.curr.playerSlot >= 0 ? buf.curr.id[buf.curr.playerSlot]! : NO_ENTITY_ID;
      ingestWeaponEvents(weaponState, events, playerId);
    },

    setWeaponLoadout(ammoGun, missilesIr, missilesRadar) {
      applyWeaponLoadout(weaponState, ammoGun, missilesIr, missilesRadar);
    },

    setDebugSurfacesEnabled(enabled) {
      debugSurfacesEnabled = enabled;
    },

    renderFrame(nowMs, camera: CameraState) {
      ctx.clearRect(0, 0, widthPx, heightPx);
      if (!buf.hasData) return;

      const curr = buf.curr;
      const playerSlot = curr.playerSlot;
      if (playerSlot < 0) return;
      const hud = curr.hud;

      drawLadder(ctx, hud, widthPx, heightPx);
      drawSpeedTape(ctx, hud, 50, heightPx * 0.5, heightPx * 0.32, speedUnit);
      drawAltitudeTape(ctx, hud, widthPx - 50, heightPx * 0.5, heightPx * 0.32);
      drawHeadingTape(ctx, hud, widthPx * 0.5, 16, widthPx * 0.28);
      drawAoaGReadout(ctx, hud, 16, heightPx - 44);
      drawPowerIndicator(ctx, playerThrottleFrac, playerAfterburnerOn, 100, heightPx - 44);
      drawGearIndicator(ctx, hud[SnapshotHud.GEAR_POS]!, 184, heightPx - 44);
      drawIlsNeedles(ctx, hud, widthPx, heightPx);

      const tierSettings = RENDER_QUALITY_TABLE[tier];
      const headingRad = hud[SnapshotHud.HEADING_RAD]!;
      const playerTeam = curr.team[playerSlot]!;
      const scopeRadiusPx = 90;
      drawRadarScope(ctx, curr, playerSlot, headingRad, playerTeam, tierSettings.radarScopeContactCap, widthPx - scopeRadiusPx - 20, heightPx - scopeRadiusPx - 20, scopeRadiusPx);

      const targetId = hud[SnapshotHud.TARGET_ID]!;
      if (hasTarget(targetId)) {
        const targetSlot = findEntitySlotById(curr, targetId);
        if (targetSlot >= 0) {
          const f = computeInterpFraction(nowMs, curr.arrivalMs);
          interpolateHudEntity(buf, targetSlot, f, interpTarget);
          drawTargetBox(ctx, camera, interpTarget.pos, widthPx, heightPx, hud[SnapshotHud.TARGET_RANGE_M]!, hud[SnapshotHud.CLOSURE_MPS]!, scratchProjection);
        }
      }

      drawLeadSight(ctx, camera, hud, widthPx, heightPx);
      drawWeaponStatus(ctx, hud, weaponState, widthPx - 16, heightPx - 44);
      drawWarnings(ctx, hud, nowMs, widthPx * 0.5, heightPx * 0.28);

      if (debugSurfacesEnabled) {
        drawControlSurfaceDebug(ctx, playerElevonLRad, playerElevonRRad, playerRudderRad, 16, 28);
      }
    },

    dispose() {
      // Canvas 2D contexts hold no GPU resources of their own to release.
    },
  };

  return api;
};
