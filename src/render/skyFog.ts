/**
 * src/render/skyFog.ts
 *
 * Sky-dome gradient mesh, THREE.Fog/scene background wiring, sun direction
 * -> directional light. 08-render.md section 4.11, table 5.9.
 */

import * as THREE from 'three';
import type { Vec3Like } from '../contracts/core';
import type { SceneEnvironment } from '../contracts/render';

export const SKY_ZENITH_COLOR_HEX = 0x3a6ea8;
export const SKY_HORIZON_COLOR_HEX = 0xbcd4e8;
export const SKY_GROUND_COLOR_HEX = 0x7a6a52;
export const SUN_DISC_COLOR_HEX = 0xfff6e0;
const SKY_DOME_RADIUS_M = 25000;
const SUN_DISC_RADIUS_M = 250;
const SUN_LIGHT_DISTANCE_M = 10000;
/** Fixed cascade split distance from camera, per 08-render.md section 4.11. */
const SHADOW_CASCADE_SPLIT_M = 500;

/** Sky tint per theatre: zenith, horizon (= fog colour) and below-horizon colour. */
const SKY_BY_STYLE: Readonly<Record<SceneEnvironment['surfaceStyle'], readonly [number, number, number]>> = {
  default: [SKY_ZENITH_COLOR_HEX, SKY_HORIZON_COLOR_HEX, SKY_GROUND_COLOR_HEX],
  // Humid coastal haze; the sea fills the view below the horizon.
  coastal: [0x3f73a8, 0xc4d4df, 0x5f7f92],
  // North Indian plains in winter: heavy dusty haze, a pale washed-out sky.
  farmland: [0x6f8fb3, 0xc9c8bc, 0x9a9580],
};

export interface SkyFogSystem {
  setFog(fogStartM: number, fogEndM: number): void;
  /** Re-tints sky, background and fog for a theatre. */
  setStyle(style: SceneEnvironment['surfaceStyle']): void;
  /** The current horizon/fog colour (live object; copy it, don't keep it). */
  readonly horizonColor: THREE.Color;
  setSunDirection(dirWorld: Readonly<Vec3Like>): void;
  setShadowsEnabled(enabled: boolean, cascades: 0 | 1 | 2): void;
  dispose(): void;
}

export function createSkyFogSystem(scene: THREE.Scene): SkyFogSystem {
  scene.fog = new THREE.Fog(SKY_HORIZON_COLOR_HEX, 1500, 5000);
  scene.background = new THREE.Color(SKY_HORIZON_COLOR_HEX);

  const skyGeometry = new THREE.SphereGeometry(SKY_DOME_RADIUS_M, 32, 16);
  const skyMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color(SKY_ZENITH_COLOR_HEX) },
      uHorizon: { value: new THREE.Color(SKY_HORIZON_COLOR_HEX) },
      uGround: { value: new THREE.Color(SKY_GROUND_COLOR_HEX) },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uGround;
      varying vec3 vDir;
      void main() {
        float t = vDir.y;
        vec3 col = t >= 0.0 ? mix(uHorizon, uZenith, clamp(t, 0.0, 1.0)) : mix(uHorizon, uGround, clamp(-t, 0.0, 1.0));
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

  const sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = SUN_LIGHT_DISTANCE_M * 2;
  scene.add(sunLight);
  scene.add(sunLight.target);

  const horizonColor = new THREE.Color(SKY_HORIZON_COLOR_HEX);

  return {
    horizonColor,

    setStyle(style) {
      const [zenith, horizon, ground] = SKY_BY_STYLE[style];
      horizonColor.setHex(horizon);
      (skyMaterial.uniforms['uZenith']!.value as THREE.Color).setHex(zenith);
      (skyMaterial.uniforms['uHorizon']!.value as THREE.Color).setHex(horizon);
      (skyMaterial.uniforms['uGround']!.value as THREE.Color).setHex(ground);
      (scene.fog as THREE.Fog).color.setHex(horizon);
      (scene.background as THREE.Color).setHex(horizon);
    },

    setFog(fogStartM, fogEndM) {
      const fog = scene.fog as THREE.Fog;
      fog.near = fogStartM;
      fog.far = fogEndM;
    },

    setSunDirection(dirWorld) {
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
      sunGeometry.dispose();
      sunMaterial.dispose();
      scene.remove(sunLight);
      scene.remove(sunLight.target);
    },
  };
}
