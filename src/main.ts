/**
 * src/main.ts — app entry point: creates both workers, wires
 * src/render/src/hud/src/input/src/ui, drives requestAnimationFrame, resize,
 * visibility pause. See 10-core-worker.md section 4.10 (this file has no
 * contract of its own — see 00-architecture.md section 12 step 4's flagged
 * exception — so it is written directly against the real, now-implemented
 * exports of modules 04/08/09/11 rather than a contracts/*.ts file).
 */

import { NO_ENTITY_ID, MissionObjectiveKind, SpeedUnit } from './contracts/core';
import type {
  AiDifficulty,
  EntityId,
  Mission,
  MissionEndedEvent,
  PilotInputs,
  QualityTier,
  SimCommandMessage,
  SimEventsMessage,
  SimInitMessage,
  SimReleaseBufferMessage,
  SimSnapshotMessage,
  SimToMainMessage,
} from './contracts/core';
import type { MainToTerrainMessage, TerrainToMainMessage } from './contracts/core';
import type { MainToTerrainMessageExt, TerrainToMainMessageExt, AirportFlattenZone, TerrainParams } from './contracts/terrain';
import { DEFAULT_TERRAIN_PARAMS } from './contracts/terrain';
import { RunwaySurface } from './contracts/airport';
import type { AirportLayout, RunwayDef, TaxiwayDef, ApronDef } from './contracts/airport';
import type { CameraState, HudRenderer, SceneEnvironment, SceneRenderer } from './contracts/render';
import type { PlayerInputSystem } from './contracts/input';
import { RebindDeviceKind } from './contracts/input';
import type {
  BindableAction,
  DebriefStats,
  EditorAirportLayout,
  EditorRunway,
  MissionSelectOptions,
  MissionSummary,
  OrientationPromptHandle,
  ScreenHandle,
  SettingsScreenHandle,
  SettingsState,
} from './contracts/ui';
import { MissionOutcome } from './contracts/ui';
import type { ChunkManager } from './contracts/terrain';
import type { SnapshotEntityView } from './contracts/sim';

import { createSceneRenderer } from './render';
import { createHudRenderer } from './hud';
import { createPlayerInputSystem } from './input';
import {
  createMainMenu,
  createMissionSelect,
  createSettingsScreen,
  createPauseMenu,
  createDebriefScreen,
  createLoadingScreen,
  mountOrientationPrompt,
  detectQualityTier,
  runwayDesignator,
  computeFlattenZones,
} from './ui';
import { createChunkManager } from './terrain';
import { createHeightSampler } from './terrain';
import { createAirportNavDb, validateAirportLayout } from './airport';
import { tejasDefinition } from './aircraft';
import { isBuiltinMissionId, resolveBuiltinMission } from './core/missions/index';
import { readSnapshotEntity, readSnapshotHeader } from './core/snapshotReader';
import { subSeed } from './core/seed';
import { buildKeyBindingsFromInputMap, isAxisRebindMiscapturePositive, targetForBindableAction } from './core/inputBindingsAdapter';

// -----------------------------------------------------------------------------
// Settings persistence (10-core-worker.md section 4.10.2).
// -----------------------------------------------------------------------------

interface PersistedSettings {
  qualityTierOverride: QualityTier | 'auto';
  version: 1;
  /**
   * Result of the last auto-detection (detectQualityTier), cached so the ~2.5s/300k-triangle GPU
   * benchmark (src/ui/benchmark.ts) only ever has to run once per browser instead of on every
   * single page load — it was previously unconditional whenever qualityTierOverride === 'auto'
   * (the default), which is what made every load "lag the entire browser and PC" for its
   * duration. Optional so old saved data (from before this field existed) still parses fine.
   */
  cachedAutoTier?: QualityTier;
  /** HUD airspeed-tape display unit (src/ui/settings.ts's "Speed unit" control). Optional so old saved data (from before this field existed) still parses fine; missing means 'ms', matching SnapshotHud.IAS_MPS's own wire unit. */
  speedUnit?: SpeedUnit;
  /** src/ui/settings.ts's "AoA limiter" control; see PilotInputs.alphaLimiterDisabled's doc comment. Optional so old saved data still parses fine; missing means the limiter stays enabled (the safe default). */
  alphaLimiterEnabled?: boolean;
}

function loadPersistedSettings(): PersistedSettings | undefined {
  try {
    const raw = localStorage.getItem('tejas.settings.v1');
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    if (parsed.version !== 1 || typeof parsed.qualityTierOverride !== 'string') return undefined;
    if (parsed.cachedAutoTier !== undefined && typeof parsed.cachedAutoTier !== 'string') return undefined;
    if (parsed.speedUnit !== undefined && typeof parsed.speedUnit !== 'string') return undefined;
    if (parsed.alphaLimiterEnabled !== undefined && typeof parsed.alphaLimiterEnabled !== 'boolean') return undefined;
    return parsed as PersistedSettings;
  } catch {
    return undefined;
  }
}

/**
 * Merges `s` onto whatever is already persisted rather than overwriting it outright — every call
 * site here only ever intends to update the field(s) it actually knows about (e.g. onChange's
 * quality-tier save doesn't know the cached benchmark tier; boot's benchmark-fallback save
 * doesn't know the player's speed-unit choice), so a plain overwrite silently drops any OTHER
 * optional field a different call site previously wrote (found by live-testing: switching the
 * speed unit, then reloading twice, reverted it back to m/s because the intervening boot-time
 * quality-tier save had overwritten the whole record without it). Merging keeps each optional
 * field's last-written value until something explicitly changes it again.
 */
function savePersistedSettings(s: PersistedSettings): void {
  try {
    const merged: PersistedSettings = { ...loadPersistedSettings(), ...s };
    localStorage.setItem('tejas.settings.v1', JSON.stringify(merged));
  } catch {
    // Storage unavailable/full — silently ignored, matches this project's
    // "never throw for ordinary bad/missing data" convention.
  }
}

// -----------------------------------------------------------------------------
// App state machine (10-core-worker.md section 4.10.1).
// -----------------------------------------------------------------------------

type AppState = 'boot' | 'mainMenu' | 'missionSelect' | 'loading' | 'gameplay' | 'paused' | 'debrief' | 'airportEditor';

let appState: AppState = 'boot';
let currentScreen: ScreenHandle | undefined;
let orientationPrompt: OrientationPromptHandle | undefined;
let uiRoot: HTMLElement;
let renderCanvas: HTMLCanvasElement;
let hudCanvas: HTMLCanvasElement;

let renderer: SceneRenderer;
let hud: HudRenderer;
let inputSystem: PlayerInputSystem;
let chunkManager: ChunkManager;
let currentQualityTier: QualityTier;
let currentSpeedUnit: SpeedUnit = SpeedUnit.Mps;
let currentMission: Mission | undefined;
let currentDifficulty: AiDifficulty = 'veteran';
let playerEntityId: EntityId = NO_ENTITY_ID;
let sessionStartSimTimeSec = 0;
let latestSimTimeSec = 0;

// Session-wide combat-stat counters for DebriefStats (11-ui.md's own doc
// comment: "no module owns a dedicated combat-stats aggregate... src/main.ts
// is the natural place").
let statKills = 0;
let statDeaths = 0;
let statShotsFiredGun = 0;
let statShotsHitGun = 0;
let statMissilesFired = 0;
let statMissilesHit = 0;

const simWorker = new Worker(new URL('./core/sim.worker.ts', import.meta.url), { type: 'module' });
const terrainWorker = new Worker(new URL('./terrain/terrain.worker.ts', import.meta.url), { type: 'module' });

const entityViewScratch: SnapshotEntityView = {
  id: NO_ENTITY_ID,
  kind: 'aircraft',
  team: 0,
  pos: { x: 0, y: 0, z: 0 },
  rot: { x: 0, y: 0, z: 0, w: 1 },
  vel: { x: 0, y: 0, z: 0 },
  omega: { x: 0, y: 0, z: 0 },
  alive: false,
  hp: 0,
  fuelKg: 0,
  elevonL: 0,
  elevonR: 0,
  rudder: 0,
  gearPos: 0,
  throttle: 0,
  afterburnerOn: false,
  flags: 0,
};

// -----------------------------------------------------------------------------
// Airport editor "Test Fly" — converts an EditorAirportLayout (module 11,
// contracts/ui.ts) into a real AirportLayout (module 05, contracts/airport.ts)
// and synthesizes a one-off free-flight Mission from it, per 10-core-worker.md
// section 4.10.1's 'airportEditor -> onLaunchMission(layout) -> loading (a
// synthesized single-runway free-flight Mission using the edited layout)'.
// No such converter exists anywhere else in the codebase (contracts/ui.ts's
// own header explains why: it is drafted blind to contracts/airport.ts's real
// field names), so this module — the one place allowed to import every leaf
// module's real code — owns it.
// -----------------------------------------------------------------------------

function wrapTwoPi(rad: number): number {
  const twoPi = Math.PI * 2;
  return ((rad % twoPi) + twoPi) % twoPi;
}

/** One EditorRunway (a single centerline + primary landing heading) becomes TWO reciprocal RunwayDef entries, matching module 05's schema (00-architecture.md section 9.1-adjacent; see contracts/airport.ts's own RunwayDef doc comment). */
function editorRunwayToAirportRunways(r: EditorRunway): RunwayDef[] {
  const primaryDesignator = runwayDesignator(r.headingRad);
  const reciprocalHeadingRad = wrapTwoPi(r.headingRad + Math.PI);
  const reciprocalDesignator = runwayDesignator(reciprocalHeadingRad);
  const halfLenM = r.lengthM / 2;
  // forwardWorld(heading) per 00-architecture.md section 3.1.
  const fwdX = Math.sin(r.headingRad);
  const fwdZ = -Math.cos(r.headingRad);
  const primary: RunwayDef = {
    id: primaryDesignator,
    thresholdWorldX: r.centerXM - fwdX * halfLenM,
    thresholdWorldZ: r.centerZM - fwdZ * halfLenM,
    elevationM: r.elevationM,
    headingRad: r.headingRad,
    lengthM: r.lengthM,
    widthM: r.widthM,
    surface: RunwaySurface.Asphalt,
    reciprocalId: reciprocalDesignator,
  };
  const reciprocal: RunwayDef = {
    id: reciprocalDesignator,
    thresholdWorldX: r.centerXM + fwdX * halfLenM,
    thresholdWorldZ: r.centerZM + fwdZ * halfLenM,
    elevationM: r.elevationM,
    headingRad: reciprocalHeadingRad,
    lengthM: r.lengthM,
    widthM: r.widthM,
    surface: RunwaySurface.Asphalt,
    reciprocalId: primaryDesignator,
  };
  if (r.ilsPrimary) primary.ils = { frequencyMhz: r.ilsPrimary.frequencyMhz, glideslopeAngleRad: r.ilsPrimary.glideslopeAngleRad };
  if (r.ilsReciprocal) reciprocal.ils = { frequencyMhz: r.ilsReciprocal.frequencyMhz, glideslopeAngleRad: r.ilsReciprocal.glideslopeAngleRad };
  return [primary, reciprocal];
}

function editorLayoutToAirportLayout(editor: EditorAirportLayout): AirportLayout {
  const flattenZones: AirportFlattenZone[] = computeFlattenZones(editor).map((z) => ({ ...z }));
  const runways: RunwayDef[] = [];
  for (const r of editor.runways) runways.push(...editorRunwayToAirportRunways(r));
  const taxiways: TaxiwayDef[] = editor.taxiways.map((t) => ({
    id: t.id,
    widthM: t.widthM,
    points: t.points.map((p) => ({ worldX: p.xM, worldZ: p.zM })),
  }));
  const aprons: ApronDef[] = editor.aprons.map((a) => ({
    id: a.id,
    elevationM: editor.elevationM,
    points: a.points.map((p) => ({ worldX: p.xM, worldZ: p.zM })),
  }));
  return {
    id: editor.id,
    name: editor.name,
    referenceWorldX: editor.referenceXM,
    referenceWorldZ: editor.referenceZM,
    elevationM: editor.elevationM,
    flattenZones,
    runways,
    taxiways,
    aprons,
    parkingSpots: [],
  };
}

/** Builds a one-off free-flight Mission from an edited airport layout, or `undefined` (logging why, never throwing — this project's standard bad-data convention) if the layout has no runway to spawn the player on. */
function buildTestFlightMission(editorLayout: EditorAirportLayout): Mission | undefined {
  const rawLayout = editorLayoutToAirportLayout(editorLayout);
  const validated = validateAirportLayout(rawLayout);
  const layout = validated.ok ? validated.value.layout : rawLayout;
  if (!validated.ok) {
    console.warn('Airport editor Test Fly: edited layout has validation errors, launching best-effort anyway', validated.error);
  }
  const firstRunway = layout.runways[0];
  if (!firstRunway) {
    console.warn('Airport editor Test Fly: edited layout has no runways — cannot spawn the player.');
    return undefined;
  }
  const missionSeed = subSeed(1, 'editor:' + layout.id);
  return {
    id: 'editor-test-fly',
    name: `Test Fly — ${layout.name}`,
    world: {
      seed: missionSeed,
      terrain: { ...DEFAULT_TERRAIN_PARAMS, seed: missionSeed } as TerrainParams,
      airports: [layout],
    },
    playerStart: { airportId: layout.id, runwayId: firstRunway.id, speedMps: 0 },
    aiFlights: [],
    weather: { windWorldMps: { x: 0, y: 0, z: 0 }, gustMps: 1, turbulence: 0.05 },
    objectives: [
      {
        id: 'obj-test-fly',
        kind: MissionObjectiveKind.SurviveTime,
        description: 'Test flight — fly the edited layout.',
        params: { seconds: 3600 },
      },
    ],
  };
}

function destroyCurrentScreen(): void {
  currentScreen?.destroy();
  currentScreen = undefined;
}

function showMainMenu(): void {
  destroyCurrentScreen();
  appState = 'mainMenu';
  currentScreen = createMainMenu(uiRoot, {
    onPlay: showMissionSelect,
    onAirportEditor: () => {
      // Lazily imported so the editor's own code/deps are not part of the
      // main-menu-critical bundle. onLaunchMission ('Test Fly') builds a
      // real AirportLayout from the edited layout and boots a mission from
      // it — see buildTestFlightMission above.
      destroyCurrentScreen();
      appState = 'airportEditor';
      void import('./ui').then(({ createAirportEditor }) => {
        currentScreen = createAirportEditor(
          uiRoot,
          {},
          {
            onExit: showMainMenu,
            onLaunchMission: (layout) => {
              const mission = buildTestFlightMission(layout);
              if (!mission) {
                showMainMenu();
                return;
              }
              launchMission(mission);
            },
          }
        );
      });
    },
    onSettings: showSettingsOverlay,
  });
}

const MISSION_SUMMARIES: readonly MissionSummary[] = [
  { id: 'konkan-free', name: 'Free Flight — Goa Coast', description: 'INS Hansa on the Konkan coast. Mostly Arabian Sea, with the Western Ghats inland. Water is not a runway.', aircraftLabel: 'HAL Tejas Mk1' },
  { id: 'konkan-dogfight', name: '1v1 Dogfight — Arabian Sea', description: 'One hostile Tejas off the Goa coast.', aircraftLabel: 'HAL Tejas Mk1' },
  { id: 'punjab-free', name: 'Free Flight — Punjab Plains', description: 'Adampur, over flat farmland crossed by the Sutlej and Beas.', aircraftLabel: 'HAL Tejas Mk1' },
  { id: 'punjab-dogfight', name: '1v1 Dogfight — Punjab Plains', description: 'One hostile Tejas low over the plains.', aircraftLabel: 'HAL Tejas Mk1' },
  { id: 'ladakh-free', name: 'Free Flight — Leh, Ladakh', description: 'Leh at 3,256 m in the Indus valley, 6,000 m ridges around it. Thin air: expect a long takeoff roll.', aircraftLabel: 'HAL Tejas Mk1' },
  { id: 'ladakh-dogfight', name: '1v1 Dogfight — Ladakh', description: 'One hostile Tejas above the Himalayan ridges.', aircraftLabel: 'HAL Tejas Mk1' },
  { id: 'free-flight', name: 'Free Flight — Konarak Coastal', description: 'Unopposed circuit and landing practice (original test terrain).', aircraftLabel: 'HAL Tejas Mk1' },
  { id: 'dogfight-1v1', name: '1v1 Dogfight — Rangpur Highlands', description: 'One hostile Tejas over mountainous terrain (original test terrain).', aircraftLabel: 'HAL Tejas Mk1' },
];

function showMissionSelect(): void {
  destroyCurrentScreen();
  appState = 'missionSelect';
  const options: MissionSelectOptions = { missions: MISSION_SUMMARIES, defaultDifficulty: currentDifficulty };
  currentScreen = createMissionSelect(uiRoot, options, {
    onLaunch: (missionId, difficulty) => {
      currentDifficulty = difficulty;
      const mission = resolveBuiltinMission(isBuiltinMissionId(missionId) ? missionId : 'free-flight');
      launchMission(mission);
    },
    onBack: showMainMenu,
  });
}

// Previously main.ts passed `keyBindings: []` and no-op rebind callbacks here, so the settings
// screen always showed '—' for every action (throttle genuinely worked — it just had no way to
// be seen) and "Rebind" silently did nothing. See
// src/core/inputBindingsAdapter.ts's header for the full module-09/module-11 naming-mismatch
// story this wiring has to bridge, including the one keyboard-axis-capture limitation it
// inherits (and refuses to silently mis-apply) from module 09.
//
// REBIND_TIMEOUT_MS below must match settings.ts's own (private) REBIND_TIMEOUT_MS: that module
// reverts a row's "press any key…" display after 5s but has no way to tell US a capture timed
// out (its timeout is purely visual), so this file runs its own matching timer to cancel the
// REAL pending capture on inputSystem — without this, a capture nobody completed would leave
// PlayerInputSystem stuck skipping normal input assembly (see startRebind's doc comment: while a
// rebind is pending, update() only runs capture logic) even after the player leaves Settings.
const SETTINGS_REBIND_TIMEOUT_MS = 5000;
let settingsRebindTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
let settingsRebindUnsubscribe: (() => void) | undefined;
let settingsPendingAction: BindableAction | undefined;

function clearSettingsRebindTimeout(): void {
  if (settingsRebindTimeoutHandle !== undefined) {
    clearTimeout(settingsRebindTimeoutHandle);
    settingsRebindTimeoutHandle = undefined;
  }
}

/** Cancels any in-flight rebind capture and drops the subscription. Safe to call when nothing is pending. */
function closeSettingsRebindState(): void {
  clearSettingsRebindTimeout();
  settingsPendingAction = undefined;
  if (inputSystem && inputSystem.isRebinding()) inputSystem.cancelRebind();
  settingsRebindUnsubscribe?.();
  settingsRebindUnsubscribe = undefined;
}

function showSettingsOverlay(): void {
  const initial: SettingsState = {
    qualityOverride: (loadPersistedSettings()?.qualityTierOverride ?? 'auto') as QualityTier | 'auto',
    detectedTier: currentQualityTier,
    keyBindings: inputSystem ? buildKeyBindingsFromInputMap(inputSystem.inputMap.data) : [],
    mouseSensitivityMultiplier: 1,
    invertPitch: false,
    speedUnit: currentSpeedUnit,
    alphaLimiterEnabled: inputSystem ? !inputSystem.isAlphaLimiterDisabled() : true,
  };
  const handle: SettingsScreenHandle = createSettingsScreen(uiRoot, initial, {
    onChange: (next) => {
      savePersistedSettings({
        qualityTierOverride: next.qualityOverride,
        version: 1,
        speedUnit: next.speedUnit,
        alphaLimiterEnabled: next.alphaLimiterEnabled,
      });
      if (next.qualityOverride !== 'auto') {
        currentQualityTier = next.qualityOverride;
        renderer?.setQualityTier(currentQualityTier);
        hud?.setQualityTier(currentQualityTier);
      }
      currentSpeedUnit = next.speedUnit;
      hud?.setSpeedUnit(currentSpeedUnit);
      inputSystem?.setAlphaLimiterDisabled(!next.alphaLimiterEnabled);
    },
    onRebindStart: (action) => {
      if (!inputSystem) return;
      closeSettingsRebindState();
      if (isAxisRebindMiscapturePositive(action)) {
        // Refuse rather than mis-rebind: module 09's keyboard axis capture always writes the
        // NEGATIVE key of the pair (see inputBindingsAdapter.ts), so rebinding e.g. "throttleUp"
        // would silently overwrite "throttleDown"'s key instead. settings.ts's own 5s
        // capture-timeout reverts the row's "press any key…" display on its own since we never
        // start a real capture for it.
        return;
      }
      settingsPendingAction = action;
      const target = targetForBindableAction(action);
      inputSystem.startRebind(target.rebindAction, RebindDeviceKind.Keyboard);
      settingsRebindTimeoutHandle = setTimeout(() => {
        settingsRebindTimeoutHandle = undefined;
        inputSystem.cancelRebind();
      }, SETTINGS_REBIND_TIMEOUT_MS);
    },
    onResetDefaults: () => {
      closeSettingsRebindState();
      if (!inputSystem) return;
      inputSystem.resetInputMapToDefaults();
      inputSystem.saveInputMap();
      handle.destroy();
      showSettingsOverlay(); // simplest correct refresh: rebuild the whole screen from the now-reset live data
    },
    onBack: () => {
      closeSettingsRebindState();
      handle.destroy();
    },
  });

  if (inputSystem) {
    settingsRebindUnsubscribe = inputSystem.onRebindComplete((result) => {
      clearSettingsRebindTimeout();
      const action = settingsPendingAction;
      settingsPendingAction = undefined;
      if (result.cancelled || result.binding === undefined || action === undefined) return;
      // Keyboard-only UI: onRebindStart above only ever requests RebindDeviceKind.Keyboard, so
      // `binding` here is always a KeyboardCode string, never a GamepadButtonBinding/AxisBinding.
      handle.setCapturedKey(action, String(result.binding));
    });
  }
}

function showPauseMenu(): void {
  destroyCurrentScreen();
  appState = 'paused';
  simWorker.postMessage({ type: 'command', command: { kind: 'pause', paused: true } } satisfies SimCommandMessage);
  currentScreen = createPauseMenu(uiRoot, {
    onResume: () => {
      destroyCurrentScreen();
      appState = 'gameplay';
      simWorker.postMessage({ type: 'command', command: { kind: 'pause', paused: false } } satisfies SimCommandMessage);
    },
    onRestart: () => {
      if (currentMission) launchMission(currentMission);
    },
    onQuitToMenu: showMainMenu,
    onOpenSettings: showSettingsOverlay,
  });
}

function showDebrief(ended: MissionEndedEvent): void {
  destroyCurrentScreen();
  appState = 'debrief';
  const stats: DebriefStats = {
    missionId: currentMission?.id ?? '',
    outcome: ended.outcome === 'success' ? MissionOutcome.Success : ended.outcome === 'failure' ? MissionOutcome.Failure : MissionOutcome.Aborted,
    durationSec: Math.max(0, latestSimTimeSec - sessionStartSimTimeSec),
    kills: statKills,
    deaths: statDeaths,
    shotsFiredGun: statShotsFiredGun,
    shotsHitGun: statShotsHitGun,
    missilesFired: statMissilesFired,
    missilesHit: statMissilesHit,
    objectivesCompleted: ended.objectivesCompleted,
    objectivesTotal: ended.objectivesTotal,
  };
  currentScreen = createDebriefScreen(uiRoot, stats, {
    onReplay: () => {
      if (currentMission) launchMission(currentMission);
    },
    onMissionSelect: showMissionSelect,
    onMainMenu: showMainMenu,
  });
}

// -----------------------------------------------------------------------------
// Worker + renderer + input construction (10-core-worker.md section 4.10.3).
// -----------------------------------------------------------------------------

async function initWorkersAndRenderer(qualityTier: QualityTier): Promise<void> {
  renderer = createSceneRenderer(renderCanvas, qualityTier);
  hud = createHudRenderer(hudCanvas, qualityTier);
  inputSystem = createPlayerInputSystem({ window, touchOverlayContainer: uiRoot });

  // Debug-only control-surface overlay toggle (F9 — not part of the rebindable BindableAction
  // set, deliberately: this is an FCS dev/debug aid, not a gameplay control, so it bypasses
  // src/input's whole rebind system rather than adding a permanent player-facing binding for it.
  // See src/hud/controlSurfaceDebug.ts.
  let debugSurfacesOn = false;
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code !== 'F9') return;
    debugSurfacesOn = !debugSurfacesOn;
    hud.setDebugSurfacesEnabled(debugSurfacesOn);
  });
  renderer.registerAircraftModel(tejasDefinition.wireframe);
  renderer.setSunDirection({ x: 0.4, y: 0.7, z: -0.3 });

  // Single terrain-worker message router for the whole session. `chunkManager`
  // is reassigned per mission load (launchMission, below) but this handler
  // always reads the CURRENT value, so it needs wiring only once.
  terrainWorker.onmessage = (e: MessageEvent<TerrainToMainMessage | TerrainToMainMessageExt>): void => {
    if (e.data.type === 'terrainReady') {
      terrainReady = true;
      for (const m of pendingTerrainMsgs.splice(0)) terrainWorker.postMessage(m);
      // Deliberately no `return` here (see this file's own git history for the bug this fixes):
      // this branch used to swallow the terrainReady message entirely, so ChunkManager's own
      // internal `ready` flag (set only inside its handleTerrainWorkerMessage, which gates its
      // trySendRequests -- see src/terrain/chunkManager.ts) NEVER got set. That meant
      // ChunkManager never sent a single requestChunk message, for the entire life of the
      // session, no matter how long you waited -- terrain simply never streamed in. This queue
      // (terrainReady/pendingTerrainMsgs) and ChunkManager's own readiness gate were two
      // independently-built mechanisms for the same handshake that were never actually
      // connected. Falling through here lets ChunkManager also learn the worker is ready.
    }
    chunkManager?.handleTerrainWorkerMessage(e.data);
  };

  simWorker.onmessage = (e: MessageEvent<SimToMainMessage>): void => {
    const msg = e.data;
    if (msg.type === 'ready') return;
    if (msg.type === 'snapshot') {
      const view = new Float64Array((msg as SimSnapshotMessage).buffer);
      const header = readSnapshotHeader(view);
      latestSimTimeSec = header.simTimeSec;
      if (playerEntityId === NO_ENTITY_ID && header.playerIndex >= 0) {
        const ev = readSnapshotEntity(view, header.playerIndex, entityViewScratch);
        playerEntityId = ev.id;
      }
      renderer.ingestSnapshot(view);
      hud.ingestSnapshot(view);
      simWorker.postMessage({ type: 'releaseBuffer', buffer: (msg as SimSnapshotMessage).buffer } satisfies SimReleaseBufferMessage, [(msg as SimSnapshotMessage).buffer]);
      return;
    }
    if (msg.type === 'events') {
      const eventsMsg = msg as SimEventsMessage;
      renderer.ingestEvents(eventsMsg.events);
      hud.ingestEvents(eventsMsg.events);
      for (const ev of eventsMsg.events) {
        if (ev.type === 'gunFire') statShotsFiredGun += 1;
        else if (ev.type === 'missileLaunch') statMissilesFired += 1;
        else if (ev.type === 'hit') {
          if (ev.weapon === 'gun') statShotsHitGun += 1;
          else statMissilesHit += 1;
        } else if (ev.type === 'kill') {
          if (ev.sourceId === playerEntityId) statKills += 1;
          if (ev.targetId === playerEntityId) statDeaths += 1;
        }
      }
      const missionEnded = eventsMsg.events.find((x): x is MissionEndedEvent => x.type === 'missionEnded');
      if (missionEnded) showDebrief(missionEnded);
    }
  };
}

// -----------------------------------------------------------------------------
// Per-mission terrain/navdb wiring (main thread's OWN copy — mirrors
// src/core/wireDependencies.ts's cast-from-Mission.world approach, since the
// sim worker's HeightSampler/AirportNavDb instances cannot cross the
// postMessage boundary — see 00-architecture.md section 7).
//
// `sendToTerrainWorker` queues everything except `terrainInit` until the
// worker confirms readiness (00-architecture.md section 5's handshake); a
// mission switch resets `terrainReady` so the SAME gate applies again for
// the new mission's own `terrainInit`, not just the session's first one.
// -----------------------------------------------------------------------------

let terrainReady = false;
const pendingTerrainMsgs: (MainToTerrainMessage | MainToTerrainMessageExt)[] = [];

function sendToTerrainWorker(msg: MainToTerrainMessage | MainToTerrainMessageExt): void {
  if (!terrainReady && msg.type !== 'terrainInit') {
    pendingTerrainMsgs.push(msg);
    return;
  }
  terrainWorker.postMessage(msg);
}

/** The theatre look for the renderer: ground style and water from the terrain, runways from the layouts. */
function buildSceneEnvironment(terrainParams: TerrainParams, airportLayouts: readonly AirportLayout[]): SceneEnvironment {
  const runways: SceneEnvironment['runways'][number][] = [];
  for (const layout of airportLayouts) {
    for (const r of layout.runways) {
      // Each physical runway appears twice (once per direction); keep the lower designator only.
      if (r.reciprocalId !== undefined && r.reciprocalId < r.id) continue;
      runways.push({
        centerX: r.thresholdWorldX + (Math.sin(r.headingRad) * r.lengthM) / 2,
        centerZ: r.thresholdWorldZ - (Math.cos(r.headingRad) * r.lengthM) / 2,
        headingRad: r.headingRad,
        lengthM: r.lengthM,
        widthM: r.widthM,
      });
    }
  }
  return {
    surfaceStyle: terrainParams.surfaceStyle ?? 'default',
    ...(terrainParams.waterLevelM !== undefined ? { waterLevelM: terrainParams.waterLevelM } : {}),
    runways,
  };
}

function launchMission(mission: Mission): void {
  destroyCurrentScreen();
  appState = 'loading';
  const loading = createLoadingScreen(uiRoot);
  currentScreen = loading;
  loading.setProgress(0, 'Loading mission…');

  currentMission = mission;
  playerEntityId = NO_ENTITY_ID;
  statKills = 0;
  statDeaths = 0;
  statShotsFiredGun = 0;
  statShotsHitGun = 0;
  statMissilesFired = 0;
  statMissilesHit = 0;
  sessionStartSimTimeSec = latestSimTimeSec;

  const terrainParams = mission.world.terrain as TerrainParams;
  const airportLayouts = mission.world.airports as readonly AirportLayout[];
  const flattenZones: readonly AirportFlattenZone[] = airportLayouts.flatMap((a) => a.flattenZones);
  const navDb = createAirportNavDb(airportLayouts);
  renderer.setNavDb(navDb);
  renderer.setEnvironment(buildSceneEnvironment(terrainParams, airportLayouts));

  terrainReady = false;
  pendingTerrainMsgs.length = 0;
  chunkManager?.dispose();
  // createChunkManager itself sends the TerrainInitMessage at construction
  // (src/terrain/chunkManager.ts) — no separate explicit send needed here.
  chunkManager = createChunkManager({ qualityTier: currentQualityTier, terrainParams, flattenZones }, sendToTerrainWorker);
  chunkManager.onChunkReady((chunk) =>
    renderer.ingestTerrainChunk({
      type: 'chunkReady',
      requestId: -1,
      chunkX: chunk.key.cx,
      chunkZ: chunk.key.cz,
      lod: chunk.key.depth,
      positions: chunk.geometry.positions.buffer as ArrayBuffer,
      normals: chunk.geometry.normals.buffer as ArrayBuffer,
      indices: chunk.geometry.indices.buffer as ArrayBuffer,
    })
  );
  chunkManager.onChunkEvicted((key) => renderer.evictTerrainChunk(key.cx, key.cz, key.depth));

  hud.setWeaponLoadout(220, 4, 4);

  loading.setProgress(0.5, 'Starting simulation…');
  simWorker.postMessage({ type: 'init', mission, qualityTier: currentQualityTier } satisfies SimInitMessage);

  const onReady = (e: MessageEvent<SimToMainMessage>): void => {
    if (e.data.type === 'ready') {
      simWorker.removeEventListener('message', onReady as EventListener);
      loading.setProgress(1, 'Ready');
      destroyCurrentScreen();
      appState = 'gameplay';
    }
  };
  simWorker.addEventListener('message', onReady as EventListener);
}

// -----------------------------------------------------------------------------
// Boot sequence (10-core-worker.md section 4.10.2).
// -----------------------------------------------------------------------------

async function boot(): Promise<void> {
  uiRoot = document.getElementById('ui-root') as HTMLElement;
  renderCanvas = document.getElementById('render-canvas') as HTMLCanvasElement;
  hudCanvas = document.getElementById('hud-canvas') as HTMLCanvasElement;

  const loading = createLoadingScreen(uiRoot);
  currentScreen = loading;
  loading.setProgress(0, 'Detecting quality tier…');

  const persisted = loadPersistedSettings();
  if (persisted && persisted.qualityTierOverride !== 'auto') {
    currentQualityTier = persisted.qualityTierOverride;
  } else if (persisted && persisted.cachedAutoTier) {
    currentQualityTier = persisted.cachedAutoTier;
  } else {
    const benchCanvas = document.createElement('canvas');
    const report = await detectQualityTier(benchCanvas);
    currentQualityTier = report.tier;
    savePersistedSettings({ qualityTierOverride: 'auto', version: 1, cachedAutoTier: currentQualityTier });
  }
  currentSpeedUnit = persisted?.speedUnit ?? SpeedUnit.Mps;
  orientationPrompt = mountOrientationPrompt(uiRoot);

  loading.setProgress(0.3, 'Starting simulation…');
  await initWorkersAndRenderer(currentQualityTier);
  hud.setSpeedUnit(currentSpeedUnit);
  inputSystem.setAlphaLimiterDisabled((persisted?.alphaLimiterEnabled ?? true) === false);
  // Size renderer/HUD from the current window/DPR once, synchronously, right
  // now — before the first requestAnimationFrame(frame) callback draws
  // anything. onResize() is otherwise wired only as a 'resize' listener
  // (wireGlobalListeners, below), which on many mobile browsers never fires
  // after initial load; without this call the render/HUD canvases stay at
  // the HTML5 default backing-store size (300x150) for the whole session.
  onResize();
  loading.setProgress(1, 'Ready');
  destroyCurrentScreen();
  showMainMenu();
}

// -----------------------------------------------------------------------------
// Per-frame loop, resize, pause, meta actions (10-core-worker.md section
// 4.10.4).
// -----------------------------------------------------------------------------

const pilotInputsScratch: PilotInputs = {
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0,
  afterburner: false,
  brakes: 0,
  gearDown: true,
  airbrake: false,
  trigger: false,
  launch: false,
  cycleWeapon: false,
  cycleTarget: false,
  nwsEnabled: false,
};

let lastFrameMs = performance.now();
function frame(nowMs: number): void {
  const dtSec = Math.min((nowMs - lastFrameMs) / 1000, 0.25);
  lastFrameMs = nowMs;
  if (appState === 'gameplay' && renderer && hud && inputSystem) {
    inputSystem.update(undefined as never, dtSec, pilotInputsScratch);
    simWorker.postMessage({ type: 'input', entityId: playerEntityId, inputs: pilotInputsScratch } as const);
  }
  if (renderer && hud) {
    const camera: CameraState = renderer.renderFrame(nowMs);
    hud.renderFrame(nowMs, camera);
    chunkManager?.update(camera.worldPos, currentQualityTier);
  }
  requestAnimationFrame(frame);
}

function onResize(): void {
  if (!renderer || !hud) return;
  const dpr = window.devicePixelRatio || 1;
  renderer.resize(window.innerWidth, window.innerHeight, dpr);
  hud.resize(window.innerWidth, window.innerHeight, dpr);
}

function wireGlobalListeners(): void {
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', () => {
    const paused = document.visibilityState === 'hidden';
    simWorker.postMessage({ type: 'command', command: { kind: 'pause', paused } } satisfies SimCommandMessage);
  });
}

void orientationPrompt;

wireGlobalListeners();
requestAnimationFrame(frame);
boot().catch((err) => {
  // Boot failure has no recovery path in this v1 shell; surface it loudly
  // rather than leaving a permanently-blank loading screen.
  console.error('Tejas Sim failed to boot:', err);
});

// Meta actions (camera cycle / menu toggle) are wired once inputSystem
// exists; PlayerInputSystem.onMetaAction fires regardless of appState, so
// the handler itself gates on 'gameplay'/'paused'.
function wireMetaActionsOnce(): void {
  if (!inputSystem) {
    setTimeout(wireMetaActionsOnce, 50);
    return;
  }
  inputSystem.onMetaAction((action) => {
    if (action === 'menuToggle') {
      if (appState === 'gameplay') showPauseMenu();
      else if (appState === 'paused') {
        destroyCurrentScreen();
        appState = 'gameplay';
        simWorker.postMessage({ type: 'command', command: { kind: 'pause', paused: false } } satisfies SimCommandMessage);
      }
    } else if (action === 'cameraCycle' && appState === 'gameplay') {
      // SceneRenderer.setCameraMode cycling is a small local rotation this
      // shell owns directly (module 08 exposes the setter, not a cycle
      // helper).
      cycleCameraMode();
    }
  });
}
wireMetaActionsOnce();

const CAMERA_MODE_CYCLE = ['cockpit', 'chase', 'external', 'flyby'] as const;
let cameraModeIndex = 1;
function cycleCameraMode(): void {
  cameraModeIndex = (cameraModeIndex + 1) % CAMERA_MODE_CYCLE.length;
  renderer.setCameraMode(CAMERA_MODE_CYCLE[cameraModeIndex] as (typeof CAMERA_MODE_CYCLE)[number]);
}
