/**
 * =============================================================================
 * TEJAS SIM — UI CONTRACT (docs/spec/contracts/ui.ts)
 * =============================================================================
 * Owner: module 11 (docs/spec/11-ui.md). Implemented by src/ui/*.ts and
 * public/*. This file imports ONLY from './core' (no './math', no other
 * contract). Per 00-architecture.md §10, src/ui/* may import from ANY file
 * under src/contracts/* at implementation time (all contracts are copied
 * there verbatim), but THIS CONTRACT FILE itself only depends on core.ts so
 * it can be drafted and audited in isolation, consistent with every other
 * leaf contract in this project.
 *
 * Scope: plain-DOM menu screens (main menu, mission select, settings, pause,
 * debrief, loading screen), a mobile landscape-orientation prompt, GPU/
 * benchmark-driven quality-tier detection, and PWA service-worker
 * registration. See 11-ui.md for the full design.
 *
 * Contract-file rules (00-architecture.md §8): interfaces, type aliases,
 * `as const` objects + derived unions, and bare function-signature aliases
 * (`export type CreateX = (...) => X`) only. No implementation.
 *
 * NOTE on quality tiers: this file only lets module 11 SELECT a `QualityTier`
 * value (core.ts). What each tier actually controls in rendering/HUD is
 * fixed authoritatively in 00-architecture.md §14 — this contract does not
 * repeat or reinterpret that table.
 * =============================================================================
 */

import type { AiDifficulty, HeightSampler, QualityTier, Result, SpeedUnit, WeatherMode } from './core';

// -----------------------------------------------------------------------------
// 1. Generic screen-mount conventions. Every DOM screen factory in this file
//    follows the same contract: it APPENDS one root element into `container`
//    and returns a handle. `destroy()` removes that root element from its
//    parent and detaches all listeners; it must be idempotent (a second call
//    is a no-op, never throws). `show()/hide()` toggle visibility without
//    destroying/rebuilding DOM. Module 11 does not own screen NAVIGATION
//    (which screen is active, when to create/destroy the next one) — that is
//    src/core's app-state machine (module 10); this file fixes only how each
//    screen is constructed and what it emits.
// -----------------------------------------------------------------------------

export interface ScreenHandle {
  readonly rootEl: HTMLElement;
  show(): void;
  hide(): void;
  /** Idempotent. Removes rootEl from its parent and detaches all listeners. */
  destroy(): void;
}

// -----------------------------------------------------------------------------
// 2. Quality tier detection. Split into a PURE decision function
//    (ComputeQualityTier — fully unit-testable, no DOM/WebGL) and impure
//    measurement functions (ReadWebglRendererStrings, RunRenderBenchmark)
//    that `DetectQualityTier` composes. See 11-ui.md §4 for the exact scoring
//    algorithm these constants and types implement.
// -----------------------------------------------------------------------------

/** Cap applied to `window.devicePixelRatio` everywhere in this project (rendering AND the benchmark canvas), so a 3x/4x phone panel is treated as 2x. */
export const DEVICE_PIXEL_RATIO_CAP = 2;

/**
 * Total wall-clock duration of one quality-tier benchmark run, ms. This (plus
 * BENCHMARK_WARMUP_MS/TRIANGLE_COUNT below) used to run unconditionally on EVERY page load
 * (main.ts now caches the result — see PersistedSettings.cachedAutoTier — so it only runs once
 * per browser), which is what made every load visibly "lag the entire browser and PC" for its
 * duration. Shrunk 5x/3.4x from the original 2000ms/300k-triangle run for the one-off cost that
 * remains; still comfortably enough frames at any real frame rate to produce a stable fps
 * average for ComputeQualityTier's bucket thresholds below.
 */
export const BENCHMARK_DURATION_MS = 800;
/** Leading portion of BENCHMARK_DURATION_MS discarded before averaging (JIT/driver warm-up), ms. */
export const BENCHMARK_WARMUP_MS = 150;
/** Triangle count of the synthetic benchmark scene (a single static triangle-soup VBO, regenerated with `Math.random()` per 00-architecture.md §2's "cosmetic-only" allowance — this never feeds simulation state). */
export const BENCHMARK_TRIANGLE_COUNT = 60_000;

/** Benchmark fps buckets used by ComputeQualityTier. fps >= ULTRA -> benchmarkScore 3, >= HIGH -> 2, >= MEDIUM -> 1, else 0. */
export const QUALITY_BENCHMARK_FPS_THRESHOLDS = {
  ULTRA: 55,
  HIGH: 40,
  MEDIUM: 25,
} as const;

/** How a recognised GPU renderer string biases tier selection. 'unknown' contributes 0 (neutral, never penalised for being unrecognised). */
export const GpuStrengthHint = {
  Strong: 'strong',
  Weak: 'weak',
  Unknown: 'unknown',
} as const;
export type GpuStrengthHint = (typeof GpuStrengthHint)[keyof typeof GpuStrengthHint];

export interface GpuInfo {
  /** UNMASKED_VENDOR_WEBGL string, or 'unknown' if the WEBGL_debug_renderer_info extension is unavailable/blocked. */
  vendor: string;
  /** UNMASKED_RENDERER_WEBGL string, or 'unknown'. */
  renderer: string;
  strengthHint: GpuStrengthHint;
}

export interface BenchmarkResult {
  avgFrameMs: number;
  fps: number;
  /** Number of frames measured AFTER the BENCHMARK_WARMUP_MS window. 0 if WebGL was unavailable. */
  samples: number;
}

export interface QualityTierReport {
  tier: QualityTier;
  /** Human-readable log of every factor that contributed, for a debug/QA overlay. E.g. "gpu: strong (+2)", "benchmark: 47fps -> high (+2)". */
  reasons: readonly string[];
  gpu: GpuInfo;
  benchmark: BenchmarkResult;
  devicePixelRatioCapped: number;
}

/** Pure string classifier: no canvas/DOM access. Matches known GPU renderer substrings (11-ui.md §4/§5 gives the exact token tables). */
export type ClassifyGpuRenderer = (rendererString: string, vendorString: string) => GpuInfo;

/** Impure: queries a canvas's WebGL context for WEBGL_debug_renderer_info. Returns {renderer:'unknown', vendor:'unknown'} if unavailable or context creation fails; never throws. */
export type ReadWebglRendererStrings = (canvas: HTMLCanvasElement) => { renderer: string; vendor: string };

/** Impure: renders the synthetic benchmark scene via raw WebGL2 (WebGL1 fallback) for `durationMs`, discarding the first `warmupMs`. Resolves with fps=0, samples=0 if no WebGL context could be created. Never throws or rejects. */
export type RunRenderBenchmark = (
  canvas: HTMLCanvasElement,
  durationMs: number,
  warmupMs: number,
  triangleCount: number
) => Promise<BenchmarkResult>;

/** Pure: combines a GpuInfo + BenchmarkResult + capped DPR into one QualityTierReport. See 11-ui.md §4 for the exact score->tier table. This is the function tests/ui/qualityTierDetect.test.ts exercises directly. */
export type ComputeQualityTier = (gpu: GpuInfo, benchmark: BenchmarkResult, devicePixelRatioCapped: number) => QualityTierReport;

/** The one function src/core actually calls: reads the GPU string, runs the benchmark, caps DPR, and returns ComputeQualityTier's result. Composition only — contains no scoring logic of its own. */
export type DetectQualityTier = (canvas: HTMLCanvasElement) => Promise<QualityTierReport>;

// -----------------------------------------------------------------------------
// 3. Settings screen. `BindableAction`/`KeyBinding` are a LOCAL, self-
//    contained model owned by this contract (ui.ts cannot import
//    contracts/input.ts — module 09 is drafted in parallel and unseen; see
//    11-ui.md §9). src/core (module 10) is responsible for bridging this
//    shape onto whatever concrete InputMap contracts/input.ts actually
//    defines.
// -----------------------------------------------------------------------------

export const BindableAction = {
  PitchUp: 'pitchUp',
  PitchDown: 'pitchDown',
  RollLeft: 'rollLeft',
  RollRight: 'rollRight',
  YawLeft: 'yawLeft',
  YawRight: 'yawRight',
  ThrottleUp: 'throttleUp',
  ThrottleDown: 'throttleDown',
  Afterburner: 'afterburner',
  Brakes: 'brakes',
  GearToggle: 'gearToggle',
  Airbrake: 'airbrake',
  Trigger: 'trigger',
  Launch: 'launch',
  CycleWeapon: 'cycleWeapon',
  CycleTarget: 'cycleTarget',
  JettisonTanks: 'jettisonTanks',
  Service: 'service',
  NoseWheelSteer: 'noseWheelSteer',
  PauseToggle: 'pauseToggle',
  CameraCycle: 'cameraCycle',
  TaxiGuide: 'taxiGuide',
  RadarMode: 'radarMode',
  RadarRangeUp: 'radarRangeUp',
  RadarRangeDown: 'radarRangeDown',
} as const;
export type BindableAction = (typeof BindableAction)[keyof typeof BindableAction];

export interface KeyBinding {
  action: BindableAction;
  /** `KeyboardEvent.code` value, e.g. "KeyW", "Space", "ShiftLeft". */
  code: string;
}

export interface SettingsState {
  /** 'auto' = use the last QualityTierReport.tier from DetectQualityTier; any explicit QualityTier overrides it. */
  qualityOverride: QualityTier | 'auto';
  detectedTier: QualityTier;
  keyBindings: readonly KeyBinding[];
  /** [0.1, 3.0] multiplier applied to mouse-look input by whatever src/input actually does with it. */
  mouseSensitivityMultiplier: number;
  invertPitch: boolean;
  /** Display unit for the HUD airspeed tape; see contracts/core.ts's SpeedUnit doc comment. */
  speedUnit: SpeedUnit;
  /** false = fly with PilotInputs.alphaLimiterDisabled=true (no FBW alpha protection); see that field's own doc comment. Defaults to true (limiter active, the safe/real-Tejas default). */
  alphaLimiterEnabled: boolean;
  /**
   * Weather on/off: clouds and their shadows (immediately) and wind, gusts and turbulence (from the
   * next mission start). Optional so older callers still type-check; missing means on.
   */
  weatherEnabled?: boolean;
  /**
   * Weather choice (see core.ts WeatherMode). Visuals change immediately; 'off' also calms the air
   * (no wind, gusts or turbulence) from the next mission start. Missing = 'clear' (or 'off' when
   * weatherEnabled is false, for older callers).
   */
  weatherMode?: WeatherMode;
  /** Local time of day, hours 0-24 (sun, moon, sky and night lights). Missing = 10.5. */
  timeOfDayH?: number;
}

export interface SettingsCallbacks {
  /** Fired with the full next state on every committed change (not per keystroke while typing a number field — see 11-ui.md §4 for exact commit timing). */
  onChange(next: SettingsState): void;
  /** UI asks the caller to start listening for the next physical key press and report it back via `SettingsScreenHandle.setCapturedKey`. */
  onRebindStart(action: BindableAction): void;
  onResetDefaults(): void;
  onBack(): void;
}

export interface SettingsScreenHandle extends ScreenHandle {
  /** Caller reports the key captured after onRebindStart fired. No-op if no rebind is in progress. */
  setCapturedKey(action: BindableAction, code: string): void;
}

export type CreateSettingsScreen = (
  container: HTMLElement,
  initial: SettingsState,
  callbacks: SettingsCallbacks
) => SettingsScreenHandle;

// -----------------------------------------------------------------------------
// 4. Main menu, mission select, pause, debrief, loading screen, orientation
//    prompt.
// -----------------------------------------------------------------------------

export interface MainMenuCallbacks {
  onPlay(): void;
  onSettings(): void;
}
export type CreateMainMenu = (container: HTMLElement, callbacks: MainMenuCallbacks) => ScreenHandle;

export interface MissionSummary {
  id: string;
  name: string;
  description: string;
  /** Display-only, e.g. "HAL Tejas Mk1". */
  aircraftLabel: string;
}
export interface MissionSelectOptions {
  missions: readonly MissionSummary[];
  defaultDifficulty: AiDifficulty;
}
export interface MissionSelectCallbacks {
  onLaunch(missionId: string, difficulty: AiDifficulty): void;
  onBack(): void;
}
export type CreateMissionSelect = (
  container: HTMLElement,
  options: MissionSelectOptions,
  callbacks: MissionSelectCallbacks
) => ScreenHandle;

export interface PauseMenuCallbacks {
  onResume(): void;
  onRestart(): void;
  onQuitToMenu(): void;
  onOpenSettings(): void;
}
export type CreatePauseMenu = (container: HTMLElement, callbacks: PauseMenuCallbacks) => ScreenHandle;

/** MUST use the same three string values as `core.ts`'s own `MissionOutcome` (duplicated there only because `core.ts`, the root contract, cannot import this leaf contract — see `core.ts`'s matching comment). */
export const MissionOutcome = {
  Success: 'success',
  Failure: 'failure',
  Aborted: 'aborted',
} as const;
export type MissionOutcome = (typeof MissionOutcome)[keyof typeof MissionOutcome];

/**
 * Populated and handed to `CreateDebriefScreen` by `src/main.ts` (module 10),
 * from a `MissionEndedEvent` (`core.ts`'s `SimEvent`, emitted by `World` per
 * `10-core-worker.md` section 4.1b) plus this session's own running
 * kill/shot counters (accumulated client-side from `gunFire`/`hit`/`kill`
 * `SimEvent`s over the mission's lifetime — no module owns a dedicated
 * "combat stats" aggregate, so `src/main.ts` is the natural place, being the
 * one file that already sees every `SimEvent` as it streams in). `outcome`
 * mirrors `MissionEndedEvent.outcome` for a normal end; `src/main.ts` sets it
 * to `Aborted` itself when the player quits/reloads via the pause menu
 * before a `MissionEndedEvent` ever arrives.
 */
export interface DebriefStats {
  missionId: string;
  outcome: MissionOutcome;
  durationSec: number;
  kills: number;
  /** 0 or 1 for the player aircraft. */
  deaths: number;
  shotsFiredGun: number;
  shotsHitGun: number;
  missilesFired: number;
  missilesHit: number;
  /** MissionObjective.id (core.ts) values completed. */
  objectivesCompleted: readonly string[];
  objectivesTotal: number;
}
export interface DebriefCallbacks {
  onReplay(): void;
  onMissionSelect(): void;
  onMainMenu(): void;
}
export type CreateDebriefScreen = (
  container: HTMLElement,
  stats: DebriefStats,
  callbacks: DebriefCallbacks
) => ScreenHandle;

export interface LoadingScreenHandle extends ScreenHandle {
  /** `fraction` clamped internally to [0,1]. `message` is short status text, e.g. "Building terrain…". */
  setProgress(fraction: number, message?: string): void;
}
export type CreateLoadingScreen = (container: HTMLElement) => LoadingScreenHandle;

/** The larger of screen.width/screen.height must be <= this (px, CSS pixels) for the orientation prompt's mobile heuristic to apply. See 11-ui.md §4. */
export const MOBILE_MAX_DIMENSION_PX = 900;

export interface OrientationPromptHandle {
  readonly rootEl: HTMLElement;
  destroy(): void;
}
/** Self-managing: watches `matchMedia('(orientation: portrait)')` and `matchMedia('(pointer: coarse)')` itself and shows/hides its own overlay. No callbacks — purely advisory (never blocks input). */
export type MountOrientationPrompt = (container: HTMLElement) => OrientationPromptHandle;

// -----------------------------------------------------------------------------
// 5. PWA service-worker registration glue (src/ui/pwa.ts). public/manifest.
//    webmanifest and public/service-worker.js are static assets specified in
//    full in 11-ui.md §5, not TypeScript, so they have no contract types.
// -----------------------------------------------------------------------------

export interface ServiceWorkerRegistrationHandle {
  readonly registered: boolean;
  readonly scope: string | undefined;
  readonly error: string | undefined;
  /** `cb` fires at most once per registration, when a newer service worker has taken control and a reload would pick it up. */
  onUpdateAvailable(cb: () => void): void;
}
/** No-ops (registered:false, error set) when `navigator.serviceWorker` is unavailable (unsupported browser, or non-HTTPS/non-localhost origin). Never throws or rejects. */
export type RegisterServiceWorker = (swUrl: string) => Promise<ServiceWorkerRegistrationHandle>;
