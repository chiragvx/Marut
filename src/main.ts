/// <reference types="vite/client" />
/**
 * src/main.ts — app entry point: creates both workers, wires
 * src/render/src/hud/src/input/src/ui, drives requestAnimationFrame, resize,
 * visibility pause. See 10-core-worker.md section 4.10 (this file has no
 * contract of its own — see 00-architecture.md section 12 step 4's flagged
 * exception — so it is written directly against the real, now-implemented
 * exports of modules 04/08/09/11 rather than a contracts/*.ts file).
 */

import { AutopilotFlag, EntityFlag, HUD_BLOCK_START, LIGHT_MODES, LockStateCode, NO_ENTITY_ID, ServiceStateCode, SnapshotHud, SpeedUnit, WarningBit, WeaponKindCode, WeatherMode, type AutopilotAction } from './contracts/core';
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
import type { CameraState, HudRenderer, SceneEnvironment, SceneRenderer, ShowcaseFrame } from './contracts/render';
import type { PlayerInputSystem } from './contracts/input';
import { RebindDeviceKind } from './contracts/input';
import type { BindableAction, DebriefStats, LoadingScreenHandle, OrientationPromptHandle, ScreenHandle, SettingsScreenHandle, SettingsState } from './contracts/ui';
import { MissionOutcome } from './contracts/ui';
import type { ChunkManager } from './contracts/terrain';
import type { SnapshotEntityView } from './contracts/sim';

import { createSceneRenderer } from './render';
import { createHudRenderer } from './hud';
import { buildHudAirbases } from './hud/airbaseMarkers';
import { createPlayerInputSystem } from './input';
import {
  createMainMenu,
  createSettingsScreen,
  createPauseMenu,
  createDebriefScreen,
  createLoadingScreen,
  mountOrientationPrompt,
  detectQualityTier,
  createFreeFlightSetup,
  createMissionList,
  createBriefing,
  createControlsScreen,
  createDeviceNotice,
  isTouchFirstDevice,
  registerServiceWorker,
  feedbackUrl,
  keyLabel,
  GAME_NAME,
  DEFAULT_FREE_FLIGHT,
  type FreeFlightSetup,
  type MissionProgress,
  type LoadoutSelection,
  type ControlGroup,
} from './ui';
import './ui/ui.css';
import { startAnalytics } from './ui/analytics';
import { approachScene, nightDepartureScene, taxiScene, type ShowcaseScene } from './ui/showcase';
import { createFlightOverlay, hintText, pickHint, type FlightOverlay, type HintId, type HintKeys } from './ui/flightOverlay';
import { DEFAULT_INPUT_MAP_DATA } from './input/inputMap';
import { BASES, MISSIONS, baseInfo, freeFlightMission, missionEntry, type BaseId } from './core/missions/catalogue';
import { createChunkManager } from './terrain';
import { buildCoastProfile, createHeightSampler } from './terrain';
import { RIVER_FLOATS, packRiver } from './terrain/riverMath';
import { ESTUARY_FLOATS, packEstuary } from './terrain/coastMath';
import { createAirportNavDb } from './airport';
import { buildPavementGeometry } from './airport/pavementGeometry';
import { buildAirfieldMask } from './airport/airfieldMask';
import { buildAirfieldAids } from './airport/airfieldAids';
import { activeRunway, buildTaxiGraph, routeToRunway, routeToStand, type TaxiGraph } from './airport/taxiGraph';
import { tejasDefinition } from './aircraft';
import { getAircraftDefinition } from './aircraft/registry';
import { resolveLoadout, type LoadoutFit } from './aircraft/loadout';
import { WEAPONS } from './catalog';
import { isBuiltinMissionId, resolveBuiltinMission, type BuiltinMissionId } from './core/missions/index';
import { readSnapshotEntity, readSnapshotHeader } from './core/snapshotReader';
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
  /** src/ui/settings.ts's old "Weather" on/off control. Optional so old saved data still parses; missing means on. */
  weatherEnabled?: boolean;
  /** src/ui/settings.ts's "Weather" choice; missing = 'clear' (or 'off' if weatherEnabled was false). */
  weatherMode?: WeatherMode;
  /** src/ui/settings.ts's "Time of day" (hours); missing = 10.5. */
  timeOfDayH?: number;
  /** Mouse sensitivity multiplier (Settings -> Controls); missing = 1. */
  mouseSensitivity?: number;
  /** First-flight hints in flight (Settings -> Gameplay); missing = on. */
  hintsEnabled?: boolean;
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
    if (parsed.weatherEnabled !== undefined && typeof parsed.weatherEnabled !== 'boolean') return undefined;
    if (parsed.weatherMode !== undefined && !(Object.values(WeatherMode) as string[]).includes(parsed.weatherMode)) delete parsed.weatherMode;
    if (parsed.timeOfDayH !== undefined && !(typeof parsed.timeOfDayH === 'number' && parsed.timeOfDayH >= 0 && parsed.timeOfDayH <= 24)) delete parsed.timeOfDayH;
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

type AppState = 'boot' | 'mainMenu' | 'missionSelect' | 'loading' | 'gameplay' | 'paused' | 'debrief';

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
/** Settings "Weather" choice; 'off' = clear sky and calm air. */
let weatherMode: WeatherMode = 'clear';
/** Settings "Time of day", hours. */
let timeOfDayH = 10.5;
/** Seeds dynamic weather: a new random sequence every mission. */
const newWeatherSeed = (): number => Math.floor(Math.random() * 4294967296) >>> 0;
/** First-flight hints (Settings -> Gameplay). */
let hintsEnabled = true;
/** Exterior light mode (LIGHT_MODES index), cycled with L; nav + strobes at the start of a flight. */
const DEFAULT_LIGHT_MODE = 2;
let lightMode = DEFAULT_LIGHT_MODE;
/** Objective tracker, event messages and hints over the HUD (src/ui/flightOverlay.ts). */
let flightOverlay: FlightOverlay | undefined;
let hintsDone = new Set<HintId>();
let playerMissilesFired = 0;
let banditsTotal = 0;
let lastWarningBits = 0;
let lastTankFuelKg = -1;
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

// -----------------------------------------------------------------------------
// Menus and flights: main menu -> Free Flight setup, or Missions -> briefing; loading (the
// flight waits, paused, for Start); flight; pause; debrief. Screen text lives in src/ui and
// src/core/missions/catalogue.ts.
// -----------------------------------------------------------------------------

/** What the player chose to fly; replayed by Restart, Fly again and Continue. */
type Flight = { kind: 'free'; setup: FreeFlightSetup } | { kind: 'mission'; id: BuiltinMissionId; difficulty: AiDifficulty; loadout: LoadoutSelection };
let currentFlight: Flight | undefined;

const STORAGE = {
  freeFlight: 'tejas.freeFlight.v1',
  progress: 'tejas.progress.v1',
  lastFlight: 'tejas.lastFlight.v1',
  missionPrefs: 'tejas.missionPrefs.v1',
} as const;

function loadJson<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}
function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable or full: the choice just isn't remembered.
  }
}

const isWeather = (w: unknown): w is WeatherMode => typeof w === 'string' && (Object.values(WeatherMode) as string[]).includes(w);

/** The saved Free Flight setup, with anything unknown replaced by the default. */
function savedFreeFlight(): FreeFlightSetup {
  const s = loadJson<Partial<FreeFlightSetup>>(STORAGE.freeFlight) ?? {};
  const d = DEFAULT_FREE_FLIGHT;
  return {
    baseId: BASES.some((b) => b.id === s.baseId) ? (s.baseId as BaseId) : d.baseId,
    start: s.start === 'parked' || s.start === 'runway' || s.start === 'air' ? s.start : d.start,
    timeOfDayH: typeof s.timeOfDayH === 'number' && s.timeOfDayH >= 0 && s.timeOfDayH <= 24 ? s.timeOfDayH : d.timeOfDayH,
    weather: isWeather(s.weather) && s.weather !== 'off' ? s.weather : d.weather,
    loadout: s.loadout && typeof s.loadout === 'object' ? s.loadout : d.loadout,
  };
}

function savedProgress(): Record<string, MissionProgress> {
  return loadJson<Record<string, MissionProgress>>(STORAGE.progress) ?? {};
}

function savedLastFlight(): Flight | undefined {
  const f = loadJson<Flight>(STORAGE.lastFlight);
  if (f?.kind === 'free' && f.setup) return { kind: 'free', setup: { ...savedFreeFlight(), ...f.setup } };
  if (f?.kind === 'mission' && missionEntry(f.id)) return f;
  return undefined;
}

function flightTitle(f: Flight): string {
  return f.kind === 'free' ? `Free Flight · ${baseInfo(f.setup.baseId).name}` : (missionEntry(f.id)?.title ?? 'Mission');
}

function qualityLabel(): string {
  const auto = (loadPersistedSettings()?.qualityTierOverride ?? 'auto') === 'auto';
  const t = currentQualityTier ?? 'medium';
  return `${t[0]!.toUpperCase()}${t.slice(1)}${auto ? ' (auto)' : ''}`;
}

const playerAircraft = tejasDefinition;

function showMainMenu(): void {
  destroyCurrentScreen();
  appState = 'mainMenu';
  startShowcase();
  const last = savedLastFlight();
  const progress = savedProgress();
  const fb = feedbackUrl({ screen: 'menu', quality: currentQualityTier });
  currentScreen = createMainMenu(
    uiRoot,
    {
      ...(last ? { continueLabel: flightTitle(last) } : {}),
      missionsDone: MISSIONS.filter((m) => progress[m.id]?.completed).length,
      missionsTotal: MISSIONS.length,
      qualityLabel: qualityLabel(),
      ...(fb ? { feedbackUrl: fb } : {}),
    },
    {
      ...(last ? { onContinue: () => launchFlight(last) } : {}),
      onFreeFlight: showFreeFlight,
      onMissions: showMissions,
      onSettings: showSettingsOverlay,
      onControls: showControlsOverlay,
    }
  );
}

function showFreeFlight(): void {
  destroyCurrentScreen();
  appState = 'mainMenu';
  currentScreen = createFreeFlightSetup(
    uiRoot,
    { bases: BASES, def: playerAircraft, setup: savedFreeFlight() },
    {
      onFly: (setup) => {
        saveJson(STORAGE.freeFlight, setup);
        launchFlight({ kind: 'free', setup });
      },
      onBack: showMainMenu,
    }
  );
}

function showMissions(): void {
  destroyCurrentScreen();
  appState = 'missionSelect';
  currentScreen = createMissionList(uiRoot, { missions: MISSIONS, bases: BASES, progress: savedProgress() }, { onSelect: showBriefing, onBack: showMainMenu });
}

function showBriefing(id: string): void {
  const index = MISSIONS.findIndex((m) => m.id === id);
  const entry = MISSIONS[index];
  if (!entry) return showMissions();
  destroyCurrentScreen();
  appState = 'missionSelect';
  const prefs = loadJson<{ difficulty?: AiDifficulty; loadout?: LoadoutSelection }>(STORAGE.missionPrefs) ?? {};
  const difficulty: AiDifficulty = prefs.difficulty === 'rookie' || prefs.difficulty === 'ace' ? prefs.difficulty : 'veteran';
  const b = inputSystem.inputMap.data.keyboard.buttons;
  currentScreen = createBriefing(
    uiRoot,
    {
      entry,
      base: baseInfo(entry.baseId),
      index,
      def: playerAircraft,
      difficulty,
      loadout: prefs.loadout ?? {},
      keys: { target: keyLabel(b.cycleTarget), launch: keyLabel(b.launch), weapon: keyLabel(b.cycleWeapon), gun: keyLabel(b.trigger) },
    },
    {
      onStart: (d, loadout) => {
        saveJson(STORAGE.missionPrefs, { difficulty: d, loadout });
        launchFlight({ kind: 'mission', id: entry.id, difficulty: d, loadout });
      },
      onBack: showMissions,
    }
  );
}

/** The key groups for the Controls screen, from the live key map. */
function controlGroups(): ControlGroup[] {
  const k = inputSystem.inputMap.data.keyboard;
  const a = k.axes;
  const b = k.buttons;
  const m = k.meta;
  const L = keyLabel;
  return [
    {
      title: 'Fly',
      rows: [
        { keys: [L(a.pitch.positive)], label: 'Nose up' },
        { keys: [L(a.pitch.negative)], label: 'Nose down' },
        { keys: [L(a.roll.negative), L(a.roll.positive)], label: 'Roll left / right' },
        { keys: [L(a.yaw.negative), L(a.yaw.positive)], label: 'Rudder / steer left, right' },
        { keys: [L(a.throttle.positive)], label: 'Throttle up' },
        { keys: [L(a.throttle.negative)], label: 'Throttle down' },
        { keys: [L(b.afterburner)], label: 'Afterburner (hold)' },
      ],
    },
    {
      title: 'Fight',
      rows: [
        { keys: [L(b.cycleTarget)], label: 'Next target' },
        { keys: [L(b.launch)], label: 'Fire missile (after LOCK)' },
        { keys: [L(b.cycleWeapon)], label: 'Next weapon' },
        { keys: [L(b.trigger)], label: 'Gun (hold)' },
        { keys: [L(b.radarMode)], label: 'Radar mode' },
        { keys: [L(m.radarRangeDown), L(m.radarRangeUp)], label: 'Radar range' },
      ],
    },
    {
      title: 'Aircraft',
      rows: [
        { keys: [L(b.gearToggle)], label: 'Landing gear' },
        { keys: [L(b.airbrakeToggle)], label: 'Airbrake and wheel brakes' },
        { keys: [L(b.jettisonTanks)], label: 'Drop tanks' },
        { keys: [L(b.service)], label: 'Refuel and rearm (stopped on a stand)' },
        { keys: [L(m.taxiGuide)], label: 'Taxi guidance' },
        { keys: [L(m.lightsCycle)], label: 'Lights: off, nav, strobes, landing, formation' },
      ],
    },
    {
      title: 'Autopilot',
      rows: [
        { keys: [L(m.apToggle)], label: 'Autopilot on / off' },
        { keys: [L(m.atToggle)], label: 'Autothrottle' },
        { keys: [L(m.apHdgDown), L(m.apHdgUp)], label: 'Heading' },
        { keys: [L(m.apAltDown), L(m.apAltUp)], label: 'Altitude' },
        { keys: [L(m.apVsDown), L(m.apVsUp)], label: 'Climb rate' },
        { keys: [L(m.apSpdDown), L(m.apSpdUp)], label: 'Speed' },
      ],
    },
    {
      title: 'View and menus',
      rows: [
        { keys: [L(m.cameraCycle)], label: 'Change camera' },
        { keys: ['Drag', 'Scroll'], label: 'Look around, zoom (the view returns behind the jet after 6 s)' },
        { keys: ['←', '↑', '↓', '→'], label: 'Look around' },
        { keys: ['Esc'], label: 'Pause' },
        { keys: ['F1'], label: 'This screen (in flight)' },
      ],
    },
  ];
}

/** Controls, over whatever screen is showing (main menu or pause); Back returns to it. */
function showControlsOverlay(): void {
  const handle = createControlsScreen(uiRoot, controlGroups(), { onBack: () => handle.destroy() });
}

/** Mouse flying from the settings, into the live key map (saved with it). */
function applyMouseSettings(enabled: boolean, sensitivity: number, invert: boolean): void {
  const mouse = inputSystem.inputMap.data.mouse;
  mouse.enabled = enabled;
  mouse.sensitivityPerPx = DEFAULT_INPUT_MAP_DATA.mouse.sensitivityPerPx * sensitivity;
  mouse.invertPitch = invert;
  inputSystem.saveInputMap();
}

/** A preset or custom fit onto the mission's player start. */
function withLoadout(m: Mission, sel: LoadoutSelection): Mission {
  const { loadout: _l, loadoutId: _id, ...rest } = m.playerStart;
  void _l;
  void _id;
  const playerStart = { ...rest, ...(sel.fit ? { loadout: sel.fit } : sel.presetId ? { loadoutId: sel.presetId } : {}) };
  return { ...m, playerStart };
}

function launchFlight(flight: Flight): void {
  currentFlight = flight;
  saveJson(STORAGE.lastFlight, flight);
  if (flight.kind === 'free') {
    const s = flight.setup;
    weatherMode = s.weather;
    timeOfDayH = s.timeOfDayH;
    renderer.setTimeOfDay(timeOfDayH);
    launchMission(withLoadout(freeFlightMission(s.baseId, s.start), s.loadout), { title: flightTitle(flight), airStart: s.start === 'air' });
    return;
  }
  const base = resolveBuiltinMission(flight.id);
  weatherMode = 'clear';
  timeOfDayH = 10.5;
  renderer.setTimeOfDay(timeOfDayH);
  const mission: Mission = { ...base, aiFlights: base.aiFlights.map((f) => ({ ...f, difficulty: flight.difficulty })) };
  launchMission(withLoadout(mission, flight.loadout), { title: flightTitle(flight), airStart: false });
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
  const persisted = loadPersistedSettings();
  const mouse = inputSystem?.inputMap.data.mouse;
  const initial: SettingsState = {
    qualityOverride: (persisted?.qualityTierOverride ?? 'auto') as QualityTier | 'auto',
    detectedTier: persisted?.cachedAutoTier ?? currentQualityTier,
    keyBindings: inputSystem ? buildKeyBindingsFromInputMap(inputSystem.inputMap.data) : [],
    mouseSensitivityMultiplier: persisted?.mouseSensitivity ?? 1,
    invertPitch: mouse?.invertPitch ?? false,
    mouseEnabled: mouse?.enabled ?? false,
    speedUnit: currentSpeedUnit,
    alphaLimiterEnabled: inputSystem ? !inputSystem.isAlphaLimiterDisabled() : true,
    hintsEnabled: persisted?.hintsEnabled ?? true,
  };
  const handle: SettingsScreenHandle = createSettingsScreen(uiRoot, initial, {
    onChange: (next) => {
      savePersistedSettings({
        qualityTierOverride: next.qualityOverride,
        version: 1,
        speedUnit: next.speedUnit,
        alphaLimiterEnabled: next.alphaLimiterEnabled,
        mouseSensitivity: next.mouseSensitivityMultiplier,
        hintsEnabled: next.hintsEnabled ?? true,
      });
      const tier = next.qualityOverride === 'auto' ? (loadPersistedSettings()?.cachedAutoTier ?? currentQualityTier) : next.qualityOverride;
      if (tier !== currentQualityTier) {
        currentQualityTier = tier;
        renderer?.setQualityTier(currentQualityTier);
        hud?.setQualityTier(currentQualityTier);
      }
      currentSpeedUnit = next.speedUnit;
      hud?.setSpeedUnit(currentSpeedUnit);
      inputSystem?.setAlphaLimiterDisabled(!next.alphaLimiterEnabled);
      if (inputSystem) applyMouseSettings(next.mouseEnabled ?? false, next.mouseSensitivityMultiplier, next.invertPitch);
      hintsEnabled = next.hintsEnabled ?? true;
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
      const mouseNow = { ...inputSystem.inputMap.data.mouse };
      inputSystem.resetInputMapToDefaults();
      // "Reset keys" resets the keys; the mouse choices stay.
      applyMouseSettings(mouseNow.enabled, loadPersistedSettings()?.mouseSensitivity ?? 1, mouseNow.invertPitch ?? false);
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

function resumeFlight(): void {
  destroyCurrentScreen();
  appState = 'gameplay';
  simWorker.postMessage({ type: 'command', command: { kind: 'pause', paused: false } } satisfies SimCommandMessage);
}

function showPauseMenu(): void {
  if (appState !== 'gameplay') return;
  destroyCurrentScreen();
  appState = 'paused';
  simWorker.postMessage({ type: 'command', command: { kind: 'pause', paused: true } } satisfies SimCommandMessage);
  const fb = feedbackUrl({ screen: 'pause', ...(currentMission ? { missionId: currentMission.id } : {}), quality: currentQualityTier });
  currentScreen = createPauseMenu(
    uiRoot,
    {
      onResume: resumeFlight,
      onRestart: () => {
        if (currentFlight) launchFlight(currentFlight);
        else if (currentMission) launchMission(currentMission, { title: currentMission.name, airStart: false });
      },
      onQuitToMenu: showMainMenu,
      onOpenSettings: showSettingsOverlay,
      onControls: showControlsOverlay,
    },
    { ...(currentFlight ? { subtitle: flightTitle(currentFlight) } : {}), ...(fb ? { feedbackUrl: fb } : {}) }
  );
}

function showDebrief(ended: MissionEndedEvent): void {
  destroyCurrentScreen();
  appState = 'debrief';
  simWorker.postMessage({ type: 'command', command: { kind: 'pause', paused: true } } satisfies SimCommandMessage);
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
  const flight = currentFlight;
  const entry = flight?.kind === 'mission' ? missionEntry(flight.id) : undefined;
  let newBest = false;
  if (entry && stats.outcome === MissionOutcome.Success) {
    const progress = savedProgress();
    const prev = progress[entry.id];
    newBest = prev?.bestSec === undefined || stats.durationSec < prev.bestSec;
    progress[entry.id] = { completed: true, bestSec: newBest ? stats.durationSec : prev!.bestSec! };
    saveJson(STORAGE.progress, progress);
  }
  const nextEntry = entry ? MISSIONS[MISSIONS.indexOf(entry) + 1] : undefined;
  const fb = feedbackUrl({ screen: 'debrief', missionId: stats.missionId, quality: currentQualityTier });
  currentScreen = createDebriefScreen(
    uiRoot,
    stats,
    {
      onReplay: () => {
        if (flight) launchFlight(flight);
        else if (currentMission) launchMission(currentMission, { title: currentMission.name, airStart: false });
      },
      onMissionSelect: showMissions,
      onMainMenu: showMainMenu,
      ...(nextEntry && stats.outcome === MissionOutcome.Success ? { onNext: () => showBriefing(nextEntry.id) } : {}),
    },
    {
      ...(flight ? { title: flightTitle(flight) } : {}),
      freeFlight: flight?.kind === 'free',
      newBest,
      ...(entry ? { objectiveText: entry.objective } : {}),
      ...(fb ? { feedbackUrl: fb } : {}),
    }
  );
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
  renderer.setTimeOfDay(timeOfDayH);
  renderer.setWeather(weatherMode, newWeatherSeed());

  // Single terrain-worker message router for the whole session. `chunkManager`
  // is reassigned per mission load (launchMission, below) but this handler
  // always reads the CURRENT value, so it needs wiring only once.
  terrainWorker.onmessage = (e: MessageEvent<TerrainToMainMessage | TerrainToMainMessageExt>): void => {
    if (e.data.type === 'terrainReady') {
      terrainReady = true;
      renderer.setSettlements(e.data.settlements ?? null);
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
      if (header.playerIndex >= 0) {
        const ev = readSnapshotEntity(view, header.playerIndex, entityViewScratch);
        if (playerEntityId === NO_ENTITY_ID) playerEntityId = ev.id;
        lastPlayer.x = ev.pos.x;
        lastPlayer.z = ev.pos.z;
        lastPlayer.speedMps = Math.hypot(ev.vel.x, ev.vel.y, ev.vel.z);
        lastPlayer.onGround = (ev.flags & EntityFlag.OnGround) !== 0;
        lastPlayer.valid = true;
      }
      // A completed ground service re-arms: reset the HUD's locally counted ammunition.
      const service = view[HUD_BLOCK_START + SnapshotHud.SERVICE_STATE] ?? 0;
      if (service === ServiceStateCode.Complete && lastServiceState !== ServiceStateCode.Complete) setPlayerFullLoad();
      const serviceWas = lastServiceState;
      lastServiceState = service;
      // The autothrottle drives the throttle lever (so taking over, or disengaging, never jumps).
      if (((view[HUD_BLOCK_START + SnapshotHud.AP_FLAGS] ?? 0) & AutopilotFlag.Autothrottle) !== 0) inputSystem?.setThrottle(view[HUD_BLOCK_START + SnapshotHud.AP_THROTTLE] ?? 0);
      if (service === ServiceStateCode.Complete && serviceWas !== ServiceStateCode.Complete && appState === 'gameplay') flightOverlay?.message('Refuelled and rearmed');
      renderer.ingestSnapshot(view);
      hud.ingestSnapshot(view);
      updateFlightOverlay(view);
      simWorker.postMessage({ type: 'releaseBuffer', buffer: (msg as SimSnapshotMessage).buffer } satisfies SimReleaseBufferMessage, [(msg as SimSnapshotMessage).buffer]);
      return;
    }
    if (msg.type === 'events') {
      const eventsMsg = msg as SimEventsMessage;
      renderer.ingestEvents(eventsMsg.events);
      hud.ingestEvents(eventsMsg.events);
      for (const ev of eventsMsg.events) {
        if (ev.type === 'gunFire') statShotsFiredGun += 1;
        else if (ev.type === 'missileLaunch') {
          statMissilesFired += 1;
          if (ev.shooterId === playerEntityId) {
            playerMissilesFired += 1;
            flightOverlay?.message('Missile away');
          }
        }
        else if (ev.type === 'hit') {
          if (ev.weapon === 'gun') statShotsHitGun += 1;
          else statMissilesHit += 1;
        } else if (ev.type === 'kill') {
          if (ev.sourceId === playerEntityId) {
            statKills += 1;
            flightOverlay?.message('Target destroyed');
          }
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
function buildSceneEnvironment(terrainParams: TerrainParams, airportLayouts: readonly AirportLayout[], wind: { x: number; z: number } = { x: 0, z: 0 }): SceneEnvironment {
  const aids = airportLayouts.map((a) => buildAirfieldAids(a));
  // Windsocks stream downwind (limp towards the south in calm air); floodlight masts at the aprons.
  const downwind = Math.hypot(wind.x, wind.z) > 0.2 ? Math.atan2(wind.x, -wind.z) : Math.PI;
  const aidStructures = aids.flatMap((a, i) => [
    ...a.windsocks.map(([x, z]) => ({ kind: 'windsock', worldX: x, worldY: a.groundY, worldZ: z, headingRad: downwind, widthM: 2, lengthM: 6, heightM: 7, side: airportLayouts[i]!.side ?? 'neutral' })),
    ...a.floodlights.map(([x, z]) => ({ kind: 'light_mast', worldX: x, worldY: a.groundY, worldZ: z, headingRad: 0, widthM: 2.4, lengthM: 2.4, heightM: 21, side: airportLayouts[i]!.side ?? 'neutral' })),
  ]);
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
  const coast = buildCoastProfile(terrainParams);
  let estuaries: SceneEnvironment['estuaries'];
  if (terrainParams.shape?.kind === 'coast' && terrainParams.shape.estuaries.length > 0) {
    const packed = new Float32Array(terrainParams.shape.estuaries.length * ESTUARY_FLOATS);
    terrainParams.shape.estuaries.forEach((e, i) => packEstuary(e, i, terrainParams.seed, packed, i * ESTUARY_FLOATS));
    estuaries = { packed: Array.from(packed), count: terrainParams.shape.estuaries.length };
  }
  let rivers: SceneEnvironment['rivers'];
  if (terrainParams.shape?.kind === 'plains' && terrainParams.shape.rivers.length > 0) {
    const packed = new Float32Array(terrainParams.shape.rivers.length * RIVER_FLOATS);
    terrainParams.shape.rivers.forEach((r, i) => packRiver(r, i, terrainParams.seed, packed, i * RIVER_FLOATS));
    rivers = { packed: Array.from(packed), count: terrainParams.shape.rivers.length };
  }
  // Cumulus layer heights per theatre; how much cloud there is comes from the weather (skyState.ts).
  const clouds =
    terrainParams.surfaceStyle === 'farmland'
      ? { coverage: 0.22, baseM: 1700, topM: 2300, seed: terrainParams.seed }
      : terrainParams.surfaceStyle === 'coastal'
        ? { coverage: 0.09, baseM: 1200, topM: 1700, seed: terrainParams.seed }
        : undefined;
  return {
    surfaceStyle: terrainParams.surfaceStyle ?? 'default',
    groundLevelM: terrainParams.shape?.kind === 'plains' ? terrainParams.shape.baseElevationM : (terrainParams.waterLevelM ?? 0) + 20,
    ...(clouds ? { clouds } : {}),
    ...(rivers ? { rivers } : {}),
    ...(estuaries ? { estuaries } : {}),
    ...(coast ? { coast } : {}),
    ...(terrainParams.waterLevelM !== undefined ? { waterLevelM: terrainParams.waterLevelM } : {}),
    pavement: buildPavementGeometry(airportLayouts),
    airfieldMasks: airportLayouts.map((a) => buildAirfieldMask(a)),
    structures: [
      ...airportLayouts.flatMap((a) =>
        (a.structures ?? []).map((s) => ({ kind: s.kind, worldX: s.worldX, worldY: a.elevationM, worldZ: s.worldZ, headingRad: s.headingRad, widthM: s.widthM, lengthM: s.lengthM, heightM: s.heightM, side: a.side ?? 'neutral' }))
      ),
      ...aidStructures,
    ],
    airfieldAids: aids,
    runways,
  };
}

/**
 * Dev aid: `?start=x,y,z,headingDeg,speedMps` spawns the player airborne there instead of on the
 * runway (for checking scenery anywhere on a map). Only acts when the parameter is present.
 */
function applyDevStart(mission: Mission): Mission {
  const raw = new URLSearchParams(location.search).get('start');
  if (!raw) return mission;
  const v = raw.split(',').map(Number);
  if (v.length < 3 || v.some((n) => !Number.isFinite(n))) return mission;
  return {
    ...mission,
    playerStart: { pos: { x: v[0]!, y: v[1]!, z: v[2]! }, headingRad: ((v[3] ?? 0) * Math.PI) / 180, speedMps: v[4] ?? 200 },
  };
}

/**
 * The air for the simulation from the weather choice: 'off' = calm (no wind, gusts or turbulence);
 * fog forms in near-calm air; rain brings gusts and turbulence. Other choices keep the mission's air.
 */
function applyWeatherSetting(mission: Mission): Mission {
  const wx = mission.weather;
  switch (weatherMode) {
    case 'off':
      return { ...mission, weather: { windWorldMps: { x: 0, y: 0, z: 0 }, gustMps: 0, turbulence: 0 } };
    case 'fog':
      return { ...mission, weather: { windWorldMps: { x: wx.windWorldMps.x * 0.3, y: 0, z: wx.windWorldMps.z * 0.3 }, gustMps: 0, turbulence: 0 } };
    case 'rain':
      return { ...mission, weather: { ...wx, gustMps: Math.max(wx.gustMps, 6), turbulence: Math.max(wx.turbulence, 0.35) } };
    default:
      return mission;
  }
}

/**
 * Loads a mission's world into the view (terrain streaming, airfields, the renderer's environment),
 * for a flight or for the menu's cinematic. `tier` sets how much terrain streams in.
 */
function setupWorldView(mission: Mission, tier: QualityTier): void {
  const terrainParams = mission.world.terrain as TerrainParams;
  const airportLayouts = mission.world.airports as readonly AirportLayout[];
  const flattenZones: readonly AirportFlattenZone[] = airportLayouts.flatMap((a) => a.flattenZones);
  const navDb = createAirportNavDb(airportLayouts);
  renderer.setNavDb(navDb);
  // The same ground the simulation flies over (airfields flattened), for keeping the camera above it.
  renderer.setGroundHeight(createHeightSampler(terrainParams, flattenZones).heightAt);
  renderer.setEnvironment(buildSceneEnvironment(terrainParams, airportLayouts, { x: mission.weather.windWorldMps.x, z: mission.weather.windWorldMps.z }));
  renderer.setWeather(weatherMode, newWeatherSeed());

  terrainReady = false;
  pendingTerrainMsgs.length = 0;
  chunkManager?.dispose();
  // createChunkManager itself sends the TerrainInitMessage at construction
  // (src/terrain/chunkManager.ts) — no separate explicit send needed here.
  chunkManager = createChunkManager({ qualityTier: tier, terrainParams, flattenZones }, sendToTerrainWorker);
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
      ...(chunk.geometry.features
        ? {
            features: {
              decalPositions: chunk.geometry.features.decalPositions.buffer as ArrayBuffer,
              decalAttribs: chunk.geometry.features.decalAttribs.buffer as ArrayBuffer,
              decalIndices: chunk.geometry.features.decalIndices.buffer as ArrayBuffer,
              treeMatrices: chunk.geometry.features.treeMatrices.map((a) => a.buffer as ArrayBuffer),
              treeColors: chunk.geometry.features.treeColors.map((a) => a.buffer as ArrayBuffer),
              buildingMatrices: chunk.geometry.features.buildingMatrices.buffer as ArrayBuffer,
              buildingColors: chunk.geometry.features.buildingColors.buffer as ArrayBuffer,
              domeMatrices: chunk.geometry.features.domeMatrices.buffer as ArrayBuffer,
              houseMatrices: chunk.geometry.features.houseMatrices.buffer as ArrayBuffer,
              houseColors: chunk.geometry.features.houseColors.buffer as ArrayBuffer,
            },
          }
        : {}),
    })
  );
  chunkManager.onChunkEvicted((key) => renderer.evictTerrainChunk(key.cx, key.cz, key.depth));

}

/** The keys a first-time pilot needs, for the loading screen. */
function firstKeys(): [string[], string][] {
  const k = inputSystem.inputMap.data.keyboard;
  return [
    [[keyLabel(k.axes.pitch.positive), keyLabel(k.axes.pitch.negative)], 'Nose up / down'],
    [[keyLabel(k.axes.roll.negative), keyLabel(k.axes.roll.positive)], 'Roll left / right'],
    [[keyLabel(k.axes.throttle.positive), keyLabel(k.axes.throttle.negative)], 'Throttle up / down'],
    [[keyLabel(k.buttons.afterburner)], 'Afterburner'],
    [[keyLabel(k.buttons.gearToggle)], 'Landing gear'],
    [['F1'], 'All controls'],
  ];
}

function hintKeys(): HintKeys {
  const k = inputSystem.inputMap.data.keyboard;
  return {
    throttleUp: keyLabel(k.axes.throttle.positive),
    throttleDown: keyLabel(k.axes.throttle.negative),
    afterburner: keyLabel(k.buttons.afterburner),
    noseUp: keyLabel(k.axes.pitch.positive),
    gear: keyLabel(k.buttons.gearToggle),
    taxiGuide: keyLabel(k.meta.taxiGuide),
    target: keyLabel(k.buttons.cycleTarget),
    launch: keyLabel(k.buttons.launch),
    weapon: keyLabel(k.buttons.cycleWeapon),
  };
}

/** Objective tracker, warnings-as-messages and hints, from the latest snapshot's HUD block. */
function updateFlightOverlay(view: Float64Array): void {
  const o = flightOverlay;
  const flight = currentFlight;
  if (!o || !flight || !currentMission || (appState !== 'gameplay' && appState !== 'paused')) return;
  const hudv = (f: number): number => view[HUD_BLOCK_START + f] ?? 0;

  // Objective, or the nearest friendly base in Free Flight.
  if (flight.kind === 'mission') {
    const entry = missionEntry(flight.id);
    o.setObjective('Objective', entry?.objective ?? '', `Destroyed ${statKills} / ${banditsTotal}`);
  } else if (lastPlayer.valid) {
    let best: AirportLayout | undefined;
    let bd = Infinity;
    for (const a of currentMission.world.airports as readonly AirportLayout[]) {
      if (a.side === 'hostile') continue;
      const d = Math.hypot(a.referenceWorldX - lastPlayer.x, a.referenceWorldZ - lastPlayer.z);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    if (best) {
      const brg = ((Math.atan2(best.referenceWorldX - lastPlayer.x, -(best.referenceWorldZ - lastPlayer.z)) * 180) / Math.PI + 360) % 360;
      o.setObjective('Nearest base', best.name, bd < 1500 ? 'Overhead' : `${(bd / 1000).toFixed(1)} km · bearing ${String(Math.round(brg) % 360).padStart(3, '0')}°`);
    }
  }

  // Missile launch warning and dropped tanks.
  const warn = hudv(SnapshotHud.WARNING_BITS);
  if ((warn & WarningBit.MissileLaunch) !== 0 && (lastWarningBits & WarningBit.MissileLaunch) === 0) o.message('Missile launched at you!', true);
  lastWarningBits = warn;
  const tank = hudv(SnapshotHud.TANK_FUEL_KG);
  if (lastTankFuelKg >= 0 && tank < 0) o.message('Tanks dropped');
  lastTankFuelKg = tank;

  // First-flight hints.
  if (!hintsEnabled || appState !== 'gameplay') {
    o.setHint(undefined);
    return;
  }
  const weapon = hudv(SnapshotHud.WEAPON_IDX);
  const hint = pickHint(
    {
      t: latestSimTimeSec - sessionStartSimTimeSec,
      start: flight.kind === 'free' ? flight.setup.start : missionStartKind(flight.id),
      mission: flight.kind === 'mission',
      onGround: lastPlayer.onGround,
      speedMps: lastPlayer.speedMps,
      aglM: hudv(SnapshotHud.ALT_AGL_M),
      vsMps: hudv(SnapshotHud.VSPEED_MPS),
      gearPos: hudv(SnapshotHud.GEAR_POS),
      taxiGuideOn: hud.hasTaxiGuide(),
      hasTarget: hudv(SnapshotHud.TARGET_ID) !== NO_ENTITY_ID,
      locked: hudv(SnapshotHud.LOCK_STATE) === LockStateCode.locked,
      missileSelected: weapon === WeaponKindCode.ir_missile || weapon === WeaponKindCode.radar_missile,
      missilesFired: playerMissilesFired,
    },
    hintsDone
  );
  o.setHint(hint ? hintText(hint, hintKeys()) : undefined);
}

/** How a mission starts the player: parked (shelter) or on a runway. */
function missionStartKind(id: BuiltinMissionId): 'parked' | 'runway' {
  return resolveBuiltinMission(id).playerStart.parkingSpotId ? 'parked' : 'runway';
}

/** Dev aid: ?mission=<built-in mission id>. */
function devMissionId(): BuiltinMissionId | undefined {
  const id = new URLSearchParams(location.search).get('mission');
  return id && isBuiltinMissionId(id) ? id : undefined;
}
let devAutoStart = false;

/** A flight being loaded: waits for the terrain around the aircraft, then for Start. */
let pendingStart: { loading: LoadingScreenHandle; simReady: boolean; t0: number; shown: boolean } | undefined;

function tickPendingStart(nowMs: number): void {
  const p = pendingStart;
  if (!p || !p.simReady || p.shown) return;
  const prog = chunkManager?.loadProgress() ?? { resident: 0, desired: 0 };
  const frac = prog.desired > 0 ? prog.resident / prog.desired : 0;
  const elapsed = nowMs - p.t0;
  p.loading.setProgress(0.2 + 0.8 * frac, 'Loading terrain…');
  if ((playerEntityId !== NO_ENTITY_ID && frac >= 0.9 && elapsed > 800) || elapsed > 20000) {
    p.shown = true;
    if (devAutoStart) {
      pendingStart = undefined;
      resumeFlight();
      return;
    }
    p.loading.setReady('Start  (Space)', () => {
      if (pendingStart !== p) return;
      pendingStart = undefined;
      resumeFlight();
    });
  }
}

// -----------------------------------------------------------------------------
// The menu's cinematic (src/ui/showcase.ts): three shots of Bhisiana (Bathinda), looping behind the
// menus. The base's world loads once (capped at High quality); each shot waits for the terrain
// around its camera before fading in, and fades to black before the next.
// -----------------------------------------------------------------------------

const SHOWCASE_FADE_SEC = 1.6;
const SHOWCASE_LOAD_TIMEOUT_SEC = 10;
let showcaseActive = false;
let showcaseIndex = 0;
let showcaseScene: ShowcaseScene | undefined;
let showcasePhase: 'loading' | 'playing' = 'loading';
let showcaseT = 0;
let fadeEl: HTMLDivElement | undefined;

function setFade(black: boolean): void {
  if (!fadeEl) {
    fadeEl = document.createElement('div');
    fadeEl.className = 'tj-fade tj-passive';
    uiRoot.prepend(fadeEl);
  }
  fadeEl.style.transitionDuration = `${SHOWCASE_FADE_SEC}s`;
  fadeEl.classList.toggle('tj-fade--black', black);
}

/** The cinematic's shots, in order (all at Bhisiana: INS Hansa is left out until it is tested). */
const SHOWCASE_SHOTS = [approachScene, taxiScene, nightDepartureScene] as const;
/** The world the cinematic has loaded (a new one only when the base changes). */
let showcaseWorldBase: string | undefined;

function showcaseSceneFor(index: number): ShowcaseScene | undefined {
  const base = baseInfo('bathinda');
  const mission = resolveBuiltinMission(base.freeMissionId);
  const layout = (mission.world.airports as readonly AirportLayout[]).find((a) => a.id === base.airportId);
  if (!layout) return undefined;
  const wind = mission.weather.windWorldMps;
  const rwyId = activeRunway(layout, { x: wind.x, z: wind.z });
  const runway = layout.runways.find((r) => r.id === rwyId) ?? layout.runways[0];
  if (!runway) return undefined;
  const shot = SHOWCASE_SHOTS[((index % SHOWCASE_SHOTS.length) + SHOWCASE_SHOTS.length) % SHOWCASE_SHOTS.length]!;
  const scene = shot(layout, runway);
  weatherMode = 'clear';
  renderer.setWeather(weatherMode, 7);
  if (showcaseWorldBase !== base.id) {
    setupWorldView(mission, currentQualityTier === 'ultra' ? 'high' : currentQualityTier);
    showcaseWorldBase = base.id;
  }
  timeOfDayH = scene.timeOfDayH;
  renderer.setTimeOfDay(timeOfDayH);
  return scene;
}

function enterShowcaseScene(index: number): void {
  showcaseIndex = index;
  showcaseScene = showcaseSceneFor(index);
  showcasePhase = 'loading';
  showcaseT = 0;
  setFade(true);
  if (showcaseScene) renderer.setShowcase(showcaseScene.frame(0));
}

/** Plays the cinematic behind the menus (no-op if already playing). */
/**
 * Dev aid: ?showcase=<shot>,<t>[,near] holds the cinematic at shot 0 (approach), 1 (taxi) or 2 (night take-off), t s
 * in; `near` moves the camera to 25 m beside the jet (for checking it against the ground).
 */
const devShowcase = ((): { index: number; t: number; near: boolean } | undefined => {
  const v = new URLSearchParams(location.search).get('showcase')?.split(',');
  if (!v || v.length < 2) return undefined;
  const index = Number(v[0]);
  const t = Number(v[1]);
  return Number.isFinite(index) && Number.isFinite(t) ? { index, t, near: v[2] === 'near' } : undefined;
})();

function devShowcaseFrame(sc: ShowcaseScene, t: number): ShowcaseFrame {
  const fr = sc.frame(t);
  const jet = fr.aircraft[0];
  if (!devShowcase?.near || !jet) return fr;
  const vh = Math.hypot(jet.vel.x, jet.vel.z) || 1;
  fr.camPos.x = jet.pos.x - (jet.vel.z / vh) * 25;
  fr.camPos.y = jet.pos.y + 1.5;
  fr.camPos.z = jet.pos.z + (jet.vel.x / vh) * 25;
  fr.lookAt.x = jet.pos.x;
  fr.lookAt.y = jet.pos.y;
  fr.lookAt.z = jet.pos.z;
  fr.fovDeg = 35;
  fr.offsetX = 0;
  return fr;
}

function startShowcase(): void {
  if (showcaseActive || !renderer) return;
  showcaseActive = true;
  hudCanvas.style.visibility = 'hidden';
  enterShowcaseScene(devShowcase?.index ?? 0);
}

function stopShowcase(): void {
  if (!showcaseActive) return;
  showcaseActive = false;
  showcaseScene = undefined;
  // A flight loads its own world; the cinematic reloads the base's when it starts again.
  showcaseWorldBase = undefined;
  renderer.setShowcase(null);
  hudCanvas.style.visibility = 'visible';
  setFade(false);
}

function tickShowcase(dtSec: number): void {
  const sc = showcaseScene;
  if (!showcaseActive || !sc) return;
  if (showcasePhase === 'loading') {
    // Hold on black until the terrain around the camera has loaded.
    renderer.setShowcase(sc.frame(0));
    showcaseT += dtSec;
    const prog = chunkManager?.loadProgress() ?? { resident: 0, desired: 0 };
    if ((prog.desired > 0 && prog.resident / prog.desired >= 0.9 && showcaseT > 0.8) || showcaseT > SHOWCASE_LOAD_TIMEOUT_SEC) {
      showcasePhase = 'playing';
      showcaseT = 0;
      setFade(false);
    }
    return;
  }
  if (devShowcase) {
    renderer.setShowcase(devShowcaseFrame(sc, (globalThis as { __showcaseT?: number }).__showcaseT ?? devShowcase.t));
    return;
  }
  showcaseT += dtSec;
  renderer.setShowcase(sc.frame(showcaseT));
  if (showcaseT > sc.durationSec - SHOWCASE_FADE_SEC) setFade(true);
  if (showcaseT >= sc.durationSec) enterShowcaseScene(showcaseIndex + 1);
}

function launchMission(missionIn: Mission, opts: { title: string; airStart: boolean }): void {
  stopShowcase();
  const mission = applyWeatherSetting(applyDevStart(missionIn));
  destroyCurrentScreen();
  appState = 'loading';
  const loading = createLoadingScreen(uiRoot, { title: opts.title, eyebrow: 'Loading', tips: firstKeys() });
  currentScreen = loading;
  loading.setProgress(0, 'Loading mission…');
  pendingStart = { loading, simReady: false, t0: performance.now(), shown: false };
  flightOverlay?.clear();
  hintsDone = new Set();
  playerMissilesFired = 0;
  lastWarningBits = 0;
  lastTankFuelKg = -1;
  banditsTotal = missionIn.aiFlights.filter((f) => f.team === 1).reduce((n, f) => n + (f.count ?? 1), 0);
  // Gear lever and throttle to suit the start (the gear lever otherwise keeps the last flight's).
  inputSystem.setGearDown(!opts.airStart);
  lightMode = DEFAULT_LIGHT_MODE;
  inputSystem.setThrottle(opts.airStart ? 0.8 : 0);

  currentMission = mission;
  playerEntityId = NO_ENTITY_ID;
  statKills = 0;
  statDeaths = 0;
  statShotsFiredGun = 0;
  statShotsHitGun = 0;
  statMissilesFired = 0;
  statMissilesHit = 0;
  // Each launch starts a new world whose clock starts at 0.
  latestSimTimeSec = 0;
  sessionStartSimTimeSec = 0;

  setupWorldView(mission, currentQualityTier);

  playerFullLoad = fullLoadFor(mission.playerStart.aircraftId, mission.playerStart.loadoutId, mission.playerStart.loadout);
  setPlayerFullLoad();
  hud.setTaxiGuide(null);
  hud.setAirbases(buildHudAirbases(mission.world.airports as readonly AirportLayout[]));
  lastPlayer.valid = false;

  loading.setProgress(0.1, 'Starting simulation…');
  // The flight is held until Start; one snapshot still arrives so terrain streams around the aircraft.
  simWorker.postMessage({ type: 'init', mission, qualityTier: currentQualityTier, startPaused: true } satisfies SimInitMessage);

  const starting = pendingStart;
  const onReady = (e: MessageEvent<SimToMainMessage>): void => {
    if (e.data.type === 'ready') {
      simWorker.removeEventListener('message', onReady as EventListener);
      if (pendingStart === starting && starting) {
        starting.simReady = true;
        starting.t0 = performance.now();
      }
    }
  };
  simWorker.addEventListener('message', onReady as EventListener);
}

// -----------------------------------------------------------------------------
// Boot sequence (10-core-worker.md section 4.10.2).
// -----------------------------------------------------------------------------

async function boot(): Promise<void> {
  startAnalytics();
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
  flightOverlay = createFlightOverlay(uiRoot);

  loading.setProgress(0.3, 'Starting simulation…');
  await initWorkersAndRenderer(currentQualityTier);
  hud.setSpeedUnit(currentSpeedUnit);
  inputSystem.setAlphaLimiterDisabled((persisted?.alphaLimiterEnabled ?? true) === false);
  weatherMode = persisted?.weatherMode ?? (persisted?.weatherEnabled === false ? 'off' : 'clear');
  timeOfDayH = persisted?.timeOfDayH ?? 10.5;
  renderer.setTimeOfDay(timeOfDayH);
  renderer.setWeather(weatherMode, newWeatherSeed());
  // Size renderer/HUD from the current window/DPR once, synchronously, right
  // now — before the first requestAnimationFrame(frame) callback draws
  // anything. onResize() is otherwise wired only as a 'resize' listener
  // (wireGlobalListeners, below), which on many mobile browsers never fires
  // after initial load; without this call the render/HUD canvases stay at
  // the HTML5 default backing-store size (300x150) for the whole session.
  onResize();
  applyMouseSettings(inputSystem.inputMap.data.mouse.enabled, persisted?.mouseSensitivity ?? 1, inputSystem.inputMap.data.mouse.invertPitch ?? false);
  hintsEnabled = persisted?.hintsEnabled ?? true;
  document.title = GAME_NAME;
  // Offline play and install: production builds only (a cached dev server would serve stale code).
  if (import.meta.env.PROD) void registerServiceWorker('../service-worker.js');
  loading.setProgress(1, 'Ready');
  destroyCurrentScreen();
  if (isTouchFirstDevice() && sessionStorageGet('tejas.deviceNotice') === null) {
    currentScreen = createDeviceNotice(uiRoot, {
      onContinue: () => {
        sessionStorageSet('tejas.deviceNotice', '1');
        showMainMenu();
      },
    });
  } else if (devMissionId()) {
    // Dev aid (?mission=<id>, with ?start= / ?cam=): straight into a mission, starting as soon as it loads.
    devAutoStart = true;
    const id = devMissionId()!;
    launchMission(resolveBuiltinMission(id), { title: id, airStart: (new URLSearchParams(location.search).get('start') ?? '') !== '' });
  } else {
    showMainMenu();
    // Links from the landing page: /play/#free and /play/#missions.
    if (location.hash === '#free') showFreeFlight();
    else if (location.hash === '#missions') showMissions();
  }
}

function sessionStorageGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function sessionStorageSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // ignored
  }
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
    pilotInputsScratch.lights = LIGHT_MODES[lightMode]!.flags;
    simWorker.postMessage({ type: 'input', entityId: playerEntityId, inputs: pilotInputsScratch } as const);
  }
  tickPendingStart(nowMs);
  tickShowcase(dtSec);
  tickLookKeys(dtSec);
  flightOverlay?.setVisible(appState === 'gameplay');
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
    // Leaving the tab in flight opens the pause menu (the flight then waits for Resume).
    if (document.visibilityState === 'hidden' && appState === 'gameplay') showPauseMenu();
  });
  // /play/#free and /play/#missions, also when the hash changes on an open game page (menus only).
  window.addEventListener('hashchange', () => {
    if (appState !== 'mainMenu' && appState !== 'missionSelect') return;
    if (location.hash === '#free') showFreeFlight();
    else if (location.hash === '#missions') showMissions();
  });
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code !== 'F1') return;
    e.preventDefault(); // the browser's help page
    if (appState === 'gameplay') showPauseMenu();
    if (appState === 'paused') showControlsOverlay();
  });
}

void orientationPrompt;

// -----------------------------------------------------------------------------
// Free look (chase and external views): drag with the mouse (right button, or left when not
// flying with the mouse), scroll to zoom, or hold the arrow keys. The chase view eases back
// behind the aircraft a few seconds after you stop (src/render/cameraModes.ts).
// -----------------------------------------------------------------------------

const LOOK_RAD_PER_PX = 0.006;
const MAX_LOOK_PX_PER_EVENT = 120;
const LOOK_KEY_RAD_PER_SEC = 1.6;
const ZOOM_M_PER_WHEEL_UNIT = 0.02;
const lookKeys = new Set<string>();

/** True if the key map uses this key for anything (then it is not a look key). */
function isBoundKey(code: string): boolean {
  if (!inputSystem) return false;
  const k = inputSystem.inputMap.data.keyboard;
  const axes = Object.values(k.axes).flatMap((a) => [a.negative, a.positive]);
  return [...axes, ...Object.values(k.buttons), ...Object.values(k.meta)].includes(code);
}

function wireFreeLook(): void {
  let dragging = false;
  window.addEventListener('pointerdown', (e: PointerEvent) => {
    if (appState !== 'gameplay' || e.pointerType === 'touch' || e.target !== renderCanvas) return;
    const mouseFlying = inputSystem?.inputMap.data.mouse.enabled ?? false;
    if (e.button === 2 || (e.button === 0 && !mouseFlying)) dragging = true;
  });
  window.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    if (appState !== 'gameplay' || (e.buttons & 3) === 0) {
      dragging = false;
      return;
    }
    // Drag right: the view turns right (the camera swings round the aircraft's left); drag down: look down on it.
    // Capped per event: browsers occasionally report a spurious huge jump in movementX/Y.
    const mx = Math.max(-MAX_LOOK_PX_PER_EVENT, Math.min(MAX_LOOK_PX_PER_EVENT, e.movementX));
    const my = Math.max(-MAX_LOOK_PX_PER_EVENT, Math.min(MAX_LOOK_PX_PER_EVENT, e.movementY));
    renderer.orbitCamera(-mx * LOOK_RAD_PER_PX, my * LOOK_RAD_PER_PX, 0);
  });
  window.addEventListener('pointerup', () => (dragging = false));
  window.addEventListener('blur', () => {
    dragging = false;
    lookKeys.clear();
  });
  window.addEventListener('contextmenu', (e) => {
    if (appState === 'gameplay') e.preventDefault();
  });
  window.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if (appState !== 'gameplay') return;
      renderer.orbitCamera(0, 0, e.deltaY * ZOOM_M_PER_WHEEL_UNIT);
    },
    { passive: true }
  );
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.code.startsWith('Arrow') && appState === 'gameplay' && !isBoundKey(e.code)) {
      lookKeys.add(e.code);
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e: KeyboardEvent) => lookKeys.delete(e.code));
}

/** Arrow keys held: keep looking round. */
function tickLookKeys(dtSec: number): void {
  if (lookKeys.size === 0 || appState !== 'gameplay' || !renderer) return;
  const r = LOOK_KEY_RAD_PER_SEC * dtSec;
  const yaw = (lookKeys.has('ArrowLeft') ? r : 0) - (lookKeys.has('ArrowRight') ? r : 0);
  const pitch = (lookKeys.has('ArrowUp') ? -r : 0) + (lookKeys.has('ArrowDown') ? r : 0);
  if (yaw !== 0 || pitch !== 0) renderer.orbitCamera(yaw, pitch, 0);
}

wireFreeLook();
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
  inputSystem.onMetaAction((action, repeat) => {
    if (action === 'menuToggle') {
      if (appState === 'gameplay') showPauseMenu();
      else if (appState === 'paused') resumeFlight();
    } else if (action === 'lightsCycle' && appState === 'gameplay') {
      lightMode = (lightMode + 1) % LIGHT_MODES.length;
      flightOverlay?.message(`Lights: ${LIGHT_MODES[lightMode]!.name}`);
    } else if (action === 'taxiGuide' && appState === 'gameplay') {
      toggleTaxiGuide();
    } else if ((action === 'radarRangeUp' || action === 'radarRangeDown') && appState === 'gameplay') {
      hud.cycleRadarRange(action === 'radarRangeUp' ? 1 : -1);
    } else if (AUTOPILOT_KEYS.has(action) && appState === 'gameplay') {
      autopilotKey(action, repeat === true);
    } else if (action === 'cameraCycle' && appState === 'gameplay') {
      // SceneRenderer.setCameraMode cycling is a small local rotation this
      // shell owns directly (module 08 exposes the setter, not a cycle
      // helper).
      cycleCameraMode();
    }
  });
}
wireMetaActionsOnce();

/** The player's full weapon load (their aircraft's loadout preset), for the HUD's ammunition counters. */
interface FullLoad { gun: number; ir: number; radar: number; irName?: string; radarName?: string }
let playerFullLoad: FullLoad = { gun: 0, ir: 0, radar: 0 };
function fullLoadFor(aircraftId: string | undefined, loadoutId: string | undefined, custom?: LoadoutFit): FullLoad {
  const out: FullLoad = { gun: 0, ir: 0, radar: 0 };
  const def = getAircraftDefinition(aircraftId ?? 'tejas-mk1a');
  const preset = def ? resolveLoadout(def, loadoutId, custom) : undefined;
  if (!preset) return out;
  for (const fit of Object.values(preset.fit)) {
    const w = fit ? WEAPONS[fit.store] : undefined;
    if (!w || !fit) continue;
    if (w.kind === 'gun') out.gun += fit.count;
    else if (w.kind === 'ir_missile') { out.ir += fit.count; out.irName ??= w.name.toUpperCase(); }
    else if (w.kind === 'radar_missile') { out.radar += fit.count; out.radarName ??= w.name.toUpperCase().replace(' MK1', ''); }
  }
  return out;
}
function setPlayerFullLoad(): void {
  const f = playerFullLoad;
  hud.setWeaponLoadout(f.gun, f.ir, f.radar, { ...(f.irName ? { ir: f.irName } : {}), ...(f.radarName ? { radar: f.radarName } : {}) });
}
let lastServiceState = 0;

/**
 * Autopilot keys -> sim commands. A tap steps a bug by the small amount; holding the key repeats
 * it (every AP_REPEAT_INTERVAL_SEC) by the larger one: heading 1 / 5 deg, altitude 100 / 500 m,
 * vertical speed 1 / 2.5 m/s, speed 5 / 10 kt (or 2 / 5 m/s).
 */
const AUTOPILOT_KEYS = new Set<string>(['apToggle', 'atToggle', 'apHdgDown', 'apHdgUp', 'apAltDown', 'apAltUp', 'apVsDown', 'apVsUp', 'apSpdDown', 'apSpdUp']);
function autopilotKey(action: string, held: boolean): void {
  const post = (a: AutopilotAction): void => {
    simWorker.postMessage({ type: 'command', command: { kind: 'autopilot', action: a } } satisfies SimCommandMessage);
  };
  if (action === 'apToggle') return post({ type: 'toggleAp' });
  if (action === 'atToggle') return post({ type: 'toggleAt' });
  const sign = action.endsWith('Up') ? 1 : -1;
  const kt = currentSpeedUnit === SpeedUnit.Knots;
  if (action.startsWith('apHdg')) post({ type: 'adjust', target: 'hdg', delta: (sign * (held ? 5 : 1) * Math.PI) / 180 });
  else if (action.startsWith('apAlt')) post({ type: 'adjust', target: 'alt', delta: sign * (held ? 500 : 100) });
  else if (action.startsWith('apVs')) post({ type: 'adjust', target: 'vs', delta: sign * (held ? 2.5 : 1) });
  else if (action.startsWith('apSpd')) post({ type: 'adjust', target: 'spd', delta: sign * (kt ? (held ? 10 : 5) * 0.514444 : held ? 5 : 2) });
}

/** The player as of the latest snapshot (for taxi guidance). */
const lastPlayer = { x: 0, z: 0, speedMps: 0, onGround: false, valid: false };
const taxiGraphs = new Map<string, TaxiGraph>();

/**
 * Taxi guidance (H): on the ground near a stand, a route to the runway in use (into the wind,
 * full length); elsewhere on the ground (after landing), a route to the nearest stand. H again clears.
 */
function toggleTaxiGuide(): void {
  if (hud.hasTaxiGuide()) {
    hud.setTaxiGuide(null);
    return;
  }
  if (!lastPlayer.valid || !currentMission) return;
  if (!lastPlayer.onGround || lastPlayer.speedMps > 40) {
    hud.setTaxiGuide({ message: 'TAXI GUIDE: ON THE GROUND ONLY' });
    return;
  }
  let best: AirportLayout | undefined;
  let bd = 6000;
  for (const a of currentMission.world.airports as readonly AirportLayout[]) {
    if (a.side === 'hostile') continue;
    const d = Math.hypot(a.referenceWorldX - lastPlayer.x, a.referenceWorldZ - lastPlayer.z);
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  if (!best) {
    hud.setTaxiGuide({ message: 'NO FRIENDLY AIRBASE HERE' });
    return;
  }
  let g = taxiGraphs.get(best.id);
  if (!g) {
    g = buildTaxiGraph(best);
    taxiGraphs.set(best.id, g);
  }
  const nearStand = g.stands.some((s) => Math.hypot(g!.nodes[s.node]![0] - lastPlayer.x, g!.nodes[s.node]![1] - lastPlayer.z) < 40);
  const wind = currentMission.weather.windWorldMps;
  const rwy = activeRunway(best, { x: wind.x, z: wind.z });
  const route = nearStand && rwy ? routeToRunway(g, best, lastPlayer.x, lastPlayer.z, rwy) : routeToStand(g, lastPlayer.x, lastPlayer.z);
  if (!route || route.points.length < 2) {
    hud.setTaxiGuide({ message: 'NO TAXI ROUTE FROM HERE' });
    return;
  }
  hud.setTaxiGuide({ points: route.points, groundY: best.elevationM, holdIndex: route.holdIndex, runwayId: route.runwayId, standNumber: route.standNumber });
}

const CAMERA_MODE_CYCLE = ['cockpit', 'chase', 'external', 'flyby'] as const;
let cameraModeIndex = 1;
function cycleCameraMode(): void {
  cameraModeIndex = (cameraModeIndex + 1) % CAMERA_MODE_CYCLE.length;
  renderer.setCameraMode(CAMERA_MODE_CYCLE[cameraModeIndex] as (typeof CAMERA_MODE_CYCLE)[number]);
}
