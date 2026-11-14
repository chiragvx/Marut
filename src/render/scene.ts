/**
 * src/render/scene.ts
 *
 * Three.js Scene/WebGLRenderer/root-group setup; implements
 * `CreateSceneRenderer`; owns the per-frame draw call orchestration.
 * 08-render.md section 4.14 (AA + context loss), section 3 (call sequence).
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';

import { AIRCRAFT_MODEL_MASK, AIRCRAFT_MODEL_SHIFT, AircraftModel, aircraftModelOf, EntityFlag, EntityKindCode, HUD_BLOCK_START, ServiceStateCode, SnapshotHud, unpackEngines, unpackUnits4, type QualityTier } from '../contracts/core';
import {
  AntiAliasMode,
  CAMERA_FAR_M,
  CAMERA_MIN_GROUND_CLEARANCE_M,
  CAMERA_NEAR_M,
  CHASE_VERTICAL_FOV_DEG,
  CameraMode,
  COCKPIT3D_VERTICAL_FOV_DEG,
  COCKPIT_VERTICAL_FOV_DEG,
  POD_MOUNT_BODY_M,
  EXTERNAL_VERTICAL_FOV_DEG,
  FLYBY_VERTICAL_FOV_DEG,
  RENDER_QUALITY_TABLE,
  type CameraState,
  type CockpitAuxState,
  type CockpitPilotControls,
  type CreateSceneRenderer,
  type SceneRenderer,
} from '../contracts/render';

import { computeCameraPose, createCameraModeState, createCameraPose, keepAboveGround, lookCamera } from './cameraModes';
import { rotateVecByQuat } from './mathInternal';
import { createEffectsSystem } from './effects';
import { createFloatingOriginState, updateFloatingOrigin } from './floatingOrigin';
import {
  createInterpolatedEntity,
  createSnapshotDoubleBuffer,
  ingestSnapshotIntoBuffer,
  interpolateEntity,
  advanceRenderClock,
} from './snapshotInterpolation';
import { createSkyFogSystem } from './skyFog';
import { createTerrainChunkConsumer } from './terrainChunkConsumer';
import { createUrbanCache } from './urbanCache';
import { createChunkFeatureRenderer } from './chunkFeatureRenderer';
import { createCloudSystem } from './clouds';
import { createCloudDeck } from './cloudDeck';
import { createRain } from './rain';
import { createRunwayLights, setLightViewport } from './nightLights';
import { createAirfieldPavement } from './airfieldPavement';
import { createAirbaseStructures } from './airbaseStructures';
import { createGroundUnitRenderer } from './groundUnits';
import { createGroundEffects } from './groundEffects';
import { createRunwayCraters } from './runwayCraters';
import { createAirfieldSigns } from './airfieldSigns';
import { createHangarBay } from './hangarBay';
import { createFarGround } from './farGround';
import { getAtmosphereUniforms, setAtmosphereCamera, setAtmosphereHaze } from './atmosphere';
import type { SimEvent, WeatherMode } from '../contracts/core';
import type { SceneEnvironment } from '../contracts/render';
import {
  computeSkyLight,
  createDynamicWeather,
  createSkyLight,
  latitudeFor,
  moonDirAt,
  sunDirAt,
  weatherPreset,
  type Dir3,
  type DynamicWeather,
  type WeatherState,
} from './skyState';
import { createGrade } from './postGrade';
import { createSunShadows } from './sunShadows';
import { TERRAIN_QUALITY_PROFILES, TERRAIN_WORLD_EXTENT_M } from '../contracts/terrain';
import { createMeshAircraftRenderer, type MeshAircraftRenderer } from './meshAircraftRenderer';
import { airHumidity } from './vapour';

/** Dev: ?humid=0..1 overrides the air's humidity (to see the vapour effects in any weather). */
const DEV_HUMIDITY = import.meta.env.DEV ? Number(new URLSearchParams(location.search).get('humid') ?? NaN) : NaN;
import { createDroneRenderer } from './droneModel';
import { buildTejasModel } from './aircraftModels/tejasModel';
import { JF17_FIT, JF17_GLB_URL, loadGltfAircraftModel, TEJAS_GLB_URL } from './aircraftModels/gltfModel';
import { LIVERY_MAP, tejasLiveryTexture } from './aircraftModels/tejasLivery';
import { C17_FIT, loadC17Model } from './aircraftModels/c17Model';
import { applyC17PoseOverride, c17PoseCycle, parseC17PoseOverride } from './aircraftModels/c17Pose';

/**
 * Dev aids for looking at another type's model before it flies: ?model=c-17 (or jf-17) draws the
 * player's aircraft with that model (its own flight model unchanged; a C-17 on the Tejas's physics
 * is lifted so its wheels meet the ground), and with the C-17 ?pose=flaps:1,ramp:1,gear:0 (keys gear,
 * flaps, slats, spoilers, rev, ramp, troop, door, n1; 0..1) or ?pose=cycle (each group in turn)
 * poses its parts (c17Pose.ts).
 */
const DEV_PARAMS = import.meta.env.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search) : undefined;
const DEV_MODEL = ((): number | undefined => {
  const m = DEV_PARAMS?.get('model')?.toLowerCase().replace('-', '');
  return m === 'c17' ? AircraftModel.C17 : m === 'jf17' ? AircraftModel.Jf17 : m === 'tejas' ? AircraftModel.Tejas : undefined;
})();
let devPose = parseC17PoseOverride(DEV_PARAMS?.get('pose'));
let devPoseRaw: string | undefined;
/** Dev: the pose override, also settable at run time (globalThis.__c17Pose = 'ramp:1'; for scripted checks). */
function devPoseNow(): typeof devPose {
  const g = (globalThis as { __c17Pose?: string }).__c17Pose;
  if (import.meta.env.DEV && g !== undefined && g !== devPoseRaw) {
    devPoseRaw = g;
    devPose = parseC17PoseOverride(g);
  }
  return devPose;
}
/** Dev: ?camrel=dx,dy,dz[,lookY] holds the camera at that offset from the player (world axes, m), looking at it. */
const DEV_CAMREL = ((): number[] | undefined => {
  const v = DEV_PARAMS?.get('camrel')?.split(',').map(Number);
  return v && v.length >= 3 && v.every(Number.isFinite) ? v : undefined;
})();
/** Tejas wheel contact below its CG (aircraft/tejasGeometry.ts gear y) less the C-17's (c17Model.ts C17_FIT), m. */
const DEV_C17_LIFT_M = 4.25 - 1.7;
/** Tejas length, m: the outside cameras scale with a model's length against it. */
const TEJAS_LENGTH_M = 13.2;
/** Each model's length against the Tejas's (cameraModes.ts subjectScale). */
const MODEL_SCALE: Partial<Record<number, number>> = { [AircraftModel.C17]: C17_FIT.lengthM / TEJAS_LENGTH_M };

/** The Tejas with its livery (markings, panel lines). */
const withLivery = <T extends { livery?: unknown }>(m: T): T => ({ ...m, livery: { texture: tejasLiveryTexture(), map: LIVERY_MAP } });
import { createCockpitSystem, type CockpitSystem } from './cockpit';
import { CockpitPass } from './cockpit/pass';
import { TEJAS_COCKPIT } from './cockpit/layouts/tejas';
import type { CockpitFlight } from './cockpit/types';

const FOV_BY_MODE: Readonly<Record<CameraMode, number>> = {
  [CameraMode.Cockpit]: COCKPIT_VERTICAL_FOV_DEG,
  [CameraMode.Cockpit3d]: COCKPIT3D_VERTICAL_FOV_DEG,
  [CameraMode.Chase]: CHASE_VERTICAL_FOV_DEG,
  [CameraMode.External]: EXTERNAL_VERTICAL_FOV_DEG,
  [CameraMode.Flyby]: FLYBY_VERTICAL_FOV_DEG,
  [CameraMode.Tgp]: 18,
};

/** The hangar lamps' light on the jet in the loadout view (linear RGB). */
const HANGAR_FILL = [0.42, 0.4, 0.37] as const;

export const createSceneRenderer: CreateSceneRenderer = (canvas, initialTier) => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(COCKPIT_VERTICAL_FOV_DEG, 1, CAMERA_NEAR_M, CAMERA_FAR_M);

  let renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  let composer = new EffectComposer(renderer);
  let renderPass = new RenderPass(scene, camera);
  let thermalPolarity: 1 | 2 = 1;
  let grade = createGrade();
  // The 3D cockpit, drawn over the world in its own pass (src/render/cockpit); built on first use.
  const cockpitPass = new CockpitPass();
  let cockpit: CockpitSystem | null = null;
  let sizeW = 1;
  let sizeH = 1;
  let cssW = 1;
  let cssH = 1;

  function rebuildComposerAndPasses(): void {
    composer = new EffectComposer(renderer);
    renderPass = new RenderPass(scene, camera);
    // FXAA and colour grading/lens effects are one fused pass (postGrade.ts); a grade-only pass
    // replaces it on tiers without anti-aliasing.
    grade = createGrade();
    grade.setSize(sizeW, sizeH);
    composer.addPass(renderPass);
    composer.addPass(cockpitPass);
    composer.addPass(grade.fxaaPass);
    composer.addPass(grade.gradePass);
  }
  rebuildComposerAndPasses();

  let contextLost = false;
  canvas.addEventListener('webglcontextlost', (e: Event) => {
    e.preventDefault();
    contextLost = true;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    rebuildComposerAndPasses();
    // Every THREE.BufferGeometry (wireframe aircraft, terrain chunks, airport
    // lines, effect pools) is still held CPU-side by this module's own
    // systems above — the new WebGLRenderer has no buffer cache for them, so
    // it re-uploads each one automatically the next time it renders them
    // (08-render.md section 4.14). No explicit re-request to any worker.
    applyQualityTier(tier);
    contextLost = false;
  });

  const aircraftRoot = new THREE.Group();
  scene.add(aircraftRoot);
  // Solid articulated aircraft; it replaces the original wireframe, so registerAircraftModel's
  // WireframeModel is no longer drawn. The procedural Tejas draws at once; the imported, textured
  // model (public/models/tejas.glb) replaces it when loaded (aircraftModelReady: the loading screens
  // wait for it). Dev aid: ?jetmodel=classic keeps the procedural one.
  let aircraftRenderer = createMeshAircraftRenderer(aircraftRoot, withLivery(buildTejasModel()));
  /** Target drones (EntityFlag.Drone) have their own model. */
  const drones = createDroneRenderer(aircraftRoot);
  let sceneDisposed = false;
  let modelReady = true;
  const importedModels = typeof location === 'undefined' || new URLSearchParams(location.search).get('jetmodel') !== 'classic';
  if (importedModels) {
    modelReady = false;
    loadGltfAircraftModel(TEJAS_GLB_URL)
      .then((template) => {
        if (sceneDisposed) return;
        aircraftRenderer.dispose();
        aircraftRenderer = createMeshAircraftRenderer(aircraftRoot, template);
      })
      .catch((err: unknown) => console.warn('[aircraft] imported model failed to load; keeping the procedural Tejas', err))
      .finally(() => {
        modelReady = true;
      });
  }
  // Other types' models (contracts/core.ts AircraftModel, from the entity's flags), by model code:
  // each loads the first time one is seen (drawn as the Tejas until then, or if it fails).
  let lastHumidity = 0.45;
  const typeRenderers: (MeshAircraftRenderer | undefined)[] = [];
  const typeRequested: boolean[] = [];
  const TYPE_MODELS: Partial<Record<number, () => Promise<MeshAircraftRenderer>>> = {
    [AircraftModel.Jf17]: () => loadGltfAircraftModel(JF17_GLB_URL, JF17_FIT).then((t) => createMeshAircraftRenderer(aircraftRoot, t)),
    // A few at most in any mission (each is ~70 draw calls with its gear down).
    [AircraftModel.C17]: () => loadC17Model().then((t) => createMeshAircraftRenderer(aircraftRoot, t, 16)),
  };
  function rendererFor(flags: number): MeshAircraftRenderer {
    const code = aircraftModelOf(flags);
    if (code === AircraftModel.Tejas) return aircraftRenderer;
    const r = typeRenderers[code];
    if (r) return r;
    const load = TYPE_MODELS[code];
    if (load && importedModels && !typeRequested[code]) {
      typeRequested[code] = true;
      load()
        .then((made) => {
          if (sceneDisposed) {
            made.dispose();
            return;
          }
          made.setHumidity(lastHumidity);
          typeRenderers[code] = made;
        })
        .catch((err: unknown) => console.warn(`[aircraft] model ${code} failed to load; drawn as the Tejas`, err));
    }
    return aircraftRenderer;
  }
  /** Every aircraft renderer (the Tejas's first). */
  function eachRenderer(fn: (r: MeshAircraftRenderer) => void): void {
    fn(aircraftRenderer);
    for (const r of typeRenderers) if (r) fn(r);
  }
  const aircraftState = {
    elevonL: 0,
    elevonR: 0,
    rudder: 0,
    gearPos: 0,
    throttle: 0,
    afterburner: false,
    abStage: 1,
    airbrakeOut: false,
    onGround: false,
    team: 0,
    vel: { x: 0, y: 0, z: 0 },
    stores: 0,
    storesB: 0,
    flags: 0,
    groundY: undefined as number | undefined,
    // Transports' parts (meshAircraftRenderer.ts MeshAircraftState; the C-17's rig): unset = stowed defaults.
    flaps: undefined as number | undefined,
    slats: undefined as number | undefined,
    spoilers: undefined as number | undefined,
    reversers: undefined as readonly number[] | undefined,
    ramp: undefined as number | undefined,
    troopDoors: undefined as number | undefined,
    crewDoor: undefined as number | undefined,
    n1: undefined as readonly number[] | undefined,
  };
  /** Clears the transport fields (the state object is reused for every aircraft). */
  function clearTransportState(st: typeof aircraftState): void {
    st.flaps = undefined;
    st.slats = undefined;
    st.spoilers = undefined;
    st.reversers = undefined;
    st.ramp = undefined;
    st.troopDoors = undefined;
    st.crewDoor = undefined;
    st.n1 = undefined;
  }
  /** Dev (?model=): the player's flags with the model swapped. */
  const devFlags = (flags: number): number => (DEV_MODEL === undefined ? flags : (flags & ~AIRCRAFT_MODEL_MASK) | (DEV_MODEL << AIRCRAFT_MODEL_SHIFT));
  const devLiftedPos = { x: 0, y: 0, z: 0 };
  const hlScratch = [0, 0, 0, 0], n1Scratch = [0, 0, 0, 0], revScratch = [0, 0, 0, 0];

  const terrainRoot = new THREE.Group();
  scene.add(terrainRoot);
  const terrainConsumer = createTerrainChunkConsumer(terrainRoot);
  // Street and lot detail of the urban layer, baked around the camera (urbanCache.ts).
  const urbanCache = createUrbanCache();

  const featureRoot = new THREE.Group();
  scene.add(featureRoot);
  const features = createChunkFeatureRenderer(featureRoot);
  const featureKey = (cx: number, cz: number, lod: number): string => `${cx}:${cz}:${lod}`;

  const effectsRoot = new THREE.Group();
  scene.add(effectsRoot);
  const effects = createEffectsSystem(effectsRoot);
  const groundEffects = createGroundEffects(effectsRoot);
  const craters = createRunwayCraters();
  effectsRoot.add(craters.object);
  const viewSize = new THREE.Vector2();


  const skyFog = createSkyFogSystem(scene);
  const farGround = createFarGround(scene);
  const sunShadows = createSunShadows();
  const shadowFocus = new THREE.Vector3();
  const clouds = createCloudSystem(scene);
  const deck = createCloudDeck(scene);
  const rain = createRain(scene);
  const runwayLights = createRunwayLights(scene);
  const pavement = createAirfieldPavement(scene);
  const structures = createAirbaseStructures(scene);
  const groundUnits = createGroundUnitRenderer(scene);
  const groundPos = { x: 0, y: 0, z: 0 };
  const groundRot = { x: 0, y: 0, z: 0, w: 1 };
  const signs = createAirfieldSigns(scene);
  const hangarBay = createHangarBay(scene);
  let hangarHidden: string | null = null;
  /** The loadout view's hangar: its interior shown, the closed shed it stands in hidden. */
  const setHangar = (bay: import('../contracts/render').ShowcaseFrame['hangar'] | null): void => {
    hangarBay.set(bay ?? null);
    const hide = bay?.hideTargetId ?? null;
    if (hide !== hangarHidden) {
      structures.setHidden(hide);
      hangarHidden = hide;
    }
  };
  /** The player's ground-service state and heading from the latest snapshot (for the service vehicles). */
  let playerServiceState = 0;
  let playerHeadingRad = 0;
  /** Overcast deck base/top per theatre, m MSL. */
  const DECK_LEVELS: Readonly<Record<SceneEnvironment['surfaceStyle'], [number, number]>> = {
    coastal: [1000, 1450],
    farmland: [1150, 1600],
    default: [1200, 1650],
  };

  /** The player's aircraft for the 3D cockpit, filled each frame. */
  const cockpitFlight: CockpitFlight = {
    valid: false,
    simTimeSec: 0,
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 0, y: 0, z: 0 },
    hud: new Float64Array(0),
    flags: 0,
    throttle: 0,
    afterburner: false,
    gearPos: 1,
    elevonL: 0,
    elevonR: 0,
    rudder: 0,
    stores: 0,
    storesB: 0,
    targetValid: false,
    targetPos: { x: 0, y: 0, z: 0 },
    sunDir: { x: 0, y: 1, z: 0 },
    sunCol: { r: 1, g: 1, b: 1 },
    ambSky: { r: 0.4, g: 0.45, b: 0.5 },
    ambGround: { r: 0.3, g: 0.28, b: 0.25 },
    night: 0,
  };
  const cockpitControls: CockpitPilotControls = { pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false, brakes: 0, trigger: false };
  let cockpitAux: CockpitAuxState | null = null;
  const qWorldCam = new THREE.Quaternion();
  const qBodyCam = new THREE.Quaternion();
  const vEyeWorld = { x: 0, y: 0, z: 0 };
  function ensureCockpit(): CockpitSystem {
    if (!cockpit) {
      cockpit = createCockpitSystem(TEJAS_COCKPIT);
      cockpit.setControls(cockpitControls);
      if (cockpitAux) cockpit.setAux(cockpitAux);
      cockpit.setShadowQuality(tier === 'low' ? 1024 : 2048);
      cockpitPass.scene = cockpit.scene;
      cockpitPass.camera = cockpit.camera;
    }
    return cockpit;
  }

  const snapshotBuf = createSnapshotDoubleBuffer();
  const floatingOrigin = createFloatingOriginState();
  const cameraModeState = createCameraModeState();
  const cameraPose = createCameraPose();
  const WORLD_UP = { x: 0, y: 1, z: 0 } as const;
  const interpEntity = createInterpolatedEntity();
  const interpTarget = createInterpolatedEntity();

  const debugCam = ((): number[] | undefined => {
    if (typeof location === 'undefined') return undefined;
    const v = new URLSearchParams(location.search).get('cam')?.split(',').map(Number);
    return v && v.length === 6 && v.every(Number.isFinite) ? v : undefined;
  })();
  let tier: QualityTier = initialTier;
  /** Ground height under a point (the world's height sampler), for keeping outside views above it. */
  let groundHeightAt: ((x: number, z: number) => number) | null = null;
  /** The menu's cinematic, drawn instead of the flight while set. */
  let showcase: import('../contracts/render').ShowcaseFrame | null = null;
  /** The cinematic shot's clock last frame (its events play as the clock passes them); NaN: none yet. */
  let showcaseLastT = NaN;
  let mode: CameraMode = CameraMode.Chase;
  let lastFrameMs = -1;

  const cameraState: CameraState = {
    viewProjectionMatrix: new Array(16).fill(0),
    originWorld: { x: 0, y: 0, z: 0 },
    worldPos: { x: 0, y: 0, z: 0 },
  };
  const scratchProjMatrix = new THREE.Matrix4();
  const cameraWorldRot = { x: 0, y: 0, z: 0, w: 1 };
  const subjectPos = { x: 0, y: 0, z: 0 };
  const subjectRot = { x: 0, y: 0, z: 0, w: 1 };

  // --- Time of day and weather (skyState.ts) ---
  let timeOfDayH: number | undefined;
  let weatherMode: WeatherMode = 'clear';
  let dynamicWeather: DynamicWeather | undefined;
  let weatherSeed = 1;
  let style: SceneEnvironment['surfaceStyle'] = 'default';
  let fixedWeather: WeatherState = weatherPreset('clear', style);
  const skyLight = createSkyLight();
  const sunDir: Dir3 = { x: 0.4, y: 0.7, z: -0.3 };
  const moonDir: Dir3 = { x: 0, y: -1, z: 0 };
  const lastKey = { x: NaN, y: NaN, z: NaN };
  let wet = 0;
  const skyAbove = createSkyLight();
  const effWeather: WeatherState = { ...fixedWeather };
  const camPrev = { x: NaN, y: NaN, z: NaN };
  const camVel = { x: 0, y: 0, z: 0 };
  let lastCoverage = -1;
  let lastDark = -1;

  function resetWeather(): void {
    fixedWeather = weatherPreset(weatherMode === 'dynamic' ? 'clear' : weatherMode, style);
    dynamicWeather = weatherMode === 'dynamic' ? createDynamicWeather(style, weatherSeed) : undefined;
    const w = dynamicWeather ? dynamicWeather.current : fixedWeather;
    wet = w.rain;
    lastCoverage = -1;
  }

  /** Per frame: advance the weather, then set the sky, haze, light, clouds and glare from it. */
  function updateSky(dt: number, nowSec: number): void {
    const w0 = dynamicWeather ? dynamicWeather.update(dt) : fixedWeather;
    // Above the overcast deck the sky is clear and the sun full; below it, grey (and raining).
    const [deckBase, deckTop] = DECK_LEVELS[style];
    const camY = cameraPose.pos.y;
    const below = 1 - Math.max(0, Math.min(1, (camY - deckBase) / (deckTop - deckBase)));
    Object.assign(effWeather, w0);
    // Condensation over the wings wants humid air (vapour.ts): the weather itself, not the view of it.
    lastHumidity = Number.isFinite(DEV_HUMIDITY) ? DEV_HUMIDITY : airHumidity(w0, style);
    eachRenderer((r) => r.setHumidity(lastHumidity));
    effWeather.deck = w0.deck * below;
    effWeather.grey = w0.grey * (0.3 + 0.7 * below);
    const w = effWeather;
    // The ground takes a couple of minutes to get wet in rain, and longer to dry.
    wet += (w.rain - wet) * Math.min(1, dt / (w.rain > wet ? 90 : 300));
    if (timeOfDayH !== undefined) {
      const lat = latitudeFor(style);
      sunDirAt(timeOfDayH, lat, sunDir);
      moonDirAt(timeOfDayH, lat, moonDir);
    }
    computeSkyLight(sunDir, moonDir, skyFog.baseZenith, skyFog.baseHorizon, w, skyLight);
    skyFog.setSkyLight(skyLight, sunDir, moonDir);
    setAtmosphereHaze(w.visKm, w.hazeScaleM);
    const u = getAtmosphereUniforms();
    u.uAtmWet.value = wet;
    const fog = scene.fog as THREE.Fog;
    fog.near = 0.15 / u.uAtmHazeParams.value.x;
    fog.far = 3.0 / u.uAtmHazeParams.value.x;
    const k = skyLight.keyDir;
    if (k.x !== lastKey.x || k.y !== lastKey.y || k.z !== lastKey.z) {
      lastKey.x = k.x;
      lastKey.y = k.y;
      lastKey.z = k.z;
      terrainConsumer.setSunDirection(k);
      features.uniforms.uSunDir.value.set(k.x, k.y, k.z);
      pavement.setSunDirection(k);
      structures.setSunDirection(k);
      groundUnits.setSunDirection(k);
    }
    if (Math.abs(w.cumulus - lastCoverage) > 0.001 || Math.abs(w.cloudDark - lastDark) > 0.01) {
      lastCoverage = w.cumulus;
      lastDark = w.cloudDark;
      clouds.setWeather(w.cumulus, w.cloudDark);
    }
    grade.setGlare(skyLight.glare);

    // Deck, lit from above by the unobstructed sun.
    effWeather.deck = 0;
    computeSkyLight(sunDir, moonDir, skyFog.baseZenith, skyFog.baseHorizon, effWeather, skyAbove);
    effWeather.deck = w0.deck * below;
    const origin = floatingOrigin.originWorld;
    deck.setLevels(deckBase, deckTop);
    deck.update(cameraPose.pos, origin, w0.deck, w0.cloudDark, skyAbove.keyCol, nowSec);

    // Rain below the cloud base, streaking with the camera's own speed.
    const p = cameraPose.pos;
    if (Number.isFinite(camPrev.x) && dt > 0) {
      const vx = (p.x - camPrev.x) / dt;
      const vy = (p.y - camPrev.y) / dt;
      const vz = (p.z - camPrev.z) / dt;
      if (Math.hypot(vx, vy, vz) < 1500) {
        const k = Math.min(1, dt * 10);
        camVel.x += (vx - camVel.x) * k;
        camVel.y += (vy - camVel.y) * k;
        camVel.z += (vz - camVel.z) * k;
      }
    }
    camPrev.x = p.x;
    camPrev.y = p.y;
    camPrev.z = p.z;
    const rainBelow = 1 - Math.max(0, Math.min(1, (camY - (deckBase - 150)) / 150));
    rain.update(w0.rain * rainBelow, p, camVel, origin, nowSec);

    // Lights: towns at night; runways at night and in poor visibility.
    const murk = 1 - Math.max(0, Math.min(1, (w.visKm - 3) / 7));
    features.setNightLights(skyLight.lights);
    runwayLights.update(Math.max(skyLight.lights, murk * 0.8, w0.deck * 0.5), origin);
  }

  let shadowsOn = false;
  /** Terrain only casts sun shadows where there is relief to cast them (Goa's Ghats, the test terrain). */
  let hillyTheatre = false;

  function applyQualityTier(t: QualityTier): void {
    const settings = RENDER_QUALITY_TABLE[t];
    grade.setAntialias(settings.antialias !== AntiAliasMode.Off);
    grade.setTier(t);
    skyFog.setFog(settings.fogStartM, settings.fogEndM);
    // The terrain material fogs itself (it is a ShaderMaterial with fog: false), so it needs the
    // same distances; before this it stayed at its built-in 1.5-5 km on every tier.
    terrainConsumer.setFog(settings.fogStartM, settings.fogEndM);
    features.uniforms.uFogStart.value = settings.fogStartM;
    features.uniforms.uFogEnd.value = settings.fogEndM;
    // Sun shadows use their own map (sunShadows.ts); three's built-in shadow maps stay off, since
    // every world material is a custom shader.
    skyFog.setShadowsEnabled(false, 0);
    sunShadows.setTier(t);
    terrainConsumer.setShadowsEnabled(settings.shadowsEnabled && sunShadows.terrainCasts() && hillyTheatre);
    // Urban layer: the terrain worker builds 3D buildings only on chunks of depth >= 4.
    terrainConsumer.setUrbanQuality(TERRAIN_QUALITY_PROFILES[t].maxLodDepth >= 4);
    features.setRealShadowRadius(settings.shadowsEnabled ? sunShadows.radiusM() : 0, settings.shadowsEnabled && sunShadows.treesCast());
    effects.setBudget(settings.effectBudget);
    shadowsOn = settings.shadowsEnabled;
    cockpit?.setShadowQuality(t === 'low' ? 1024 : 2048);
    if (settings.antialias === AntiAliasMode.Msaa4x) {
      composer.renderTarget1.samples = 4;
      composer.renderTarget2.samples = 4;
    }
  }
  applyQualityTier(tier);

  const api: SceneRenderer = {
    resize(widthPx, heightPx, devicePixelRatio) {
      const cap = RENDER_QUALITY_TABLE[tier].pixelRatioCap;
      const ratio = Math.min(devicePixelRatio, cap);
      renderer.setPixelRatio(ratio);
      composer.setPixelRatio(ratio);
      renderer.setSize(widthPx, heightPx, false);
      composer.setSize(widthPx, heightPx);
      cssW = Math.max(1, widthPx);
      cssH = Math.max(1, heightPx);
      camera.aspect = widthPx / Math.max(heightPx, 1);
      camera.updateProjectionMatrix();
      sizeW = Math.round(widthPx * ratio);
      sizeH = Math.round(heightPx * ratio);
      grade.setSize(sizeW, sizeH);
      setLightViewport(sizeW, sizeH);
    },

    setQualityTier(t) {
      tier = t;
      applyQualityTier(t);
    },

    setCameraMode(m) {
      mode = m;
      if (m === CameraMode.Cockpit3d) ensureCockpit();
    },

    setThermalPolarity(p) {
      thermalPolarity = p;
    },

    lookCockpit(dYaw, dPitch, dFov) {
      if (mode === CameraMode.Cockpit3d) cockpit?.look(dYaw, dPitch, dFov);
    },

    recenterCockpit() {
      cockpit?.recenter();
    },

    setCockpitControls(c) {
      Object.assign(cockpitControls, c);
      cockpit?.setControls(cockpitControls);
    },

    setCockpitAux(a) {
      cockpitAux = { ...a };
      cockpit?.setAux(cockpitAux);
    },

    cockpitPointer(xPx, yPx, click) {
      if (mode !== CameraMode.Cockpit3d || !cockpit || showcase) return { action: null, hover: null };
      if (xPx === null) return cockpit.pointer(null, 0, false, 0, 0);
      return cockpit.pointer((xPx / cssW) * 2 - 1, -((yPx / cssH) * 2 - 1), click, xPx, yPx);
    },

    setGroundHeight(heightAt) {
      groundHeightAt = heightAt;
    },

    aircraftModelReady() {
      return modelReady;
    },
    setShowcase(frame) {
      if (!frame && showcase) {
        effects.reset();
        showcaseLastT = NaN;
      }
      if (!frame) {
        setHangar(null);
        eachRenderer((r) => r.setFillLight(0, 0, 0));
      }
      showcase = frame;
    },

    orbitCamera(deltaYawRad, deltaPitchRad, deltaZoomSteps) {
      lookCamera(mode, cameraModeState, deltaYawRad, deltaPitchRad, deltaZoomSteps);
    },

    setCameraOptions(o) {
      cameraModeState.chase.returnDelaySec = o.recenterSec > 0 ? o.recenterSec : Infinity;
    },

    glanceRad() {
      if (mode !== CameraMode.Cockpit) return 0;
      const c = cameraModeState.cockpit;
      return Math.hypot(c.yawRad, c.pitchRad);
    },

    registerAircraftModel() {
      // The mesh model (meshAircraftRenderer.ts) is drawn instead of the wireframe.
    },

    setNavDb(navDb) {
      runwayLights.setNavDb(navDb);
    },

    setTimeOfDay(hours) {
      timeOfDayH = ((hours % 24) + 24) % 24;
    },

    setSettlements(layer) {
      terrainConsumer.setSettlements(layer);
      urbanCache.setLayer(layer?.urban);
    },

    setWeather(m, seed) {
      weatherMode = m;
      weatherSeed = seed;
      resetWeather();
    },

    setSunDirection(dirWorld) {
      sunDir.x = dirWorld.x;
      sunDir.y = dirWorld.y;
      sunDir.z = dirWorld.z;
      skyFog.setSunDirection(dirWorld);
      terrainConsumer.setSunDirection(dirWorld);
      features.uniforms.uSunDir.value.set(dirWorld.x, dirWorld.y, dirWorld.z);
      clouds.setSunDirection(dirWorld);
    },

    setEnvironment(env) {
      skyFog.setStyle(env.surfaceStyle);
      style = env.surfaceStyle;
      terrainConsumer.setFogColor(skyFog.horizonColor);
      features.uniforms.uFogColor.value.copy(skyFog.horizonColor);
      clouds.setFog(skyFog.horizonColor, 0);
      clouds.setConfig(env.clouds);
      resetWeather();
      const shore = env.coast ? env.coast.shoreX.reduce((a, b) => a + b, 0) / env.coast.shoreX.length : undefined;
      farGround.setEnvironment(env, env.groundLevelM ?? 0, shore);
      terrainConsumer.setEnvironment(env);
      pavement.setGeometry(env.pavement ?? null, env.runways);
      structures.setStructures(env.structures);
      craters.clear();
      runwayLights.setAids(env.airfieldAids ?? []);
      signs.setSigns(env.airfieldAids ?? []);
      hillyTheatre = env.surfaceStyle !== 'farmland';
      applyQualityTier(tier);
    },

    ingestSnapshot(view) {
      playerServiceState = view[HUD_BLOCK_START + SnapshotHud.SERVICE_STATE] ?? 0;
      playerHeadingRad = view[HUD_BLOCK_START + SnapshotHud.HEADING_RAD] ?? 0;
      ingestSnapshotIntoBuffer(snapshotBuf, view, performance.now());
    },

    ingestEvents(events) {
      effects.ingestEvents(events);
      groundEffects.ingestEvents(events);
      craters.ingestEvents(events);
      for (const ev of events) if (ev.type === 'targetState') structures.setTargetState(ev.targetId, ev.state);
    },

    ingestTerrainChunk(msg) {
      terrainConsumer.ingestChunk(msg);
      const f = msg.features;
      if (f) {
        const size = TERRAIN_WORLD_EXTENT_M / Math.pow(2, msg.lod);
        features.ingest(
          featureKey(msg.chunkX, msg.chunkZ, msg.lod),
          {
            decalPositions: new Float32Array(f.decalPositions),
            decalAttribs: new Float32Array(f.decalAttribs),
            decalIndices: new Uint32Array(f.decalIndices),
            treeMatrices: f.treeMatrices.map((b) => new Float32Array(b)),
            treeColors: f.treeColors.map((b) => new Float32Array(b)),
            buildingMatrices: new Float32Array(f.buildingMatrices),
            buildingColors: new Float32Array(f.buildingColors),
            domeMatrices: new Float32Array(f.domeMatrices),
            houseMatrices: new Float32Array(f.houseMatrices),
            houseColors: new Float32Array(f.houseColors),
          },
          -TERRAIN_WORLD_EXTENT_M / 2 + (msg.chunkX + 0.5) * size,
          -TERRAIN_WORLD_EXTENT_M / 2 + (msg.chunkZ + 0.5) * size,
          size / 2
        );
      }
    },

    evictTerrainChunk(chunkX, chunkZ, lod) {
      terrainConsumer.evictChunk(chunkX, chunkZ, lod);
      features.evict(featureKey(chunkX, chunkZ, lod));
    },

    renderFrame(nowMs) {
      const frameDtSec = lastFrameMs < 0 ? 1 / 60 : Math.min(Math.max((nowMs - lastFrameMs) / 1000, 0), 0.25);
      lastFrameMs = nowMs;

      /** Everything that follows the floating origin and the camera. */
      const followOrigin = (origin: Readonly<{ x: number; y: number; z: number }>): void => {
        terrainConsumer.updateOrigin(origin);
        features.update(origin, cameraPose.pos);
        clouds.update(cameraPose.pos, origin);
        pavement.updateOrigin(origin);
        structures.update(origin, lastFrameMs / 1000);
        signs.updateOrigin(origin);
        hangarBay.updateOrigin(origin);
      };
      /** Points the three.js camera from cameraPose (after the floating origin has moved). */
      const placeCamera = (fovDeg: number): Readonly<{ x: number; y: number; z: number }> => {
        updateFloatingOrigin(floatingOrigin, cameraPose.pos);
        const origin = floatingOrigin.originWorld;
        camera.fov = fovDeg;
        camera.updateProjectionMatrix();
        eachRenderer((r) => r.setViewport(sizeH, camera.projectionMatrix.elements[5]!));
        camera.position.set(cameraPose.pos.x - origin.x, cameraPose.pos.y - origin.y, cameraPose.pos.z - origin.z);
        setAtmosphereCamera(cameraPose.pos);
        skyFog.followCamera(camera.position);
        farGround.update(origin);
        if (cameraPose.useLookAt) {
          const up = showcase ? (showcase.up ?? WORLD_UP) : cameraPose.up;
          camera.up.set(up.x, up.y, up.z);
          camera.lookAt(cameraPose.lookAt.x - origin.x, cameraPose.lookAt.y - origin.y, cameraPose.lookAt.z - origin.z);
        } else {
          camera.quaternion.set(cameraPose.rot.x, cameraPose.rot.y, cameraPose.rot.z, cameraPose.rot.w);
        }
        return origin;
      };

      // The 3D view plays the snapshots back on the sim's clock (snapshotInterpolation.ts).
      const fInterp = snapshotBuf.hasData ? advanceRenderClock(snapshotBuf, nowMs) : 1;
      let subjectDrawn = false;
      if (showcase) {
        // The menu's cinematic: a scripted camera and aircraft, no flight.
        const sc = showcase;
        cameraPose.pos.x = sc.camPos.x;
        cameraPose.pos.y = sc.camPos.y;
        cameraPose.pos.z = sc.camPos.z;
        cameraPose.lookAt.x = sc.lookAt.x;
        cameraPose.lookAt.y = sc.lookAt.y;
        cameraPose.lookAt.z = sc.lookAt.z;
        cameraPose.useLookAt = true;
        shadowFocus.set(sc.aircraft[0]?.pos.x ?? sc.lookAt.x, sc.aircraft[0]?.pos.y ?? sc.lookAt.y, sc.aircraft[0]?.pos.z ?? sc.lookAt.z);
        structures.setServiceVehicles(null);
        setHangar(sc.hangar ?? null);
        if (sc.hangar) eachRenderer((r) => r.setFillLight(HANGAR_FILL[0], HANGAR_FILL[1], HANGAR_FILL[2]));
        else eachRenderer((r) => r.setFillLight(0, 0, 0));
        // Subject off-centre (clear of the menu): shift the frustum, not the camera.
        if (sc.offsetX) camera.setViewOffset(sizeW, sizeH, -sc.offsetX * sizeW, 0, sizeW, sizeH);
        else if (camera.view) camera.clearViewOffset();
        const origin = placeCamera(sc.fovDeg);
        // On the shot's own clock when it has one: the effects step with it (frame-by-frame
        // captures, slow motion), and its events play as the clock passes them. A jump (a new
        // shot, a capture starting) starts the effects over.
        let showDt = frameDtSec;
        let showTime = nowMs / 1000;
        if (sc.timeSec !== undefined) {
          const step = sc.timeSec - showcaseLastT;
          if (!(step >= 0 && step < 0.3)) {
            effects.reset();
            showDt = 0;
          } else {
            showDt = step;
            const due: SimEvent[] = [];
            for (const e of sc.events ?? []) if (e.t > showcaseLastT && e.t <= sc.timeSec) due.push(e.ev);
            if (due.length) {
              effects.ingestEvents(due);
              groundEffects.ingestEvents(due);
            }
          }
          showcaseLastT = sc.timeSec;
          showTime = sc.timeSec;
        }
        eachRenderer((r) => r.beginFrame(showDt, origin, cameraPose.pos, showTime));
        for (const st of sc.stores ?? []) aircraftRenderer.updateMissile(st.code, st.pos, st.vel, st.rot, origin, st.flags ?? 0);
        for (const a of sc.aircraft) {
          const st = aircraftState;
          st.elevonL = 0;
          st.elevonR = 0;
          st.rudder = 0;
          st.gearPos = a.gearPos;
          st.throttle = a.throttle;
          st.afterburner = a.afterburner;
          st.abStage = 1;
          st.airbrakeOut = false;
          st.onGround = false;
          st.team = a.team ?? 0;
          st.vel = a.vel;
          st.stores = a.stores;
          st.storesB = a.storesB;
          st.flags = a.flags;
          st.groundY = a.groundY;
          rendererFor(a.flags).updateEntity(a.id, a.pos, a.rot, st, origin);
        }
        eachRenderer((r) => r.endFrame());
        renderer.getDrawingBufferSize(viewSize);
        effects.setView(viewSize.x, viewSize.y);
        effects.syncShowcase(sc, origin);
        effects.tick(showDt, origin);
        groundEffects.tick(showDt, origin, viewSize.y, camera.fov);
        followOrigin(origin);
      } else if (snapshotBuf.hasData && snapshotBuf.curr.playerSlot >= 0) {
        subjectDrawn = true;
        const curr = snapshotBuf.curr;
        const playerSlot = curr.playerSlot;
        const f = fInterp;

        interpolateEntity(snapshotBuf, playerSlot, f, interpEntity);
        // The subject's pose (the engine sound's emitter) is taken now: interpEntity is reused below
        // for every missile, dropped store and aircraft, and then holds the last one drawn.
        Object.assign(subjectPos, interpEntity.pos);
        Object.assign(subjectRot, interpEntity.rot);
        shadowFocus.set(interpEntity.pos.x, interpEntity.pos.y, interpEntity.pos.z);
        const cf = cockpitFlight;
        cf.valid = true;
        cf.simTimeSec = snapshotBuf.renderSimSec;
        Object.assign(cf.pos, interpEntity.pos);
        Object.assign(cf.rot, interpEntity.rot);
        Object.assign(cf.vel, interpEntity.vel);
        cf.hud = curr.hud;
        cf.flags = curr.flags[playerSlot]!;
        cf.throttle = interpEntity.throttle;
        cf.afterburner = curr.afterburnerOn[playerSlot]! > 0;
        cf.gearPos = interpEntity.gearPos;
        cf.elevonL = interpEntity.elevonL;
        cf.elevonR = interpEntity.elevonR;
        cf.rudder = interpEntity.rudder;
        cf.stores = curr.stores[playerSlot]!;
        cf.storesB = curr.storesB[playerSlot]!;
        structures.setServiceVehicles(
          playerServiceState === ServiceStateCode.Servicing ? { x: interpEntity.pos.x, y: interpEntity.pos.y - 1.15, z: interpEntity.pos.z, headingRad: playerHeadingRad } : null
        );
        // Outside views stay above the ground: free look and the orbit swing round the aircraft no
        // lower than the ground under it, then the camera is kept clear of the ground under itself.
        const minOffsetY = groundHeightAt ? groundHeightAt(interpEntity.pos.x, interpEntity.pos.z) + CAMERA_MIN_GROUND_CLEARANCE_M - interpEntity.pos.y : -Infinity;
        let fovDeg = FOV_BY_MODE[mode];
        cameraPose.up.x = 0;
        cameraPose.up.y = 1;
        cameraPose.up.z = 0;
        if (mode === CameraMode.Cockpit3d) {
          // The pilot's head: eye and view direction relative to the body, turned into the world.
          const hp = ensureCockpit().head(frameDtSec);
          rotateVecByQuat(interpEntity.rot, hp.eyeBody, vEyeWorld);
          cameraPose.pos.x = interpEntity.pos.x + vEyeWorld.x;
          cameraPose.pos.y = interpEntity.pos.y + vEyeWorld.y;
          cameraPose.pos.z = interpEntity.pos.z + vEyeWorld.z;
          qWorldCam.set(interpEntity.rot.x, interpEntity.rot.y, interpEntity.rot.z, interpEntity.rot.w).multiply(qBodyCam.copy(hp.rotBody));
          cameraPose.rot.x = qWorldCam.x;
          cameraPose.rot.y = qWorldCam.y;
          cameraPose.rot.z = qWorldCam.z;
          cameraPose.rot.w = qWorldCam.w;
          cameraPose.useLookAt = false;
          fovDeg = hp.fovDeg;
        } else if (mode === CameraMode.Tgp) {
          // The pod: from its mount under the intake, looking at its point, with its field of view.
          rotateVecByQuat(interpEntity.rot, POD_MOUNT_BODY_M, vEyeWorld);
          cameraPose.pos.x = interpEntity.pos.x + vEyeWorld.x;
          cameraPose.pos.y = interpEntity.pos.y + vEyeWorld.y;
          cameraPose.pos.z = interpEntity.pos.z + vEyeWorld.z;
          cameraPose.lookAt.x = curr.hud[SnapshotHud.POD_X] ?? 0;
          cameraPose.lookAt.y = curr.hud[SnapshotHud.POD_Y] ?? 0;
          cameraPose.lookAt.z = curr.hud[SnapshotHud.POD_Z] ?? 0;
          cameraPose.useLookAt = true;
          fovDeg = Math.max(0.3, curr.hud[SnapshotHud.POD_FOV_DEG] || 18);
        } else {
          cameraModeState.subjectScale = MODEL_SCALE[aircraftModelOf(devFlags(curr.flags[playerSlot]!))] ?? 1;
          computeCameraPose(mode, interpEntity.pos, interpEntity.rot, interpEntity.vel, cameraModeState, frameDtSec, cameraPose, minOffsetY);
          if (cameraPose.fovDeg > 0) fovDeg = cameraPose.fovDeg;
        }
        if (mode !== CameraMode.Cockpit && mode !== CameraMode.Cockpit3d && mode !== CameraMode.Tgp && groundHeightAt) keepAboveGround(cameraPose, groundHeightAt, CAMERA_MIN_GROUND_CLEARANCE_M);
        if (DEV_CAMREL) {
          cameraPose.pos.x = interpEntity.pos.x + DEV_CAMREL[0]!;
          cameraPose.pos.y = interpEntity.pos.y + DEV_CAMREL[1]!;
          cameraPose.pos.z = interpEntity.pos.z + DEV_CAMREL[2]!;
          cameraPose.lookAt.x = interpEntity.pos.x;
          cameraPose.lookAt.y = interpEntity.pos.y + (DEV_CAMREL[3] ?? 0);
          cameraPose.lookAt.z = interpEntity.pos.z;
          cameraPose.useLookAt = true;
        }
        if (debugCam) {
          // Dev aid (?cam=x,y,z,lookX,lookY,lookZ): a fixed camera anywhere, for checking scenery.
          cameraPose.pos.x = debugCam[0]!;
          cameraPose.pos.y = debugCam[1]!;
          cameraPose.pos.z = debugCam[2]!;
          cameraPose.lookAt.x = debugCam[3]!;
          cameraPose.lookAt.y = debugCam[4]!;
          cameraPose.lookAt.z = debugCam[5]!;
          cameraPose.useLookAt = true;
        }
        if (camera.view) camera.clearViewOffset();
        const origin = placeCamera(fovDeg);

        eachRenderer((r) => r.beginFrame(frameDtSec, origin, cameraPose.pos, nowMs / 1000));
        drones.beginFrame();
        for (let i = 0; i < curr.entityCount; i++) {
          if (curr.alive[i] === 1 && curr.kind[i] === EntityKindCode.aircraft && (curr.flags[i]! & EntityFlag.Drone) !== 0) {
            interpolateEntity(snapshotBuf, i, f, interpEntity);
            drones.update(curr.id[i]!, interpEntity.pos, interpEntity.rot, origin);
            continue;
          }
          if (curr.alive[i] === 1 && curr.kind[i] === EntityKindCode.missile) {
            interpolateEntity(snapshotBuf, i, f, interpEntity);
            aircraftRenderer.updateMissile(curr.stores[i]!, interpEntity.pos, interpEntity.vel, interpEntity.rot, origin, curr.flags[i]!);
            continue;
          }
          if (curr.alive[i] === 1 && curr.kind[i] === EntityKindCode.effect) {
            interpolateEntity(snapshotBuf, i, f, interpEntity);
            aircraftRenderer.updateStore(curr.stores[i]!, interpEntity.pos, interpEntity.rot, origin);
            continue;
          }
          if (curr.alive[i] !== 1 || curr.kind[i] !== EntityKindCode.aircraft) continue;
          // No cockpit interior yet: from the cockpit, the player's own jet is not drawn.
          if (i === playerSlot && (mode === CameraMode.Cockpit || mode === CameraMode.Tgp) && !debugCam) continue;
          interpolateEntity(snapshotBuf, i, f, interpEntity);
          const flags = i === playerSlot ? devFlags(curr.flags[i]!) : curr.flags[i]!;
          const st = aircraftState;
          clearTransportState(st);
          st.elevonL = interpEntity.elevonL;
          st.elevonR = interpEntity.elevonR;
          st.rudder = interpEntity.rudder;
          st.gearPos = interpEntity.gearPos;
          st.throttle = interpEntity.throttle;
          st.afterburner = curr.afterburnerOn[i]! > 0;
          st.abStage = curr.afterburnerOn[i]!;
          st.airbrakeOut = (flags & EntityFlag.AirbrakeOut) !== 0;
          st.onGround = (flags & EntityFlag.OnGround) !== 0;
          st.team = curr.team[i]!;
          st.vel = interpEntity.vel;
          st.stores = curr.stores[i]!;
          st.storesB = curr.storesB[i]!;
          st.flags = flags;
          // The player's ground height (from the HUD's height above ground) lights the runway ahead.
          st.groundY = i === playerSlot ? interpEntity.pos.y - (curr.hud[SnapshotHud.ALT_AGL_M] ?? 0) : undefined;
          // Transports' moving parts from the flight model (SnapshotEntity.HIGH_LIFT / ENGINES).
          if (curr.highLift[i]! !== 0) {
            unpackUnits4(curr.highLift[i]!, hlScratch);
            st.flaps = hlScratch[0]; st.slats = hlScratch[1]; st.spoilers = hlScratch[2]; st.ramp = hlScratch[3];
          }
          if (curr.engines[i]! !== 0) {
            unpackEngines(curr.engines[i]!, n1Scratch, revScratch);
            st.n1 = n1Scratch; st.reversers = revScratch;
          }
          let drawPos = interpEntity.pos;
          if (import.meta.env.DEV && i === playerSlot && aircraftModelOf(flags) === AircraftModel.C17) {
            const pose = devPoseNow();
            if (pose?.cycle) c17PoseCycle(nowMs / 1000, st);
            else if (pose) applyC17PoseOverride(pose, st);
          }
          if (i === playerSlot && DEV_MODEL === AircraftModel.C17 && aircraftModelOf(curr.flags[i]!) !== AircraftModel.C17) {
            // The C-17 drawn on another aircraft's physics: lifted so its own wheels meet the ground.
            devLiftedPos.x = interpEntity.pos.x;
            devLiftedPos.y = interpEntity.pos.y + DEV_C17_LIFT_M;
            devLiftedPos.z = interpEntity.pos.z;
            drawPos = devLiftedPos;
          }
          rendererFor(flags).updateEntity(curr.id[i]!, drawPos, interpEntity.rot, st, origin);
        }
        drones.endFrame();
        eachRenderer((r) => r.endFrame());

        // Ground units (static for now: drawn at their current snapshot pose).
        groundUnits.beginFrame();
        for (let i = 0; i < curr.entityCount; i++) {
          if (curr.kind[i] !== EntityKindCode.ground) continue;
          groundPos.x = curr.posX[i]!; groundPos.y = curr.posY[i]!; groundPos.z = curr.posZ[i]!;
          groundRot.x = curr.rotX[i]!; groundRot.y = curr.rotY[i]!; groundRot.z = curr.rotZ[i]!; groundRot.w = curr.rotW[i]!;
          groundUnits.update(curr.stores[i]!, groundPos, groundRot, curr.flags[i]!, curr.team[i]!);
        }
        groundUnits.endFrame(origin, nowMs / 1000);

        // The designated target, interpolated like the view (for the 3D cockpit's HUD).
        cf.targetValid = false;
        if (mode === CameraMode.Cockpit3d) {
          const targetId = curr.hud[SnapshotHud.TARGET_ID] ?? -1;
          for (let i = 0; i < curr.entityCount && targetId >= 0; i++) {
            if (curr.id[i] !== targetId || curr.alive[i] !== 1) continue;
            interpolateEntity(snapshotBuf, i, f, interpTarget);
            Object.assign(cf.targetPos, interpTarget.pos);
            cf.targetValid = true;
            break;
          }
        }

        renderer.getDrawingBufferSize(viewSize);
        effects.setView(viewSize.x, viewSize.y);
        effects.syncFromSnapshot(snapshotBuf, f, origin);
        effects.tick(frameDtSec, origin);
        groundEffects.tick(frameDtSec, origin, viewSize.y, camera.fov);
        craters.tick(origin);
        followOrigin(origin);
      }

      camera.updateMatrixWorld(true);
      updateSky(frameDtSec, nowMs / 1000);
      grade.update(nowMs, camera, getAtmosphereUniforms().uAtmSunDir.value);
      // The pod's FLIR picture: heat sources by their shaders, the rest by brightness normalised to
      // the light level (so it works at night).
      {
        const u = getAtmosphereUniforms();
        const thermal = mode === CameraMode.Tgp && !showcase;
        u.uAtmThermal.value = thermal ? 1 : 0;
        const light = 0.2126 * (u.uAtmAmbSky.value.r + 0.8 * u.uAtmSunCol.value.r) + 0.7152 * (u.uAtmAmbSky.value.g + 0.8 * u.uAtmSunCol.value.g) + 0.0722 * (u.uAtmAmbSky.value.b + 0.8 * u.uAtmSunCol.value.b);
        grade.setThermal(thermal ? thermalPolarity : 0, 1 / Math.max(0.05, light / 0.95));
      }
      // Wrapped so float precision in the water animation never degrades over a long session.
      terrainConsumer.setTime((nowMs / 1000) % 3600);
      scratchProjMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      cameraState.viewProjectionMatrix = scratchProjMatrix.elements;
      cameraState.originWorld.x = floatingOrigin.originWorld.x;
      cameraState.originWorld.y = floatingOrigin.originWorld.y;
      cameraState.originWorld.z = floatingOrigin.originWorld.z;
      cameraState.worldPos.x = cameraPose.pos.x;
      cameraState.worldPos.y = cameraPose.pos.y;
      cameraState.worldPos.z = cameraPose.pos.z;
      cameraState.renderSimSec = snapshotBuf.hasData && !showcase ? snapshotBuf.renderSimSec : undefined;
      Object.assign(cameraWorldRot, { x: camera.quaternion.x, y: camera.quaternion.y, z: camera.quaternion.z, w: camera.quaternion.w });
      cameraState.worldRot = cameraWorldRot;
      cameraState.subjectPos = subjectDrawn ? subjectPos : undefined;
      cameraState.subjectRot = subjectDrawn ? subjectRot : undefined;

      // The 3D cockpit: lit by this frame's sun and sky, drawn over the world.
      const inCockpit = mode === CameraMode.Cockpit3d && !showcase && cockpit !== null && cockpitFlight.valid && snapshotBuf.hasData;
      cockpitPass.enabled = inCockpit;
      renderer.shadowMap.enabled = inCockpit;
      // (Set every frame: a restored WebGL context brings a new renderer with the default type.)
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      if (inCockpit && cockpit) {
        const u = getAtmosphereUniforms();
        const cf = cockpitFlight;
        cf.sunDir.x = u.uAtmSunDir.value.x;
        cf.sunDir.y = u.uAtmSunDir.value.y;
        cf.sunDir.z = u.uAtmSunDir.value.z;
        cf.sunCol.r = u.uAtmSunCol.value.r;
        cf.sunCol.g = u.uAtmSunCol.value.g;
        cf.sunCol.b = u.uAtmSunCol.value.b;
        cf.ambSky.r = u.uAtmAmbSky.value.r;
        cf.ambSky.g = u.uAtmAmbSky.value.g;
        cf.ambSky.b = u.uAtmAmbSky.value.b;
        cf.ambGround.r = u.uAtmAmbGround.value.r;
        cf.ambGround.g = u.uAtmAmbGround.value.g;
        cf.ambGround.b = u.uAtmAmbGround.value.b;
        cf.night = u.uAtmLights.value;
        cockpit.update(cf, frameDtSec, nowMs / 1000, camera.aspect);
      }

      if (!contextLost) {
        urbanCache.update(renderer, cameraPose.pos.x, cameraPose.pos.z);
        sunShadows.render(renderer, scene, shadowFocus, floatingOrigin.originWorld, getAtmosphereUniforms().uAtmSunDir.value, shadowsOn);
        composer.render();
      }

      return cameraState;
    },

    dispose() {
      sceneDisposed = true;
      cockpit?.dispose();
      eachRenderer((r) => r.dispose());
      drones.dispose();
      terrainConsumer.dispose();
      urbanCache.dispose();
      features.dispose();
      clouds.dispose();
      runwayLights.dispose();
      pavement.dispose();
      structures.dispose();
      groundUnits.dispose();
      signs.dispose();
      hangarBay.dispose();
      deck.dispose();
      rain.dispose();
      farGround.dispose();
      sunShadows.dispose();
      effects.dispose();
      groundEffects.dispose();
      craters.dispose();
      skyFog.dispose();
      renderer.dispose();
    },
  };

  return api;
};
