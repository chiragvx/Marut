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

import { EntityFlag, EntityKindCode, HUD_BLOCK_START, ServiceStateCode, SnapshotHud, type QualityTier } from '../contracts/core';
import {
  AntiAliasMode,
  CAMERA_FAR_M,
  CAMERA_NEAR_M,
  CHASE_VERTICAL_FOV_DEG,
  CameraMode,
  COCKPIT_VERTICAL_FOV_DEG,
  EXTERNAL_VERTICAL_FOV_DEG,
  FLYBY_VERTICAL_FOV_DEG,
  RENDER_QUALITY_TABLE,
  type CameraState,
  type CreateSceneRenderer,
  type SceneRenderer,
} from '../contracts/render';

import { createAirportLinesSystem } from './airportLines';
import { chaseLook, computeCameraPose, createCameraModeState, createCameraPose, orbitCamera as applyOrbitDelta } from './cameraModes';
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
import { createAirfieldSigns } from './airfieldSigns';
import { createFarGround } from './farGround';
import { getAtmosphereUniforms, setAtmosphereCamera, setAtmosphereHaze } from './atmosphere';
import type { WeatherMode } from '../contracts/core';
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
import { createMeshAircraftRenderer } from './meshAircraftRenderer';
import { buildTejasTestModel } from './aircraftModels/tejasTestModel';

const FOV_BY_MODE: Readonly<Record<CameraMode, number>> = {
  [CameraMode.Cockpit]: COCKPIT_VERTICAL_FOV_DEG,
  [CameraMode.Chase]: CHASE_VERTICAL_FOV_DEG,
  [CameraMode.External]: EXTERNAL_VERTICAL_FOV_DEG,
  [CameraMode.Flyby]: FLYBY_VERTICAL_FOV_DEG,
};

export const createSceneRenderer: CreateSceneRenderer = (canvas, initialTier) => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(COCKPIT_VERTICAL_FOV_DEG, 1, CAMERA_NEAR_M, CAMERA_FAR_M);

  let renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  let composer = new EffectComposer(renderer);
  let renderPass = new RenderPass(scene, camera);
  let grade = createGrade();
  let sizeW = 1;
  let sizeH = 1;

  function rebuildComposerAndPasses(): void {
    composer = new EffectComposer(renderer);
    renderPass = new RenderPass(scene, camera);
    // FXAA and colour grading/lens effects are one fused pass (postGrade.ts); a grade-only pass
    // replaces it on tiers without anti-aliasing.
    grade = createGrade();
    grade.setSize(sizeW, sizeH);
    composer.addPass(renderPass);
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
  // Solid articulated aircraft (a procedural Tejas until an art asset exists); it replaces the
  // original wireframe, so registerAircraftModel's WireframeModel is no longer drawn.
  const aircraftRenderer = createMeshAircraftRenderer(aircraftRoot, buildTejasTestModel());
  const aircraftState = {
    elevonL: 0,
    elevonR: 0,
    rudder: 0,
    gearPos: 0,
    throttle: 0,
    afterburner: false,
    airbrakeOut: false,
    onGround: false,
    team: 0,
    vel: { x: 0, y: 0, z: 0 },
    stores: 0,
  };

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

  const airportRoot = new THREE.Group();
  scene.add(airportRoot);
  const airportLines = createAirportLinesSystem(airportRoot);

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
  const signs = createAirfieldSigns(scene);
  /** The player's ground-service state and heading from the latest snapshot (for the service vehicles). */
  let playerServiceState = 0;
  let playerHeadingRad = 0;
  /** Overcast deck base/top per theatre, m MSL. */
  const DECK_LEVELS: Readonly<Record<SceneEnvironment['surfaceStyle'], [number, number]>> = {
    coastal: [1000, 1450],
    farmland: [1150, 1600],
    default: [1200, 1650],
  };

  const snapshotBuf = createSnapshotDoubleBuffer();
  const floatingOrigin = createFloatingOriginState();
  const cameraModeState = createCameraModeState();
  const cameraPose = createCameraPose();
  const interpEntity = createInterpolatedEntity();

  const debugCam = ((): number[] | undefined => {
    if (typeof location === 'undefined') return undefined;
    const v = new URLSearchParams(location.search).get('cam')?.split(',').map(Number);
    return v && v.length === 6 && v.every(Number.isFinite) ? v : undefined;
  })();
  let tier: QualityTier = initialTier;
  let mode: CameraMode = CameraMode.Chase;
  let lastFrameMs = -1;

  const cameraState: CameraState = {
    viewProjectionMatrix: new Array(16).fill(0),
    originWorld: { x: 0, y: 0, z: 0 },
    worldPos: { x: 0, y: 0, z: 0 },
  };
  const scratchProjMatrix = new THREE.Matrix4();

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
    const day = (0.2126 * (skyLight.ambSky[0] + skyLight.keyCol[0] * 0.8) + 0.7152 * (skyLight.ambSky[1] + skyLight.keyCol[1] * 0.8) + 0.0722 * (skyLight.ambSky[2] + skyLight.keyCol[2] * 0.8)) / 0.95;
    airportLines.setBrightness(Math.max(0.12, Math.min(1, day)));
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
    renderer.shadowMap.enabled = false;
    shadowsOn = settings.shadowsEnabled;
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
    },

    orbitCamera(deltaYawRad, deltaPitchRad, deltaZoomM) {
      if (mode === CameraMode.Chase) chaseLook(cameraModeState.chase, deltaYawRad, deltaPitchRad, deltaZoomM);
      else if (mode === CameraMode.External) applyOrbitDelta(cameraModeState.external, deltaYawRad, deltaPitchRad, deltaZoomM);
    },

    registerAircraftModel() {
      // The mesh model (meshAircraftRenderer.ts) is drawn instead of the wireframe.
    },

    setNavDb(navDb) {
      airportLines.setNavDb(navDb);
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

      // The 3D view plays the snapshots back on the sim's clock (snapshotInterpolation.ts).
      const fInterp = snapshotBuf.hasData ? advanceRenderClock(snapshotBuf, nowMs) : 1;
      if (snapshotBuf.hasData && snapshotBuf.curr.playerSlot >= 0) {
        const curr = snapshotBuf.curr;
        const playerSlot = curr.playerSlot;
        const f = fInterp;

        interpolateEntity(snapshotBuf, playerSlot, f, interpEntity);
        shadowFocus.set(interpEntity.pos.x, interpEntity.pos.y, interpEntity.pos.z);
        structures.setServiceVehicles(
          playerServiceState === ServiceStateCode.Servicing ? { x: interpEntity.pos.x, y: interpEntity.pos.y - 1.15, z: interpEntity.pos.z, headingRad: playerHeadingRad } : null
        );
        computeCameraPose(mode, interpEntity.pos, interpEntity.rot, interpEntity.vel, cameraModeState, frameDtSec, cameraPose);
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
        updateFloatingOrigin(floatingOrigin, cameraPose.pos);
        const origin = floatingOrigin.originWorld;

        camera.fov = FOV_BY_MODE[mode];
        camera.updateProjectionMatrix();
        camera.position.set(cameraPose.pos.x - origin.x, cameraPose.pos.y - origin.y, cameraPose.pos.z - origin.z);
        setAtmosphereCamera(cameraPose.pos);
        skyFog.followCamera(camera.position);
        farGround.update(origin);
        if (cameraPose.useLookAt) {
          camera.up.set(0, 1, 0);
          camera.lookAt(cameraPose.lookAt.x - origin.x, cameraPose.lookAt.y - origin.y, cameraPose.lookAt.z - origin.z);
        } else {
          camera.quaternion.set(cameraPose.rot.x, cameraPose.rot.y, cameraPose.rot.z, cameraPose.rot.w);
        }

        aircraftRenderer.beginFrame(frameDtSec, origin, cameraPose.pos, nowMs / 1000);
        for (let i = 0; i < curr.entityCount; i++) {
          if (curr.alive[i] === 1 && curr.kind[i] === EntityKindCode.missile) {
            interpolateEntity(snapshotBuf, i, f, interpEntity);
            aircraftRenderer.updateMissile(curr.stores[i]!, interpEntity.pos, interpEntity.vel, interpEntity.rot, origin);
            continue;
          }
          if (curr.alive[i] !== 1 || curr.kind[i] !== EntityKindCode.aircraft) continue;
          // No cockpit interior yet: from the cockpit, the player's own jet is not drawn.
          if (i === playerSlot && mode === CameraMode.Cockpit && !debugCam) continue;
          interpolateEntity(snapshotBuf, i, f, interpEntity);
          const flags = curr.flags[i]!;
          const st = aircraftState;
          st.elevonL = interpEntity.elevonL;
          st.elevonR = interpEntity.elevonR;
          st.rudder = interpEntity.rudder;
          st.gearPos = interpEntity.gearPos;
          st.throttle = interpEntity.throttle;
          st.afterburner = curr.afterburnerOn[i] === 1;
          st.airbrakeOut = (flags & EntityFlag.AirbrakeOut) !== 0;
          st.onGround = (flags & EntityFlag.OnGround) !== 0;
          st.team = curr.team[i]!;
          st.vel = interpEntity.vel;
          st.stores = curr.stores[i]!;
          aircraftRenderer.updateEntity(curr.id[i]!, interpEntity.pos, interpEntity.rot, st, origin);
        }
        aircraftRenderer.endFrame();

        effects.syncFromSnapshot(snapshotBuf, f, origin);
        effects.tick(frameDtSec, origin);

        terrainConsumer.updateOrigin(origin);
        features.update(origin, cameraPose.pos);
        clouds.update(cameraPose.pos, origin);
        airportLines.updateOrigin(origin);
        pavement.updateOrigin(origin);
        structures.update(origin, lastFrameMs / 1000);
        signs.updateOrigin(origin);
      }

      camera.updateMatrixWorld(true);
      updateSky(frameDtSec, nowMs / 1000);
      grade.update(nowMs, camera, getAtmosphereUniforms().uAtmSunDir.value);
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
      cameraState.renderSimSec = snapshotBuf.hasData ? snapshotBuf.renderSimSec : undefined;

      if (!contextLost) {
        urbanCache.update(renderer, cameraPose.pos.x, cameraPose.pos.z);
        sunShadows.render(renderer, scene, shadowFocus, floatingOrigin.originWorld, getAtmosphereUniforms().uAtmSunDir.value, shadowsOn);
        composer.render();
      }

      return cameraState;
    },

    dispose() {
      aircraftRenderer.dispose();
      terrainConsumer.dispose();
      urbanCache.dispose();
      features.dispose();
      clouds.dispose();
      runwayLights.dispose();
      pavement.dispose();
      structures.dispose();
      signs.dispose();
      deck.dispose();
      rain.dispose();
      farGround.dispose();
      sunShadows.dispose();
      effects.dispose();
      airportLines.dispose();
      skyFog.dispose();
      renderer.dispose();
    },
  };

  return api;
};
