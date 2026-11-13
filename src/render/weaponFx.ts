/**
 * src/render/weaponFx.ts — the gun and the countermeasures, drawn as they look:
 *
 * - Gun (GSh-23): at the muzzle on the jet as drawn (not where the sim was a moment earlier), a
 *   flickering flame plume a metre or two long out of the blast tube with a white-hot root, the
 *   gun gas's grey smoke streaming back from it; tracer rounds (every other round in the belt) as
 *   thin hot orange-red streaks, a few pixels wide however far, starting at the muzzle.
 * - Flares: out of the dispensers in the rear fuselage's underside, down and outboard; a moment
 *   later each lights, a blinding white-hot magnesium core with a short flame licking back along
 *   its path through the air, flickering, and a thick white smoke trail that stays hanging where it
 *   was laid, lit orange right behind the flare; it burns out after ~4 s.
 * - Chaff: a bundle bursts into a cloud of fine dipoles, a fast-spreading silvery haze that stops
 *   in the air within a fraction of a second, the dipoles glinting in the sun as they tumble down.
 *
 * - Missiles and rockets: the motor's flame and a long, dense white smoke trail while it burns
 *   (they then coast on, unseen but for the trail they left).
 * - Explosions in the air: a flash, a fireball rolling out and darkening into black smoke, hot
 *   fragments flung out on smoking arcs; a big one (an aircraft) leaves burning wreckage falling.
 *
 * Three batched draws: soft lit smoke puffs (normal blending), streaks (camera-facing capsules,
 * additive) and sparks (round points, additive). Everything is in absolute world coordinates on
 * the CPU and drawn relative to the floating origin. The flight of a decoy is the sim's own
 * (src/combat/countermeasures.ts); the dispensers' places are the sim's (dispenserBody).
 */
import * as THREE from 'three';
import { EntityKindCode, type QuatLike, type SimEvent, type Vec3Like } from '../contracts/core';
import type { ShowcaseFrame } from '../contracts/render';
import { CHAFF_LIFE_SEC, FLARE_LIFE_SEC, dispenserBody } from '../combat/countermeasures';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';
import { interpolateEntity, type SnapshotDoubleBuffer } from './snapshotInterpolation';

const MAX_PUFFS = 2048;
const MAX_STREAKS = 384;
const MAX_SPARKS = 1536;
/** A gun counts as firing this long after its last round, s. */
const GUN_FIRING_SEC = 0.04;
/** Tracer streak length (the eye's persistence of a round at ~1 km/s), m. */
const TRACER_LEN_M = 16;
/** Decoys in the air at once (visuals). */
const MAX_DECOYS = 96;
const CHAFF_GLINTS = 70;
/** Flare: horizontal slowing time constant and terminal fall, as the sim flies it. */
const FLARE_TAU_SEC = 1.5;
const FLARE_FALL_MPS = 40;
const CHAFF_TAU_SEC = 0.2;
const CHAFF_FALL_MPS = 2;

// ---------------------------------------------------------------------------------------------
// Small vector helpers.
// ---------------------------------------------------------------------------------------------

function rotate(q: QuatLike, v: Vec3Like, out: Vec3Like): Vec3Like {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  const vx = v.x, vy = v.y, vz = v.z;
  out.x = vx + q.w * tx + (q.y * tz - q.z * ty);
  out.y = vy + q.w * ty + (q.z * tx - q.x * tz);
  out.z = vz + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

// ---------------------------------------------------------------------------------------------
// Shaders.
// ---------------------------------------------------------------------------------------------

const PUFF_VS = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aTint;
  uniform float uViewH;
  uniform vec3 uOrigin;
  varying float vAlpha;
  varying vec3 vTint;
  varying vec3 vWorld;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = max(0.05, -mv.z);
    float px = aSize * projectionMatrix[1][1] * 0.5 * uViewH / dist;
    // Fades as it comes right up to the eye (a puff filling the screen), and under a pixel.
    vAlpha = aAlpha * (1.0 - smoothstep(uViewH * 0.18, uViewH * 0.6, px)) * smoothstep(1.0, 6.0, dist) * min(1.0, px);
    gl_PointSize = clamp(px, 1.0, 1024.0);
    vTint = aTint;
    vWorld = position + uOrigin;
  }
`;
const PUFF_FS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  varying float vAlpha;
  varying vec3 vTint;
  varying vec3 vWorld;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r = length(c);
    if (r > 1.0) discard;
    // A lumpy edge (each puff turned by its seed), densest in the middle.
    float a = atan(c.y, c.x) + vTint.z * 6.2832;
    float lump = 0.8 + 0.11 * sin(a * 3.0) + 0.07 * sin(a * 5.0 + vTint.z * 20.0) + 0.04 * sin(a * 9.0);
    float d = r / lump;
    float alpha = vAlpha * (1.0 - smoothstep(0.35, 1.0, d));
    if (alpha < 0.003) discard;
    // Lit by the sky and the sun (a sunlit cloud of fine particles: no hard terminator), plus the
    // glow of a burning flare right behind it.
    vec3 lit = uAtmAmbSky * 1.05 + uAtmAmbGround * 0.25 + uAtmSunCol * 0.55;
    vec3 col = vec3(vTint.x) * lit + vec3(1.0, 0.6, 0.28) * vTint.y * (1.2 - d);
    gl_FragColor = vec4(atmApply(col, vWorld), alpha);
  }
`;

const STREAK_VS = /* glsl */ `
  attribute vec3 aA;
  attribute vec3 aB;
  attribute vec2 aCorner;
  attribute vec2 aW;
  attribute vec4 aCol;
  uniform vec2 uView;
  uniform vec3 uOrigin;
  // (Screen-space quantities times w, with w alone: divided back in the fragment shader they
  // interpolate linearly on screen, not with perspective.)
  varying vec4 vPixW;
  varying float vW;
  varying vec4 vCol;
  varying vec3 vWorld;
  void main() {
    vec4 va = modelViewMatrix * vec4(aA, 1.0);
    vec4 vb = modelViewMatrix * vec4(aB, 1.0);
    // Clip at the near plane in view space so a streak through the eye stays sane.
    const float NZ = -0.15;
    if (va.z > NZ && vb.z > NZ) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    if (va.z > NZ) va = mix(va, vb, (va.z - NZ) / (va.z - vb.z));
    if (vb.z > NZ) vb = mix(vb, va, (vb.z - NZ) / (vb.z - va.z));
    vec4 ca = projectionMatrix * va;
    vec4 cb = projectionMatrix * vb;
    vec2 half_ = uView * 0.5;
    vec2 pa = ca.xy / ca.w * half_;
    vec2 pb = cb.xy / cb.w * half_;
    vec2 d = pb - pa;
    float L = length(d);
    vec2 dir = L > 1e-3 ? d / L : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    bool head = aCorner.x > 0.5;
    vec4 c = head ? cb : ca;
    float realPx = aW.x * projectionMatrix[1][1] * half_.y / c.w;
    float hw = 0.5 * max(realPx, aW.y);
    vec2 off = nrm * aCorner.y * hw + dir * (head ? hw : -hw);
    c.xy += off / half_ * c.w;
    gl_Position = c;
    vPixW = vec4(aCorner.y * hw, (head ? 1.0 : -1.0) * (0.5 * L + hw), 0.5 * L, hw) * c.w;
    vW = c.w;
    // Thinner than its minimum on screen: dimmer (the same light over a wider line), but never gone.
    vCol = vec4(aCol.rgb * max(0.4, min(1.0, realPx / max(aW.y, 1e-3))), aCol.a);
    vWorld = (head ? aB : aA) + uOrigin;
  }
`;
const STREAK_FS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  varying vec4 vPixW;
  varying float vW;
  varying vec4 vCol;
  varying vec3 vWorld;
  void main() {
    vec4 pw = vPixW / vW;
    vec2 vPix = pw.xy;
    vec2 vHalf = pw.zw;
    // Distance from the segment, in half-widths (a capsule).
    vec2 q = vec2(abs(vPix.x), max(abs(vPix.y) - vHalf.x, 0.0));
    float dist = length(q) / max(vHalf.y, 1e-3);
    if (dist > 1.0) discard;
    float core = exp(-dist * dist * 4.0);
    float t = clamp((vPix.y + vHalf.x) / max(2.0 * vHalf.x, 1e-3), 0.0, 1.0);
    float along = mix(vCol.a, 1.0, t);
    // White-hot along the middle, the colour at the edges.
    vec3 col = mix(vCol.rgb, vec3(max(max(vCol.r, vCol.g), vCol.b)), exp(-dist * dist * 14.0) * 0.6);
    gl_FragColor = vec4(col * core * along * atmTransmittance(vWorld), 1.0);
  }
`;

const SPARK_VS = /* glsl */ `
  attribute vec2 aSize;
  attribute vec3 aCol;
  uniform float uViewH;
  uniform vec3 uOrigin;
  varying vec3 vCol;
  varying vec3 vWorld;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float px = aSize.x * projectionMatrix[1][1] * 0.5 * uViewH / max(0.05, -mv.z);
    gl_PointSize = clamp(max(px, aSize.y), 1.0, 512.0);
    vCol = aCol * max(0.5, min(1.0, px / max(aSize.y, 1e-3)));
    vWorld = position + uOrigin;
  }
`;
const SPARK_FS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  varying vec3 vCol;
  varying vec3 vWorld;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    float i = exp(-r2 * 3.5);
    vec3 col = mix(vCol, vec3(max(max(vCol.r, vCol.g), vCol.b)), exp(-r2 * 12.0) * 0.7);
    gl_FragColor = vec4(col * i * atmTransmittance(vWorld), 1.0);
  }
`;

// ---------------------------------------------------------------------------------------------

interface Shooter {
  lastFireSec: number;
  posBody: Vec3Like | undefined;
  /** For a gun without an airframe (ground AAA): where it is and where it points. */
  pos: Vec3Like;
  dir: Vec3Like;
  /** The muzzle last frame (absolute world), for the smoke laid between frames. */
  last: Vec3Like;
  hasLast: boolean;
}

interface DecoyFx {
  active: boolean;
  flare: boolean;
  pos: Vec3Like;
  vel: Vec3Like;
  age: number;
  seed: number;
  lastSmoke: Vec3Like;
}

/** A pose as drawn this frame. */
export interface FxPose {
  pos: Vec3Like;
  rot: QuatLike;
  vel: Vec3Like;
}

/** Where things are as drawn this frame (the interpolated snapshot, or a cinematic shot). */
export interface FxPoses {
  /** The pose of entity `id`: 'aircraft', 'other', or null when it is not there. */
  pose(id: number, out: FxPose): 'aircraft' | 'other' | null;
  /** Every gun round in flight. */
  bullets(cb: (id: number, pos: Vec3Like, vel: Vec3Like) => void): void;
}

/** FxPoses over the interpolated snapshot. */
export function snapshotPoses(buf: SnapshotDoubleBuffer, f: number): FxPoses {
  const scratch = { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 0, y: 0, z: 0 }, elevonL: 0, elevonR: 0, rudder: 0, gearPos: 0, throttle: 0 };
  return {
    pose(id, out) {
      const c = buf.curr;
      for (let i = 0; i < c.entityCount; i++) {
        if (c.id[i] !== id || c.alive[i] !== 1) continue;
        interpolateEntity(buf, i, f, scratch);
        Object.assign(out.pos, scratch.pos);
        Object.assign(out.rot, scratch.rot);
        Object.assign(out.vel, scratch.vel);
        return c.kind[i] === EntityKindCode.aircraft ? 'aircraft' : 'other';
      }
      return null;
    },
    bullets(cb) {
      const c = buf.curr;
      for (let i = 0; i < c.entityCount; i++) {
        if (c.alive[i] !== 1 || c.kind[i] !== EntityKindCode.bullet) continue;
        interpolateEntity(buf, i, f, scratch);
        cb(c.id[i]!, scratch.pos, scratch.vel);
      }
    },
  };
}

/** FxPoses over a cinematic shot's frame. */
export function showcasePoses(fr: ShowcaseFrame): FxPoses {
  return {
    pose(id, out) {
      for (const a of fr.aircraft) {
        if (a.id !== id) continue;
        Object.assign(out.pos, a.pos); Object.assign(out.rot, a.rot); Object.assign(out.vel, a.vel);
        return 'aircraft';
      }
      for (const a of fr.stores ?? []) {
        if (a.id !== id) continue;
        Object.assign(out.pos, a.pos); Object.assign(out.rot, a.rot); Object.assign(out.vel, a.vel);
        return 'other';
      }
      return null;
    },
    bullets(cb) {
      for (const b of fr.bullets ?? []) cb(b.id, b.pos, b.vel);
    },
  };
}

export interface WeaponFx {
  ingest(ev: SimEvent): void;
  /** The jets as drawn this frame: muzzle flashes, tracers, decoys leaving their dispensers, missile motors. */
  sync(poses: FxPoses, originWorld: Readonly<Vec3Like>): void;
  /** Clears everything (a cinematic shot starting over). */
  reset(): void;
  tick(dtSec: number, originWorld: Readonly<Vec3Like>): void;
  setView(widthPx: number, heightPx: number): void;
  dispose(): void;
}

export function createWeaponFx(root: THREE.Object3D): WeaponFx {
  const atm = getAtmosphereUniforms();
  const uOrigin = { value: new THREE.Vector3() };
  const uViewH = { value: 1080 };
  const uView = { value: new THREE.Vector2(1920, 1080) };

  // --- Puffs ---
  const pX = new Float64Array(MAX_PUFFS), pY = new Float64Array(MAX_PUFFS), pZ = new Float64Array(MAX_PUFFS);
  const pVx = new Float32Array(MAX_PUFFS), pVy = new Float32Array(MAX_PUFFS), pVz = new Float32Array(MAX_PUFFS);
  const pAge = new Float32Array(MAX_PUFFS), pLife = new Float32Array(MAX_PUFFS).fill(-1);
  const pS0 = new Float32Array(MAX_PUFFS), pS1 = new Float32Array(MAX_PUFFS), pGrow = new Float32Array(MAX_PUFFS);
  const pA0 = new Float32Array(MAX_PUFFS), pAlb = new Float32Array(MAX_PUFFS), pGlow = new Float32Array(MAX_PUFFS);
  const pSeed = new Float32Array(MAX_PUFFS), pDrag = new Float32Array(MAX_PUFFS), pGlowTau = new Float32Array(MAX_PUFFS);
  let pHead = 0;
  const puffGeo = new THREE.BufferGeometry();
  const puffPos = new Float32Array(MAX_PUFFS * 3), puffSize = new Float32Array(MAX_PUFFS), puffAlpha = new Float32Array(MAX_PUFFS), puffTint = new Float32Array(MAX_PUFFS * 3);
  puffGeo.setAttribute('position', new THREE.BufferAttribute(puffPos, 3).setUsage(THREE.DynamicDrawUsage));
  puffGeo.setAttribute('aSize', new THREE.BufferAttribute(puffSize, 1).setUsage(THREE.DynamicDrawUsage));
  puffGeo.setAttribute('aAlpha', new THREE.BufferAttribute(puffAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  puffGeo.setAttribute('aTint', new THREE.BufferAttribute(puffTint, 3).setUsage(THREE.DynamicDrawUsage));
  puffGeo.setDrawRange(0, 0);
  const puffMat = new THREE.ShaderMaterial({ uniforms: { ...atm, uOrigin, uViewH }, vertexShader: PUFF_VS, fragmentShader: PUFF_FS, transparent: true, depthWrite: false });
  const puffs = new THREE.Points(puffGeo, puffMat);
  puffs.frustumCulled = false;
  puffs.renderOrder = 2;

  function puff(x: number, y: number, z: number, vx: number, vy: number, vz: number, drag: number, life: number, s0: number, s1: number, grow: number, a0: number, albedo: number, glow: number, glowTau = 0.12): void {
    const i = pHead;
    pHead = (pHead + 1) % MAX_PUFFS;
    pX[i] = x; pY[i] = y; pZ[i] = z;
    pVx[i] = vx; pVy[i] = vy; pVz[i] = vz;
    pDrag[i] = drag;
    pAge[i] = 0; pLife[i] = life;
    pS0[i] = s0; pS1[i] = s1; pGrow[i] = grow;
    pA0[i] = a0; pAlb[i] = albedo; pGlow[i] = glow;
    pSeed[i] = Math.random();
    pGlowTau[i] = glowTau;
  }

  // --- Streaks ---
  const SV = MAX_STREAKS * 4;
  const sA = new Float32Array(SV * 3), sB = new Float32Array(SV * 3), sW = new Float32Array(SV * 2), sCol = new Float32Array(SV * 4);
  const corner = new Float32Array(SV * 2);
  const idx = new Uint32Array(MAX_STREAKS * 6);
  for (let i = 0; i < MAX_STREAKS; i++) {
    corner.set([0, -1, 0, 1, 1, -1, 1, 1], i * 8);
    idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 1, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const streakGeo = new THREE.BufferGeometry();
  // (three.js wants a position attribute for its bookkeeping; aA does the work.)
  streakGeo.setAttribute('position', new THREE.BufferAttribute(sA, 3).setUsage(THREE.DynamicDrawUsage));
  streakGeo.setAttribute('aA', streakGeo.getAttribute('position'));
  streakGeo.setAttribute('aB', new THREE.BufferAttribute(sB, 3).setUsage(THREE.DynamicDrawUsage));
  streakGeo.setAttribute('aW', new THREE.BufferAttribute(sW, 2).setUsage(THREE.DynamicDrawUsage));
  streakGeo.setAttribute('aCol', new THREE.BufferAttribute(sCol, 4).setUsage(THREE.DynamicDrawUsage));
  streakGeo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  streakGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  streakGeo.setDrawRange(0, 0);
  const streakMat = new THREE.ShaderMaterial({
    uniforms: { ...atm, uOrigin, uView }, vertexShader: STREAK_VS, fragmentShader: STREAK_FS,
    transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const streaks = new THREE.Mesh(streakGeo, streakMat);
  streaks.frustumCulled = false;
  streaks.renderOrder = 3;
  let streakN = 0;
  let org = { x: 0, y: 0, z: 0 };

  /** A streak from a (dim end, `tailAlpha`) to b (bright end), absolute world. */
  function streak(ax: number, ay: number, az: number, bx: number, by: number, bz: number, widthM: number, minPx: number, r: number, g: number, b: number, tailAlpha: number): void {
    if (streakN >= MAX_STREAKS) return;
    const v0 = streakN * 4;
    for (let k = 0; k < 4; k++) {
      const v = v0 + k;
      sA[v * 3] = ax - org.x; sA[v * 3 + 1] = ay - org.y; sA[v * 3 + 2] = az - org.z;
      sB[v * 3] = bx - org.x; sB[v * 3 + 1] = by - org.y; sB[v * 3 + 2] = bz - org.z;
      sW[v * 2] = widthM; sW[v * 2 + 1] = minPx;
      sCol[v * 4] = r; sCol[v * 4 + 1] = g; sCol[v * 4 + 2] = b; sCol[v * 4 + 3] = tailAlpha;
    }
    streakN++;
  }

  // --- Sparks ---
  const kPos = new Float32Array(MAX_SPARKS * 3), kSize = new Float32Array(MAX_SPARKS * 2), kCol = new Float32Array(MAX_SPARKS * 3);
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(kPos, 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setAttribute('aSize', new THREE.BufferAttribute(kSize, 2).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setAttribute('aCol', new THREE.BufferAttribute(kCol, 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setDrawRange(0, 0);
  const sparkMat = new THREE.ShaderMaterial({
    uniforms: { ...atm, uOrigin, uViewH }, vertexShader: SPARK_VS, fragmentShader: SPARK_FS,
    transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  sparks.renderOrder = 3;
  let sparkN = 0;
  function spark(x: number, y: number, z: number, sizeM: number, minPx: number, r: number, g: number, b: number): void {
    if (sparkN >= MAX_SPARKS) return;
    kPos[sparkN * 3] = x - org.x; kPos[sparkN * 3 + 1] = y - org.y; kPos[sparkN * 3 + 2] = z - org.z;
    kSize[sparkN * 2] = sizeM; kSize[sparkN * 2 + 1] = minPx;
    kCol[sparkN * 3] = r; kCol[sparkN * 3 + 1] = g; kCol[sparkN * 3 + 2] = b;
    sparkN++;
  }

  // Chaff dipoles (glints): their own little particles.
  const gX = new Float64Array(MAX_SPARKS), gY = new Float64Array(MAX_SPARKS), gZ = new Float64Array(MAX_SPARKS);
  const gVx = new Float32Array(MAX_SPARKS), gVy = new Float32Array(MAX_SPARKS), gVz = new Float32Array(MAX_SPARKS);
  const gAge = new Float32Array(MAX_SPARKS), gLife = new Float32Array(MAX_SPARKS).fill(-1), gFall = new Float32Array(MAX_SPARKS);
  let gHead = 0;

  root.add(puffs, streaks, sparks);

  // --- State ---
  const shooters = new Map<number, Shooter>();
  const pending: { ownerId: number; flare: boolean; pos: Vec3Like; vel: Vec3Like }[] = [];
  const decoys: DecoyFx[] = Array.from({ length: MAX_DECOYS }, () => ({ active: false, flare: true, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, age: 0, seed: 0, lastSmoke: { x: 0, y: 0, z: 0 } }));
  let clock = 0;
  const pose: FxPose = { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 0, y: 0, z: 0 } };
  /** Missiles and rockets in flight: their motors and smoke trails. */
  const motors: { id: number; age: number; burnSec: number; last: Vec3Like; hasLast: boolean; seen: boolean }[] = [];
  /** Explosions in the air (their flash), and the fragments they threw. */
  const blasts: { pos: Vec3Like; r: number; age: number }[] = [];
  const frags: { pos: Vec3Like; vel: Vec3Like; age: number; life: number; size: number; burning: boolean; last: Vec3Like }[] = [];
  const v1 = { x: 0, y: 0, z: 0 };
  const v2 = { x: 0, y: 0, z: 0 };
  const fwd = { x: 0, y: 0, z: 0 };
  const X_AXIS = { x: 1, y: 0, z: 0 };
  const Z_AXIS = { x: 0, y: 0, z: 1 };
  /** Muzzles firing this frame (absolute world) and their pointing, for the tracers' start. */
  const muzzles: { p: Vec3Like; d: Vec3Like }[] = [];
  let muzzleN = 0;

  /** An explosion in the air at p, radius r (m); `vel` the velocity of what blew up (its wreckage carries it). */
  function blast(p: Vec3Like, r: number, vel?: Vec3Like): void {
    if (blasts.length > 24) blasts.shift();
    blasts.push({ pos: { ...p }, r, age: 0 });
    const vx = vel?.x ?? 0, vy = vel?.y ?? 0, vz = vel?.z ?? 0;
    // The fireball: hot, billowing, rolling outwards, cooling into black smoke.
    const nFire = Math.min(26, 8 + Math.round(r * 1.2));
    for (let k = 0; k < nFire; k++) {
      const u = rnd(-1, 1), th = rnd(0, Math.PI * 2), s = Math.sqrt(1 - u * u), sp = rnd(0.5, 1.6) * r;
      puff(p.x + s * Math.cos(th) * r * 0.2, p.y + u * r * 0.2, p.z + s * Math.sin(th) * r * 0.2,
        vx * 0.5 + s * Math.cos(th) * sp, vy * 0.5 + u * sp, vz * 0.5 + s * Math.sin(th) * sp,
        0.45, rnd(3.5, 6.5), r * rnd(0.25, 0.45), r * rnd(1.0, 1.6), 0.35, 0.85, 0.16, rnd(2.2, 3.2), rnd(0.25, 0.5));
    }
    // Fragments: hot bits flung out on smoking arcs; a big blast leaves burning wreckage.
    const nFrag = Math.min(22, 6 + Math.round(r));
    for (let k = 0; k < nFrag; k++) {
      const u = rnd(-0.6, 1), th = rnd(0, Math.PI * 2), s = Math.sqrt(1 - u * u), sp = rnd(30, 110);
      const burning = r >= 12 && k < 3;
      const m = burning ? 0.25 : 1;
      frags.push({
        pos: { ...p },
        vel: { x: vx * (burning ? 0.8 : 0.4) + s * Math.cos(th) * sp * m, y: vy * 0.5 + u * sp * m, z: vz * (burning ? 0.8 : 0.4) + s * Math.sin(th) * sp * m },
        age: 0, life: burning ? rnd(5, 8) : rnd(0.8, 2.2), size: burning ? rnd(1.2, 2.2) : rnd(0.15, 0.4), burning, last: { ...p },
      });
    }
    if (frags.length > 160) frags.splice(0, frags.length - 160);
  }

  function launch(flare: boolean, pos: Vec3Like, vel: Vec3Like): void {
    const d = decoys.find((x) => !x.active);
    if (!d) return;
    d.active = true;
    d.flare = flare;
    Object.assign(d.pos, pos);
    Object.assign(d.vel, vel);
    Object.assign(d.lastSmoke, pos);
    d.age = 0;
    d.seed = Math.random() * 100;
    if (!flare) {
      // The bundle bursts: dipoles flung out in all directions, slowing in the air at once.
      for (let k = 0; k < CHAFF_GLINTS; k++) {
        const i = gHead;
        gHead = (gHead + 1) % MAX_SPARKS;
        const u = rnd(-1, 1), th = rnd(0, Math.PI * 2), s = Math.sqrt(1 - u * u), sp = rnd(6, 22);
        gX[i] = pos.x; gY[i] = pos.y; gZ[i] = pos.z;
        gVx[i] = vel.x + s * Math.cos(th) * sp;
        gVy[i] = vel.y + u * sp;
        gVz[i] = vel.z + s * Math.sin(th) * sp;
        gAge[i] = 0;
        gLife[i] = rnd(2.5, CHAFF_LIFE_SEC * 0.7);
        gFall[i] = rnd(0.8, 2.5);
      }
      // And a silvery haze where they spread.
      for (let k = 0; k < 5; k++) {
        puff(pos.x, pos.y, pos.z, vel.x + rnd(-8, 8), vel.y + rnd(-8, 8), vel.z + rnd(-8, 8), CHAFF_TAU_SEC, rnd(2.2, 3.4), 0.8, rnd(8, 12), 0.35, 0.2, 0.82, 0);
      }
    }
  }

  return {
    ingest(ev) {
      if (ev.type === 'gunFire') {
        let s = shooters.get(ev.shooterId);
        if (!s) {
          s = { lastFireSec: -1, posBody: undefined, pos: { x: 0, y: 0, z: 0 }, dir: { x: 1, y: 0, z: 0 }, last: { x: 0, y: 0, z: 0 }, hasLast: false };
          shooters.set(ev.shooterId, s);
        }
        if (clock - s.lastFireSec > 0.3) s.hasLast = false;
        s.lastFireSec = clock;
        s.posBody = ev.posBody;
        Object.assign(s.pos, ev.pos);
        Object.assign(s.dir, ev.dir);
      } else if (ev.type === 'countermeasure') {
        pending.push({ ownerId: ev.entityId, flare: ev.kind === 'flare', pos: { ...ev.pos }, vel: { ...ev.vel } });
      } else if (ev.type === 'missileLaunch') {
        if (ev.weapon === 'bomb' || ev.weapon === 'guided_bomb') return;
        const burnSec = ev.weapon === 'rocket' ? 1.1 : ev.weapon === 'ir_missile' ? 2.8 : 5.5;
        if (motors.length > 32) motors.shift();
        motors.push({ id: ev.missileId, age: 0, burnSec, last: { x: 0, y: 0, z: 0 }, hasLast: false, seen: false });
      } else if (ev.type === 'explosion') {
        blast(ev.pos, Math.max(3, ev.radiusM), ev.vel);
      }
    },

    sync(poses, originWorld) {
      org = originWorld as { x: number; y: number; z: number };
      // Decoys out of the dispensers of the jet as drawn.
      for (const p of pending) {
        if (poses.pose(p.ownerId, pose)) {
          // Which side's dispenser: the side the cartridge was fired towards.
          rotate(pose.rot, Z_AXIS, v1);
          const side = (p.vel.x - pose.vel.x) * v1.x + (p.vel.y - pose.vel.y) * v1.y + (p.vel.z - pose.vel.z) * v1.z >= 0 ? 1 : -1;
          rotate(pose.rot, dispenserBody(side, v2), v2);
          p.pos.x = pose.pos.x + v2.x;
          p.pos.y = pose.pos.y + v2.y;
          p.pos.z = pose.pos.z + v2.z;
        }
        launch(p.flare, p.pos, p.vel);
      }
      pending.length = 0;

      const sunL = (atm.uAtmSunCol.value.r + atm.uAtmSunCol.value.g + atm.uAtmSunCol.value.b) / 3;
      const dayNight = 1 - Math.min(1, sunL * 2);
      // Guns: the flash at the muzzle on the jet as drawn; the gun gas's smoke.
      muzzleN = 0;
      streakN = 0;
      for (const [id, s] of shooters) {
        if (clock - s.lastFireSec > GUN_FIRING_SEC) {
          if (clock - s.lastFireSec > 5) shooters.delete(id);
          continue;
        }
        let m: Vec3Like = s.pos;
        let d: Vec3Like = s.dir;
        if (s.posBody && poses.pose(id, pose) === 'aircraft') {
          rotate(pose.rot, s.posBody!, v1);
          m = { x: pose.pos.x + v1.x, y: pose.pos.y + v1.y, z: pose.pos.z + v1.z };
          d = rotate(pose.rot, X_AXIS, { x: 0, y: 0, z: 0 });
        }
        if (muzzleN < 16) {
          const mz = muzzles[muzzleN] ?? (muzzles[muzzleN] = { p: { x: 0, y: 0, z: 0 }, d: { x: 0, y: 0, z: 0 } });
          Object.assign(mz.p, m);
          Object.assign(mz.d, d);
          muzzleN++;
        }
        // The flame out of the blast tube: brightest at the muzzle, a ragged plume that flickers
        // round after round; now and then a short star of side jets.
        // (In daylight a gun's flash is a brief orange flicker; at night it lights up.)
        const big = Math.random() < 0.45;
        const len = big ? rnd(0.7, 1.4) : rnd(0.25, 0.6);
        const k = (big ? rnd(0.8, 1.15) : rnd(0.35, 0.6)) * (0.6 + 0.4 * dayNight);
        streak(m.x + d.x * len, m.y + d.y * len, m.z + d.z * len, m.x, m.y, m.z, big ? rnd(0.3, 0.45) : 0.22, 2.0, 1.0 * k, 0.55 * k, 0.2 * k, 0.0);
        streak(m.x + d.x * len * 0.35, m.y + d.y * len * 0.35, m.z + d.z * len * 0.35, m.x, m.y, m.z, 0.16, 1.4, 1.0 * k, 0.88 * k, 0.65 * k, 0.15);
        if (big && Math.random() < 0.4) {
          for (let j = 0; j < 3; j++) {
            v1.x = d.x * 0.5 + rnd(-1, 1); v1.y = d.y * 0.5 + rnd(-1, 1); v1.z = d.z * 0.5 + rnd(-1, 1);
            const l = rnd(0.25, 0.55) / Math.max(0.3, Math.hypot(v1.x, v1.y, v1.z));
            streak(m.x + v1.x * l, m.y + v1.y * l, m.z + v1.z * l, m.x, m.y, m.z, 0.12, 1.2, 0.9 * k, 0.5 * k, 0.2 * k, 0.0);
          }
        }
        // Gun gas: grey smoke laid along the muzzle's path since last frame (it stops in the air
        // at once, so it streams back from the jet), blown forward a little by the blast.
        const from = s.hasLast ? s.last : m;
        const dist = Math.hypot(m.x - from.x, m.y - from.y, m.z - from.z);
        const n = Math.min(10, Math.max(1, Math.ceil(dist / 1.4)));
        for (let j = 0; j < n; j++) {
          const t = (j + Math.random()) / n;
          const blast = rnd(15, 45);
          puff(from.x + (m.x - from.x) * t, from.y + (m.y - from.y) * t, from.z + (m.z - from.z) * t,
            d.x * blast, d.y * blast, d.z * blast, 0.12, rnd(1.1, 1.8), 0.35, rnd(1.8, 2.8), 0.6, 0.3, 0.58, j === n - 1 ? 0.4 : 0);
        }
        Object.assign(s.last, m);
        s.hasLast = true;
      }

      // Tracers: every other round, a hot streak from the round back along its flight, cut at the
      // muzzle while it is just out of the gun.
      poses.bullets((id, bpos, bvel) => {
        if ((id & 1) === 1) return;
        const bullet = { pos: bpos, vel: bvel };
        const sp = Math.hypot(bullet.vel.x, bullet.vel.y, bullet.vel.z);
        if (sp < 1) return;
        fwd.x = bullet.vel.x / sp; fwd.y = bullet.vel.y / sp; fwd.z = bullet.vel.z / sp;
        const h = bullet.pos;
        let L = TRACER_LEN_M;
        for (let j = 0; j < muzzleN; j++) {
          const mp = muzzles[j]!.p;
          const dx = h.x - mp.x, dy = h.y - mp.y, dz = h.z - mp.z;
          const along = dx * fwd.x + dy * fwd.y + dz * fwd.z;
          if (along > -1 && along < L && dx * dx + dy * dy + dz * dz - along * along < 25) L = Math.max(0, along);
        }
        if (L < 0.3) return;
        streak(h.x - fwd.x * L, h.y - fwd.y * L, h.z - fwd.z * L, h.x, h.y, h.z, 0.1, 1.8, 1.0, 0.42, 0.16, 0.0);
      });

      // Missile and rocket motors: the flame, the trail laid along the path while it burns.
      for (let i = motors.length - 1; i >= 0; i--) {
        const m = motors[i]!;
        const kind = poses.pose(m.id, pose);
        if (!kind) {
          if (m.seen || m.age > 2) motors.splice(i, 1);
          continue;
        }
        m.seen = true;
        if (m.age > m.burnSec + 0.3) {
          m.hasLast = false;
          continue;
        }
        const sp = Math.hypot(pose.vel.x, pose.vel.y, pose.vel.z);
        if (sp > 1) {
          fwd.x = pose.vel.x / sp; fwd.y = pose.vel.y / sp; fwd.z = pose.vel.z / sp;
        } else rotate(pose.rot, X_AXIS, fwd);
        // The nozzle, at the missile's tail.
        const nx = pose.pos.x - fwd.x * 1.5, ny = pose.pos.y - fwd.y * 1.5, nz = pose.pos.z - fwd.z * 1.5;
        const burning = m.age > 0.04 && m.age < m.burnSec;
        const I = burning ? Math.min(1, (m.age - 0.04) / 0.08) * (0.85 + rnd(0, 0.3)) : 0;
        if (I > 0) {
          const fl = rnd(2.2, 3.4);
          streak(nx - fwd.x * fl, ny - fwd.y * fl, nz - fwd.z * fl, nx, ny, nz, 0.45, 2.2, 1.0 * I, 0.62 * I, 0.3 * I, 0.0);
          spark(nx, ny, nz, 0.6, 3, 1.5 * I, 1.35 * I, 1.1 * I);
          spark(nx, ny, nz, 2.5, 5, 0.25 * I, 0.14 * I, 0.06 * I);
        }
        // Dense white smoke, laid along the path, hanging in the air.
        if (burning) {
          const from = m.hasLast ? m.last : { x: nx, y: ny, z: nz };
          const dx = nx - from.x, dy = ny - from.y, dz = nz - from.z;
          const dist = Math.hypot(dx, dy, dz);
          const n = Math.min(40, Math.max(1, Math.floor(dist / 0.7)));
          for (let j = 1; j <= n; j++) {
            const t = j / n;
            puff(from.x + dx * t + rnd(-0.1, 0.1), from.y + dy * t + rnd(-0.1, 0.1), from.z + dz * t + rnd(-0.1, 0.1),
              rnd(-0.4, 0.4), rnd(-0.2, 0.4), rnd(-0.4, 0.4), 1, rnd(6, 9), 0.35, rnd(2.6, 4), 3.0, 0.42 * Math.min(1, m.age / 0.25 + 0.3), 0.9, j === n ? 0.9 : 0.3);
          }
          m.last.x = nx; m.last.y = ny; m.last.z = nz;
          m.hasLast = true;
        }
      }
    },

    tick(dtSec, originWorld) {
      clock += dtSec;
      org = originWorld as { x: number; y: number; z: number };
      uOrigin.value.set(originWorld.x, originWorld.y, originWorld.z);
      sparkN = 0;
      const sunLum = Math.min(1.5, (atm.uAtmSunCol.value.r + atm.uAtmSunCol.value.g + atm.uAtmSunCol.value.b) / 3);
      const night = 1 - Math.min(1, sunLum * 2);

      for (const m of motors) m.age += dtSec;
      // Explosion flashes.
      for (let i = blasts.length - 1; i >= 0; i--) {
        const b = blasts[i]!;
        b.age += dtSec;
        if (b.age > 0.6) {
          blasts.splice(i, 1);
          continue;
        }
        const I = Math.exp(-b.age / 0.09);
        spark(b.pos.x, b.pos.y, b.pos.z, b.r * 1.4, 10, 2.0 * I, 1.7 * I, 1.2 * I);
        spark(b.pos.x, b.pos.y, b.pos.z, b.r * 4, 16, 0.5 * I, 0.3 * I, 0.12 * I);
      }
      // Fragments: hot streaks on ballistic arcs, smoking; burning wreckage trailing fire and black smoke.
      for (let i = frags.length - 1; i >= 0; i--) {
        const g = frags[i]!;
        g.age += dtSec;
        if (g.age >= g.life) {
          frags.splice(i, 1);
          continue;
        }
        const k = Math.min(1, dtSec / (g.burning ? 6 : 1.2));
        g.vel.x -= g.vel.x * k;
        g.vel.z -= g.vel.z * k;
        g.vel.y -= 9.81 * dtSec + g.vel.y * k * 0.3;
        g.pos.x += g.vel.x * dtSec;
        g.pos.y += g.vel.y * dtSec;
        g.pos.z += g.vel.z * dtSec;
        const heat = g.burning ? Math.min(1, (g.life - g.age) / 1.5) : Math.exp(-g.age / (g.life * 0.45));
        const sp = Math.hypot(g.vel.x, g.vel.y, g.vel.z) || 1;
        const tl = Math.min(g.burning ? 6 : 3, sp * 0.03);
        streak(g.pos.x - (g.vel.x / sp) * tl, g.pos.y - (g.vel.y / sp) * tl, g.pos.z - (g.vel.z / sp) * tl, g.pos.x, g.pos.y, g.pos.z, g.size, 1.6, 1.0 * heat, 0.5 * heat, 0.18 * heat, 0.0);
        if (g.burning) spark(g.pos.x, g.pos.y, g.pos.z, g.size * 1.6, 4, 1.2 * heat, 0.75 * heat, 0.35 * heat);
        const dx = g.pos.x - g.last.x, dy = g.pos.y - g.last.y, dz = g.pos.z - g.last.z;
        const dist = Math.hypot(dx, dy, dz);
        const step = g.burning ? 1.2 : 2.5;
        if (dist > step) {
          const n = Math.min(10, Math.floor(dist / step));
          for (let j = 1; j <= n; j++) {
            const t = j / n;
            if (g.burning) puff(g.last.x + dx * t, g.last.y + dy * t, g.last.z + dz * t, rnd(-0.5, 0.5), rnd(0, 1), rnd(-0.5, 0.5), 1, rnd(5, 8), 0.8, rnd(5, 8), 1.8, 0.65 * heat + 0.1, 0.12, 2.0 * heat, 0.25);
            else puff(g.last.x + dx * t, g.last.y + dy * t, g.last.z + dz * t, 0, 0, 0, 1, rnd(1.5, 2.5), 0.25, rnd(1.2, 2), 0.8, 0.35 * heat, 0.3, 0.6 * heat, 0.1);
          }
          Object.assign(g.last, g.pos);
        }
      }
      // Decoys.
      for (const d of decoys) {
        if (!d.active) continue;
        d.age += dtSec;
        const life = d.flare ? FLARE_LIFE_SEC : CHAFF_LIFE_SEC;
        if (d.age >= life) {
          d.active = false;
          continue;
        }
        const k = Math.min(1, dtSec / (d.flare ? FLARE_TAU_SEC : CHAFF_TAU_SEC));
        d.vel.x -= d.vel.x * k;
        d.vel.y += (-(d.flare ? FLARE_FALL_MPS : CHAFF_FALL_MPS) - d.vel.y) * k;
        d.vel.z -= d.vel.z * k;
        d.pos.x += d.vel.x * dtSec;
        d.pos.y += d.vel.y * dtSec;
        d.pos.z += d.vel.z * dtSec;
        if (!d.flare) continue;
        // Lights a moment after it leaves the dispenser, burns fiercely, gutters and dies.
        const burn = Math.min(1, Math.max(0, (d.age - 0.06) / 0.12)) * (1 - smooth01((d.age - (life - 0.9)) / 0.9));
        if (burn <= 0.01) {
          Object.assign(d.lastSmoke, d.pos);
          continue;
        }
        const flick = 0.82 + 0.18 * Math.sin(clock * 53 + d.seed) * Math.sin(clock * 31 + d.seed * 1.7) + rnd(-0.08, 0.08);
        const I = burn * flick;
        const p = d.pos;
        // The flame: back along its path through the air.
        const sp = Math.hypot(d.vel.x, d.vel.y, d.vel.z);
        if (sp > 1) {
          const fl = Math.min(4.5, Math.max(0.5, sp * 0.016));
          streak(p.x - (d.vel.x / sp) * fl, p.y - (d.vel.y / sp) * fl, p.z - (d.vel.z / sp) * fl, p.x, p.y, p.z, 0.55, 2.2, 1.0 * I, 0.55 * I, 0.22 * I, 0.0);
        }
        // White-hot core and the glare round it (stronger at night).
        spark(p.x, p.y, p.z, 0.9, 3.0, 1.6 * I, 1.5 * I, 1.35 * I);
        spark(p.x, p.y, p.z, 4.0, 7.0, (0.22 + 0.25 * night) * I, (0.12 + 0.14 * night) * I, (0.05 + 0.05 * night) * I);
        // Thick white smoke laid along the path, glowing orange right behind the flame.
        const dx = p.x - d.lastSmoke.x, dy = p.y - d.lastSmoke.y, dz = p.z - d.lastSmoke.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist > 0.7) {
          const n = Math.min(12, Math.floor(dist / 0.7));
          for (let j = 1; j <= n; j++) {
            const t = j / n;
            puff(d.lastSmoke.x + dx * t + rnd(-0.15, 0.15), d.lastSmoke.y + dy * t + rnd(-0.15, 0.15), d.lastSmoke.z + dz * t + rnd(-0.15, 0.15),
              rnd(-0.4, 0.4), rnd(-0.2, 0.5), rnd(-0.4, 0.4), 1, rnd(3.2, 5.2), 0.55 * burn + 0.2, rnd(4, 6.5), 1.6, 0.5 * burn + 0.08, 0.92, 1.1 * I);
          }
          Object.assign(d.lastSmoke, p);
        }
      }

      // Chaff glints: dipoles tumbling, catching the sun.
      for (let i = 0; i < MAX_SPARKS; i++) {
        if (gLife[i]! < 0) continue;
        const age = (gAge[i]! += dtSec);
        if (age >= gLife[i]!) {
          gLife[i] = -1;
          continue;
        }
        const k = Math.min(1, dtSec / CHAFF_TAU_SEC);
        gVx[i]! -= gVx[i]! * k;
        gVy[i]! += (-gFall[i]! - gVy[i]!) * k;
        gVz[i]! -= gVz[i]! * k;
        gX[i]! += (gVx[i]! + rnd(-0.6, 0.6)) * dtSec;
        gY[i]! += gVy[i]! * dtSec;
        gZ[i]! += (gVz[i]! + rnd(-0.6, 0.6)) * dtSec;
        const fade = 1 - smooth01((age - gLife[i]! * 0.6) / (gLife[i]! * 0.4));
        const glint = Math.random() < 0.12 ? 1 : 0.18;
        const b = fade * glint * (0.12 + 0.9 * sunLum);
        spark(gX[i]!, gY[i]!, gZ[i]!, 0.05, 1.6, 0.9 * b, 0.93 * b, 1.0 * b);
      }

      // Puffs.
      let n = 0;
      for (let i = 0; i < MAX_PUFFS; i++) {
        const life = pLife[i]!;
        if (life < 0) continue;
        const age = (pAge[i]! += dtSec);
        if (age >= life) {
          pLife[i] = -1;
          continue;
        }
        const k = Math.min(1, dtSec / pDrag[i]!);
        pVx[i]! -= pVx[i]! * k;
        pVy[i]! -= pVy[i]! * k;
        pVz[i]! -= pVz[i]! * k;
        pX[i]! += pVx[i]! * dtSec;
        pY[i]! += pVy[i]! * dtSec + 0.15 * dtSec;
        pZ[i]! += pVz[i]! * dtSec;
        const u = age / life;
        puffPos[n * 3] = pX[i]! - org.x;
        puffPos[n * 3 + 1] = pY[i]! - org.y;
        puffPos[n * 3 + 2] = pZ[i]! - org.z;
        puffSize[n] = pS0[i]! + (pS1[i]! - pS0[i]!) * (1 - Math.exp(-age / pGrow[i]!));
        puffAlpha[n] = pA0[i]! * Math.pow(1 - u, 1.6) * Math.min(1, age / 0.04);
        puffTint[n * 3] = pAlb[i]!;
        puffTint[n * 3 + 1] = pGlow[i]! * Math.exp(-age / pGlowTau[i]!);
        puffTint[n * 3 + 2] = pSeed[i]!;
        n++;
      }
      for (const name of ['position', 'aSize', 'aAlpha', 'aTint']) puffGeo.getAttribute(name).needsUpdate = true;
      puffGeo.setDrawRange(0, n);

      for (const name of ['position', 'aB', 'aW', 'aCol']) streakGeo.getAttribute(name).needsUpdate = true;
      streakGeo.setDrawRange(0, streakN * 6);
      for (const name of ['position', 'aSize', 'aCol']) sparkGeo.getAttribute(name).needsUpdate = true;
      sparkGeo.setDrawRange(0, sparkN);
      // (Streaks from sync() are drawn once; tick() without a sync (no player) draws none.)
      streakN = 0;
    },

    reset() {
      pLife.fill(-1);
      gLife.fill(-1);
      for (const d of decoys) d.active = false;
      motors.length = 0;
      blasts.length = 0;
      frags.length = 0;
      shooters.clear();
      pending.length = 0;
    },

    setView(w, h) {
      uViewH.value = h;
      uView.value.set(w, h);
    },

    dispose() {
      root.remove(puffs, streaks, sparks);
      puffGeo.dispose(); streakGeo.dispose(); sparkGeo.dispose();
      puffMat.dispose(); streakMat.dispose(); sparkMat.dispose();
    },
  };
}

function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}
