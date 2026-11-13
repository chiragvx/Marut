/**
 * src/render/aircraftLights.ts — what the aircraft's exterior lights throw into the scene, beyond
 * the lit lamp surfaces themselves (aircraftMaterial.ts):
 * - a point of light at every lit lamp (navigation, strobe flashes, landing light): a crisp disc
 *   the size of the lens, with no glow or halo round it, shown only inside the lamp's arc
 *   (navigation lights' sectors, the landing light's beam), fading with distance and haze; a
 *   distant aircraft at night is still a point of light;
 * - the light the lamps throw on the ground (the player's aircraft, whose ground height is known):
 *   the navigation lights and the landing light are handed to the terrain and pavement shaders as
 *   real lights (groundLamps.ts), so the concrete is lit, not overlaid. (The landing light's beam
 *   itself is not drawn: in clear air it is invisible; only what it lights shows.)
 * Strobes flash a double pulse every 1.2 s, each aircraft at its own phase. By day the steady
 * lights are faint and the strobes still show; at night everything is bright.
 * One Points draw for every lamp.
 */
import * as THREE from 'three';
import { EntityFlag } from '../contracts/core';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';
import type { AircraftSharedUniforms } from './aircraftMaterial';
import { MAX_GROUND_LAMPS, getGroundLampUniforms } from './groundLamps';

const MAX_GLOWS = 512;
/** Landing light beam: half-angle of its bright core, rad. */
const BEAM_HALF_ANGLE_RAD = 0.16;
const STROBE_PERIOD_SEC = 1.2;

/** Strobe flash brightness (0..1) at time t: two short pulses per period. */
export function strobeFlash(tSec: number, phaseSec: number): number {
  const p = (((tSec + phaseSec) % STROBE_PERIOD_SEC) + STROBE_PERIOD_SEC) % STROBE_PERIOD_SEC;
  return p < 0.05 || (p > 0.16 && p < 0.21) ? 1 : 0;
}

// A lamp seen from outside: an evenly lit disc the size of its lens (never under ~1.5 px, so a
// distant aircraft at night is still a point of light), with a one-pixel anti-aliased rim and no
// glow round it. Brightness falls with distance (a point source) and with the haze; directional
// lamps (navigation lights: their sector, the landing light: its beam) fade outside their arc. A
// lamp brighter than the display can show burns towards white at its centre, as a real one does.
const GLOW_VS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aIntensity;
  attribute vec4 aDir; // xyz: lamp axis (render space), w: cos(half-angle) of its arc (-2 = all round)
  attribute vec3 aUp;  // for a horizontal sector (navigation lights): the airframe's up; zero for a cone
  uniform vec3 uOrigin;
  uniform float uPxScale;
  varying vec3 vColor;
  varying float vIntensity;
  varying float vRadPx;
  varying float vPointPx;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float dist = max(0.1, -mv.z);
    // Up close the lit lens itself (aircraftMaterial.ts) is the light; the point takes over only
    // further out, where the lens shrinks under a few pixels. There it is drawn a little towards
    // the eye (a fraction of a pixel) so the fairing round the lens never hides it.
    float nearFade = smoothstep(12.0, 35.0, dist);
    mv.xyz += normalize(-mv.xyz) * min(0.004 * dist, 0.5);
    float arc = 1.0;
    if (aDir.w > -1.5) {
      vec3 toCam = normalize(uAtmCamPos - (position + uOrigin));
      float steep = 0.0;
      if (dot(aUp, aUp) > 0.5) {
        // A sector: the bearing round the airframe's up axis decides; from above or below, every lamp shows.
        float u = dot(toCam, aUp);
        steep = smoothstep(0.45, 0.8, abs(u));
        toCam = normalize(toCam - aUp * u + aDir.xyz * 1e-4);
      }
      arc = max(smoothstep(aDir.w - 0.06, aDir.w + 0.04, dot(toCam, aDir.xyz)), steep);
    }
    // Once the lens is under a pixel or two the eye sees a point whose brightness, not size, falls
    // with distance; gently, so a nav light at night still reads several km out.
    float far = 1.0 / (1.0 + pow(dist / 2500.0, 2.0));
    float I = aIntensity * arc * far * nearFade * atmTransmittance(position + uOrigin);
    vRadPx = 0.5 * max(2.0, aSize * uPxScale / dist);
    vPointPx = clamp(2.0 * vRadPx + 2.0, 3.0, 128.0);
    gl_PointSize = I > 0.003 ? vPointPx : 0.0;
    vColor = aColor;
    vIntensity = I;
    gl_Position = projectionMatrix * mv;
  }
`;

const GLOW_FS = /* glsl */ `
  precision highp float;
  varying vec3 vColor;
  varying float vIntensity;
  varying float vRadPx;
  varying float vPointPx;
  void main() {
    float r = length(gl_PointCoord - 0.5) * vPointPx; // px from the centre
    float cov = clamp(vRadPx + 0.5 - r, 0.0, 1.0);
    if (cov <= 0.0) discard;
    // The lamp's own colour; an over-bright lamp (strobe, landing light head-on) burns white.
    vec3 c = mix(vColor, vec3(1.0), smoothstep(1.0, 4.0, vIntensity) * 0.7);
    gl_FragColor = vec4(c * min(vIntensity, 1.6) * cov, 1.0);
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
  /** Formation (covert) strips: centre and outward normal of each. */
  formation?: readonly { p: readonly number[]; n: readonly number[] }[];
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
const tmpA = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
/** Navigation light arcs: red/green from ahead to 110 deg to the side (axis 55 deg off the nose,
 *  half-angle 55 deg plus a little spill); white tail light over 140 deg astern. */
const NAV_ARC_X = Math.cos((55 * Math.PI) / 180);
const NAV_ARC_Z = Math.sin((55 * Math.PI) / 180);
const NAV_ARC_COS = Math.cos((60 * Math.PI) / 180);
const TAIL_ARC_COS = Math.cos((72 * Math.PI) / 180);

export function createAircraftLights(root: THREE.Object3D, lights: LightLayout, shared: AircraftSharedUniforms): AircraftLights {
  const atm = getAtmosphereUniforms();

  // Glow sprites.
  const pos = new Float32Array(MAX_GLOWS * 3);
  const col = new Float32Array(MAX_GLOWS * 3);
  const size = new Float32Array(MAX_GLOWS);
  const inten = new Float32Array(MAX_GLOWS);
  const dir = new Float32Array(MAX_GLOWS * 4);
  const up = new Float32Array(MAX_GLOWS * 3);
  const glowGeom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  const sizeAttr = new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage);
  const intAttr = new THREE.BufferAttribute(inten, 1).setUsage(THREE.DynamicDrawUsage);
  const dirAttr = new THREE.BufferAttribute(dir, 4).setUsage(THREE.DynamicDrawUsage);
  const upAttr = new THREE.BufferAttribute(up, 3).setUsage(THREE.DynamicDrawUsage);
  glowGeom.setAttribute('position', posAttr);
  glowGeom.setAttribute('aColor', colAttr);
  glowGeom.setAttribute('aSize', sizeAttr);
  glowGeom.setAttribute('aIntensity', intAttr);
  glowGeom.setAttribute('aDir', dirAttr);
  glowGeom.setAttribute('aUp', upAttr);
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

  // Lamps lighting the ground (groundLamps.ts), world coordinates.
  const gl = getGroundLampUniforms();
  let lampN = 0;
  const origin = shared.uOrigin.value;
  /** A lamp on the ground shader: render-space position, colour x intensity; a spot (axis, cos of
   *  its half-angle) or a horizontal sector (axis, cos of its half-angle). */
  function groundLamp(p: THREE.Vector3, r: number, g: number, b: number, intensity: number, spotAxis?: THREE.Vector3, spotCos = -2, sectorAxis?: THREE.Vector3, sectorCos = -2): void {
    if (lampN >= MAX_GROUND_LAMPS || intensity <= 0) return;
    gl.uGLampPos.value[lampN]!.set(p.x + origin.x, p.y + origin.y, p.z + origin.z, intensity);
    gl.uGLampCol.value[lampN]!.set(r, g, b, spotAxis ? spotCos : -2);
    const d = gl.uGLampDir.value[lampN]!;
    if (spotAxis) d.set(spotAxis.x, spotAxis.y, spotAxis.z, -2);
    else if (sectorAxis) {
      const h = Math.hypot(sectorAxis.x, sectorAxis.z) || 1;
      d.set(sectorAxis.x / h, 0, sectorAxis.z / h, sectorCos);
    } else d.set(0, 0, 0, -2);
    lampN++;
  }

  /** A lamp at p (render space): colour, lens size (m), intensity, and its arc (axis + cos of the
   *  half-angle; omit for all round); with `sectorUp`, the arc is a horizontal sector about that axis. */
  function glow(p: THREE.Vector3, r: number, g: number, bl: number, sizeM: number, intensity: number, axis?: THREE.Vector3, cosHalf = -2, sectorUp?: THREE.Vector3): void {
    if (n >= MAX_GLOWS || intensity <= 0) return;
    pos[n * 3] = p.x;
    pos[n * 3 + 1] = p.y;
    pos[n * 3 + 2] = p.z;
    col[n * 3] = r;
    col[n * 3 + 1] = g;
    col[n * 3 + 2] = bl;
    size[n] = sizeM;
    inten[n] = intensity;
    dir[n * 4] = axis?.x ?? 0;
    dir[n * 4 + 1] = axis?.y ?? 0;
    dir[n * 4 + 2] = axis?.z ?? 0;
    dir[n * 4 + 3] = axis ? cosHalf : -2;
    up[n * 3] = sectorUp?.x ?? 0;
    up[n * 3 + 1] = sectorUp?.y ?? 0;
    up[n * 3 + 2] = sectorUp?.z ?? 0;
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
      lampN = 0;
      time = timeSec;
      night = Math.min(1, Math.max(0, atm.uAtmLights.value));
    },

    add(a) {
      const f = a.flags;
      // Steady lights: barely there by day (a real nav light is lost against a bright sky), bright at night.
      const steady = 0.12 + 1.5 * night;
      if (f & EntityFlag.Lights) {
        // Arcs (body axes, then into render space): red from dead ahead round to 110 deg left, green
        // the same to the right, white over 140 deg astern.
        const ax = (x: number, y: number, z: number): THREE.Vector3 => tmpA.set(x, y, z).transformDirection(a.airframe);
        const upAx = tmpUp.set(0, 1, 0).transformDirection(a.airframe);
        glow(at(a.airframe, lights.navLeft), 1.0, 0.1, 0.06, 0.09, steady, ax(NAV_ARC_X, 0, -NAV_ARC_Z), NAV_ARC_COS, upAx);
        glow(at(a.airframe, lights.navRight), 0.1, 1.0, 0.32, 0.09, steady, ax(NAV_ARC_X, 0, NAV_ARC_Z), NAV_ARC_COS, upAx);
        glow(at(a.airframe, lights.navTail), 1.0, 1.0, 0.95, 0.07, steady * 0.8, ax(-1, 0, 0), TAIL_ARC_COS, upAx);
        if (a.groundY !== undefined && night > 0.05) {
          // Near the ground at night the wingtip and tail lights light the concrete round them.
          const k = 8.0 * night;
          const lit = (p: THREE.Vector3): boolean => p.y - a.groundY! < 30;
          let p = at(a.airframe, lights.navLeft);
          if (lit(p)) groundLamp(p, 1.0, 0.1, 0.06, k, undefined, -2, ax(NAV_ARC_X, 0, -NAV_ARC_Z), NAV_ARC_COS);
          p = at(a.airframe, lights.navRight);
          if (lit(p)) groundLamp(p, 0.08, 1.0, 0.3, k, undefined, -2, ax(NAV_ARC_X, 0, NAV_ARC_Z), NAV_ARC_COS);
          p = at(a.airframe, lights.navTail);
          if (lit(p)) groundLamp(p, 1.0, 0.97, 0.9, k * 0.6, undefined, -2, ax(-1, 0, 0), TAIL_ARC_COS);
        }
      }
      if (f & EntityFlag.LightsFormation && lights.formation && night > 0.05) {
        // Formation strips: a faint green glimmer at night, seen only from the strip's side, so a
        // wingman can hold position from a few hundred metres; nothing by day (the lit panel itself
        // is drawn by the shader).
        for (const s of lights.formation) {
          const axis = tmpD.set(s.n[0]!, s.n[1]!, s.n[2]!).transformDirection(a.airframe);
          glow(at(a.airframe, s.p), 0.55, 1.0, 0.4, 0.05, 0.2 * night, axis, 0.05);
        }
      }
      const strobe = f & EntityFlag.LightsStrobe ? strobeFlash(time, a.phase) : 0;
      if (strobe > 0) {
        glow(at(a.airframe, lights.strobeLeft), 1.0, 0.98, 0.95, 0.07, 2.5 + 3.0 * night);
        glow(at(a.airframe, lights.strobeRight), 1.0, 0.98, 0.95, 0.07, 2.5 + 3.0 * night);
      }
      if (f & EntityFlag.LightsLanding && a.gearPos > 0.9) {
        const local = [lights.landing[0]! - a.landingPivot[0]!, lights.landing[1]! - a.landingPivot[1]!, lights.landing[2]! - a.landingPivot[2]!];
        const lamp = at(a.landingPart, local).clone();
        tmpA.set(lights.landingDir[0]!, lights.landingDir[1]!, lights.landingDir[2]!).transformDirection(a.landingPart);
        // Dazzling looking into the beam, just the lens from the side.
        glow(lamp, 1.0, 0.96, 0.88, 0.1, 2.0 + 3.0 * night, tmpA, Math.cos(0.5));
        glow(lamp, 1.0, 0.96, 0.88, 0.1, 0.15 + 0.5 * night);
        if (a.groundY !== undefined && lamp.y - a.groundY < 400) {
          // The beam on the runway. Aimed along the lamp's axis it would graze the concrete (the lamp
          // is under a metre up, the axis a few degrees down), so the slightest nose-up pitch threw
          // the hotspot 100 m+ down the runway; a taxi/landing lamp's beam is broad and spills
          // downwards, so it is taken a few degrees lower and wider: the pool starts just ahead of
          // the nose wheel and fades down the runway.
          tmpD.copy(tmpA);
          tmpD.y -= 0.06;
          tmpD.normalize();
          groundLamp(lamp, 1.0, 0.94, 0.84, 200 + 15000 * night, tmpD, Math.cos(BEAM_HALF_ANGLE_RAD * 1.5));
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
      dirAttr.needsUpdate = true;
      upAttr.needsUpdate = true;
      gl.uGLampN.value = lampN;
    },

    dispose() {
      root.remove(glows);
      glowGeom.dispose();
      glowMat.dispose();
      gl.uGLampN.value = 0;
    },
  };
}
