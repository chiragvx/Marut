/**
 * =============================================================================
 * TEJAS SIM — RENDER + HUD CONTRACT (docs/spec/contracts/render.ts)
 * =============================================================================
 * Owner: module 08 (docs/spec/08-render.md). Imports ONLY from './core'.
 * Contains interfaces, type aliases, `as const` objects + derived unions,
 * constants, and bare factory function-signature aliases. NO implementation
 * code, NO class bodies. Must compile standalone with `tsc --noEmit --strict`.
 *
 * Covers BOTH owned runtime directories of module 08:
 *   - src/render/*  (Three.js scene: terrain, wireframe aircraft, effects,
 *     camera, floating origin, snapshot interpolation)
 *   - src/hud/*     (Canvas-2D HUD overlay: ladder, tapes, ILS needles,
 *     radar scope, target box + lead sight, weapon status, warnings)
 *
 * Per 00-architecture.md section 10, src/render and src/hud may each import
 * ONLY from src/contracts/* (this file and core.ts) — NEITHER may import
 * src/math/*, and src/hud may NOT import src/render/* (separate directories,
 * separate dependency-rule rows). Both directories therefore implement their
 * own small, private, allocation-free vector/quaternion helpers internally
 * (see 08-render.md section 2, src/render/mathInternal.ts and
 * src/hud/mathInternal.ts) rather than reusing src/math. Three.js's own
 * Vector3/Quaternion/Matrix4 classes MAY be used freely inside src/render
 * (three is the one permitted renderer dependency) but never inside src/hud
 * (Canvas-2D only, no Three.js there).
 * =============================================================================
 */

import type { AirportNavDb, QualityTier, SimEvent, SpeedUnit, TerrainChunkReadyMessage, Vec3Like, WeaponKind, WeatherMode } from './core';
import { WarningBit } from './core';
import type { SettlementLayer } from './terrain';

// -----------------------------------------------------------------------------
// 1. Quality tiers → render/HUD settings. RENDER_QUALITY_TABLE's six fields
//    marked "(architecture)" below reproduce 00-architecture.md section 14's
//    table EXACTLY (values are law, do not vary them). The remaining fields
//    (pixelRatioCap, fogStartM, fogEndM) are this module's own tuning,
//    documented in 08-render.md section 5. src/ui MAY also read this table
//    (it lives under src/contracts, which src/ui may import) to label its
//    quality-tier settings menu and to interpret its own FPS benchmark
//    against `targetFps` — module 08 does not depend on src/ui for this.
// -----------------------------------------------------------------------------

export const AntiAliasMode = {
  Off: 'off',
  Fxaa: 'fxaa',
  Msaa4x: 'msaa4x',
} as const;
export type AntiAliasMode = (typeof AntiAliasMode)[keyof typeof AntiAliasMode];

export interface RenderQualitySettings {
  /** Terrain streaming radius, in chunks, from the viewer. (architecture) */
  terrainDrawDistanceChunks: number;
  /** Terrain quadtree max LOD depth. (architecture) */
  terrainMaxLodDepth: number;
  /** (architecture) */
  shadowsEnabled: boolean;
  /** 0 when shadowsEnabled is false. (architecture) */
  shadowCascades: 0 | 1 | 2;
  /** Max concurrent instanced effect particles (explosion + muzzle-flash + smoke-trail combined). (architecture) */
  effectBudget: number;
  /** (architecture) */
  antialias: AntiAliasMode;
  /** Renderer clamps `min(window.devicePixelRatio, pixelRatioCap)`. Not in architecture's table; this module's own mobile-fill-rate control. */
  pixelRatioCap: number;
  /** Max HUD radar-scope contacts drawn (nearest-N of the ones found; see 08-render.md section 4.7). (architecture) */
  radarScopeContactCap: number;
  /** Informational design frame-rate target for this tier; never enforced by src/render itself (the browser's rAF and src/ui's benchmark own actual throttling). (architecture) */
  targetFps: number;
  /** Linear fog start distance from camera, m. Not in architecture's table. */
  fogStartM: number;
  /** Linear fog end distance (fully fogged) from camera, m. Not in architecture's table. */
  fogEndM: number;
}

// Shadows are on for every tier now (the user asked for low-quality shadows on Low and high-quality
// on High); their per-tier quality lives in src/render/sunShadows.ts SHADOW_TIERS.
export const RENDER_QUALITY_TABLE: Readonly<Record<QualityTier, RenderQualitySettings>> = {
  low: {
    terrainDrawDistanceChunks: 6,
    terrainMaxLodDepth: 3,
    shadowsEnabled: true,
    shadowCascades: 1,
    effectBudget: 16,
    antialias: AntiAliasMode.Off,
    pixelRatioCap: 1.0,
    radarScopeContactCap: 8,
    targetFps: 30,
    fogStartM: 1500,
    fogEndM: 5000,
  },
  medium: {
    terrainDrawDistanceChunks: 10,
    terrainMaxLodDepth: 4,
    shadowsEnabled: true,
    shadowCascades: 1,
    effectBudget: 32,
    antialias: AntiAliasMode.Fxaa,
    pixelRatioCap: 1.5,
    radarScopeContactCap: 16,
    targetFps: 45,
    fogStartM: 2500,
    fogEndM: 8000,
  },
  high: {
    terrainDrawDistanceChunks: 16,
    terrainMaxLodDepth: 5,
    shadowsEnabled: true,
    shadowCascades: 1,
    effectBudget: 64,
    antialias: AntiAliasMode.Fxaa,
    pixelRatioCap: 2.0,
    radarScopeContactCap: 32,
    targetFps: 60,
    fogStartM: 4000,
    fogEndM: 13000,
  },
  ultra: {
    terrainDrawDistanceChunks: 24,
    terrainMaxLodDepth: 6,
    shadowsEnabled: true,
    shadowCascades: 2,
    effectBudget: 128,
    antialias: AntiAliasMode.Msaa4x,
    pixelRatioCap: 2.0,
    radarScopeContactCap: 32,
    targetFps: 60,
    fogStartM: 6000,
    fogEndM: 20000,
  },
} as const;

// -----------------------------------------------------------------------------
// 2. Camera modes and tuning constants. See 08-render.md section 4.2 for the
//    exact per-mode position/orientation formulas that consume these.
// -----------------------------------------------------------------------------

export const CameraMode = {
  Cockpit: 'cockpit',
  Chase: 'chase',
  External: 'external',
  Flyby: 'flyby',
} as const;
export type CameraMode = (typeof CameraMode)[keyof typeof CameraMode];

/** Eye position, body-frame metres from the player aircraft's origin (not CG), for CameraMode.Cockpit. */
export const COCKPIT_EYE_OFFSET_BODY_M: Vec3Like = { x: 0.35, y: 1.05, z: 0 };
export const COCKPIT_VERTICAL_FOV_DEG = 75;

export const CHASE_CAM_DISTANCE_M = 15;
export const CHASE_CAM_HEIGHT_M = 4;
/** Exponential-smoothing time constant, seconds, for the chase camera easing toward its target pose (see 08-render.md 4.2). */
export const CHASE_CAM_SMOOTHING_TAU_SEC = 0.15;
export const CHASE_VERTICAL_FOV_DEG = 60;

export const EXTERNAL_ORBIT_DEFAULT_RADIUS_M = 25;
export const EXTERNAL_ORBIT_MIN_RADIUS_M = 8;
export const EXTERNAL_ORBIT_MAX_RADIUS_M = 150;
export const EXTERNAL_ORBIT_DEFAULT_PITCH_RAD = 0.35;
export const EXTERNAL_VERTICAL_FOV_DEG = 60;

/** World-fixed flyby camera: distance ahead of the aircraft's velocity vector at which the camera is (re)placed, m. */
export const FLYBY_PLACEMENT_DISTANCE_M = 300;
export const FLYBY_HEIGHT_OFFSET_M = 15;
/** Once the aircraft has passed more than this far behind the fixed camera, the camera is replaced ahead again. */
export const FLYBY_RESET_DISTANCE_M = 400;
export const FLYBY_VERTICAL_FOV_DEG = 45;

/**
 * Near/far clip. Far covers the far-ground ring and sky dome out to the horizon (~300 km). Near is
 * 0.5 m (not 0.1) to keep depth precision usable over that range with a 24-bit depth buffer.
 */
export const CAMERA_NEAR_M = 0.5;
export const CAMERA_FAR_M = 330000;

// -----------------------------------------------------------------------------
// 3. Wireframe aircraft model. Structurally mirrors contracts/aircraft.ts
//    (module 03)'s WireframeModel/WireframeGroup exactly as fixed, verbatim,
//    by 00-architecture.md section 9.1 — this module declares its OWN copy
//    (rather than `import type { WireframeModel } from './aircraft'`) so
//    this contract stays self-contained during parallel drafting; the two
//    declarations MUST remain structurally identical because section 9.1
//    pins the shape for both module 02/03 and this module. A real
//    AircraftDefinition.wireframe value from src/aircraft is structurally
//    assignable to this type without change.
// -----------------------------------------------------------------------------

export interface WireframeGroup {
  /** e.g. "elevonL","elevonR","rudder","noseGear","mainGearL","mainGearR". See WIREFRAME_CONTROL_GROUP_NAMES below — only these exact strings are animated; any other name is rendered static (rest pose, no rotation applied). */
  name: string;
  /** Indices into WireframeModel.vertices this group rotates. */
  vertexIndices: readonly number[];
  /** Body-frame pivot point, m. */
  pivotBodyM: Vec3Like;
  /** Body-frame unit rotation axis. */
  axisBody: Vec3Like;
}

export interface WireframeModel {
  /** Body-frame, m, rest pose. */
  vertices: readonly (readonly [number, number, number])[];
  /** Index pairs into `vertices`. */
  edges: readonly (readonly [number, number])[];
  groups: readonly WireframeGroup[];
}

/**
 * The only group-name strings this module animates. A group whose `name` is
 * not one of these six exact strings is drawn in its rest pose every frame
 * (no rotation). This upgrades 00-architecture.md section 9.1's "e.g." naming
 * examples into a hard, load-bearing convention because WireframeGroup itself
 * carries no semantic-role field — see 08-render.md section 9 for the
 * documented risk if contracts/aircraft.ts's actual data uses different
 * literal names (graceful degradation: static part, not a crash).
 */
export const WIREFRAME_CONTROL_GROUP_NAMES = {
  ElevonL: 'elevonL',
  ElevonR: 'elevonR',
  Rudder: 'rudder',
  NoseGear: 'noseGear',
  MainGearL: 'mainGearL',
  MainGearR: 'mainGearR',
} as const;

/**
 * Total rotation swing, radians, applied to a gear WireframeGroup between
 * gearPos=0 and gearPos=1. Rest-pose vertices (the raw WireframeModel JSON)
 * are assumed authored at gearPos=0 (fully retracted); rotation angle at a
 * given gearPos is `gearPos * GEAR_TRAVEL_RAD` (see 08-render.md section 4.4
 * for the full Rodrigues-rotation formula and the documented assumption
 * about module 03's authoring convention).
 */
export const GEAR_TRAVEL_RAD = 1.7453292519943295; // 100 degrees

// -----------------------------------------------------------------------------
// 4. Camera state handed from SceneRenderer to HudRenderer once per rendered
//    frame (src/core wires this; src/hud never imports src/render). Lets the
//    HUD project a world-space point (target box, lead-sight pipper) into
//    screen pixels using the SAME camera the 3D scene drew with this frame.
// -----------------------------------------------------------------------------

export interface CameraState {
  /**
   * Column-major 4x4 view-projection matrix, length-16, matching
   * THREE.Matrix4.elements ordering. Operates on RENDER-SPACE coordinates —
   * i.e. a world position must first have `originWorld` subtracted (see
   * 08-render.md section 4.6's exact multiply formula).
   */
  viewProjectionMatrix: readonly number[];
  /** The renderOriginWorld (floating-origin) active when this matrix was built, m, absolute float64. */
  originWorld: Vec3Like;
  /** Camera's absolute world position this frame, m. */
  worldPos: Vec3Like;
  /** The sim time the 3D view shows this frame (it plays a few snapshots behind the newest), s; HUD symbols on world objects use it to line up. */
  renderSimSec?: number;
}

// -----------------------------------------------------------------------------
// 5. Effect kinds (instanced, pooled; budget = RenderQualitySettings.effectBudget
//    combined across kinds). Real bullets and missiles are drawn directly from
//    snapshot entities (kind=bullet/missile), NOT as one of these effects —
//    these three cover only cosmetic, event-triggered visuals.
// -----------------------------------------------------------------------------

export const EffectKind = {
  Explosion: 'explosion',
  MuzzleFlash: 'muzzleFlash',
  SmokeTrail: 'smokeTrail',
} as const;
export type EffectKind = (typeof EffectKind)[keyof typeof EffectKind];

// -----------------------------------------------------------------------------
// 6. HUD warning display table. Built from core.ts's own WarningBit values
//    (imported as a value, not just a type) so this table can never drift
//    from core.ts's bit assignments. flashHz = 0 means steady (no flashing).
//    priority: lower number = higher priority = drawn first / listed first
//    when more than one warning is active (see 08-render.md section 4.9).
// -----------------------------------------------------------------------------

export interface WarningDisplayEntry {
  bit: number;
  text: string;
  flashHz: number;
  priority: number;
}

export const WARNING_DISPLAY: readonly WarningDisplayEntry[] = [
  { bit: WarningBit.TerrainPullUp, text: 'PULL UP', flashHz: 4, priority: 0 },
  { bit: WarningBit.EngineFire, text: 'ENGINE FIRE', flashHz: 3, priority: 1 },
  { bit: WarningBit.MissileLaunch, text: 'MISSILE LAUNCH', flashHz: 3, priority: 2 },
  { bit: WarningBit.OverG, text: 'OVER G', flashHz: 2, priority: 3 },
  { bit: WarningBit.Stall, text: 'STALL', flashHz: 2, priority: 4 },
  { bit: WarningBit.MissileLock, text: 'LOCK', flashHz: 2, priority: 5 },
  { bit: WarningBit.Overspeed, text: 'OVERSPEED', flashHz: 1, priority: 6 },
  { bit: WarningBit.GearUnsafe, text: 'GEAR', flashHz: 1, priority: 7 },
  { bit: WarningBit.ConfigWarning, text: 'CONFIG', flashHz: 0, priority: 8 },
  { bit: WarningBit.LowFuel, text: 'FUEL', flashHz: 0, priority: 9 },
] as const;

// -----------------------------------------------------------------------------
// 7. Gun lead-computing sight. src/combat (module 07) computes the real,
//    gravity-drop-compensated aim point (`computeLeadSolution`, using this
//    SAME muzzle velocity) once per tick and src/core writes it into the
//    Snapshot HUD block's `PIPPER_X/Y/Z/VALID` floats (core.ts section 11,
//    `HUD_BLOCK_FLOATS = 27`) via `CombatStatus.aimPointWorld`/
//    `aimPointValid` — see 08-render.md section 4.8. `src/hud` therefore
//    NEVER computes its own lead solution: it reads `PIPPER_*` off the
//    snapshot and projects that single world point through the frame's
//    `CameraState`. `GUN_MUZZLE_VELOCITY_MPS` is kept here only as a fixed
//    reference value (must equal contracts/combat.ts's own constant of the
//    same name — both are 715, the real GSh-23 muzzle velocity) for this
//    module's documentation/tests; it is not used in any HUD-side formula.
// -----------------------------------------------------------------------------

export const GUN_MUZZLE_VELOCITY_MPS = 715;
/** Beyond this range the lead-sight pipper is not drawn (gun is not usefully effective) — src/hud hides the pipper when `PIPPER_VALID === 0` OR `TARGET_RANGE_M > GUN_MAX_EFFECTIVE_RANGE_M`. */
export const GUN_MAX_EFFECTIVE_RANGE_M = 1800;
export const WEAPON_DISPLAY_LABEL: Readonly<Record<WeaponKind, string>> = {
  gun: 'GUN',
  ir_missile: 'IR',
  radar_missile: 'RDR',
} as const;

// -----------------------------------------------------------------------------
// 8. Public factories and the two runtime systems src/core creates, drives,
//    and injects data into every frame. Every method must be allocation-free
//    in steady state (see 08-render.md section 6) and non-blocking.
// -----------------------------------------------------------------------------

/**
 * The active theatre's look, derived by src/main from the mission's TerrainParams and airport
 * layouts: ground colouring style, water level (absent = no water) and the runways to paint.
 */
export interface SceneEnvironment {
  surfaceStyle: 'default' | 'coastal' | 'farmland';
  waterLevelM?: number;
  /** Coast theatres only: shoreline X and headland weight sampled along Z (see contracts/terrain.ts CoastProfile). */
  coast?: { z0: number; dz: number; shoreX: readonly number[]; headland: readonly number[]; plainRiseMPerKm: number; hillsStartM: number; hillsRampM: number };
  /** Typical ground elevation (m MSL) for the far-ground ring beyond the streamed terrain. */
  groundLevelM?: number;
  /** Fair-weather cumulus (absent = clear sky): fraction of 3.5 km cells with a cloud, base/top m MSL, seed. */
  clouds?: { coverage: number; baseM: number; topM: number; seed: number };
  /** Plains theatres: rivers packed by src/terrain/riverMath.ts packRiver (16 floats each). */
  rivers?: { packed: readonly number[]; count: number };
  /** Coast theatres: estuaries packed by src/terrain/coastMath.ts packEstuary (16 floats each). */
  estuaries?: { packed: readonly number[]; count: number };
  /** Airbases' paved surfaces as one mesh (src/airport/pavementGeometry.ts), drawn with markings. */
  pavement?: { positions: Float32Array; surf: Float32Array; extra: Float32Array; indices: Uint32Array };
  /** Airbase structures (contracts/airport.ts StructureDef, placed at their base's elevation). */
  structures?: readonly { kind: string; worldX: number; worldY: number; worldZ: number; headingRad: number; widthM: number; lengthM: number; heightM: number; side: string }[];
  /** Per airbase: taxiway edge lights, floodlights, PAPIs and signs (src/airport/airfieldAids.ts). */
  airfieldAids?: readonly {
    groundY: number;
    taxiEdgeLights: readonly (readonly [number, number])[];
    floodlights: readonly (readonly [number, number])[];
    papi: readonly { x: number; z: number; approachX: number; approachZ: number; angleRad: number }[];
    signs: readonly { x: number; z: number; headingRad: number; text: string; style: 'mandatory' | 'direction' | 'distance' }[];
  }[];
  /** Per airbase: where the airfield ground is (src/airport/airfieldMask.ts), for the ground shader. */
  airfieldMasks?: readonly { minX: number; minZ: number; sizeM: number; data: Uint8Array }[];
  /** One entry per physical runway (not per direction). */
  runways: readonly { centerX: number; centerZ: number; headingRad: number; lengthM: number; widthM: number }[];
}

export interface SceneRenderer {
  /** Call on window resize / orientation change / initial mount. */
  resize(widthPx: number, heightPx: number, devicePixelRatio: number): void;
  setQualityTier(tier: QualityTier): void;
  setCameraMode(mode: CameraMode): void;
  /** Only meaningful in CameraMode.External; deltas are radians/radians/metres applied to the orbit state. */
  orbitCamera(deltaYawRad: number, deltaPitchRad: number, deltaZoomM: number): void;
  /**
   * Registers the single wireframe model used to draw every EntityKind
   * 'aircraft' entity (this project has exactly one aircraft type, the
   * Tejas — see 08-render.md section 9). Must be called once before the
   * first ingestSnapshot that contains an aircraft entity.
   */
  registerAircraftModel(model: WireframeModel): void;
  setNavDb(navDb: AirportNavDb): void;
  /** Sets the theatre look (ground style, water, sky/fog tint, runways). Call on each mission load. */
  setEnvironment(env: SceneEnvironment): void;
  /** World-frame unit vector toward the sun, used for sky gradient + directional light + shadows. */
  setSunDirection(dirWorld: Vec3Like): void;
  /** Local solar time, hours (0-24): sun and moon positions, sky, light, stars, night lights. Overrides setSunDirection. */
  setTimeOfDay(hours: number): void;
  /** Visual weather: a preset, or 'dynamic' (random, changing every few minutes; seeded). */
  setWeather(mode: WeatherMode, seed: number): void;
  /** The theatre's villages and towns for the terrain's distant town layer (null = none). */
  setSettlements(layer: SettlementLayer | null): void;
  /**
   * Copies everything this frame's render needs out of `view` synchronously
   * before returning (per-entity pos/rot/kind/team/alive/elevonL/elevonR/
   * rudder/gearPos/throttle/afterburnerOn/flags via core.ts's SnapshotEntity
   * offsets). MUST NOT retain a reference to `view` after returning — the
   * caller transfers the underlying ArrayBuffer back to the sim worker
   * immediately afterward (see 00-architecture.md section 5).
   */
  ingestSnapshot(view: Float64Array): void;
  /** Spawns/updates cosmetic effects (explosion, muzzleFlash, smokeTrail) from this tick's events. Call once per received SimEventsMessage, in tick order. */
  ingestEvents(events: readonly SimEvent[]): void;
  /** Uploads chunk geometry received from terrain.worker.ts (relayed by src/core's main.ts). Takes ownership of the three transferred ArrayBuffers (zero-copy). */
  ingestTerrainChunk(msg: TerrainChunkReadyMessage): void;
  /** Frees GPU resources for a chunk src/terrain's chunk manager has evicted. No-op if the chunk was never ingested or already evicted. */
  evictTerrainChunk(chunkX: number, chunkZ: number, lod: number): void;
  /**
   * Advances snapshot interpolation, floating-origin rebase, camera pose,
   * and draws one frame. Returns a reused, mutable CameraState — callers
   * must read it synchronously (pass straight to HudRenderer.renderFrame)
   * and must not retain it past the current call.
   */
  renderFrame(nowMs: number): CameraState;
  dispose(): void;
}

/** A facility labelled on the HUD close to an airbase. World x, y (ground level), z. */
export interface HudFacility {
  kind: 'runway' | 'stand' | 'hangar' | 'tower' | 'fuel' | 'arms' | 'radar';
  label: string;
  x: number;
  y: number;
  z: number;
}

/** An airbase for the HUD's navigation markers. x, z = its reference point; y = field elevation. */
export interface HudAirbase {
  id: string;
  name: string;
  side: 'friendly' | 'hostile';
  x: number;
  y: number;
  z: number;
  /** Runway designators for the label, e.g. "08/26". */
  runways: string;
  facilities: readonly HudFacility[];
}

export interface HudRenderer {
  resize(widthPx: number, heightPx: number, devicePixelRatio: number): void;
  setQualityTier(tier: QualityTier): void;
  /** Display unit for the airspeed tape only; defaults to 'ms' (SnapshotHud.IAS_MPS's own wire unit) until called. */
  setSpeedUnit(unit: SpeedUnit): void;
  /** Same synchronous-copy contract as SceneRenderer.ingestSnapshot. */
  ingestSnapshot(view: Float64Array): void;
  /** Drives ammo decrement (gunFire/missileLaunch), warning toasts, and lock/kill toasts. */
  ingestEvents(events: readonly SimEvent[]): void;
  /**
   * Taxi guidance: a route (world x, z points, the base's ground level), with the runway holding
   * point index and the destination (runway id, or stand number); a message alone (e.g. no route);
   * or null to clear. The HUD draws a follow-me cue along it and clears it on arrival or take-off.
   */
  setTaxiGuide(guide: { points: readonly (readonly [number, number])[]; groundY: number; holdIndex: number; runwayId: string; standNumber: number } | { message: string } | null): void;
  /** True while a taxi route is being shown. */
  hasTaxiGuide(): boolean;
  /**
   * The mission's airbases for the HUD's navigation markers (src/hud/airbaseMarkers.ts): every
   * base on the heading tape, friendly ones as a marker over the field, and their facilities
   * labelled when the player is on or low over the field. Empty = none.
   */
  setAirbases(bases: readonly HudAirbase[]): void;
  /** Steps the radar display's range scale up (+1) or down (-1). */
  cycleRadarRange(dir: 1 | -1): void;
  /** Sets/resets the ammo counters the weapon-status widget decrements locally; call at spawn and at any rearm.
   *  `names` labels the missile types (e.g. 'ASRAAM', 'ASTRA') in place of the generic IR/RDR. */
  setWeaponLoadout(ammoGun: number, missilesIr: number, missilesRadar: number, names?: { ir?: string; radar?: string }): void;
  /** Debug-only overlay (src/hud/controlSurfaceDebug.ts): live elevonL/elevonR/rudder as text + bar gauges. Off by default; not a player-facing Settings option — src/main.ts toggles it on a raw F9 keydown for FCS debug testing. */
  setDebugSurfacesEnabled(enabled: boolean): void;
  /** camera must be the SAME-FRAME value SceneRenderer.renderFrame just returned (or a previous frame's if in a HUD-only/no-3D debug mode — target box + lead sight are simply not drawn while camera is stale beyond one frame; see 08-render.md 4.6). */
  renderFrame(nowMs: number, camera: CameraState): void;
  dispose(): void;
}

export type CreateSceneRenderer = (canvas: HTMLCanvasElement, initialTier: QualityTier) => SceneRenderer;
export type CreateHudRenderer = (canvas: HTMLCanvasElement, initialTier: QualityTier) => HudRenderer;
