/**
 * src/main.ts — app entry point: creates both workers, wires
 * src/render/src/hud/src/input/src/ui, drives requestAnimationFrame, resize,
 * visibility pause. See 10-core-worker.md section 4.10 (this file has no
 * contract of its own — see 00-architecture.md section 12 step 4's flagged
 * exception — so it is written directly against the real, now-implemented
 * exports of modules 04/08/09/11 rather than a contracts/*.ts file).
 */

import { NO_ENTITY_ID } from './contracts/core';
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
import type { AirportLayout } from './contracts/airport';
import type { CameraState, HudRenderer, SceneRenderer } from './contracts/render';
import type { PlayerInputSystem } from './contracts/input';
import type {
  DebriefStats,
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
} from './ui';
import { createChunkManager } from './terrain';
import { createHeightSampler } from './terrain';
import { createAirportNavDb } from './airport';
import { tejasDefinition } from './aircraft';
import { resolveBuiltinMission } from './core/missions/index';
import { readSnapshotEntity, readSnapshotHeader } from './core/snapshotReader';

// -----------------------------------------------------------------------------
// Settings persistence (10-core-worker.md section 4.10.2).
// -----------------------------------------------------------------------------

interface PersistedSettings {
  qualityTierOverride: QualityTier | 'auto';
  version: 1;
}

function loadPersistedSettings(): PersistedSettings | undefined {
  try {
    const raw = localStorage.getItem('tejas.settings.v1');
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
    if (parsed.version !== 1 || typeof parsed.qualityTierOverride !== 'string') return undefined;
    return parsed as PersistedSettings;
  } catch {
    return undefined;
  }
}

function savePersistedSettings(s: PersistedSettings): void {
  try {
    localStorage.setItem('tejas.settings.v1', JSON.stringify(s));
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
      // Airport editor is out of this integration pass's critical path;
      // module 11's own screen is fully usable stand-alone. A minimal wiring
      // (mount + onExit back to main menu) is provided so the menu entry is
      // never dead.
      destroyCurrentScreen();
      appState = 'airportEditor';
      void import('./ui').then(({ createAirportEditor }) => {
        currentScreen = createAirportEditor(
          uiRoot,
          {},
          {
            onExit: showMainMenu,
            onLaunchMission: () => showMainMenu(),
          }
        );
      });
    },
    onSettings: showSettingsOverlay,
  });
}

const MISSION_SUMMARIES: readonly MissionSummary[] = [
  { id: 'free-flight', name: 'Free Flight — Konarak Coastal', description: 'Unopposed circuit and landing practice.', aircraftLabel: 'HAL Tejas Mk1' },
  { id: 'dogfight-1v1', name: '1v1 Dogfight — Rangpur Highlands', description: 'One hostile Tejas over mountainous terrain.', aircraftLabel: 'HAL Tejas Mk1' },
];

function showMissionSelect(): void {
  destroyCurrentScreen();
  appState = 'missionSelect';
  const options: MissionSelectOptions = { missions: MISSION_SUMMARIES, defaultDifficulty: currentDifficulty };
  currentScreen = createMissionSelect(uiRoot, options, {
    onLaunch: (missionId, difficulty) => {
      currentDifficulty = difficulty;
      const mission = resolveBuiltinMission(missionId === 'dogfight-1v1' ? 'dogfight-1v1' : 'free-flight');
      launchMission(mission);
    },
    onBack: showMainMenu,
  });
}

function showSettingsOverlay(): void {
  const initial: SettingsState = {
    qualityOverride: (loadPersistedSettings()?.qualityTierOverride ?? 'auto') as QualityTier | 'auto',
    detectedTier: currentQualityTier,
    keyBindings: [],
    mouseSensitivityMultiplier: 1,
    invertPitch: false,
  };
  const handle: SettingsScreenHandle = createSettingsScreen(uiRoot, initial, {
    onChange: (next) => {
      savePersistedSettings({ qualityTierOverride: next.qualityOverride, version: 1 });
      if (next.qualityOverride !== 'auto') {
        currentQualityTier = next.qualityOverride;
        renderer?.setQualityTier(currentQualityTier);
        hud?.setQualityTier(currentQualityTier);
      }
    },
    onRebindStart: () => {},
    onResetDefaults: () => {},
    onBack: () => handle.destroy(),
  });
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
  renderer.registerAircraftModel(tejasDefinition.wireframe);
  renderer.setSunDirection({ x: 0.4, y: 0.7, z: -0.3 });

  // Single terrain-worker message router for the whole session. `chunkManager`
  // is reassigned per mission load (launchMission, below) but this handler
  // always reads the CURRENT value, so it needs wiring only once.
  terrainWorker.onmessage = (e: MessageEvent<TerrainToMainMessage | TerrainToMainMessageExt>): void => {
    if (e.data.type === 'terrainReady') {
      terrainReady = true;
      for (const m of pendingTerrainMsgs.splice(0)) terrainWorker.postMessage(m);
      return;
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
  } else {
    const benchCanvas = document.createElement('canvas');
    const report = await detectQualityTier(benchCanvas);
    currentQualityTier = report.tier;
  }
  orientationPrompt = mountOrientationPrompt(uiRoot);

  loading.setProgress(0.3, 'Starting simulation…');
  await initWorkersAndRenderer(currentQualityTier);
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
