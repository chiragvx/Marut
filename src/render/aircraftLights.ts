/**
 * src/render/aircraftLights.ts — what the aircraft's exterior lights throw into the scene, beyond
 * the lit lamp surfaces themselves (aircraftMaterial.ts):
 * - a glow sprite at every lit lamp (navigation, strobe flashes, landing light), sized so a distant
 *   aircraft still shows as a point of light at night, dimmed by the haze;
 * - the landing light's beam, a soft additive cone ahead of the nose gear;
 * - where that beam meets the ground (the player's aircraft, whose ground height is known), a
 *   pool of light on the runway.
 * Strobes flash a double pulse every 1.2 s, each aircraft at its own phase. By day the steady
 * lights are faint and the strobes still show; at night everything is bright.
 * One Points draw for every glow; the beams and pools are pooled meshes.
 */
import * as THREE from 'three';
import { EntityFlag } from '../contracts/core';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';
import type { AircraftSharedUniforms } from './aircraftMaterial';

const MAX_GLOWS = 512;
const MAX_BEAMS = 16;
const BEAM_LENGTH_M = 70;
const BEAM_HALF_ANGLE_RAD = 0.16;
const STROBE_PERIOD_SEC = 1.2;

/** Strobe flash brightness (0..1) at time t: two short pulses per period. */
export function strobeFlash(tSec: number, phaseSec: number): number {
  const p = (((tSec + phaseSec) % STROBE_PERIOD_SEC) + STROBE_PERIOD_SEC) % STROBE_PERIOD_SEC;
  return p < 0.05 || (p > 0.16 && p < 0.21) ? 1 : 0;
}

const GLOW_VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aIntensity;
  uniform vec3 uOrigin;
  uniform float uPxScale;
  varying vec3 vColor;
  varying float vIntensity;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = max(0.1, -mv.z);
    float px = aSize * uPxScale / dist;
    gl_PointSize = clamp(px, 3.0, 90.0);
    vColor = aColor;
    // Haze between the camera and the light.
    vIntensity = aIntensity * atmTransmittance(position + uOrigin);
    gl_Position = projectionMatrix * mv;
  }
`;

const GLOW_FS = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vIntensity;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r2 = dot(d, d) * 4.0;
    float a = exp(-r2 * 16.0) * 1.6 + exp(-r2 * 3.5) * 0.35;
    gl_FragColor = vec4(vColor * a * vIntensity, 1.0);
  }
`;

const BEAM_VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  attribute float aU;
  uniform vec3 uOrigin;
  varying float vU;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz + uOrigin;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vU = aU;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const BEAM_FS = /* glsl */ `
  precision highp float;
  ${ATMOSPHERE_GLSL}
  uniform float uIntensity;
  varying float vU;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  void main() {
    vec3 V = normalize(uAtmCamPos - vWorld);
    // Faint haze lit by the beam: brightest near the lamp, fading along it and towards its edges.
    float edge = pow(abs(dot(normalize(vNormalW), V)), 2.5);
    // max(): interpolation can take vU a hair past 1 at the open end, and pow() of a negative
    // number is NaN (drawn as a dotted black ring where the beam ends).
    float k = pow(max(1.0 - vU, 0.0), 2.5) * edge * uIntensity;
    gl_FragColor = vec4(vec3(1.0, 0.94, 0.82) * k * 0.06 * atmTransmittance(vWorld), 1.0);
  }
`;

// The pool starts where the beam's centre meets the ground (v = 0) and runs ahead (v = 1 at
// uLengthM): it widens with distance and dims with the square of it.
const POOL_FS = /* glsl */ `
  precision highp float;
  uniform float uIntensity;
  uniform float uLengthM;
  uniform float uNearM;
  varying vec2 vUv;
  void main() {
    float v = vUv.y;
    float halfWidth = 0.2 + 0.8 * v;
    float lat = abs(vUv.x - 0.5) * 2.0 / halfWidth;
    float across = exp(-lat * lat * 2.5) * (1.0 - smoothstep(0.75, 1.0, lat));
    float d = uNearM + v * uLengthM;
    float along = smoothstep(0.0, 0.08, v) * (uNearM * uNearM + 400.0) / (d * d + 400.0);
    gl_FragColor = vec4(vec3(1.0, 0.93, 0.8) * across * along * uIntensity, 1.0);
  }
`;

const POOL_VS = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Layout-frame light positions (aircraftModels/tejasTestModel.ts LIGHTS). */
export interface LightLayout {
  navLeft: readonly number[];
  navRight: readonly number[];
  navTail: readonly number[];
  strobeLeft: readonly number[];
  strobeRight: readonly number[];
  landing: readonly number[];
  landingDir: readonly number[];
}

export interface AircraftLightsInput {
  /** Layout frame -> render space. */
  airframe: THREE.Matrix4;
  /** Nose gear part frame -> render space (layout coordinates minus the part's pivot). */
  landingPart: THREE.Matrix4;
  landingPivot: readonly number[];
  flags: number;
  gearPos: number;
  /** Strobe phase offset, s. */
  phase: number;
  /** Ground height under the aircraft, render space, when known (the player). */
  groundY?: number;
}

export interface AircraftLights {
  setViewportHeight(px: number, projection11: number): void;
  begin(timeSec: number): void;
  add(a: AircraftLightsInput): { strobe: number };
  end(): void;
  dispose(): void;
}

const tmpV = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);

export function createAircraftLights(root: THREE.Object3D, lights: LightLayout, shared: AircraftSharedUniforms): AircraftLights {
  const atm = getAtmosphereUniforms();

  // Glow sprites.
  const pos = new Float32Array(MAX_GLOWS * 3);
  const col = new Float32Array(MAX_GLOWS * 3);
  const size = new Float32Array(MAX_GLOWS);
  const inten = new Float32Array(MAX_GLOWS);
  const glowGeom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  const sizeAttr = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
  const intAttr = new THREE.BufferAttribute(inten, 1).setUsage(THREE.DynamicDrawUsage);
  glowGeom.setAttribute('position', posAttr);
  glowGeom.setAttribute('aColor', colAttr);
  glowGeom.setAttribute('aSize', sizeAttr);
  glowGeom.setAttribute('aIntensity', intAttr);
  const glowMat = new THREE.ShaderMaterial({
    uniforms: { ...atm, ...shared, uPxScale: { value: 500 } },
    vertexShader: GLOW_VS,
    fragmentShader: GLOW_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glows = new THREE.Points(glowGeom, glowMat);
  glows.frustumCulled = false;
  glows.renderOrder = 2;
  root.add(glows);
  let n = 0;

  // Beams and ground pools.
  const beamGeom = (() => {
    const g = new THREE.ConeGeometry(Math.tan(BEAM_HALF_ANGLE_RAD) * BEAM_LENGTH_M, BEAM_LENGTH_M, 24, 8, true);
    // Cone along +y with its apex at +L/2: make the apex the origin and point it along +x.
    g.translate(0, -BEAM_LENGTH_M / 2, 0);
    g.rotateZ(Math.PI / 2);
    const p = g.getAttribute('position');
    const u = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) u[i] = Math.min(1, Math.max(0, p.getX(i) / BEAM_LENGTH_M));
    g.setAttribute('aU', new THREE.BufferAttribute(u, 1));
    return g;
  })();
  // Unit plane on the ground, from z = 0 (near edge, at the aim point) to z = 1 (far edge).
  const poolGeom = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5);
  const beams: { beam: THREE.Mesh; beamMat: THREE.ShaderMaterial; pool: THREE.Mesh; poolMat: THREE.ShaderMaterial }[] = [];
  let beamN = 0;
  function nextBeam(): (typeof beams)[number] | undefined {
    if (beamN >= MAX_BEAMS) return undefined;
    let b = beams[beamN];
    if (!b) {
      const beamMat = new THREE.ShaderMaterial({ uniforms: { ...atm, ...shared, uIntensity: { value: 0 } }, vertexShader: BEAM_VS, fragmentShader: BEAM_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
      const poolMat = new THREE.ShaderMaterial({ uniforms: { uIntensity: { value: 0 }, uLengthM: { value: 100 }, uNearM: { value: 10 } }, vertexShader: POOL_VS, fragmentShader: POOL_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
      const beam = new THREE.Mesh(beamGeom, beamMat);
      const pool = new THREE.Mesh(poolGeom, poolMat);
      for (const m of [beam, pool]) {
        m.matrixAutoUpdate = false;
        m.frustumCulled = false;
        m.renderOrder = 2;
        m.visible = false;
        root.add(m);
      }
      b = { beam, beamMat, pool, poolMat };
      beams.push(b);
    }
    beamN++;
    return b;
  }

  function glow(p: THREE.Vector3, r: number, g: number, bl: number, sizeM: number, intensity: number): void {
    if (n >= MAX_GLOWS || intensity <= 0) return;
    pos[n * 3] = p.x;
    pos[n * 3 + 1] = p.y;
    pos[n * 3 + 2] = p.z;
    col[n * 3] = r;
    col[n * 3 + 1] = g;
    col[n * 3 + 2] = bl;
    size[n] = sizeM;
    inten[n] = intensity;
    n++;
  }

  const at = (m: THREE.Matrix4, p: readonly number[]): THREE.Vector3 => tmpV.set(p[0]!, p[1]!, p[2]!).applyMatrix4(m);
  let time = 0;
  let night = 0;

  return {
    setViewportHeight(px, projection11) {
      (glowMat.uniforms['uPxScale'] as { value: number }).value = 0.5 * px * projection11;
    },

    begin(timeSec) {
      n = 0;
      beamN = 0;
      time = timeSec;
      night = Math.min(1, Math.max(0, atm.uAtmLights.value));
    },

    add(a) {
      const f = a.flags;
      const steady = 0.35 + 1.6 * night;
      if (f & EntityFlag.Lights) {
        glow(at(a.airframe, lights.navLeft), 1.0, 0.12, 0.08, 1.4, steady);
        glow(at(a.airframe, lights.navRight), 0.1, 1.0, 0.3, 1.4, steady);
        glow(at(a.airframe, lights.navTail), 1.0, 1.0, 1.0, 1.2, steady * 0.8);
      }
      const strobe = f & EntityFlag.LightsStrobe ? strobeFlash(time, a.phase) : 0;
      if (strobe > 0) {
        glow(at(a.airframe, lights.strobeLeft), 1.0, 0.98, 0.95, 3.0, 2.2 + 2.5 * night);
        glow(at(a.airframe, lights.strobeRight), 1.0, 0.98, 0.95, 3.0, 2.2 + 2.5 * night);
      }
      if (f & EntityFlag.LightsLanding && a.gearPos > 0.9) {
        const local = [lights.landing[0]! - a.landingPivot[0]!, lights.landing[1]! - a.landingPivot[1]!, lights.landing[2]! - a.landingPivot[2]!];
        const lamp = at(a.landingPart, local).clone();
        glow(lamp, 1.0, 0.95, 0.85, 1.1, 1.2 + 2.5 * night);
        const b = nextBeam();
        if (b) {
          // Beam frame: apex at the lamp, +x along the light's direction.
          tmpD.set(lights.landingDir[0]!, lights.landingDir[1]!, lights.landingDir[2]!).transformDirection(a.landingPart);
          tmpQ.setFromUnitVectors(X_AXIS, tmpD);
          b.beam.matrix.compose(lamp, tmpQ, tmpV.set(1, 1, 1));
          b.beam.matrixWorldNeedsUpdate = true;
          b.beam.visible = true;
          (b.beamMat.uniforms['uIntensity'] as { value: number }).value = 0.08 + 0.9 * night;
          // Pool where the beam's centre meets the ground.
          b.pool.visible = false;
          if (a.groundY !== undefined && tmpD.y < -0.01) {
            const t = (a.groundY - lamp.y) / tmpD.y;
            if (t > 0 && t < 400) {
              // From half-way to the aim point to well past it, widening with the beam.
              const near = t * 0.5;
              const length = Math.min(220, t * 4 + 40);
              const hlen = Math.hypot(tmpD.x, tmpD.z) || 1;
              const hx = lamp.x + (tmpD.x / hlen) * near * hlen;
              const hz = lamp.z + (tmpD.z / hlen) * near * hlen;
              const width = 2 * (near + length) * Math.tan(BEAM_HALF_ANGLE_RAD) + 2;
              const yaw = Math.atan2(tmpD.x, tmpD.z);
              tmpM.makeRotationY(yaw).scale(tmpV.set(width, 1, length));
              tmpM.setPosition(hx, a.groundY + 0.05, hz);
              b.pool.matrix.copy(tmpM);
              b.pool.matrixWorldNeedsUpdate = true;
              b.pool.visible = true;
              (b.poolMat.uniforms['uIntensity'] as { value: number }).value = (0.05 + 1.1 * night) / (1 + (t / 120) ** 2);
              (b.poolMat.uniforms['uLengthM'] as { value: number }).value = length;
              (b.poolMat.uniforms['uNearM'] as { value: number }).value = near;
            }
          }
        }
      }
      return { strobe };
    },

    end() {
      glowGeom.setDrawRange(0, n);
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
      intAttr.needsUpdate = true;
      for (let i = beamN; i < beams.length; i++) {
        beams[i]!.beam.visible = false;
        beams[i]!.pool.visible = false;
      }
    },

    dispose() {
      root.remove(glows);
      glowGeom.dispose();
      glowMat.dispose();
      for (const b of beams) {
        root.remove(b.beam);
        root.remove(b.pool);
        b.beamMat.dispose();
        b.poolMat.dispose();
      }
      beamGeom.dispose();
      poolGeom.dispose();
    },
  };
}
