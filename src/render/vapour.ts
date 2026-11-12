/**
 * src/render/vapour.ts — condensation a fighter pulls out of humid air.
 *
 * Air speeding over a lifting wing drops in pressure, and so in temperature; when it falls below the
 * dew point the water vapour in it condenses into a visible cloud, for an instant, and evaporates
 * again as the pressure recovers behind the wing. Three forms of it:
 * - the wing vapour sheet: a white veil over the upper wing in a hard pull, first in the leading-edge
 *   vortex (on a delta it rolls up just behind the leading edge), spreading over the whole wing as
 *   the pull tightens, streaming aft and shredding behind the trailing edge;
 * - wingtip trails: the tip vortices' cores are the lowest-pressure air of all, so they show first, as
 *   two thin white lines left hanging in the air behind the tips;
 * - the vapour cone: near the speed of sound the air expanding round the jet condenses, and a shock
 *   wave standing on the airframe (about mid-wing) clears it again: a bell of fog that fades in
 *   from the cockpit and ends in a sharp edge at the shock.
 * All need humid air (the weather: haze, overcast, rain, fog; the coast more than the plains), and
 * they belong low down, where the air holds the most water. How hard the wing is lifting comes from
 * each jet's own speed, height and angle of attack, so AI jets show it too.
 */
import * as THREE from "three";
import type { QuatLike, Vec3Like } from "../contracts/core";
import type { SceneEnvironment } from "../contracts/render";
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from "./atmosphere";
import type { WeatherState } from "./skyState";
import type { VapourCone, VapourWing } from "./aircraftModels/tejasModel";

// -----------------------------------------------------------------------------
// When: the physics.
// -----------------------------------------------------------------------------

/** Wing area, m^2, lift-curve slope, /rad (a low-aspect delta) and a typical combat weight, N. */
const WING_AREA_M2 = 38.4;
const CL_ALPHA_PER_RAD = 3.0;
const WEIGHT_N = 11500 * 9.81;

export interface VapourDrive {
  /** Wing vapour sheet, 0..1. */
  wing: number;
  /** Wingtip vortex trails, 0..1. */
  tip: number;
  /** Transonic vapour cone, 0..1. */
  cone: number;
  /** Load factor estimated from the wing's lift, g. */
  loadFactor: number;
  mach: number;
}

/** Dev: ?vapour=wing,tip,cone (0..1 each) forces the effects on every jet, to look at them. */
export const DEV_VAPOUR_FORCE: readonly number[] | undefined = (() => {
  if (!import.meta.env.DEV || typeof location === "undefined") return undefined;
  const v = new URLSearchParams(location.search).get("vapour");
  return v ? v.split(",").map(Number) : undefined;
})();

export function createVapourDrive(): VapourDrive {
  return { wing: 0, tip: 0, cone: 0, loadFactor: 0, mach: 0 };
}

const sstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * How humid the air is, 0 (dry) .. 1 (saturated), from the weather and the theatre: the coast is
 * humid, the plains drier; haze, cloud, rain and above all fog add to it.
 */
export function airHumidity(
  w: Readonly<WeatherState>,
  style: SceneEnvironment["surfaceStyle"],
): number {
  const base = style === "coastal" ? 0.6 : style === "farmland" ? 0.4 : 0.45;
  const fog = 1 - sstep(1.5, 6, w.visKm);
  return Math.min(
    1,
    base + 0.2 * w.grey + 0.15 * w.deck + 0.3 * w.rain + 0.5 * fog,
  );
}

const qInv = new THREE.Quaternion();
const vBody = new THREE.Vector3();

/**
 * The vapour each form shows for one aircraft: its world velocity and orientation, altitude (m),
 * the air's humidity (airHumidity). Pure (exported for tests).
 *
 * The wing's lift (load factor n = q S CLa alpha / W) is the pressure drop over it; vapour forms once
 * n passes an onset that falls from ~7 g in dry air to ~2.5 g in saturated air. Tip vortices go a
 * g sooner. The cone wants Mach ~0.93-1.03 (a little lower in a hard pull, where the flow over the
 * wing goes supersonic first). Humidity counts less with height (cold air holds little water).
 */
export function vapourDrive(
  altM: number,
  vel: Readonly<Vec3Like>,
  rot: Readonly<QuatLike>,
  humidity: number,
  onGround: boolean,
  out: VapourDrive,
): VapourDrive {
  out.wing = out.tip = out.cone = out.loadFactor = out.mach = 0;
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  if (onGround || speed < 60) return out;
  qInv.set(rot.x, rot.y, rot.z, rot.w).invert();
  vBody.set(vel.x, vel.y, vel.z).applyQuaternion(qInv);
  const alpha = Math.min(0.5, Math.max(0, Math.atan2(-vBody.y, vBody.x)));
  const h = Math.max(0, altM);
  const rho = 1.225 * Math.exp(-h / 8500);
  const q = 0.5 * rho * speed * speed;
  const n = (q * WING_AREA_M2 * CL_ALPHA_PER_RAD * alpha) / WEIGHT_N;
  const tempK = 288.15 - 0.0065 * Math.min(h, 11000);
  const mach = speed / Math.sqrt(1.4 * 287.05 * tempK);
  out.loadFactor = n;
  out.mach = mach;
  const wet =
    Math.min(1, Math.max(0, humidity)) * (1 - 0.85 * sstep(1000, 7000, h));
  const onset = 7 - 4.5 * wet;
  const fast = sstep(90, 150, speed);
  out.wing = sstep(onset, onset + 2.5, n) * fast;
  out.tip = sstep(onset - 1.2, onset + 1.2, n) * fast;
  const m0 = 0.93 - 0.03 * Math.min(1, n / 6);
  out.cone =
    sstep(m0, m0 + 0.04, mach) *
    (1 - sstep(1.0, 1.05, mach)) *
    sstep(0.25, 0.6, wet);
  return out;
}

// -----------------------------------------------------------------------------
// What: the visuals.
// -----------------------------------------------------------------------------

const NOISE_GLSL = /* glsl */ `
  float vHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(vHash(i), vHash(i + vec2(1.0, 0.0)), f.x), mix(vHash(i + vec2(0.0, 1.0)), vHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float vFbm(vec2 p) {
    float s = 0.0;
    float a = 0.5;
    for (int k = 0; k < 4; k++) {
      s += a * vNoise(p);
      p = p * 2.03 + 17.1;
      a *= 0.5;
    }
    return s;
  }
  // Cloud lit by the sun and sky: bright looking towards the sun through it (forward scattering).
  vec3 vapourLight(vec3 V) {
    float fwd = pow(max(dot(-V, normalize(uAtmSunDir)), 0.0), 6.0);
    return 1.1 * (uAtmAmbSky * 1.35 + uAtmSunCol * (0.8 + 1.6 * fwd));
  }
`;

const WING_VS = /* glsl */ `
  attribute vec3 aUvl; // u (0 leading edge .. 1 trailing edge, more behind), v (0 root .. 1 tip), layer 0..1
  uniform vec3 uOrigin;
  varying vec3 vWorld;
  varying vec3 vL;
  varying vec3 vUvl;
  varying vec3 vUpW;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz + uOrigin;
    vL = position;
    vUvl = aUvl;
    vUpW = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const WING_FS = /* glsl */ `
  precision highp float;
  ${ATMOSPHERE_GLSL}
  ${NOISE_GLSL}
  uniform float uI;
  uniform float uTime;
  uniform float uFlow;
  varying vec3 vWorld;
  varying vec3 vL;
  varying vec3 vUvl;
  varying vec3 vUpW;
  void main() {
    float u = vUvl.x;
    float v = vUvl.y;
    float layer = vUvl.z;
    // Where it forms first: the leading-edge vortex, rolled up just behind the leading edge (further
    // aft towards the tip), then a sheet over the forward wing that thins towards the trailing edge.
    float uc = 0.1 + 0.2 * v;
    float core = exp(-pow((u - uc) / (0.1 + 0.08 * layer), 2.0));
    float sheet = 0.7 * (1.0 - smoothstep(0.15, 1.15, u));
    float field = max(core, sheet);
    field *= smoothstep(0.0, 0.05, u) * smoothstep(0.0, 0.12, v) * (1.0 - smoothstep(0.82, 1.0, v));
    // Behind the trailing edge it shreds and evaporates.
    field *= 1.0 - smoothstep(0.95, 1.3, u);
    // Streaks along the flow, streaming aft at the jet's speed (the noise drifts towards -x).
    float t = uTime;
    float streak = vFbm(vec2(vL.x * 1.1 + t * uFlow * 0.05, vL.z * 6.5 + layer * 3.0));
    float puff = vFbm(vec2(vL.x * 2.2 + t * uFlow * 0.07, vL.z * 2.4) + layer * 7.0);
    float flicker = 0.85 + 0.3 * vNoise(vec2(t * 11.0, vL.z * 2.0 + layer * 5.0));
    // Translucent and streaky, with ragged edges: never an even sheet.
    float f = field * (0.25 + 0.95 * smoothstep(0.3, 0.75, streak)) * (0.45 + 0.75 * puff) * flicker;
    // Onset: the densest parts appear first, the whole wing as the pull tightens.
    float thr = 1.05 - uI;
    float a = smoothstep(thr, thr + 0.45, f) * sqrt(uI) * (1.0 - 0.35 * layer);
    // Seen edge on, the veil is a longer path through the cloud.
    vec3 V = normalize(uAtmCamPos - vWorld);
    float mu = abs(dot(vUpW, V));
    a *= clamp(0.4 / (mu + 0.2), 0.7, 1.6);
    if (a < 0.004) discard;
    gl_FragColor = vec4(atmApply(vapourLight(V), vWorld), min(a * 0.7, 0.85));
  }
`;

const CONE_VS = /* glsl */ `
  attribute vec2 aSt; // s: 0 at the front .. 1 at the shock (aft); theta round the axis, 0..1
  uniform vec3 uOrigin;
  varying vec3 vWorld;
  varying vec2 vSt;
  varying vec3 vNormalW;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz + uOrigin;
    vSt = aSt;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const CONE_FS = /* glsl */ `
  precision highp float;
  ${ATMOSPHERE_GLSL}
  ${NOISE_GLSL}
  uniform float uI;
  uniform float uTime;
  varying vec3 vWorld;
  varying vec2 vSt;
  varying vec3 vNormalW;
  void main() {
    float s = vSt.x;
    float th = vSt.y;
    // Fades in from the front, densest just ahead of the shock, which ends it sharply.
    float field = smoothstep(0.0, 0.75, s) * (1.0 - smoothstep(0.94, 1.0, s));
    float t = uTime;
    float rays = vFbm(vec2(th * 48.0, s * 1.5 - t * 0.6));
    float puff = vFbm(vec2(th * 9.0 + t * 0.3, s * 5.0 - t * 2.0));
    // The shock wobbles a little: the edge breathes.
    float f = field * (0.35 + 0.8 * rays) * (0.5 + 0.7 * puff) * (0.85 + 0.15 * sin(t * 23.0 + th * 40.0));
    vec3 V = normalize(uAtmCamPos - vWorld);
    // A shell standing in for a volume: through its edge the eye crosses much more of it.
    float mu = abs(dot(normalize(vNormalW), V));
    float a = f * uI * clamp(0.3 / (mu + 0.15), 0.6, 1.5);
    if (a < 0.004) discard;
    gl_FragColor = vec4(atmApply(vapourLight(V), vWorld), min(a * 0.55, 0.7));
  }
`;

const TRAIL_VS = /* glsl */ `
  attribute vec2 aTrail; // across (-1..1), alpha
  uniform vec3 uOrigin;
  varying vec3 vWorld;
  varying vec2 vTrail;
  void main() {
    vWorld = position + uOrigin;
    vTrail = aTrail;
    gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  }
`;

const TRAIL_FS = /* glsl */ `
  precision highp float;
  ${ATMOSPHERE_GLSL}
  ${NOISE_GLSL}
  varying vec3 vWorld;
  varying vec2 vTrail;
  void main() {
    float across = exp(-vTrail.x * vTrail.x * 3.0);
    float a = vTrail.y * across;
    if (a < 0.004) discard;
    vec3 V = normalize(uAtmCamPos - vWorld);
    gl_FragColor = vec4(atmApply(vapourLight(V), vWorld), min(a, 0.85));
  }
`;

/** The vapour veil over both wings: three stacked sheets (some depth to it), mirrored. */
export function buildVapourWingGeometry(w: VapourWing): THREE.BufferGeometry {
  const layers = [0.4, 1.0, 1.7];
  const pos: number[] = [];
  const uvl: number[] = [];
  const idx: number[] = [];
  for (const side of [1, -1]) {
    for (let l = 0; l < layers.length; l++) {
      const base = pos.length / 3;
      for (let j = 0; j < w.nv; j++) {
        for (let i = 0; i < w.nu; i++) {
          const k = (j * w.nu + i) * 3;
          const u = (w.uMax * i) / (w.nu - 1);
          // Above the skin, rising aft (the flow lifts off over the elevons), each layer higher.
          const lift = 0.04 + (0.04 + 0.34 * u) * layers[l]!;
          pos.push(w.surf[k]!, w.surf[k + 1]! + lift, side * w.surf[k + 2]!);
          uvl.push(u, j / (w.nv - 1), l / (layers.length - 1));
        }
      }
      for (let j = 0; j + 1 < w.nv; j++) {
        for (let i = 0; i + 1 < w.nu; i++) {
          const a = base + j * w.nu + i;
          const b = a + 1;
          const c = a + w.nu;
          const d = c + 1;
          if (side > 0) idx.push(a, c, b, b, c, d);
          else idx.push(a, b, c, b, d, c);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aUvl", new THREE.Float32BufferAttribute(uvl, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** The vapour cone: a bell opening aft round the body x axis; three nested shells give it depth. */
export function buildVapourConeGeometry(c: VapourCone): THREE.BufferGeometry {
  const NS = 14;
  const NT = 72;
  const pos: number[] = [];
  const nrm: number[] = [];
  const st: number[] = [];
  const idx: number[] = [];
  for (const scale of [0.96, 1.0, 1.04]) {
    const base = pos.length / 3;
    const r = (s: number): number =>
      scale * (c.r0 + (c.r1 - c.r0) * Math.pow(s, 0.6));
    for (let i = 0; i <= NS; i++) {
      const s = i / NS;
      const x = c.x0 - c.length * s;
      const rs = r(s);
      // Slope of the profile, for the normal.
      const ds = 1e-3;
      const dr =
        (r(Math.min(1, s + ds)) - r(Math.max(0, s - ds))) / (2 * ds * c.length);
      for (let j = 0; j <= NT; j++) {
        const th = (j / NT) * Math.PI * 2;
        const cy = Math.cos(th);
        const cz = Math.sin(th);
        pos.push(x, c.axisY + rs * cy, rs * cz);
        const n = new THREE.Vector3(dr, cy, cz).normalize();
        nrm.push(n.x, n.y, n.z);
        st.push(s, j / NT);
      }
    }
    for (let i = 0; i < NS; i++) {
      for (let j = 0; j < NT; j++) {
        const a = base + i * (NT + 1) + j;
        const b = a + 1;
        const c2 = a + NT + 1;
        const d = c2 + 1;
        idx.push(a, c2, b, b, c2, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("aSt", new THREE.Float32BufferAttribute(st, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export interface VapourShared {
  uOrigin: { value: THREE.Vector3 };
  uTime: { value: number };
}

function transparentMat(
  vs: string,
  fs: string,
  uniforms: Record<string, { value: unknown }>,
  side: THREE.Side,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...getAtmosphereUniforms(), ...uniforms },
    vertexShader: vs,
    fragmentShader: fs,
    transparent: true,
    depthWrite: false,
    side,
  });
}

/** One aircraft's wing veil and cone (children of its airframe); per-aircraft strength and speed. */
export interface VapourMeshes {
  wing?: THREE.Mesh;
  cone?: THREE.Mesh;
  set(d: Readonly<VapourDrive>, speedMps: number): void;
  dispose(): void;
}

export function createVapourMeshes(
  parent: THREE.Object3D,
  wingGeom: THREE.BufferGeometry | undefined,
  coneGeom: THREE.BufferGeometry | undefined,
  shared: VapourShared,
): VapourMeshes {
  const wingMat = wingGeom
    ? transparentMat(
        WING_VS,
        WING_FS,
        {
          uOrigin: shared.uOrigin,
          uTime: shared.uTime,
          uI: { value: 0 },
          uFlow: { value: 0 },
        },
        THREE.DoubleSide,
      )
    : undefined;
  const coneMat = coneGeom
    ? transparentMat(
        CONE_VS,
        CONE_FS,
        { uOrigin: shared.uOrigin, uTime: shared.uTime, uI: { value: 0 } },
        THREE.DoubleSide,
      )
    : undefined;
  const mk = (g: THREE.BufferGeometry, m: THREE.ShaderMaterial): THREE.Mesh => {
    const mesh = new THREE.Mesh(g, m);
    mesh.visible = false;
    mesh.frustumCulled = false;
    // After the airframe and its afterburner flame.
    mesh.renderOrder = 3;
    parent.add(mesh);
    return mesh;
  };
  const wing = wingGeom && wingMat ? mk(wingGeom, wingMat) : undefined;
  const cone = coneGeom && coneMat ? mk(coneGeom, coneMat) : undefined;
  return {
    wing,
    cone,
    set(d, speed) {
      if (wing && wingMat) {
        wing.visible = d.wing > 0.01;
        wingMat.uniforms["uI"]!.value = d.wing;
        wingMat.uniforms["uFlow"]!.value = speed;
      }
      if (cone && coneMat) {
        cone.visible = d.cone > 0.01;
        coneMat.uniforms["uI"]!.value = d.cone;
      }
    },
    dispose() {
      wingMat?.dispose();
      coneMat?.dispose();
      if (wing) parent.remove(wing);
      if (cone) parent.remove(cone);
    },
  };
}

// -----------------------------------------------------------------------------
// Wingtip trails: points left in the air behind each tip, drawn as camera-facing ribbons.
// -----------------------------------------------------------------------------

/** How long a trail lingers, s, and its width at the tip and when it fades, m. */
const TRAIL_LIFE_SEC = 0.22;
const TRAIL_W0_M = 0.07;
const TRAIL_W1_M = 0.45;
const TRAIL_MAX_POINTS = 48;
const MAX_TRAILS = 64;
const MAX_SEGMENTS = MAX_TRAILS * TRAIL_MAX_POINTS;

interface Trail {
  /** World positions (absolute), birth times and strengths, oldest first. */
  x: number[];
  y: number[];
  z: number[];
  t: number[];
  k: number[];
  lastSeen: number;
}

export interface VapourTrails {
  begin(
    timeSec: number,
    originWorld: Readonly<Vec3Like>,
    cameraWorld: Readonly<Vec3Like>,
  ): void;
  /** One wingtip's vortex this frame: key (unique per aircraft and side), tip position (world), strength 0..1. */
  emit(key: number, tipWorld: Readonly<Vec3Like>, strength: number): void;
  end(): void;
  dispose(): void;
}

export function createVapourTrails(
  root: THREE.Object3D,
  shared: VapourShared,
): VapourTrails {
  const trails = new Map<number, Trail>();
  const pos = new Float32Array(MAX_SEGMENTS * 6 * 3);
  const attr = new Float32Array(MAX_SEGMENTS * 6 * 2);
  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(
    THREE.DynamicDrawUsage,
  );
  const trailAttr = new THREE.BufferAttribute(attr, 2).setUsage(
    THREE.DynamicDrawUsage,
  );
  geom.setAttribute("position", posAttr);
  geom.setAttribute("aTrail", trailAttr);
  const mat = transparentMat(
    TRAIL_VS,
    TRAIL_FS,
    { uOrigin: shared.uOrigin },
    THREE.DoubleSide,
  );
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  root.add(mesh);
  let now = 0;
  const origin = { x: 0, y: 0, z: 0 };
  const cam = { x: 0, y: 0, z: 0 };

  return {
    begin(timeSec, o, c) {
      now = timeSec;
      Object.assign(origin, { x: o.x, y: o.y, z: o.z });
      Object.assign(cam, { x: c.x, y: c.y, z: c.z });
    },

    emit(key, p, strength) {
      let tr = trails.get(key);
      if (!tr) {
        if (strength <= 0.01 || trails.size >= MAX_TRAILS) return;
        tr = { x: [], y: [], z: [], t: [], k: [], lastSeen: now };
        trails.set(key, tr);
      }
      tr.lastSeen = now;
      const n = tr.t.length;
      // A point every frame (at most 120 a second), even at zero strength: it ends the line cleanly.
      if (n > 0 && now - tr.t[n - 1]! < 1 / 120) return;
      if (n > 0 && strength <= 0.01 && tr.k[n - 1]! <= 0.01) return;
      tr.x.push(p.x);
      tr.y.push(p.y);
      tr.z.push(p.z);
      tr.t.push(now);
      // Each puff of the core a little different: the line breaks into wisps as it dies.
      tr.k.push(Math.max(0, strength) * (0.55 + 0.45 * Math.random()));
      if (tr.t.length > TRAIL_MAX_POINTS) {
        tr.x.shift();
        tr.y.shift();
        tr.z.shift();
        tr.t.shift();
        tr.k.shift();
      }
    },

    end() {
      let v = 0;
      const put = (
        x: number,
        y: number,
        z: number,
        across: number,
        a: number,
      ): void => {
        pos[v * 3] = x - origin.x;
        pos[v * 3 + 1] = y - origin.y;
        pos[v * 3 + 2] = z - origin.z;
        attr[v * 2] = across;
        attr[v * 2 + 1] = a;
        v++;
      };
      for (const [key, tr] of trails) {
        while (tr.t.length > 0 && now - tr.t[0]! > TRAIL_LIFE_SEC) {
          tr.x.shift();
          tr.y.shift();
          tr.z.shift();
          tr.t.shift();
          tr.k.shift();
        }
        if (tr.t.length === 0 && now - tr.lastSeen > 0.5) {
          trails.delete(key);
          continue;
        }
        for (let i = 0; i + 1 < tr.t.length && v + 6 <= MAX_SEGMENTS * 6; i++) {
          const ax = tr.x[i]!,
            ay = tr.y[i]!,
            az = tr.z[i]!;
          const bx = tr.x[i + 1]!,
            by = tr.y[i + 1]!,
            bz = tr.z[i + 1]!;
          // Ribbon across the line, facing the camera.
          const dx = bx - ax,
            dy = by - ay,
            dz = bz - az;
          const vx = (ax + bx) / 2 - cam.x,
            vy = (ay + by) / 2 - cam.y,
            vz = (az + bz) / 2 - cam.z;
          let sx = dy * vz - dz * vy,
            sy = dz * vx - dx * vz,
            sz = dx * vy - dy * vx;
          const sl = Math.hypot(sx, sy, sz);
          if (sl < 1e-6) continue;
          sx /= sl;
          sy /= sl;
          sz /= sl;
          const ageA = Math.min(1, (now - tr.t[i]!) / TRAIL_LIFE_SEC);
          const ageB = Math.min(1, (now - tr.t[i + 1]!) / TRAIL_LIFE_SEC);
          // Thin and dense at the tip, spreading and fading as the core's pressure recovers.
          const wA = (TRAIL_W0_M + (TRAIL_W1_M - TRAIL_W0_M) * ageA) / 2;
          const wB = (TRAIL_W0_M + (TRAIL_W1_M - TRAIL_W0_M) * ageB) / 2;
          const aA = tr.k[i]! * (1 - ageA) ** 4 * 0.6;
          const aB = tr.k[i + 1]! * (1 - ageB) ** 4 * 0.6;
          put(ax - sx * wA, ay - sy * wA, az - sz * wA, -1, aA);
          put(ax + sx * wA, ay + sy * wA, az + sz * wA, 1, aA);
          put(bx + sx * wB, by + sy * wB, bz + sz * wB, 1, aB);
          put(ax - sx * wA, ay - sy * wA, az - sz * wA, -1, aA);
          put(bx + sx * wB, by + sy * wB, bz + sz * wB, 1, aB);
          put(bx - sx * wB, by - sy * wB, bz - sz * wB, -1, aB);
        }
      }
      geom.setDrawRange(0, v);
      posAttr.needsUpdate = true;
      trailAttr.needsUpdate = true;
      mesh.visible = v > 0;
    },

    dispose() {
      root.remove(mesh);
      geom.dispose();
      mat.dispose();
    },
  };
}
