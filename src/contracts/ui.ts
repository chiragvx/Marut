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
 * benchmark-driven quality-tier detection, the in-browser 2D top-down
 * airport editor (place/drag/rotate runways, draw taxiways/aprons, set ILS,
 * live validation, JSON import/export, shareable URL-hash encoding), and PWA
 * service-worker registration. See 11-ui.md for the full design.
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

import type { AiDifficulty, HeightSampler, QualityTier, Result, SpeedUnit } from './core';

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
  NoseWheelSteer: 'noseWheelSteer',
  PauseToggle: 'pauseToggle',
  CameraCycle: 'cameraCycle',
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
  onAirportEditor(): void;
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
// 5. Airport editor.
//
//    IMPORTANT (see 11-ui.md §9 "Open assumptions"): ui.ts cannot import
//    contracts/airport.ts (module 05 is drafted in parallel; its AirportLayout
//    shape is not pinned anywhere except the AirportFlattenZone fragment in
//    00-architecture.md §9.2). Every editor type below is therefore LOCAL to
//    this contract. `EditorFlattenZone` deliberately mirrors
//    AirportFlattenZone's field names/units EXACTLY as given in
//    00-architecture.md §9.2 (centerWorldX/centerWorldZ/elevationM/
//    flatRadiusM/blendRadiusM) since that shape IS pinned project-wide.
//    Reconciling the rest of EditorAirportLayoutExport's field names with
//    whatever contracts/airport.ts's parser actually expects is an
//    integration-time task (module 10), not something this contract can
//    guarantee alone.
// -----------------------------------------------------------------------------

/** Version tag written into every exported layout; ImportEditorLayout rejects any other value. Bump only with a corresponding migration in src/ui/airportEditorExport.ts. */
export const EDITOR_LAYOUT_FORMAT_VERSION = 1;

/** Editor-only usability bounds (deliberately tighter than contracts/airport.ts's true format-validation range of the same physical quantity — RUNWAY_LENGTH_MIN_M/MAX_M there is 300/6000). Named with the EDITOR_ prefix, matching EDITOR_MAX_RUNWAYS/EDITOR_SNAP_OPTIONS_M below, specifically so this never collides with contracts/airport.ts's own RUNWAY_LENGTH_MIN_M/MAX_M constant of the same base name. */
export const EDITOR_RUNWAY_LENGTH_MIN_M = 500;
export const EDITOR_RUNWAY_LENGTH_MAX_M = 5000;
export const EDITOR_RUNWAY_WIDTH_MIN_M = 20;
export const EDITOR_RUNWAY_WIDTH_MAX_M = 80;

export const ILS_FREQ_MIN_MHZ = 108.1;
export const ILS_FREQ_MAX_MHZ = 111.95;
/** Declared simplification: real ILS channelling only uses odd-tenth decimals; this project checks range + 0.05 MHz spacing only, not the odd/even VOR/ILS distinction. See 11-ui.md §9. */
export const ILS_FREQ_CHANNEL_STEP_MHZ = 0.05;
/** Radians. ~2 degrees. */
export const ILS_GLIDESLOPE_MIN_RAD = 0.0349;
/** Radians. ~4 degrees. */
export const ILS_GLIDESLOPE_MAX_RAD = 0.0698;

/** Extra radius (m) added beyond a runway's own half-diagonal when auto-generating its flatten zone's flatRadiusM. */
export const RUNWAY_FLATTEN_MARGIN_M = 15;
export const RUNWAY_FLATTEN_BLEND_M = 40;
/** Extra radius (m) added beyond an apron's centroid-to-farthest-vertex distance. */
export const APRON_FLATTEN_MARGIN_M = 10;
export const APRON_FLATTEN_BLEND_M = 25;

export const APRON_MIN_AREA_M2 = 100;
export const AIRPORT_ID_MIN_LEN = 2;
export const AIRPORT_ID_MAX_LEN = 40;
export const AIRPORT_NAME_MAX_LEN = 80;

export const EDITOR_MAX_RUNWAYS = 8;
export const EDITOR_MAX_TAXIWAYS = 30;
export const EDITOR_MAX_APRONS = 15;
export const EDITOR_MAX_TAXIWAY_POINTS_TOTAL = 300;

export interface EditorPoint {
  xM: number;
  zM: number;
}

export interface EditorRunwayIls {
  frequencyMhz: number;
  /** Radians above horizontal. Default ILS_DEFAULT_GLIDESLOPE_RAD (core.ts) when the user has not overridden it. */
  glideslopeAngleRad: number;
}

export interface EditorRunway {
  /** Stable internal id (e.g. "runway-1"), NOT the directional designator ("09"/"27" is derived, see RunwayDesignator). */
  id: string;
  centerXM: number;
  centerZM: number;
  /** Heading (world convention, 00-architecture.md §3.1) of the PRIMARY end's approach/landing direction, [0, 2*PI). The reciprocal end's heading is this + PI (wrapped). */
  headingRad: number;
  lengthM: number;
  widthM: number;
  /** MSL elevation at the runway center; both thresholds are treated as the same elevation (flat-runway simplification, consistent with AirportFlattenZone's single elevationM per zone). */
  elevationM: number;
  ilsPrimary?: EditorRunwayIls;
  ilsReciprocal?: EditorRunwayIls;
}

export interface EditorTaxiway {
  id: string;
  widthM: number;
  /** Centerline polyline, >= 2 points, world X/Z metres. */
  points: readonly EditorPoint[];
}

export interface EditorApron {
  id: string;
  elevationM: number;
  /** Closed polygon, >= 3 points, world X/Z metres (implicit closing edge from last point to first). */
  points: readonly EditorPoint[];
}

export interface EditorAirportLayout {
  /** Lowercase kebab-case, [AIRPORT_ID_MIN_LEN, AIRPORT_ID_MAX_LEN] chars, also used as the export filename stem. */
  id: string;
  /** [1, AIRPORT_NAME_MAX_LEN] chars. */
  name: string;
  /** Initial pan/zoom center for the editor canvas and AirportInfo.referencePos.x/z on export; world metres. */
  referenceXM: number;
  referenceZM: number;
  /** Airport reference elevation MSL, metres; used as AirportInfo.elevationM on export. */
  elevationM: number;
  runways: readonly EditorRunway[];
  taxiways: readonly EditorTaxiway[];
  aprons: readonly EditorApron[];
}

/** Mirrors AirportFlattenZone (00-architecture.md §9.2) field-for-field. */
export interface EditorFlattenZone {
  centerWorldX: number;
  centerWorldZ: number;
  elevationM: number;
  flatRadiusM: number;
  blendRadiusM: number;
}

export interface EditorRunwayExport extends EditorRunway {
  /** RunwayDesignator(headingRad), e.g. "09". */
  primaryDesignator: string;
  /** RunwayDesignator(headingRad + PI), e.g. "27". */
  reciprocalDesignator: string;
}

/** The wire/file shape written by ExportEditorLayout. `flattenZones` is ALWAYS freshly derived via ComputeFlattenZones at export time — never hand-authored, never round-tripped through ImportEditorLayout (which ignores this field on input; see 11-ui.md §4). */
export interface EditorAirportLayoutExport {
  formatVersion: typeof EDITOR_LAYOUT_FORMAT_VERSION;
  id: string;
  name: string;
  referenceXM: number;
  referenceZM: number;
  elevationM: number;
  runways: readonly EditorRunwayExport[];
  taxiways: readonly EditorTaxiway[];
  aprons: readonly EditorApron[];
  flattenZones: readonly EditorFlattenZone[];
}

export const EditorValidationSeverity = {
  Error: 'error',
  Warning: 'warning',
} as const;
export type EditorValidationSeverity = (typeof EditorValidationSeverity)[keyof typeof EditorValidationSeverity];

export interface EditorValidationIssue {
  severity: EditorValidationSeverity;
  message: string;
  featureType: 'runway' | 'taxiway' | 'apron' | 'airport';
  featureId?: string;
}

// ---- pure geometry helpers (unit-testable without any DOM) ----

/** heading -> 2-digit runway designator per magnetic-heading rounding: round(degrees/10) mod 36, with 0 mapped to "36". E.g. RunwayDesignator(0) === "36" (north), RunwayDesignator(PI/2) === "09" (east). */
export type RunwayDesignator = (headingRad: number) => string;

export interface OrientedRect {
  centerXM: number;
  centerZM: number;
  headingRad: number;
  halfLengthM: number;
  halfWidthM: number;
}
/** Separating-axis test between two runway footprints. Pure, no allocation (writes no output; returns a boolean). See 11-ui.md §4 for the exact 4-axis formula. */
export type RectanglesOverlap = (a: OrientedRect, b: OrientedRect) => boolean;

/** Shoelace formula, absolute value, square metres. `points.length` must be >= 3. */
export type PolygonAreaM2 = (points: readonly EditorPoint[]) => number;
/** Vertex-average centroid (declared approximation of the true area centroid; see 11-ui.md §9). Mutates and returns `out`. */
export type PolygonCentroid = (points: readonly EditorPoint[], out: EditorPoint) => EditorPoint;

export type ComputeFlattenZones = (layout: EditorAirportLayout) => readonly EditorFlattenZone[];
export type ValidateEditorLayout = (layout: EditorAirportLayout) => readonly EditorValidationIssue[];

// ---- import / export / share-link ----

/** JSON.stringify of an EditorAirportLayoutExport (2-space indent; exact key order given in 11-ui.md §4). */
export type ExportEditorLayout = (layout: EditorAirportLayout) => string;
/** Parses + structurally validates `json`. Rejects (ok:false) on malformed JSON, wrong/missing `formatVersion`, or any EditorValidationIssue with severity 'error'. `flattenZones`, if present in the input, is ignored (see EditorAirportLayoutExport). */
export type ImportEditorLayout = (json: string) => Result<EditorAirportLayout, string>;

/** base64url(JSON.stringify(layout)) with no padding, per 11-ui.md §4's exact byte-to-char algorithm. Returns the fragment WITHOUT a leading '#'. */
export type EncodeLayoutToUrlHash = (layout: EditorAirportLayout) => string;
/** Inverse of EncodeLayoutToUrlHash. `hash` is accepted with or without a leading '#'. */
export type DecodeLayoutFromUrlHash = (hash: string) => Result<EditorAirportLayout, string>;

// ---- editor mount ----

export interface AirportEditorOptions {
  /** Starts from a fresh blank layout (auto id/name, zero features) when omitted. */
  initial?: EditorAirportLayout;
  /** Optional terrain preview underlay; the editor works with a flat metre grid when omitted. */
  sampler?: HeightSampler;
}
export interface AirportEditorCallbacks {
  /** "Test Fly" toolbar action: user wants to launch a mission starting at this layout. */
  onLaunchMission(layout: EditorAirportLayout): void;
  onExit(): void;
  /** Fired after every COMMITTED mutation (pointerup / form-blur), never per pointermove. Optional — the editor is fully usable via getLayout() alone. */
  onChange?(layout: EditorAirportLayout): void;
}
export interface AirportEditorHandle extends ScreenHandle {
  getLayout(): EditorAirportLayout;
  setLayout(layout: EditorAirportLayout): void;
  getValidationIssues(): readonly EditorValidationIssue[];
}
export type CreateAirportEditor = (
  container: HTMLElement,
  options: AirportEditorOptions,
  callbacks: AirportEditorCallbacks
) => AirportEditorHandle;

// -----------------------------------------------------------------------------
// 6. PWA service-worker registration glue (src/ui/pwa.ts). public/manifest.
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
