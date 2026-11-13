/**
 * src/render/hangarBay.ts — the inside of a maintenance hangar, for the loadout view (the jet parked
 * in it, the camera walking round it): drawn in place of a base's closed hangar (airbaseStructures.ts
 * hides that one) while a showcase frame asks for it (ShowcaseFrame.hangar).
 *
 * A steel-framed shed with its doors slid open at the front: a polished epoxy floor with painted
 * parking lines and hazard stripes, insulated walls, a barrel roof on steel arches with tie beams,
 * rows of high-bay lamps, tool chests and a ground power cart along the walls. Lit by its lamps
 * (pools on the floor, their glints in the epoxy) and by the daylight through the open doors (sky
 * light falling off towards the back; the sun only where it reaches in, the shed casting sun shadows
 * on the floor and the jet).
 *
 * Built in the bay's own frame (x across, y up, z from the doors at -L/2 to the back wall at +L/2,
 * as the structure models), for the size of the hangar it stands in.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Vec3Like } from '../contracts/core';
import type { ShowcaseFrame } from '../contracts/render';
import { ATMOSPHERE_GLSL, getAtmosphereUniforms } from './atmosphere';
import { CLOUD_SHADOW_GLSL, getCloudShadowUniforms } from './clouds';
import { CASTER_LAYER, SUN_SHADOW_GLSL, getSunShadowUniforms } from './sunShadows';

type Bay = NonNullable<ShowcaseFrame['hangar']>;

const P = { Floor: 0, Wall: 1, Roof: 2, Steel: 3, Lamp: 4, Door: 5, Chest: 6, Yellow: 7, Rubber: 8, Bench: 9 } as const;
const MAX_LAMPS = 27;

const VS = /* glsl */ `
  attribute float aPart;
  uniform vec3 uOrigin;
  varying vec3 vWorld;
  varying vec3 vLocal;
  varying vec3 vNormalW;
  varying vec3 vNormalL;
  varying float vPart;
  void main() {
    vPart = aPart;
    vLocal = position;
    vNormalL = normal;
    vec4 rp = modelMatrix * vec4(position, 1.0);
    vWorld = rp.xyz + uOrigin;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * rp;
  }
`;

const FS = /* glsl */ `
  ${ATMOSPHERE_GLSL}
  uniform vec3 uSunDir;
  ${CLOUD_SHADOW_GLSL}
  ${SUN_SHADOW_GLSL}
  uniform vec3 uLamps[${MAX_LAMPS}];
  uniform int uLampCount;
  uniform vec3 uSize; // width, length, wall height
  uniform mat3 uToLocal;
  varying vec3 vWorld;
  varying vec3 vLocal;
  varying vec3 vNormalW;
  varying vec3 vNormalL;
  varying float vPart;

  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1, 0)), f.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), f.x), f.y);
  }
  /** A painted line of half-width w at distance d from it. */
  float paint(float d, float w) { return 1.0 - smoothstep(w - 0.01, w + 0.01, abs(d)); }

  void main() {
    int part = int(vPart + 0.5);
    vec3 n = normalize(vNormalW);
    vec3 nl = normalize(vNormalL);
    vec3 toCam = uAtmCamPos - vWorld;
    // Faces are seen from whichever side the camera is on.
    if (dot(n, toCam) < 0.0) { n = -n; nl = -nl; }
    vec3 p = vLocal;
    float W = uSize.x;
    float L = uSize.y;
    float H = uSize.z;
    vec3 col;
    float gloss = 0.0;
    vec3 glow = vec3(0.0);
    if (part == 0) {
      // Epoxy floor: pale grey, slab joints, faint scuffs and tyre marks; painted lines.
      float grime = vnoise(p.xz * 0.35) * 0.6 + vnoise(p.xz * 2.1) * 0.4;
      col = vec3(0.58, 0.6, 0.6) * (0.9 + 0.12 * grime);
      vec2 j = abs(fract(p.xz / 6.0 + 0.5) - 0.5) * 6.0;
      col *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, 0.025, min(j.x, j.y)));
      col *= 1.0 - 0.18 * smoothstep(0.55, 0.9, vnoise(vec2(p.x * 2.2, p.z * 0.15))) * (1.0 - smoothstep(1.0, 3.0, abs(abs(p.x) - 1.6)));
      vec3 yellow = vec3(0.86, 0.66, 0.08);
      // The parking box round the jet, the lead-in line out of the doors, the nose-wheel stop bar.
      float bx = max(abs(p.x) - 6.0, 0.0);
      float box = max(paint(abs(p.x) - 6.0, 0.07) * step(abs(p.z + 0.5), 8.5), paint(abs(p.z + 0.5) - 8.5, 0.07) * step(abs(p.x), 6.07));
      float lead = paint(p.x, 0.08) * step(p.z, -6.0) * step(0.35, fract(p.z / 2.0));
      float stopBar = paint(p.z + 6.6, 0.1) * step(abs(p.x), 1.2);
      col = mix(col, yellow, max(max(box, lead), stopBar) * 0.92);
      // Hazard stripes along the walls.
      float edge = min(W * 0.5 - abs(p.x), L * 0.5 - p.z);
      float hz = step(edge, 0.6) * step(0.05, edge);
      float stripe = step(0.5, fract((p.x + p.z) / 0.8));
      col = mix(col, mix(vec3(0.05), yellow, stripe), hz * 0.9);
      gloss = 0.9 - 0.4 * grime;
    } else if (part == 1) {
      // Insulated wall panels (vertical seams), a darker dado band at the bottom.
      col = vec3(0.7, 0.72, 0.72);
      float u = abs(nl.x) > 0.5 ? p.z : p.x;
      col *= 1.0 - 0.15 * (1.0 - smoothstep(0.0, 0.04, abs(fract(u / 1.2) - 0.5) * 1.2));
      col = mix(col, vec3(0.32, 0.38, 0.42), step(p.y, 1.4));
      col = mix(col, vec3(0.86, 0.66, 0.08), step(1.4, p.y) * step(p.y, 1.55));
    } else if (part == 2) {
      // Roof underside: ribbed sheeting.
      col = vec3(0.62, 0.64, 0.66) * (0.85 + 0.15 * step(0.5, fract(p.x / 0.45)));
    } else if (part == 3) {
      col = vec3(0.2, 0.25, 0.3);
      gloss = 0.3;
    } else if (part == 4) {
      col = vec3(0.05);
      glow = vec3(4.0, 3.85, 3.5) * step(-0.0, -nl.y);
    } else if (part == 5) {
      col = vec3(0.42, 0.46, 0.44) * (0.9 + 0.1 * step(0.5, fract(p.y / 1.5)));
    } else if (part == 6) {
      col = vec3(0.62, 0.08, 0.06) * (0.85 + 0.15 * step(0.5, fract(p.y / 0.18)));
      gloss = 0.5;
    } else if (part == 7) {
      col = vec3(0.85, 0.62, 0.06);
      gloss = 0.3;
    } else if (part == 8) {
      col = vec3(0.04);
    } else {
      col = vec3(0.38, 0.33, 0.27);
    }

    // Daylight through the open doors: sky light, falling off into the shed, mostly from the front.
    float fromDoor = p.z + L * 0.5;
    float day = 0.3 + 0.7 * exp(-fromDoor / 9.0);
    vec3 nLoc = uToLocal * n;
    float facing = 0.6 + 0.4 * max(-nLoc.z, 0.0) + 0.2 * nLoc.y;
    vec3 ambient = mix(uAtmAmbGround, uAtmAmbSky, 0.5 + 0.5 * n.y) * day * facing * 0.75;
    // The sun, where it reaches in.
    vec3 Ls = normalize(uAtmSunDir);
    float ndl = dot(n, Ls);
    float sun = max(ndl, 0.0) * cloudShadow(vWorld) * sunShadow(vWorld, ndl);
    // The lamps: down-lights, pools on the floor and their glints in the epoxy.
    vec3 lamp = vec3(0.0);
    vec3 spec = vec3(0.0);
    vec3 v = normalize(uToLocal * toCam);
    for (int i = 0; i < ${MAX_LAMPS}; i++) {
      if (i >= uLampCount) break;
      vec3 d = uLamps[i] - p;
      float r2 = dot(d, d);
      vec3 l = d * inversesqrt(r2);
      float cone = smoothstep(0.15, 0.7, l.y);
      lamp += vec3(1.0, 0.96, 0.88) * max(dot(nLoc, l), 0.0) * cone * 28.0 / (r2 + 6.0);
      if (gloss > 0.0) spec += vec3(1.0, 0.96, 0.88) * pow(max(dot(reflect(-l, nLoc), v), 0.0), 120.0) * cone * 2.5;
    }
    col = col * (ambient + uAtmSunCol * sun + lamp * 0.42) + spec * gloss * 0.6 + glow;
    // The floor mirrors the bright doorway a little.
    if (part == 0) col += mix(uAtmAmbSky, uAtmAmbSky * 1.6, 0.5) * 0.08 * gloss * smoothstep(-0.3, -0.9, v.z) * exp(-fromDoor / 14.0);
    gl_FragColor = vec4(atmApply(col, vWorld), 1.0);
  }
`;

function boxAt(parts: THREE.BufferGeometry[], part: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0)).toNonIndexed();
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  tag(g, part);
  parts.push(g);
}

function tag(g: THREE.BufferGeometry, part: number): void {
  g.deleteAttribute('uv');
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Array(g.getAttribute('position').count).fill(part), 1));
}

/** A box `len` long from a to b (an arch member), `w` wide across z, `t` deep. */
function beam(parts: THREE.BufferGeometry[], part: number, a: THREE.Vector3, b: THREE.Vector3, w: number, t: number): void {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(len, t, w).toNonIndexed();
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  g.rotateZ(ang);
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  tag(g, part);
  parts.push(g);
}

/** The interior for a hangar `w` wide, `l` long, `h` high (to the roof's crown); and its lamps. */
export function buildHangarInterior(w: number, l: number, h: number): { geom: THREE.BufferGeometry; lamps: THREE.Vector3[] } {
  const parts: THREE.BufferGeometry[] = [];
  const hw = w / 2;
  const hl = l / 2;
  const wallH = h * 0.72;
  const rise = h - wallH;
  const archY = (x: number): number => wallH + rise * (1 - (x / hw) ** 2);
  const SEG = 16;

  // Floor.
  const floor = new THREE.PlaneGeometry(w, l).toNonIndexed();
  floor.rotateX(-Math.PI / 2);
  floor.translate(0, 0.02, 0);
  tag(floor, P.Floor);
  parts.push(floor);

  // Side walls and the back wall (up to the arch: a gable under the roof).
  boxAt(parts, P.Wall, -hw - 0.2, -hw, 0, wallH, -hl, hl);
  boxAt(parts, P.Wall, hw, hw + 0.2, 0, wallH, -hl, hl);
  const gable = (z: number, inner: boolean): void => {
    const pos: number[] = [];
    for (let i = 0; i < SEG; i++) {
      const x0 = -hw + (w * i) / SEG;
      const x1 = -hw + (w * (i + 1)) / SEG;
      const y0 = inner ? 0 : wallH * 0.86;
      pos.push(x0, y0, z, x1, y0, z, x1, archY(x1), z, x0, y0, z, x1, archY(x1), z, x0, archY(x0), z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill(P.Wall), 1));
    parts.push(g);
  };
  gable(hl, true);
  // Front: the header over the doorway, and short wall returns either side of it.
  gable(-hl, false);
  boxAt(parts, P.Wall, -hw, -hw + 1.2, 0, wallH, -hl - 0.2, -hl);
  boxAt(parts, P.Wall, hw - 1.2, hw, 0, wallH, -hl - 0.2, -hl);
  // The door leaves, slid open outside the returns.
  boxAt(parts, P.Door, -hw - 0.1, -hw + 2.6, 0, wallH * 0.86, -hl - 0.75, -hl - 0.45);
  boxAt(parts, P.Door, hw - 2.6, hw + 0.1, 0, wallH * 0.86, -hl - 0.75, -hl - 0.45);

  // The roof skin.
  {
    const pos: number[] = [];
    for (let i = 0; i < SEG; i++) {
      const x0 = -hw + (w * i) / SEG;
      const x1 = -hw + (w * (i + 1)) / SEG;
      const a = [x0, archY(x0)];
      const b = [x1, archY(x1)];
      pos.push(a[0]!, a[1]!, -hl, b[0]!, b[1]!, -hl, b[0]!, b[1]!, hl, a[0]!, a[1]!, -hl, b[0]!, b[1]!, hl, a[0]!, a[1]!, hl);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill(P.Roof), 1));
    parts.push(g);
  }

  // Steel frames: columns, a tie beam and the arch, every ~4.5 m; purlins along the roof.
  const frames = Math.max(3, Math.round(l / 4.5));
  const lamps: THREE.Vector3[] = [];
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  for (let k = 0; k <= frames; k++) {
    const z = -hl + 0.3 + ((l - 0.6) * k) / frames;
    boxAt(parts, P.Steel, -hw, -hw + 0.4, 0, wallH, z - 0.2, z + 0.2);
    boxAt(parts, P.Steel, hw - 0.4, hw, 0, wallH, z - 0.2, z + 0.2);
    boxAt(parts, P.Steel, -hw, hw, wallH - 0.35, wallH - 0.1, z - 0.1, z + 0.1);
    for (let i = 0; i < SEG; i++) {
      const x0 = -hw + (w * i) / SEG;
      const x1 = -hw + (w * (i + 1)) / SEG;
      beam(parts, P.Steel, v0.set(x0, archY(x0) - 0.3, z), v1.set(x1, archY(x1) - 0.3, z), 0.22, 0.5);
    }
    // Struts from the tie beam up to the arch.
    for (const x of [-hw * 0.5, 0, hw * 0.5]) boxAt(parts, P.Steel, x - 0.06, x + 0.06, wallH - 0.1, archY(x) - 0.3, z - 0.06, z + 0.06);
    // High-bay lamps hung between the frames.
    if (k < frames) {
      const zm = z + (l - 0.6) / frames / 2;
      for (const x of [-hw * 0.45, 0, hw * 0.45]) {
        const y = wallH - 0.6;
        boxAt(parts, P.Steel, x - 0.02, x + 0.02, y, archY(x) - 0.3, zm - 0.02, zm + 0.02);
        const g = new THREE.CylinderGeometry(0.35, 0.5, 0.35, 12).toNonIndexed();
        g.translate(x, y - 0.17, zm);
        tag(g, P.Lamp);
        parts.push(g);
        if (lamps.length < MAX_LAMPS) lamps.push(new THREE.Vector3(x, y - 0.4, zm));
      }
    }
  }
  for (const x of [-hw * 0.75, -hw * 0.25, hw * 0.25, hw * 0.75]) boxAt(parts, P.Steel, x - 0.08, x + 0.08, archY(x) - 0.25, archY(x) - 0.05, -hl, hl);

  // Along the walls: tool chests and a workbench on the left, a ground power cart and a ladder on
  // the right, chocks and an extinguisher trolley.
  for (let i = 0; i < 3; i++) {
    const z = hl - 3 - i * 2.2;
    boxAt(parts, P.Chest, -hw + 0.3, -hw + 1.0, 0.1, 1.05, z - 0.8, z + 0.8);
    boxAt(parts, P.Rubber, -hw + 0.35, -hw + 0.95, 0, 0.1, z - 0.7, z + 0.7);
  }
  boxAt(parts, P.Bench, -hw + 0.3, -hw + 1.2, 0.85, 0.95, hl - 12, hl - 9);
  boxAt(parts, P.Steel, -hw + 0.35, -hw + 1.15, 0, 0.85, hl - 11.9, hl - 11.8);
  boxAt(parts, P.Steel, -hw + 0.35, -hw + 1.15, 0, 0.85, hl - 9.2, hl - 9.1);
  // Ground power unit.
  boxAt(parts, P.Yellow, hw - 3.2, hw - 1.6, 0.35, 1.45, hl - 6.5, hl - 4.0);
  for (const dz of [-2.2, -0.3]) for (const dx of [-3.0, -1.8]) boxAt(parts, P.Rubber, hw + dx, hw + dx + 0.25, 0, 0.55, hl - 4.2 + dz - 0.27, hl - 4.2 + dz + 0.27);
  // A maintenance stand (platform on legs, a handrail).
  boxAt(parts, P.Yellow, hw - 3.6, hw - 1.8, 1.9, 2.0, hl - 13, hl - 11);
  for (const dx of [-3.55, -1.9]) for (const dz of [-12.95, -11.1]) boxAt(parts, P.Yellow, hw + dx, hw + dx + 0.06, 0, 1.9, hl + dz, hl + dz + 0.06);
  boxAt(parts, P.Yellow, hw - 3.6, hw - 1.8, 2.9, 2.95, hl - 11.05, hl - 11.0);
  // Extinguisher trolley.
  boxAt(parts, P.Chest, hw - 1.1, hw - 0.6, 0, 1.1, -hl + 2.0, -hl + 2.5);

  const geom = mergeGeometries(parts);
  for (const g of parts) g.dispose();
  return { geom, lamps };
}

export interface HangarBay {
  /** Show the interior for this bay, or hide it (null). */
  set(bay: Bay | null): void;
  updateOrigin(origin: Readonly<Vec3Like>): void;
  dispose(): void;
}

export function createHangarBay(parent: THREE.Object3D): HangarBay {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...getAtmosphereUniforms(),
      ...getCloudShadowUniforms(),
      ...getSunShadowUniforms(),
      // The atmosphere's own sun direction (the same object: it follows the time of day).
      uSunDir: { value: getAtmosphereUniforms().uAtmSunDir.value },
      uOrigin: { value: new THREE.Vector3() },
      uLamps: { value: Array.from({ length: MAX_LAMPS }, () => new THREE.Vector3()) },
      uLampCount: { value: 0 },
      uSize: { value: new THREE.Vector3() },
      uToLocal: { value: new THREE.Matrix3() },
    },
    vertexShader: VS,
    fragmentShader: FS,
    side: THREE.DoubleSide,
  });
  let mesh: THREE.Mesh | null = null;
  let key = '';
  let world = { x: 0, y: 0, z: 0 };
  let heading = 0;

  const clear = (): void => {
    if (!mesh) return;
    parent.remove(mesh);
    mesh.geometry.dispose();
    mesh = null;
  };

  return {
    set(bay) {
      if (!bay) {
        clear();
        key = '';
        return;
      }
      const k = `${bay.widthM}|${bay.lengthM}|${bay.heightM}`;
      if (k !== key || !mesh) {
        clear();
        key = k;
        const { geom, lamps } = buildHangarInterior(bay.widthM, bay.lengthM, bay.heightM);
        mesh = new THREE.Mesh(geom, mat);
        mesh.frustumCulled = false;
        mesh.layers.enable(CASTER_LAYER);
        mesh.matrixAutoUpdate = false;
        parent.add(mesh);
        const arr = mat.uniforms['uLamps']!.value as THREE.Vector3[];
        lamps.forEach((l, i) => arr[i]!.copy(l));
        mat.uniforms['uLampCount']!.value = lamps.length;
        (mat.uniforms['uSize']!.value as THREE.Vector3).set(bay.widthM, bay.lengthM, bay.heightM * 0.72);
      }
      world = { x: bay.x, y: bay.y, z: bay.z };
      heading = bay.headingRad;
      // World -> bay: the transpose of the bay's rotation (columns right, up, back).
      const c = Math.cos(heading);
      const s = Math.sin(heading);
      (mat.uniforms['uToLocal']!.value as THREE.Matrix3).set(c, 0, s, 0, 1, 0, -s, 0, c);
    },
    updateOrigin(origin) {
      (mat.uniforms['uOrigin']!.value as THREE.Vector3).set(origin.x, origin.y, origin.z);
      if (!mesh) return;
      const c = Math.cos(heading);
      const s = Math.sin(heading);
      // Columns: right (cos h, 0, sin h), up, back (-sin h, 0, cos h), as the structure models.
      mesh.matrix.set(c, 0, -s, world.x - origin.x, 0, 1, 0, world.y - origin.y, s, 0, c, world.z - origin.z, 0, 0, 0, 1);
      mesh.matrixWorldNeedsUpdate = true;
    },
    dispose() {
      clear();
      mat.dispose();
    },
  };
}
