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

import { drawAirbaseMarkers, drawAirbaseTape } from './airbaseMarkers';
import { drawAutopilotBugs, drawAutopilotStatus } from './autopilotHud';
import { EntityFlag, NO_ENTITY_ID, SnapshotEntity, SnapshotHud, SpeedUnit, WarningBit, entityFieldOffset, type QualityTier } from '../contracts/core';
import { RENDER_QUALITY_TABLE, type CameraState, type CreateHudRenderer, type HudAirbase, type HudRenderer } from '../contracts/render';

import { drawLadder } from './ladder';
import { drawControlSurfaceDebug } from './controlSurfaceDebug';
import { drawIlsNeedles } from './ilsNeedles';
import { RADAR_RANGE_SCALES_KM, drawRadarDisplay } from './radarDisplay';
import {
  computeInterpFraction,
  createHudSnapshotDoubleBuffer,
  createInterpolatedHudEntity,
  findEntitySlotById,
  ingestSnapshotIntoHudBuffer,
  interpolateHudEntity,
} from './snapshotView';
import { createTaxiGuideState, drawTaxiGuide, setTaxiGuide as applyTaxiGuide } from './taxiGuide';
import { drawAirbrakeIndicator, drawAltitudeTape, drawAoaGReadout, drawFuelIndicator, drawGearIndicator, drawHeadingTape, drawPowerIndicator, drawServiceStatus, drawSpeedTape } from './tapes';
import { createScreenProjection, drawLeadSight, drawTargetBox, hasTarget } from './targetBox';
import { createWeaponStatusState, drawWeaponStatus, ingestWeaponEvents, setWeaponLoadout as applyWeaponLoadout } from './weaponStatus';
import { drawWarnings } from './warnings';

/**
 * True if a world point is within the aircraft HUD's field of view (a 12 deg cone round its optical
 * axis, 6.5 deg below the nose: the 3D cockpit's HUD), where the helmet display blanks its symbols.
 */
function insideHudField(curr: { posX: Float64Array; posY: Float64Array; posZ: Float64Array; rotX: Float32Array; rotY: Float32Array; rotZ: Float32Array; rotW: Float32Array }, slot: number, p: { x: number; y: number; z: number }): boolean {
  const vx = p.x - curr.posX[slot]!;
  const vy = p.y - curr.posY[slot]!;
  const vz = p.z - curr.posZ[slot]!;
  // World -> body: rotate by the conjugate of the orientation.
  const qx = -curr.rotX[slot]!;
  const qy = -curr.rotY[slot]!;
  const qz = -curr.rotZ[slot]!;
  const qw = curr.rotW[slot]!;
  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;
  const bx = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  const by = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  const bz = iz * qw + iw * -qz + ix * -qy - iy * -qx;
  const len = Math.hypot(bx, by, bz) || 1;
  const axis = (-6.5 * Math.PI) / 180;
  const cosToAxis = (bx * Math.cos(axis) + by * Math.sin(axis)) / len;
  return cosToAxis > Math.cos((11 * Math.PI) / 180) && Math.abs(bz / len) < Math.sin((10 * Math.PI) / 180);
}

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
  const taxiGuide = createTaxiGuideState();
  let radarRangeIndex = 3; // 80 km
  let lastNowMs = 0;
  const scratchProjection = createScreenProjection();

  // Player's own throttle/afterburner state, read straight off the per-entity snapshot block
  // (SnapshotEntity.THROTTLE/AFTERBURNER_ON) since the HUD block itself carries no afterburner
  // field — see drawPowerIndicator's doc comment in tapes.ts for why this exists.
  let playerThrottleFrac = 0;
  let playerAfterburnerOn = false;
  // Airbrake: commanded state from the entity FLAGS (EntityFlag.AirbrakeOut) and when it last changed.
  let playerAirbrakeOut = false;
  let airbrakeToggledAtMs = -1e9;
  // Same pattern for the debug control-surface overlay (controlSurfaceDebug.ts): elevonL/elevonR/
  // rudder are 3D-wireframe-only fields per the HUD block's own design (see snapshotView.ts's
  // InterpolatedHudEntity comment), so this reads them directly off the player's raw entity block
  // rather than extending the shared HudSnapshotFrame parse every widget shares.
  let playerElevonLRad = 0;
  let playerElevonRRad = 0;
  let playerRudderRad = 0;
  let debugSurfacesEnabled = false;
  // Navigation markers (airbaseMarkers.ts): the mission's airbases, and whether the player is on the ground.
  let airbases: readonly HudAirbase[] = [];
  let playerOnGround = false;
  // 'helmet': only the helmet-mounted display's symbols over the world (3D cockpit view).
  let overlayMode: 'full' | 'helmet' = 'full';

  const api: HudRenderer = {
    setOverlayMode(m) {
      overlayMode = m;
    },

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
        const ab = ((view[entityFieldOffset(pSlot, SnapshotEntity.FLAGS)] ?? 0) & EntityFlag.AirbrakeOut) !== 0;
        if (ab !== playerAirbrakeOut) {
          playerAirbrakeOut = ab;
          airbrakeToggledAtMs = performance.now();
        }
        playerElevonLRad = view[entityFieldOffset(pSlot, SnapshotEntity.ELEVON_L)] ?? 0;
        playerElevonRRad = view[entityFieldOffset(pSlot, SnapshotEntity.ELEVON_R)] ?? 0;
        playerRudderRad = view[entityFieldOffset(pSlot, SnapshotEntity.RUDDER)] ?? 0;
        playerOnGround = ((view[entityFieldOffset(pSlot, SnapshotEntity.FLAGS)] ?? 0) & EntityFlag.OnGround) !== 0;
      }
    },

    ingestEvents(events) {
      const playerId = buf.curr.playerSlot >= 0 ? buf.curr.id[buf.curr.playerSlot]! : NO_ENTITY_ID;
      ingestWeaponEvents(weaponState, events, playerId);
    },

    setWeaponLoadout(ammoGun, missilesIr, missilesRadar, names) {
      applyWeaponLoadout(weaponState, ammoGun, missilesIr, missilesRadar, names);
    },

    cycleRadarRange(dir) {
      radarRangeIndex = Math.max(0, Math.min(RADAR_RANGE_SCALES_KM.length - 1, radarRangeIndex + dir));
    },

    setTaxiGuide(guide) {
      applyTaxiGuide(taxiGuide, guide, lastNowMs);
    },

    hasTaxiGuide() {
      return taxiGuide.route !== undefined;
    },

    setAirbases(bases) {
      airbases = bases;
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

      if (overlayMode === 'helmet') {
        // Helmet-mounted display: world-referenced cues only (the cockpit's HUD and displays carry the rest).
        drawAirbaseMarkers(ctx, airbases, camera, curr.posX[playerSlot]!, curr.posY[playerSlot]!, curr.posZ[playerSlot]!, playerOnGround, widthPx, heightPx);
        lastNowMs = nowMs;
        if (taxiGuide.route || taxiGuide.message) {
          const p = { x: curr.posX[playerSlot]!, z: curr.posZ[playerSlot]! };
          if (!drawTaxiGuide(ctx, taxiGuide, p, hud[SnapshotHud.TAS_MPS]!, camera, widthPx, heightPx, nowMs)) applyTaxiGuide(taxiGuide, null, nowMs);
        }
        const tId = hud[SnapshotHud.TARGET_ID]!;
        const tSlot = hasTarget(tId) ? findEntitySlotById(curr, tId) : -1;
        if (tSlot >= 0) {
          const span = curr.simTimeSec - buf.prev.simTimeSec;
          const f = camera.renderSimSec !== undefined && span > 1e-6 ? Math.max(-3, Math.min(1, (camera.renderSimSec - buf.prev.simTimeSec) / span)) : computeInterpFraction(nowMs, curr.arrivalMs);
          interpolateHudEntity(buf, tSlot, f, interpTarget);
          // Like a real helmet display, blank the target box where the aircraft's own HUD shows it.
          if (!insideHudField(curr, playerSlot, interpTarget.pos)) {
            drawTargetBox(ctx, camera, interpTarget.pos, widthPx, heightPx, hud[SnapshotHud.TARGET_RANGE_M]!, hud[SnapshotHud.CLOSURE_MPS]!, scratchProjection);
          }
        }
        return;
      }

      drawLadder(ctx, hud, widthPx, heightPx);
      drawSpeedTape(ctx, hud, 50, heightPx * 0.5, heightPx * 0.32, speedUnit);
      drawAltitudeTape(ctx, hud, widthPx - 50, heightPx * 0.5, heightPx * 0.32);
      drawHeadingTape(ctx, hud, widthPx * 0.5, 16, widthPx * 0.28);
      drawAirbaseTape(ctx, airbases, curr.posX[playerSlot]!, curr.posZ[playerSlot]!, hud[SnapshotHud.HEADING_RAD]!, widthPx * 0.5, 16, widthPx * 0.28);
      drawAirbaseMarkers(ctx, airbases, camera, curr.posX[playerSlot]!, curr.posY[playerSlot]!, curr.posZ[playerSlot]!, playerOnGround, widthPx, heightPx);
      drawAutopilotBugs(ctx, hud, widthPx * 0.5, 16, widthPx * 0.28, 50, widthPx - 50, heightPx * 0.5, heightPx * 0.32);
      drawAutopilotStatus(ctx, hud, widthPx * 0.5, 62, speedUnit, nowMs);
      drawAoaGReadout(ctx, hud, 16, heightPx - 44);
      drawPowerIndicator(ctx, playerThrottleFrac, playerAfterburnerOn, 100, heightPx - 44);
      drawGearIndicator(ctx, hud[SnapshotHud.GEAR_POS]!, 184, heightPx - 44);
      drawAirbrakeIndicator(ctx, playerAirbrakeOut, nowMs - airbrakeToggledAtMs, 184, heightPx - 60);
      drawFuelIndicator(ctx, hud[SnapshotHud.FUEL_KG]!, (hud[SnapshotHud.WARNING_BITS]! & WarningBit.LowFuel) !== 0, hud[SnapshotHud.TANK_FUEL_KG]!, 184, heightPx - 28);
      drawIlsNeedles(ctx, hud, widthPx, heightPx);
      drawServiceStatus(ctx, hud, widthPx * 0.5, heightPx * 0.78);
      lastNowMs = nowMs;
      if (taxiGuide.route || taxiGuide.message) {
        const p = { x: curr.posX[playerSlot]!, z: curr.posZ[playerSlot]! };
        if (!drawTaxiGuide(ctx, taxiGuide, p, hud[SnapshotHud.TAS_MPS]!, camera, widthPx, heightPx, nowMs)) applyTaxiGuide(taxiGuide, null, nowMs);
      }

      const tierSettings = RENDER_QUALITY_TABLE[tier];
      const headingRad = hud[SnapshotHud.HEADING_RAD]!;
      const playerTeam = curr.team[playerSlot]!;
      const scopeRadiusPx = 90;
      const radarSize = Math.round(Math.min(230, heightPx * 0.3));
      drawRadarDisplay(ctx, hud, curr.posX[playerSlot]!, curr.posY[playerSlot]!, curr.posZ[playerSlot]!, headingRad, RADAR_RANGE_SCALES_KM[radarRangeIndex]! * 1000, widthPx - radarSize - 100, heightPx - radarSize - 30, radarSize);
      void playerTeam;
      void tierSettings;
      void scopeRadiusPx;

      const targetId = hud[SnapshotHud.TARGET_ID]!;
      if (hasTarget(targetId)) {
        const targetSlot = findEntitySlotById(curr, targetId);
        if (targetSlot >= 0) {
          // At the moment the 3D view shows (it plays a little behind the newest snapshot), so the
          // box stays on the aircraft it frames.
          const span = curr.simTimeSec - buf.prev.simTimeSec;
          const f = camera.renderSimSec !== undefined && span > 1e-6 ? Math.max(-3, Math.min(1, (camera.renderSimSec - buf.prev.simTimeSec) / span)) : computeInterpFraction(nowMs, curr.arrivalMs);
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
