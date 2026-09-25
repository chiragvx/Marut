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

import { EntityKindCode, type QualityTier } from '../contracts/core';
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
import { computeCameraPose, createCameraModeState, createCameraPose, orbitCamera as applyOrbitDelta } from './cameraModes';
import { createEffectsSystem } from './effects';
import { createFloatingOriginState, updateFloatingOrigin } from './floatingOrigin';
import {
  computeInterpFraction,
  createInterpolatedEntity,
  createSnapshotDoubleBuffer,
  ingestSnapshotIntoBuffer,
  interpolateEntity,
} from './snapshotInterpolation';
import { createSkyFogSystem } from './skyFog';
import { createTerrainChunkConsumer } from './terrainChunkConsumer';
import { createChunkFeatureRenderer } from './chunkFeatureRenderer';
import { createCloudSystem } from './clouds';
import { createFarGround } from './farGround';
import { getAtmosphereUniforms, setAtmosphereCamera } from './atmosphere';
import { createGrade } from './postGrade';
import { TERRAIN_WORLD_EXTENT_M } from '../contracts/terrain';
import { createWireframeAircraftRenderer } from './wireframeAircraftRenderer';

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
  const wireframeRenderer = createWireframeAircraftRenderer(aircraftRoot);

  const terrainRoot = new THREE.Group();
  scene.add(terrainRoot);
  const terrainConsumer = createTerrainChunkConsumer(terrainRoot);

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
  const clouds = createCloudSystem(scene);

  const snapshotBuf = createSnapshotDoubleBuffer();
  const floatingOrigin = createFloatingOriginState();
  const cameraModeState = createCameraModeState();
  const cameraPose = createCameraPose();
  const interpEntity = createInterpolatedEntity();

  let tier: QualityTier = initialTier;
  let mode: CameraMode = CameraMode.Chase;
  let lastFrameMs = -1;

  const cameraState: CameraState = {
    viewProjectionMatrix: new Array(16).fill(0),
    originWorld: { x: 0, y: 0, z: 0 },
    worldPos: { x: 0, y: 0, z: 0 },
  };
  const scratchProjMatrix = new THREE.Matrix4();

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
    skyFog.setShadowsEnabled(settings.shadowsEnabled, settings.shadowCascades);
    terrainConsumer.setShadowsEnabled(settings.shadowsEnabled);
    effects.setBudget(settings.effectBudget);
    renderer.shadowMap.enabled = settings.shadowsEnabled;
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
    },

    setQualityTier(t) {
      tier = t;
      applyQualityTier(t);
    },

    setCameraMode(m) {
      mode = m;
    },

    orbitCamera(deltaYawRad, deltaPitchRad, deltaZoomM) {
      applyOrbitDelta(cameraModeState.external, deltaYawRad, deltaPitchRad, deltaZoomM);
    },

    registerAircraftModel(model) {
      wireframeRenderer.registerModel(model);
    },

    setNavDb(navDb) {
      airportLines.setNavDb(navDb);
    },

    setSunDirection(dirWorld) {
      skyFog.setSunDirection(dirWorld);
      terrainConsumer.setSunDirection(dirWorld);
      features.uniforms.uSunDir.value.set(dirWorld.x, dirWorld.y, dirWorld.z);
      clouds.setSunDirection(dirWorld);
    },

    setEnvironment(env) {
      skyFog.setStyle(env.surfaceStyle);
      terrainConsumer.setFogColor(skyFog.horizonColor);
      features.uniforms.uFogColor.value.copy(skyFog.horizonColor);
      clouds.setFog(skyFog.horizonColor, 0);
      clouds.setConfig(env.clouds);
      const shore = env.coast ? env.coast.shoreX.reduce((a, b) => a + b, 0) / env.coast.shoreX.length : undefined;
      farGround.setEnvironment(env, env.groundLevelM ?? 0, shore);
      terrainConsumer.setEnvironment(env);
    },

    ingestSnapshot(view) {
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

      if (snapshotBuf.hasData && snapshotBuf.curr.playerSlot >= 0) {
        const curr = snapshotBuf.curr;
        const playerSlot = curr.playerSlot;
        const f = computeInterpFraction(nowMs, curr.arrivalMs);

        interpolateEntity(snapshotBuf, playerSlot, f, interpEntity);
        computeCameraPose(mode, interpEntity.pos, interpEntity.rot, interpEntity.vel, cameraModeState, frameDtSec, cameraPose);
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

        wireframeRenderer.beginFrame();
        for (let i = 0; i < curr.entityCount; i++) {
          if (curr.alive[i] !== 1 || curr.kind[i] !== EntityKindCode.aircraft) continue;
          interpolateEntity(snapshotBuf, i, f, interpEntity);
          wireframeRenderer.updateEntity(
            curr.id[i]!,
            interpEntity.pos,
            interpEntity.rot,
            { elevonL: interpEntity.elevonL, elevonR: interpEntity.elevonR, rudder: interpEntity.rudder, gearPos: interpEntity.gearPos },
            origin
          );
        }
        wireframeRenderer.endFrame();

        effects.syncFromSnapshot(snapshotBuf, f, origin);
        effects.tick(frameDtSec, origin);

        terrainConsumer.updateOrigin(origin);
        features.update(origin, cameraPose.pos);
        clouds.update(cameraPose.pos, origin);
        airportLines.updateOrigin(origin);
      }

      camera.updateMatrixWorld(true);
      grade.update(nowMs, camera, getAtmosphereUniforms().uAtmSunDir.value);
      scratchProjMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      cameraState.viewProjectionMatrix = scratchProjMatrix.elements;
      cameraState.originWorld.x = floatingOrigin.originWorld.x;
      cameraState.originWorld.y = floatingOrigin.originWorld.y;
      cameraState.originWorld.z = floatingOrigin.originWorld.z;
      cameraState.worldPos.x = cameraPose.pos.x;
      cameraState.worldPos.y = cameraPose.pos.y;
      cameraState.worldPos.z = cameraPose.pos.z;

      if (!contextLost) {
        composer.render();
      }

      return cameraState;
    },

    dispose() {
      wireframeRenderer.dispose();
      terrainConsumer.dispose();
      features.dispose();
      clouds.dispose();
      farGround.dispose();
      effects.dispose();
      airportLines.dispose();
      skyFog.dispose();
      renderer.dispose();
    },
  };

  return api;
};
