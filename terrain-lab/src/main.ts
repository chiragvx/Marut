/**
 * terrain-lab/src/main.ts - a standalone viewer for the procedural Himalaya terrain: nested
 * camera-centred rings of terrain, a free-fly camera, jump-to presets and a clickable minimap.
 * Dev-only (served by vite at /terrain-lab/); nothing here touches the game.
 */

import * as THREE from 'three';
import { heightAt, strips } from '../../src/terrain/himalaya/height';
import { LAKES, MAP_HALF_M, PLACES, VIEWS, geo, toGeo, type ViewPreset } from '../../src/terrain/himalaya/layout';
import { perimeter } from './grid';
import { buildAirports } from './airports';
import type { MinimapResult, RingRequest, RingResult } from './lab.worker';

// --- Renderer, scene, camera. ---
const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 2, 600_000);
camera.rotation.order = 'YXZ';

function resize(): void {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// --- Sun and sky. ---
const sun = { az: 135, el: 35 };
const sunDir = new THREE.Vector3();
function updateSun(): void {
  const az = (sun.az * Math.PI) / 180, el = (sun.el * Math.PI) / 180;
  // Azimuth clockwise from north (-z).
  sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}
updateSun();

const HORIZON = new THREE.Color(0.74, 0.82, 0.92);
const ZENITH = new THREE.Color(0.16, 0.34, 0.68);

const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: { uSun: { value: sunDir }, uHorizon: { value: HORIZON }, uZenith: { value: ZENITH }, uCamAlt: { value: 0 } },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uSun, uHorizon, uZenith; uniform float uCamAlt;
    varying vec3 vDir;
    #include <common>
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      float up = max(vDir.y, 0.0);
      // Thinner air higher up: a deeper blue overhead.
      vec3 zen = mix(uZenith, uZenith * vec3(0.55, 0.65, 0.85), clamp(uCamAlt / 12000.0, 0.0, 1.0));
      vec3 c = mix(uHorizon, zen, pow(up, 0.45));
      c = mix(c, uHorizon * 0.85, smoothstep(0.0, -0.15, vDir.y));
      float s = max(dot(vDir, uSun), 0.0);
      c += vec3(1.0, 0.95, 0.85) * (pow(s, 600.0) * 4.0 + pow(s, 12.0) * 0.12);
      gl_FragColor = vec4(c, 1.0);
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(500_000, 32, 16), skyMat);
sky.renderOrder = -1;
scene.add(sky);

// Debug toggles from the URL hash: dbg=<shader bits> (2 no detail layers),
// hskip=<DBG.skip bits for the height function> (see src/terrain/himalaya/height.ts DBG).
const DEBUG = ((): { dbg: number; hskip: number } => {
  const h = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  return { dbg: Number(h.get('dbg') ?? 0) | 0, hskip: Number(h.get('hskip') ?? 0) | 0 };
})();

// --- Terrain material. ---
// Airfields with a game layout (Ngari, Simikot, Fukche) are drawn from that JSON (airports.ts);
// the shader paints simple strips for the rest.
const STRIPS = strips().filter((s) => !s.layoutId);
const MAX_STRIPS = 16;
const stripA: THREE.Vector4[] = [], stripB: THREE.Vector4[] = [];
for (let i = 0; i < MAX_STRIPS; i++) {
  const s = STRIPS[i];
  stripA.push(s ? new THREE.Vector4(s.cx, s.cz, s.dx, s.dz) : new THREE.Vector4());
  stripB.push(s ? new THREE.Vector4(s.halfL, s.halfW, s.taxi ? 1 : 0, 0) : new THREE.Vector4());
}

const terrainVS = /* glsl */ `
  attribute vec3 aSurf;
  uniform vec3 uHole;
  varying vec3 vWorld; varying vec3 vNormal; varying vec3 vSurf;
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    if (uHole.z > 0.0 && abs(wp.x - uHole.x) < uHole.z - 1.0 && abs(wp.z - uHole.y) < uHole.z - 1.0) wp.y -= 5000.0;
    vWorld = wp.xyz; vNormal = normal; vSurf = aSurf;
    gl_Position = projectionMatrix * viewMatrix * wp;
    #include <logdepthbuf_vertex>
  }`;

const terrainFS = /* glsl */ `
  uniform vec3 uSun, uCam, uFog;
  uniform vec2 uOrigin;
  uniform vec4 uStripA[${MAX_STRIPS}], uStripB[${MAX_STRIPS}];
  uniform int uStrips;
  uniform float uShowStrips;
  uniform int uDbg; // debug: 2 no detail layers
  varying vec3 vWorld; varying vec3 vNormal; varying vec3 vSurf;
  #include <common>
  #include <logdepthbuf_pars_fragment>
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1, 0)), u.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), u.x), u.y);
  }
  vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
  // --- Close-range detail: value noise with its gradient, from a hash with no sin() (stable at
  // large coordinates); coordinates are relative to a camera-snapped origin (uOrigin) for precision.
  float hashD(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  // Periodic over per cells (per * cell = 4096 m). Each layer is turned by a 3-4-5 rotation (kills the
  // grid look); a 20480 m origin snap is then a whole number of periods in the turned frame too.
  vec3 vnoiseD(vec2 p, float per) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
    vec2 i0 = mod(i, per), i1 = mod(i + 1.0, per);
    float a = hashD(i0), b = hashD(vec2(i1.x, i0.y)), c = hashD(vec2(i0.x, i1.y)), d = hashD(i1);
    float k = a - b - c + d;
    return vec3(a + (b - a) * u.x + (c - a) * u.y + k * u.x * u.y, du * vec2(b - a + k * u.y, c - a + k * u.x));
  }
  // One detail layer (cells of s metres, turned by R, offset off, periodic over per cells) at q,
  // blended over the planes the surface faces (weights nw: horizontal, and the two vertical
  // planes); x = value, yzw = its world-space gradient (per cell). Planes with little weight are
  // skipped, so gentle ground pays for one sample. (The same as src/render/terrainMaterial.ts.)
  vec4 detailBi(vec3 q, vec3 nw, mat2 R, float s, float off, float per) {
    vec4 r = vec4(0.0);
    if (nw.y > 0.02) { vec3 d = vnoiseD(R * q.xz / s + off, per); d.yz = d.yz * R; r += nw.y * vec4(d.x, d.y, 0.0, d.z); }
    if (nw.x > 0.02) { vec3 d = vnoiseD(R * q.zy / s + off, per); d.yz = d.yz * R; r += nw.x * vec4(d.x, 0.0, d.z, d.y); }
    if (nw.z > 0.02) { vec3 d = vnoiseD(R * q.xy / s + off, per); d.yz = d.yz * R; r += nw.z * vec4(d.x, d.y, d.z, 0.0); }
    return r / max(nw.x * step(0.02, nw.x) + nw.y * step(0.02, nw.y) + nw.z * step(0.02, nw.z), 1e-3);
  }
  // Bump n by a world-space height gradient g (its part along the surface).
  vec3 bumpN(vec3 n, vec3 g, float k) { return normalize(n - (g - dot(g, n) * n) * k); }
  void main() {
    #include <logdepthbuf_fragment>
    vec3 n = normalize(vNormal);
    float slope = 1.0 - n.y;
    float h = vWorld.y;
    vec2 wp = vWorld.xz;
    float flatv = vSurf.x, river = vSurf.y, dry = vSurf.z;
    float n1 = vnoise(wp / 230.0), n2 = vnoise(wp / 41.0), n3 = vnoise(wp / 1900.0);
    float nz = n1 * 0.5 + n2 * 0.3 + n3 * 0.2;

    // Ground cover: monsoon south (forest, meadow, alpine) vs rain-shadow plateau (steppe).
    vec3 forest = lin(vec3(0.16, 0.22, 0.11)), meadow = lin(vec3(0.36, 0.38, 0.22)), alpine = lin(vec3(0.42, 0.39, 0.31));
    vec3 steppeA = lin(vec3(0.62, 0.52, 0.37)), steppeB = lin(vec3(0.52, 0.46, 0.36));
    vec3 wet = mix(forest, meadow, smoothstep(2300.0, 3500.0, h + (nz - 0.5) * 600.0));
    wet = mix(wet, alpine, smoothstep(3700.0, 4400.0, h + (nz - 0.5) * 400.0));
    vec3 dryc = mix(steppeA, steppeB, n1 * 0.7 + n2 * 0.3);
    vec3 col = mix(wet, dryc, smoothstep(0.35, 0.85, dry));

    // Valley floors and basins: gravel and alluvium.
    vec3 gravel = lin(mix(vec3(0.60, 0.57, 0.51), vec3(0.50, 0.47, 0.42), n2));
    col = mix(col, gravel, flatv * mix(0.35, 0.6, dry) * smoothstep(0.08, 0.0, slope));

    // Rock on steep ground, scree below it.
    vec3 rock = lin(mix(vec3(0.30, 0.28, 0.27), vec3(0.47, 0.43, 0.39), n1 * 0.6 + n2 * 0.4));
    vec3 scree = lin(mix(vec3(0.55, 0.52, 0.48), vec3(0.47, 0.44, 0.41), n2));
    col = mix(col, scree, smoothstep(0.10, 0.20, slope + (nz - 0.5) * 0.08) * smoothstep(2800.0, 4200.0, h) * 0.8);
    col = mix(col, rock, smoothstep(0.20, 0.34, slope + (nz - 0.5) * 0.12));

    // Snow: higher on the dry plateau and on sunny (south-facing) slopes; steep faces shed it.
    // (Aspect from n.z itself, not its direction: it fades out on gentle ground instead of flipping
    // +-350 m across every gully wall; the cover thins over a wide band and with slope, so the
    // edges are soft and follow the ground's steepness, not the mesh's facets.)
    float aspectS = clamp(n.z / 0.45, -1.0, 1.0);
    float snowline = mix(5100.0, 5950.0, dry) + 220.0 * aspectS;
    float snow = smoothstep(snowline - 250.0, snowline + 300.0, h + (n1 * 0.6 + n3 * 0.4 - 0.5) * 700.0);
    snow *= 1.0 - smoothstep(0.30, 0.62, slope + (n1 - 0.5) * 0.12);
    // Glaciers: high, gentle ground below the snowline proper.
    float glacier = smoothstep(snowline - 700.0, snowline - 300.0, h) * smoothstep(0.12, 0.04, slope) * (1.0 - flatv);
    vec3 snowc = lin(vec3(0.93, 0.95, 0.98)), ice = lin(vec3(0.80, 0.86, 0.92));
    col = mix(col, ice, glacier * 0.8);
    col = mix(col, snowc, snow);

    // River channels.
    col = mix(col, lin(vec3(0.22, 0.36, 0.40)), smoothstep(0.25, 0.75, river));

    // Runways and taxiways.
    if (uShowStrips > 0.5) {
      for (int i = 0; i < ${MAX_STRIPS}; i++) {
        if (i >= uStrips) break;
        vec4 a = uStripA[i], b = uStripB[i];
        vec2 d = wp - a.xy;
        float al = dot(d, a.zw), cr = dot(d, vec2(-a.w, a.z));
        if (abs(al) < b.x && abs(cr) < b.y) {
          vec3 asph = lin(vec3(0.20, 0.20, 0.21) + (n2 - 0.5) * 0.03);
          if (b.z > 0.5) asph = lin(vec3(0.27, 0.27, 0.27));
          else if (abs(cr) < 0.6 && mod(al, 60.0) < 30.0) asph = lin(vec3(0.85));
          else if (abs(cr) > b.y - 1.2) asph = lin(vec3(0.8));
          col = asph;
        }
      }
    }

    // Close-range detail, LOD by pixel footprint (on the surface itself): each layer fades out as its
    // cells shrink below a pixel, so far ground costs nothing and nothing shimmers. Bump (lighting)
    // + albedo. Biplanar: a cliff takes its detail from the vertical plane it faces, not from the
    // horizontal one stretched down it (which streaked every rock face). (No rock strata: regular
    // contour bands aliased into stripes on every face, and read as stripes even when filtered.)
    vec3 lq = vec3(vWorld.x - uOrigin.x, h, vWorld.z - uOrigin.y);
    vec3 nw = pow(abs(n), vec3(4.0));
    nw /= nw.x + nw.y + nw.z;
    float rockW = smoothstep(0.20, 0.34, slope), snowW = snow, grassW = (1.0 - rockW) * (1.0 - snowW) * (1.0 - dry) * (1.0 - flatv);
    float stoneW = (1.0 - rockW) * (1.0 - snowW) * max(dry, flatv);
    vec3 nb = n;
    float px = max(length(dFdx(vWorld)), length(dFdy(vWorld)));
    float f1 = 1.0 - smoothstep(4.0, 12.0, px);   // 32 m layer: patches, boulders, rock ribs
    float f2 = 1.0 - smoothstep(0.6, 2.0, px);    // 4 m layer: clumps, stones, cracks
    float f3 = 1.0 - smoothstep(0.12, 0.4, px);   // 0.8 m layer: grit, tufts, pebbles
    if ((uDbg & 2) != 0) { f1 = 0.0; f2 = 0.0; f3 = 0.0; }
    if (f1 > 0.0) {
      // Two octaves turned differently (one alone shows its lattice on a bare face). Periods: a
      // 20480 m origin shift is a whole number of cells in both turned frames.
      vec4 d1 = 0.64 * detailBi(lq, nw, mat2(0.6, 0.8, -0.8, 0.6), 32.0, 0.0, 128.0)
              + 0.36 * detailBi(lq, nw, mat2(0.8, 0.6, -0.6, 0.8), 16.0, 9.0, 256.0);
      float bump = mix(mix(0.25, 0.9, rockW), 0.08, snowW);
      nb = bumpN(nb, d1.yzw, bump * f1);
      col *= 1.0 + (d1.x - 0.5) * 0.28 * f1 * (1.0 - snowW * 0.7);
    }
    if (f2 > 0.0) {
      vec4 d2 = detailBi(lq, nw, mat2(0.8, -0.6, 0.6, 0.8), 4.0, 17.0, 1024.0);
      float bump = mix(mix(0.35, 0.8, rockW), 0.1, snowW);
      nb = bumpN(nb, d2.yzw, bump * f2 * 0.6);
      // Grass clumps darker, stones lighter, cracks in rock darker.
      col *= 1.0 + f2 * ((d2.x - 0.5) * (0.35 * grassW + 0.3 * stoneW + 0.25 * rockW) - grassW * 0.06);
    }
    if (f3 > 0.0) {
      vec4 d3 = detailBi(lq, nw, mat2(0.6, -0.8, 0.8, 0.6), 0.8, -5.0, 5120.0);
      nb = bumpN(nb, d3.yzw, 0.35 * f3 * (1.0 - snowW * 0.8));
      float speck = smoothstep(0.72, 0.9, d3.x);
      col *= 1.0 + f3 * ((d3.x - 0.5) * 0.25 + speck * 0.25 * stoneW - speck * 0.2 * grassW);
      // Snow glints in the sun.
      col += snowW * f3 * pow(smoothstep(0.93, 1.0, d3.x), 4.0) * 0.6 * max(dot(nb, uSun), 0.0);
    }
    n = nb;

    // Light: sun plus a sky/ground ambient.
    float diff = max(dot(n, uSun), 0.0);
    vec3 amb = mix(lin(vec3(0.42, 0.38, 0.33)), lin(vec3(0.62, 0.72, 0.88)), n.y * 0.5 + 0.5) * 0.36;
    vec3 lit = col * (amb + lin(vec3(1.0, 0.96, 0.88)) * diff * 1.75);

    // Haze: thinner with altitude.
    float dist = length(vWorld - uCam);
    float meanAlt = 0.5 * (vWorld.y + uCam.y);
    float dens = (1.0 / 95000.0) * exp(-max(meanAlt, 0.0) / 7500.0);
    float f = 1.0 - exp(-dist * dens);
    vec3 c = pow(lit, vec3(1.0 / 2.2));
    c = mix(c, uFog, f);
    gl_FragColor = vec4(c, 1.0);
  }`;

function terrainMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uSun: { value: sunDir }, uCam: { value: new THREE.Vector3() }, uFog: { value: HORIZON },
      uHole: { value: new THREE.Vector3(0, 0, 0) },
      uOrigin: { value: new THREE.Vector2() },
      uStripA: { value: stripA }, uStripB: { value: stripB }, uStrips: { value: Math.min(MAX_STRIPS, STRIPS.length) },
      uShowStrips: { value: 1 },
      uDbg: { value: DEBUG.dbg },
    },
    vertexShader: terrainVS,
    fragmentShader: terrainFS,
  });
}

// --- Rings: nested grids around the camera, each 4x coarser than the one inside it. ---
const RING_N = 384;
interface Ring { level: number; step: number; snap: number; rebuild: number; fixed: boolean; mesh: THREE.Mesh | null; cx: number; cz: number; pending: boolean; mat: THREE.ShaderMaterial; ms: number }
const RINGS: Ring[] = [
  { step: 15, snap: 60, rebuild: 700, fixed: false },
  { step: 60, snap: 240, rebuild: 2800, fixed: false },
  { step: 240, snap: 960, rebuild: 11000, fixed: false },
  { step: 960, snap: 960, rebuild: Infinity, fixed: true },
].map((r, level) => ({ ...r, level, mesh: null, cx: NaN, cz: NaN, pending: false, mat: terrainMaterial(), ms: 0 }));

const index = ((): THREE.BufferAttribute => {
  const n = RING_N;
  const nv = (n + 1) * (n + 1);
  const idx: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const per = perimeter(n);
  for (let p = 0; p < per.length; p++) {
    const q = (p + 1) % per.length;
    idx.push(per[p], nv + p, per[q], per[q], nv + p, nv + q);
  }
  return new THREE.BufferAttribute(new Uint32Array(idx), 1);
})();

const workers: Worker[] = [];
for (let i = 0; i < 4; i++) {
  const w = new Worker(new URL('./lab.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent) => onWorker(e.data as RingResult | MinimapResult);
  workers.push(w);
}
let reqId = 0;

function requestRing(r: Ring, cx: number, cz: number): void {
  r.pending = true;
  const q: RingRequest = { type: 'ring', id: ++reqId, level: r.level, cx, cz, n: RING_N, step: r.step, skirt: r.level === 3 ? 0 : 30 + r.step, skip: DEBUG.hskip };
  workers[r.level % workers.length].postMessage(q);
}

function onWorker(m: RingResult | MinimapResult): void {
  if (m.type === 'minimap') { onMinimap(m); return; }
  const r = RINGS[m.level];
  r.pending = false;
  r.ms = m.ms;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
  geom.setAttribute('aSurf', new THREE.BufferAttribute(m.surf, 3));
  geom.setIndex(index);
  const half = (RING_N / 2) * r.step;
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 4000, 0), half * 1.5);
  if (r.mesh) { r.mesh.geometry.dispose(); r.mesh.geometry = geom; } else { r.mesh = new THREE.Mesh(geom, r.mat); r.mesh.frustumCulled = false; scene.add(r.mesh); }
  r.mesh.position.set(m.cx, 0, m.cz);
  r.cx = m.cx; r.cz = m.cz;
  // The next ring out drops its vertices under this one.
  const outer = RINGS[m.level + 1];
  if (outer) (outer.mat.uniforms.uHole.value as THREE.Vector3).set(m.cx, m.cz, half);
}

function updateRings(): void {
  for (const r of RINGS) {
    if (r.pending) continue;
    if (r.fixed) { if (!r.mesh) requestRing(r, 0, 0); continue; }
    const cx = Math.round(camera.position.x / r.snap) * r.snap;
    const cz = Math.round(camera.position.z / r.snap) * r.snap;
    if (!r.mesh || Math.abs(cx - r.cx) > r.rebuild || Math.abs(cz - r.cz) > r.rebuild) requestRing(r, cx, cz);
  }
}

// --- Lakes. ---
const waterMat = new THREE.ShaderMaterial({
  uniforms: { uSun: { value: sunDir }, uCam: { value: new THREE.Vector3() }, uFog: { value: HORIZON }, uZenith: { value: ZENITH } },
  transparent: false,
  vertexShader: /* glsl */ `
    varying vec3 vWorld;
    #include <common>
    #include <logdepthbuf_pars_vertex>
    void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp;
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uSun, uCam, uFog, uZenith; varying vec3 vWorld;
    #include <common>
    #include <logdepthbuf_pars_fragment>
    void main() {
      #include <logdepthbuf_fragment>
      vec3 v = normalize(uCam - vWorld);
      float fres = pow(1.0 - max(v.y, 0.0), 4.0);
      vec3 deep = vec3(0.06, 0.30, 0.42), sky = mix(uFog, uZenith, 0.4);
      vec3 c = mix(deep, sky, 0.15 + 0.75 * fres);
      vec3 r = reflect(-v, vec3(0, 1, 0));
      c += vec3(1.0, 0.95, 0.85) * pow(max(dot(r, uSun), 0.0), 300.0) * 2.0;
      float dist = length(vWorld - uCam);
      float f = 1.0 - exp(-dist * (1.0 / 95000.0) * exp(-0.5 * (vWorld.y + uCam.y) / 7500.0));
      gl_FragColor = vec4(mix(c, uFog, f), 1.0);
    }`,
});
for (const l of LAKES) {
  const [x, z] = geo(l.lat, l.lon);
  const g = new THREE.CircleGeometry(Math.max(l.rx, l.rz) * 1.5, 96);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, waterMat);
  m.position.set(x, l.level, z);
  scene.add(m);
}

// --- Camera control: drag to look, WASD to fly, Q/E down/up, Shift fast, wheel = speed. ---
const keys = new Set<string>();
let speed = 250;
let yaw = 0, pitch = 0;
window.addEventListener('keydown', (e) => { if ((e.target as HTMLElement).tagName === 'INPUT') return; keys.add(e.code); });
window.addEventListener('keyup', (e) => keys.delete(e.code));
let dragging = false, lx = 0, ly = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  yaw -= (e.clientX - lx) * 0.0035;
  pitch = Math.max(-1.55, Math.min(1.55, pitch - (e.clientY - ly) * 0.0035));
  lx = e.clientX; ly = e.clientY;
});
canvas.addEventListener('wheel', (e) => { speed = Math.max(10, Math.min(20000, speed * (e.deltaY < 0 ? 1.25 : 0.8))); e.preventDefault(); }, { passive: false });

function setCamera(x: number, y: number, z: number, yawRad: number, pitchRad: number): void {
  camera.position.set(x, y, z);
  yaw = yawRad; pitch = pitchRad;
}

function applyView(v: ViewPreset): void {
  const p = PLACES.find((q) => q.id === v.place);
  if (!p) return;
  const [px, pz] = geo(p.lat, p.lon);
  const tx = px + (v.offsetM?.[0] ?? 0), tz = pz + (v.offsetM?.[1] ?? 0);
  const b =(v.bearingDeg * Math.PI) / 180;
  const x = tx + Math.sin(b) * v.distM, z = tz - Math.cos(b) * v.distM;
  lookFrom(x, Math.max(v.alt, heightAt(x, z) + 50), z, tx, v.targetAlt, tz);
}

function lookFrom(x: number, y: number, z: number, tx: number, ty: number, tz: number): void {
  const dx = tx - x, dy = ty - y, dz = tz - z;
  // Camera looks down -z at yaw 0; yaw turns toward -x.
  setCamera(x, y, z, Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
}

// --- UI: presets, places, sun, readout, minimap. ---
const viewsEl = document.getElementById('views')!;
VIEWS.forEach((v, i) => {
  const b = document.createElement('button');
  b.textContent = v.label;
  b.addEventListener('click', () => { applyView(v); setHash(); });
  b.dataset.view = String(i);
  viewsEl.appendChild(b);
});
const sunAz = document.getElementById('sunAz') as HTMLInputElement;
const sunEl = document.getElementById('sunEl') as HTMLInputElement;
const stripsBox = document.getElementById('strips') as HTMLInputElement;
const onSun = (): void => { sun.az = Number(sunAz.value); sun.el = Number(sunEl.value); updateSun(); };
sunAz.addEventListener('input', onSun);
sunEl.addEventListener('input', onSun);
// The airports from the game's layout JSON, lit by the lab sun (buildings are boxes).
const sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
const airports = buildAirports(new THREE.AmbientLight(0xb8c8e0, 0.9));
airports.add(sunLight);
scene.add(airports);
stripsBox.addEventListener('change', () => {
  for (const r of RINGS) r.mat.uniforms.uShowStrips.value = stripsBox.checked ? 1 : 0;
  airports.visible = stripsBox.checked;
});
const readout = document.getElementById('readout')!;

const mini = document.getElementById('minimap') as HTMLCanvasElement;
const miniCtx = mini.getContext('2d')!;
let miniImage: ImageData | null = null;
const MINI = 256;
function onMinimap(m: MinimapResult): void {
  miniImage = new ImageData(new Uint8ClampedArray(m.rgba), m.size, m.size);
}
workers[3].postMessage({ type: 'minimap', size: MINI });
function worldToMini(x: number, z: number): [number, number] {
  return [((x + MAP_HALF_M) / (2 * MAP_HALF_M)) * mini.width, ((z + MAP_HALF_M) / (2 * MAP_HALF_M)) * mini.height];
}
mini.addEventListener('click', (e) => {
  const rect = mini.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * 2 * MAP_HALF_M - MAP_HALF_M;
  const z = ((e.clientY - rect.top) / rect.height) * 2 * MAP_HALF_M - MAP_HALF_M;
  setCamera(x, heightAt(x, z) + 1500, z, yaw, -0.25);
  setHash();
});
function drawMini(): void {
  if (miniImage) miniCtx.putImageData(miniImage, 0, 0); else { miniCtx.fillStyle = '#222'; miniCtx.fillRect(0, 0, mini.width, mini.height); }
  miniCtx.font = '10px system-ui';
  for (const p of PLACES) {
    const [px, py] = worldToMini(...geo(p.lat, p.lon));
    miniCtx.fillStyle = '#ffcc33';
    miniCtx.fillRect(px - 1.5, py - 1.5, 3, 3);
  }
  const [cx, cy] = worldToMini(camera.position.x, camera.position.z);
  miniCtx.save();
  miniCtx.translate(cx, cy);
  miniCtx.rotate(-yaw);
  miniCtx.fillStyle = '#ff3355';
  miniCtx.beginPath(); miniCtx.moveTo(0, -7); miniCtx.lineTo(4, 5); miniCtx.lineTo(-4, 5); miniCtx.closePath(); miniCtx.fill();
  miniCtx.restore();
}

function nearestPlace(x: number, z: number): string {
  let best = '', bd = Infinity;
  for (const p of PLACES) {
    const [px, pz] = geo(p.lat, p.lon);
    const d = Math.hypot(px - x, pz - z);
    if (d < bd) { bd = d; best = `${p.name} ${(d / 1000).toFixed(1)} km`; }
  }
  return best;
}

// --- URL hash: ?at=x,y,z,yawDeg,pitchDeg or ?view=i (shareable views, and for screenshots). ---
function setHash(): void {
  const p = camera.position;
  const s = `at=${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)},${((yaw * 180) / Math.PI).toFixed(1)},${((pitch * 180) / Math.PI).toFixed(1)}`;
  history.replaceState(null, '', `${location.pathname}#${s}`);
}
function readHash(): boolean {
  const h = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  const at = h.get('at');
  if (at) {
    const [x, y, z, yd, pd] = at.split(',').map(Number);
    setCamera(x, y, z, ((yd ?? 0) * Math.PI) / 180, ((pd ?? 0) * Math.PI) / 180);
    return true;
  }
  const v = h.get('view');
  if (v !== null && VIEWS[Number(v)]) { applyView(VIEWS[Number(v)]); return true; }
  if (h.get('sun')) { const [a, e] = h.get('sun')!.split(',').map(Number); sunAz.value = String(a); sunEl.value = String(e); onSun(); }
  return false;
}
if (!readHash()) applyView(VIEWS[0]);
{
  const h = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  if (h.get('sun')) { const [a, e] = h.get('sun')!.split(',').map(Number); sunAz.value = String(a); sunEl.value = String(e); onSun(); }
}

// --- Loop. ---
const lab = { ready: false };
(window as unknown as { __lab: typeof lab }).__lab = lab;
let last = performance.now();
let hashTimer = 0;
const fwd = new THREE.Vector3(), right = new THREE.Vector3();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  camera.rotation.set(pitch, yaw, 0);
  camera.getWorldDirection(fwd);
  right.crossVectors(fwd, camera.up).normalize();
  const v = speed * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 5 : 1) * dt;
  let moved = false;
  if (keys.has('KeyW')) { camera.position.addScaledVector(fwd, v); moved = true; }
  if (keys.has('KeyS')) { camera.position.addScaledVector(fwd, -v); moved = true; }
  if (keys.has('KeyD')) { camera.position.addScaledVector(right, v); moved = true; }
  if (keys.has('KeyA')) { camera.position.addScaledVector(right, -v); moved = true; }
  if (keys.has('KeyE') || keys.has('Space')) { camera.position.y += v; moved = true; }
  if (keys.has('KeyQ') || keys.has('KeyC')) { camera.position.y -= v; moved = true; }
  const ground = heightAt(camera.position.x, camera.position.z);
  if (camera.position.y < ground + 3) camera.position.y = ground + 3;
  if (moved || dragging) { hashTimer += dt; if (hashTimer > 0.5) { hashTimer = 0; setHash(); } }

  updateRings();
  sky.position.copy(camera.position);
  sunLight.position.copy(sunDir);
  (skyMat.uniforms.uCamAlt as { value: number }).value = camera.position.y;
  for (const r of RINGS) {
    (r.mat.uniforms.uCam.value as THREE.Vector3).copy(camera.position);
    // Detail origin snapped to 20480 m (a whole number of detail periods even in the rotated frames: no pattern jump).
    (r.mat.uniforms.uOrigin.value as THREE.Vector2).set(Math.round(camera.position.x / 20480) * 20480, Math.round(camera.position.z / 20480) * 20480);
  }
  (waterMat.uniforms.uCam.value as THREE.Vector3).copy(camera.position);
  renderer.render(scene, camera);
  lab.ready = RINGS.every((r) => r.mesh && !r.pending);

  const [lat, lon] = toGeo(camera.position.x, camera.position.z);
  const hdg = ((((-yaw * 180) / Math.PI) % 360) + 360) % 360;
  readout.textContent =
    `x ${(camera.position.x / 1000).toFixed(2)} km  z ${(camera.position.z / 1000).toFixed(2)} km  (${lat.toFixed(3)}N ${lon.toFixed(3)}E)\n` +
    `alt ${camera.position.y.toFixed(0)} m  ground ${ground.toFixed(0)} m  AGL ${(camera.position.y - ground).toFixed(0)} m\n` +
    `hdg ${hdg.toFixed(0)}  speed ${speed.toFixed(0)} m/s (Shift x5, wheel to change)\n` +
    `near ${nearestPlace(camera.position.x, camera.position.z)}\n` +
    `rings ${RINGS.map((r) => `${r.step}m:${r.ms.toFixed(0)}ms`).join(' ')}`;
  drawMini();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
