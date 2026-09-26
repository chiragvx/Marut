/**
 * src/render/skyFog.ts
 *
 * Sky-dome gradient mesh, THREE.Fog/scene background wiring, sun direction
 * -> directional light. 08-render.md section 4.11, table 5.9.
 */

import * as THREE from 'three';
import type { Vec3Like } from '../contracts/core';
import type { SceneEnvironment } from '../contracts/render';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms, setAtmosphereSun, setAtmosphereStyle } from './atmosphere';
import type { Dir3, Rgb, SkyLight } from './skyState';

export const SKY_ZENITH_COLOR_HEX = 0x3a6ea8;
export const SKY_HORIZON_COLOR_HEX = 0xbcd4e8;
export const SKY_GROUND_COLOR_HEX = 0x7a6a52;
export const SUN_DISC_COLOR_HEX = 0xfff6e0;
const SKY_DOME_RADIUS_M = 200000;
const SUN_DISC_RADIUS_M = 1100;
const SUN_LIGHT_DISTANCE_M = 10000;
/** Fixed cascade split distance from camera, per 08-render.md section 4.11. */
const SHADOW_CASCADE_SPLIT_M = 500;

/** Sky tint per theatre: zenith, horizon (= fog colour) and below-horizon colour. */
const SKY_BY_STYLE: Readonly<Record<SceneEnvironment['surfaceStyle'], readonly [number, number, number]>> = {
  default: [SKY_ZENITH_COLOR_HEX, SKY_HORIZON_COLOR_HEX, SKY_GROUND_COLOR_HEX],
  // Humid coastal haze; the sea fills the view below the horizon.
  coastal: [0x3f73a8, 0xc4d4df, 0x5f7f92],
  // North Indian plains in winter: pale blue-grey haze, a slightly washed-out blue sky.
  farmland: [0x4f7fb8, 0xc3ccd6, 0x9a9580],
};

export interface SkyFogSystem {
  setFog(fogStartM: number, fogEndM: number): void;
  /** Re-tints sky, background and fog for a theatre. */
  setStyle(style: SceneEnvironment['surfaceStyle']): void;
  /** The current horizon/fog colour (live object; copy it, don't keep it). */
  readonly horizonColor: THREE.Color;
  /** The theatre's clear midday zenith and horizon colours (set by setStyle). */
  readonly baseZenith: Rgb;
  readonly baseHorizon: Rgb;
  /** Applies a time-of-day/weather sky: colours, light, sun and moon discs, stars. */
  setSkyLight(light: Readonly<SkyLight>, sunDir: Readonly<Dir3>, moonDir: Readonly<Dir3>): void;
  setSunDirection(dirWorld: Readonly<Vec3Like>): void;
  setShadowsEnabled(enabled: boolean, cascades: 0 | 1 | 2): void;
  /** Centres the sky dome and sun disc on the camera (scene coordinates) every frame. */
  followCamera(camScene: Readonly<Vec3Like>): void;
  dispose(): void;
}

export function createSkyFogSystem(scene: THREE.Scene): SkyFogSystem {
  scene.fog = new THREE.Fog(SKY_HORIZON_COLOR_HEX, 3000, 60000);
  scene.background = new THREE.Color(SKY_HORIZON_COLOR_HEX);

  const skyGeometry = new THREE.SphereGeometry(SKY_DOME_RADIUS_M, 32, 16);
  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color(SKY_ZENITH_COLOR_HEX) },
      uHorizon: { value: new THREE.Color(SKY_HORIZON_COLOR_HEX) },
      uGround: { value: new THREE.Color(SKY_GROUND_COLOR_HEX) },
      uStars: { value: 0 },
      ...getAtmosphereUniforms(),
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    // Same atmosphere as the ground shaders: sky above the horizon, pure haze below it (the
    // far-ground ring and terrain cover it; this only shows at grazing angles).
    fragmentShader: `
      ${ATMOSPHERE_GLSL}
      uniform float uStars;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = d.y >= 0.0 ? atmSky(d) : atmInscatter(vec3(d.x, 0.0, d.z) / max(length(d.xz), 1e-3));
        // Stars: one candidate per small cell of direction space (~2-3 px), a few percent lit, of
        // varied brightness, dimmed towards the horizon by the haze.
        if (uStars > 0.0 && d.y > 0.0) {
          vec3 q = d * 420.0;
          vec3 id = floor(q);
          vec3 f = fract(q) - 0.5;
          float h = fract(sin(dot(id, vec3(127.1, 311.7, 74.7))) * 43758.5453);
          if (h > 0.985) {
            float b = fract(h * 97.31);
            float star = (1.0 - smoothstep(0.12, 0.42, length(f))) * (0.25 + 0.75 * b * b);
            col += vec3(0.85, 0.9, 1.0) * star * uStars * smoothstep(0.02, 0.3, d.y);
          }
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const skyDome = new THREE.Mesh(skyGeometry, skyMaterial);
  skyDome.frustumCulled = false;
  skyDome.renderOrder = -1000;
  scene.add(skyDome);

  const sunGeometry = new THREE.SphereGeometry(SUN_DISC_RADIUS_M, 16, 8);
  const sunMaterial = new THREE.MeshBasicMaterial({ color: SUN_DISC_COLOR_HEX, fog: false });
  const sunDisc = new THREE.Mesh(sunGeometry, sunMaterial);
  sunDisc.frustumCulled = false;
  scene.add(sunDisc);

  const moonMaterial = new THREE.MeshBasicMaterial({ color: 0xd8dde8, fog: false });
  const moonDisc = new THREE.Mesh(sunGeometry, moonMaterial);
  moonDisc.frustumCulled = false;
  moonDisc.visible = false;
  scene.add(moonDisc);
  const moonDirScratch = new THREE.Vector3(0, -1, 0);

  const sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = SUN_LIGHT_DISTANCE_M * 2;
  scene.add(sunLight);
  scene.add(sunLight.target);

  const horizonColor = new THREE.Color(SKY_HORIZON_COLOR_HEX);
  const sunDirScratch = new THREE.Vector3(0.4, 0.7, -0.3).normalize();

  const baseZenith: Rgb = [0, 0, 0];
  const baseHorizon: Rgb = [0, 0, 0];
  const toRgb = (hex: number, out: Rgb): void => {
    const c = new THREE.Color(hex);
    out[0] = c.r;
    out[1] = c.g;
    out[2] = c.b;
  };
  toRgb(SKY_ZENITH_COLOR_HEX, baseZenith);
  toRgb(SKY_HORIZON_COLOR_HEX, baseHorizon);

  return {
    horizonColor,
    baseZenith,
    baseHorizon,

    setSkyLight(light, sunDir, moonDir) {
      const u = getAtmosphereUniforms();
      u.uAtmZenith.value.setRGB(...light.zenith);
      u.uAtmHaze.value.setRGB(...light.horizon);
      u.uAtmSunGlow.value.setRGB(...light.glow);
      u.uAtmSunCol.value.setRGB(...light.keyCol);
      u.uAtmAmbSky.value.setRGB(...light.ambSky);
      u.uAtmAmbGround.value.setRGB(...light.ambGround);
      u.uAtmLights.value = light.lights;
      setAtmosphereSun(light.keyDir);
      u.uAtmGlowDir.value.set(light.glowDir.x, light.glowDir.y, light.glowDir.z).normalize();
      horizonColor.setRGB(...light.horizon);
      (scene.fog as THREE.Fog).color.copy(horizonColor);
      (scene.background as THREE.Color).copy(horizonColor);
      skyMaterial.uniforms['uStars']!.value = light.stars;
      sunDirScratch.set(sunDir.x, sunDir.y, sunDir.z).normalize();
      moonDirScratch.set(moonDir.x, moonDir.y, moonDir.z).normalize();
      sunMaterial.color.setRGB(...light.sunDisc);
      sunDisc.visible = light.sunDisc[0] > 0.3;
      moonMaterial.color.setRGB(...light.moonDisc);
      moonDisc.visible = light.moonDisc[0] > 0.01;
    },

    setStyle(style) {
      const [zenith, horizon, ground] = SKY_BY_STYLE[style];
      toRgb(zenith, baseZenith);
      toRgb(horizon, baseHorizon);
      horizonColor.setHex(horizon);
      (skyMaterial.uniforms['uZenith']!.value as THREE.Color).setHex(zenith);
      (skyMaterial.uniforms['uHorizon']!.value as THREE.Color).setHex(horizon);
      (skyMaterial.uniforms['uGround']!.value as THREE.Color).setHex(ground);
      (scene.fog as THREE.Fog).color.setHex(horizon);
      (scene.background as THREE.Color).setHex(horizon);
      setAtmosphereStyle(style, horizonColor, new THREE.Color(zenith));
      // Built-in materials (aircraft wireframes, airport lines, effects) use scene.fog: match the
      // haze's ground-level visibility roughly.
      const p = getAtmosphereUniforms().uAtmHazeParams.value;
      (scene.fog as THREE.Fog).near = 0.15 / p.x;
      (scene.fog as THREE.Fog).far = 3.0 / p.x;
    },

    followCamera(camScene) {
      skyDome.position.set(camScene.x, camScene.y, camScene.z);
      sunDisc.position.set(camScene.x + sunDirScratch.x * (SKY_DOME_RADIUS_M - 1000), camScene.y + sunDirScratch.y * (SKY_DOME_RADIUS_M - 1000), camScene.z + sunDirScratch.z * (SKY_DOME_RADIUS_M - 1000));
      moonDisc.position.set(camScene.x + moonDirScratch.x * (SKY_DOME_RADIUS_M - 1000), camScene.y + moonDirScratch.y * (SKY_DOME_RADIUS_M - 1000), camScene.z + moonDirScratch.z * (SKY_DOME_RADIUS_M - 1000));
    },

    setFog() {
      // Distances come from the atmosphere now (setStyle); the tier table no longer fogs the scene.
    },

    setSunDirection(dirWorld) {
      sunDirScratch.set(dirWorld.x, dirWorld.y, dirWorld.z).normalize();
      setAtmosphereSun(dirWorld);
      sunLight.position.set(-dirWorld.x * SUN_LIGHT_DISTANCE_M, -dirWorld.y * SUN_LIGHT_DISTANCE_M, -dirWorld.z * SUN_LIGHT_DISTANCE_M);
      sunLight.target.position.set(0, 0, 0);
      sunLight.target.updateMatrixWorld();
      sunDisc.position.set(dirWorld.x * (SKY_DOME_RADIUS_M - 1000), dirWorld.y * (SKY_DOME_RADIUS_M - 1000), dirWorld.z * (SKY_DOME_RADIUS_M - 1000));
    },

    setShadowsEnabled(enabled, cascades) {
      sunLight.castShadow = enabled;
      if (!enabled) return;
      const nearMapSize = 2048;
      const farMapSize = cascades >= 2 ? 1024 : 2048;
      const mapSize = cascades >= 2 ? nearMapSize : farMapSize;
      sunLight.shadow.mapSize.set(mapSize, mapSize);
      sunLight.shadow.camera.far = cascades >= 2 ? SHADOW_CASCADE_SPLIT_M * 2 : SUN_LIGHT_DISTANCE_M * 2;
      sunLight.shadow.needsUpdate = true;
    },

    dispose() {
      scene.remove(skyDome);
      skyGeometry.dispose();
      skyMaterial.dispose();
      scene.remove(sunDisc);
      scene.remove(moonDisc);
      sunGeometry.dispose();
      sunMaterial.dispose();
      moonMaterial.dispose();
      scene.remove(sunLight);
      scene.remove(sunLight.target);
    },
  };
}
