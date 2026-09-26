/**
 * src/render/airbaseStructures.ts — draws airbase structures (contracts/airport.ts StructureDef, via
 * SceneEnvironment.structures) from the generic models in airbaseAssets.ts: one instanced mesh per
 * kind for every base in the mission (about ten draw calls in all).
 *
 * The shader picks each surface's material from the model's part code: weathered concrete (sandy,
 * with camouflage blotches on the hostile base's shelters and hangars), steel blast doors with
 * panel lines, earth-and-grass cover, office walls with window bands (lit at random at night),
 * a glazed tower cab (glowing at night), painted tanks, metal roofs; radar antennas turn. Lit like
 * the ground (sun, cloud and sun shadows), wet in rain; casts sun shadows.
 */
import * as THREE from 'three';
import type { Vec3Like } from '../contracts/core';
import type { SceneEnvironment } from '../contracts/render';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';
import { CLOUD_SHADOW_GLSL, getCloudShadowUniforms } from './clouds';
import { CASTER_LAYER, SUN_SHADOW_GLSL, getSunShadowUniforms } from './sunShadows';
import { makeAirbaseAssets } from './airbaseAssets';

type StructureList = NonNullable<SceneEnvironment['structures']>;

const VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  attribute float aPart;
  attribute float iStyle;
  uniform float uTime;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vNormalL;
  varying vec3 vLocalM;
  varying vec3 vTint;
  varying float vPart;
  varying float vStyle;
  varying float vSeed;
  void main() {
    vec3 scale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    vec3 p = position;
    vec3 n = normal;
    vSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
    if (aPart > 5.5 && aPart < 6.5) {
      // Radar antenna: turns about the mast, ~12 rpm.
      float a = uTime * 1.25 + vSeed * 6.2831;
      float c = cos(a);
      float s = sin(a);
      p.xz = mat2(c, s, -s, c) * p.xz;
      n.xz = mat2(c, s, -s, c) * n.xz;
    }
    vec4 wp = instanceMatrix * vec4(p, 1.0);
    vWorld = wp.xyz;
    vNormalW = normalize(mat3(instanceMatrix) * (n / (scale * scale)));
    vNormalL = n;
    vLocalM = p * scale;
    vTint = instanceColor;
    vPart = aPart;
    vStyle = iStyle;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(atmCurve(wp.xyz), 1.0);
  }
`;

const FS = /* glsl */ `
  precision highp float;
  ${ATMOSPHERE_GLSL}
  uniform vec3 uSunDir;
  ${CLOUD_SHADOW_GLSL}
  ${SUN_SHADOW_GLSL}
  varying vec3 vWorld;
  varying vec3 vNormalW;
  varying vec3 vNormalL;
  varying vec3 vLocalM;
  varying vec3 vTint;
  varying float vPart;
  varying float vStyle;
  varying float vSeed;
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  void main() {
    int part = int(vPart + 0.5);
    vec3 n = normalize(vNormalW);
    // Surface coordinates in metres on this face (for panels, windows, stains).
    vec2 fc = abs(vNormalL.x) > 0.5 ? vec2(vLocalM.z, vLocalM.y) : abs(vNormalL.z) > 0.5 ? vec2(vLocalM.x, vLocalM.y) : vLocalM.xz;
    float stain = vnoise(vWorld.xz / 7.0 + vWorld.y / 5.0) * 0.5 + vnoise(vWorld.xz / 1.7) * 0.5;
    vec3 col;
    vec3 glow = vec3(0.0);
    if (part == 0) {
      col = vTint * (0.86 + 0.2 * stain);
      // Rain streaks and grime darkening towards the ground.
      col *= 0.9 + 0.1 * smoothstep(0.0, 3.0, vLocalM.y);
      if (vStyle > 0.5) {
        // Camouflage: sand, olive and brown blotches.
        float b = vnoise(vWorld.xz / 9.0 + vWorld.y / 9.0 + vSeed * 13.0);
        float b2 = vnoise(vWorld.xz / 6.0 - vWorld.y / 7.0 + 7.0);
        col = mix(col, vec3(0.50, 0.48, 0.34), smoothstep(0.55, 0.6, b) * 0.7);
        col = mix(col, vec3(0.52, 0.42, 0.31), smoothstep(0.62, 0.67, b2) * 0.6);
      }
    } else if (part == 1) {
      // Steel blast doors: dark grey-green with horizontal panel seams.
      col = vec3(0.30, 0.32, 0.29) * (0.9 + 0.15 * stain);
      col *= 1.0 - 0.35 * step(0.92, fract(fc.y / 1.6));
      col *= 1.0 - 0.25 * step(0.97, fract(fc.x / 6.0));
    } else if (part == 2) {
      // Earth cover with patchy dry grass.
      col = mix(vec3(0.50, 0.44, 0.33), vec3(0.44, 0.45, 0.28), smoothstep(0.35, 0.65, vnoise(vWorld.xz / 3.0 + vWorld.y)));
      col *= 0.9 + 0.2 * vnoise(vWorld.xz * 1.3);
    } else if (part == 3) {
      // Office walls: window bands on each floor, some lit at night.
      col = vTint * (0.9 + 0.1 * stain);
      float floorH = 3.4;
      vec2 cell = vec2(floor((fc.x + 50.0) / 3.2), floor(fc.y / floorH));
      float fy = fc.y - cell.y * floorH;
      float fx = (fc.x + 50.0) - cell.x * 3.2;
      float win = step(1.0, fy) * step(fy, 2.3) * step(0.6, fx) * step(fx, 2.4) * step(0.9, fc.y);
      if (abs(vNormalL.y) > 0.5) win = 0.0;
      col = mix(col, vec3(0.13, 0.15, 0.17), win * 0.9);
      float on = step(0.45, hash12(cell + vSeed * 17.0));
      glow = vec3(1.0, 0.78, 0.45) * 0.9 * win * on * uAtmLights;
    } else if (part == 4) {
      // Tower cab glazing: dark, catching the sky; lit inside at night.
      col = vec3(0.10, 0.13, 0.16) + 0.25 * atmSky(reflect(normalize(vWorld - uAtmCamPos), n)) * 0.5;
      glow = vec3(0.55, 0.85, 0.75) * 0.5 * uAtmLights;
    } else if (part == 5) {
      col = vec3(0.84, 0.84, 0.81) * (0.92 + 0.1 * stain);
      col *= 1.0 - 0.2 * smoothstep(0.6, 0.0, vLocalM.y); // rust/dirt at the foot
    } else if (part == 6) {
      col = vec3(0.78, 0.78, 0.76);
    } else if (part == 8) {
      // Windsock bands: orange and white.
      col = mod(floor(-vLocalM.z / 0.9), 2.0) < 0.5 ? vec3(0.95, 0.42, 0.08) : vec3(0.92, 0.92, 0.9);
    } else {
      // Roofs: weathered metal / concrete.
      col = vTint * vec3(0.78, 0.80, 0.82) * (0.8 + 0.25 * stain);
      col *= 1.0 - 0.12 * step(0.9, fract(fc.x / 1.2)) * (1.0 - step(0.5, abs(vNormalL.y)));
    }
    col *= 1.0 - 0.25 * uAtmWet;
    vec3 L = normalize(uSunDir);
    // Seen from behind (from inside a shelter): an interior, lit only dimly by bounced light.
    bool inside = dot(n, vWorld - uAtmCamPos) > 0.0;
    if (inside) n = -n;
    float ndl = dot(n, L);
    float diff = inside ? 0.0 : max(ndl, 0.0) * cloudShadow(vWorld) * sunShadow(vWorld, ndl);
    vec3 ambient = mix(uAtmAmbGround, uAtmAmbSky, 0.5 + 0.5 * n.y) * (inside ? 0.8 : 1.0);
    col = col * (ambient + uAtmSunCol * diff) + glow;
    gl_FragColor = vec4(atmApply(col, vWorld), 1.0);
  }
`;

export interface AirbaseStructures {
  setStructures(list: StructureList | undefined): void;
  /**
   * The ground-service vehicles beside the player while it is refuelled and re-armed: a fuel bowser
   * on its right and a weapons trolley on its left (null hides them). y = ground level.
   */
  setServiceVehicles(at: { x: number; y: number; z: number; headingRad: number } | null): void;
  update(originWorld: Readonly<Vec3Like>, timeSec: number): void;
  setSunDirection(dir: Readonly<Vec3Like>): void;
  dispose(): void;
}

const hash = (a: number, b: number): number => {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

/** Wall colours per side (painted blocks), and concrete tints. */
const WALLS: Record<string, [number, number, number][]> = {
  friendly: [[0.86, 0.83, 0.74], [0.88, 0.87, 0.84], [0.80, 0.73, 0.60], [0.84, 0.80, 0.70]],
  hostile: [[0.80, 0.72, 0.57], [0.72, 0.68, 0.54], [0.86, 0.84, 0.79], [0.78, 0.70, 0.60]],
  neutral: [[0.86, 0.84, 0.78], [0.80, 0.76, 0.66]],
};
const CONCRETE: Record<string, [number, number, number]> = {
  friendly: [0.66, 0.66, 0.63],
  hostile: [0.68, 0.61, 0.5],
  neutral: [0.62, 0.61, 0.58],
};

export function createAirbaseStructures(root: THREE.Object3D): AirbaseStructures {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  root.add(group);
  const assets = makeAirbaseAssets();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...getAtmosphereUniforms(),
      ...getCloudShadowUniforms(),
      ...getSunShadowUniforms(),
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, -0.3) },
      uTime: { value: 0 },
    },
    vertexShader: VS,
    fragmentShader: FS,
    side: THREE.DoubleSide,
  });
  let meshes: THREE.InstancedMesh[] = [];
  const m4 = new THREE.Matrix4();
  const place = (mesh: THREE.InstancedMesh, x: number, y: number, z: number, h: number, w: number, l: number, ht: number): void => {
    const c = Math.cos(h);
    const s = Math.sin(h);
    m4.set(c * w, 0, -s * l, x, 0, ht, 0, y, s * w, 0, c * l, z, 0, 0, 0, 1);
    mesh.setMatrixAt(0, m4);
    mesh.instanceMatrix.needsUpdate = true;
  };
  const vehicle = (kind: string, tint: [number, number, number]): THREE.InstancedMesh => {
    const geom = assets[kind]!.clone();
    geom.setAttribute('iStyle', new THREE.InstancedBufferAttribute(new Float32Array(1), 1));
    const mesh = new THREE.InstancedMesh(geom, mat, 1);
    mesh.setColorAt(0, new THREE.Color(...tint));
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.layers.enable(CASTER_LAYER);
    group.add(mesh);
    return mesh;
  };
  const bowser = vehicle('fuel_truck', [0.36, 0.4, 0.27]);
  const cart = vehicle('weapons_cart', [0.3, 0.33, 0.26]);

  return {
    setStructures(list) {
      for (const m of meshes) {
        group.remove(m);
        m.geometry.dispose();
        m.dispose();
      }
      meshes = [];
      if (!list || list.length === 0) return;
      const byKind = new Map<string, StructureList[number][]>();
      for (const s of list) {
        if (!assets[s.kind]) continue;
        const a = byKind.get(s.kind) ?? [];
        a.push(s);
        byKind.set(s.kind, a);
      }
      for (const [kind, items] of byKind) {
        const geom = assets[kind]!.clone();
        const style = new Float32Array(items.length);
        const mesh = new THREE.InstancedMesh(geom, mat, items.length);
        const color = new THREE.Color();
        items.forEach((s, i) => {
          const c = Math.cos(s.headingRad);
          const sn = Math.sin(s.headingRad);
          // Columns: right (cos h, 0, sin h) * width, up * height, back (-sin h, 0, cos h) * length.
          m4.set(c * s.widthM, 0, -sn * s.lengthM, s.worldX, 0, s.heightM, 0, s.worldY, sn * s.widthM, 0, c * s.lengthM, s.worldZ, 0, 0, 0, 1);
          mesh.setMatrixAt(i, m4);
          const h = hash(s.worldX, s.worldZ);
          const side = s.side in WALLS ? s.side : 'neutral';
          const tint = kind === 'building' || kind === 'control_tower' ? WALLS[side]![Math.floor(h * WALLS[side]!.length)]! : CONCRETE[side]!;
          color.setRGB(tint[0] * (0.95 + 0.1 * h), tint[1] * (0.95 + 0.1 * h), tint[2] * (0.95 + 0.1 * h));
          mesh.setColorAt(i, color);
          style[i] = side === 'hostile' && (kind === 'shelter' || kind === 'hangar') ? 1 : 0;
        });
        geom.setAttribute('iStyle', new THREE.InstancedBufferAttribute(style, 1));
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        mesh.frustumCulled = false;
        mesh.layers.enable(CASTER_LAYER);
        group.add(mesh);
        meshes.push(mesh);
      }
    },
    setServiceVehicles(at) {
      bowser.visible = cart.visible = !!at;
      if (!at) return;
      const fx = Math.sin(at.headingRad);
      const fz = -Math.cos(at.headingRad);
      const rx = Math.cos(at.headingRad);
      const rz = Math.sin(at.headingRad);
      // Bowser parked alongside on the right, facing the same way; trolley across the left wing root.
      place(bowser, at.x + rx * 8.5 - fx * 2.5, at.y, at.z + rz * 8.5 - fz * 2.5, at.headingRad, 2.5, 9, 3.1);
      place(cart, at.x - rx * 6 + fx * 1.5, at.y, at.z - rz * 6 + fz * 1.5, at.headingRad + Math.PI / 2, 1.8, 3.6, 1.0);
    },

    update(origin, t) {
      group.position.set(-origin.x, -origin.y, -origin.z);
      group.updateMatrix();
      group.updateMatrixWorld(true);
      mat.uniforms['uTime']!.value = t % 3600;
    },
    setSunDirection(dir) {
      (mat.uniforms['uSunDir']!.value as THREE.Vector3).set(dir.x, dir.y, dir.z);
    },
    dispose() {
      for (const m of meshes) {
        m.geometry.dispose();
        m.dispose();
      }
      for (const m of [bowser, cart]) m.geometry.dispose();
      for (const g of Object.values(assets)) g.dispose();
      root.remove(group);
      mat.dispose();
    },
  };
}
