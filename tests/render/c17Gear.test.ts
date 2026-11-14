// @vitest-environment jsdom
/**
 * The C-17's gear in the 3D model: wheels spin about their axles by the distance rolled (each over
 * its own radius, bottoms moving aft when rolling forwards), the nose wheel steers about its leg
 * (+ = left), each leg's oleo slides its wheels up with the load, and all of it rides on the
 * retraction keyframes. Built from the real GLB (its node tree, meshes and animation, read here
 * without textures) through templateFromC17Gltf.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { templateFromC17Gltf } from '../../src/render/aircraftModels/c17Model';
import { rigWorld, type AircraftRig } from '../../src/render/aircraftModels/trackRig';
import { C17_OLEO_COMPRESS_M, C17_OLEO_EXTEND_M, c17GroupValue, c17NoseSteerTarget, c17OleoTarget, createC17Pose, type C17Pose } from '../../src/render/aircraftModels/c17Pose';

type Acc = { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string };
interface Gltf {
  nodes: { name?: string; children?: number[]; mesh?: number; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
  accessors: Acc[];
  bufferViews: { byteOffset?: number; byteStride?: number }[];
  scenes: { nodes: number[] }[];
  animations: { channels: { sampler: number; target: { node: number; path: string } }[]; samplers: { input: number; output: number }[] }[];
}

/** The GLB as a three.js scene and clip, as GLTFLoader would give them (no textures). */
function loadC17(): { scene: THREE.Object3D; clips: THREE.AnimationClip[] } {
  const buf = readFileSync('public/models/c17.glb');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const jlen = dv.getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jlen))) as Gltf;
  const bin = 20 + jlen + 8;
  const SIZES: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const read = (i: number): number[] => {
    const a = gltf.accessors[i]!;
    const n = SIZES[a.type]!;
    const bv = gltf.bufferViews[a.bufferView]!;
    const size = a.componentType === 5126 || a.componentType === 5125 ? 4 : a.componentType === 5123 ? 2 : 1;
    const stride = bv.byteStride ?? size * n;
    const off = bin + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out: number[] = [];
    for (let k = 0; k < a.count; k++)
      for (let j = 0; j < n; j++) {
        const o = off + k * stride + j * size;
        out.push(a.componentType === 5126 ? dv.getFloat32(o, true) : size === 4 ? dv.getUint32(o, true) : size === 2 ? dv.getUint16(o, true) : dv.getUint8(o));
      }
    return out;
  };
  const textured = new THREE.MeshStandardMaterial({ map: new THREE.Texture(), metalnessMap: new THREE.Texture(), normalMap: new THREE.Texture() });
  const names = gltf.nodes.map((n) => THREE.PropertyBinding.sanitizeNodeName(n.name ?? ''));
  const build = (i: number): THREE.Object3D => {
    const n = gltf.nodes[i]!;
    let o: THREE.Object3D;
    if (n.mesh !== undefined) {
      const p = gltf.meshes[n.mesh]!.primitives[0]!;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(read(p.attributes['POSITION']!), 3));
      if (p.indices !== undefined) g.setIndex(read(p.indices));
      o = new THREE.Mesh(g, textured);
    } else o = new THREE.Group();
    o.name = names[i]!;
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    for (const c of n.children ?? []) o.add(build(c));
    return o;
  };
  const scene = new THREE.Group();
  for (const r of gltf.scenes[0]!.nodes) scene.add(build(r));
  const tracks: THREE.KeyframeTrack[] = [];
  for (const a of gltf.animations)
    for (const ch of a.channels) {
      const s = a.samplers[ch.sampler]!;
      const name = names[ch.target.node]!;
      const times = read(s.input);
      const values = read(s.output);
      if (ch.target.path === 'rotation') tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, values));
      else if (ch.target.path === 'translation') tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, times, values));
      else if (ch.target.path === 'scale') tracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, times, values));
    }
  return { scene, clips: [new THREE.AnimationClip('anim', -1, tracks)] };
}

/** Every rig node's body-frame matrix (W(x) W(rest)^-1) for a pose, as the renderer poses them. */
function poseWorld(rig: AircraftRig, p: C17Pose): THREE.Matrix4[] {
  const world = rig.nodes.map(() => new THREE.Matrix4());
  const scratch = new THREE.Matrix4();
  return rig.nodes.map((n, i) => {
    const v = c17GroupValue(p, n.group);
    let x = v * (n.gain ?? 1);
    if (n.mode === 'track') {
      const w = rig.windows[n.group];
      x = w ? w[1] - v * (w[1] - w[0]) : 0;
    }
    rigWorld(rig.nodes, i, x, world, scratch);
    return world[i]!.clone().multiply(n.invRest);
  });
}

/** Lowest and frontmost points of a node's geometry under a pose (body frame). */
function extent(rig: AircraftRig, m: THREE.Matrix4[], i: number): THREE.Box3 {
  return new THREE.Box3().setFromBufferAttribute(rig.geometry[i]!.getAttribute('position') as THREE.BufferAttribute).applyMatrix4(m[i]!);
}

describe('C-17 gear rig (from the GLB)', () => {
  const { scene, clips } = loadC17();
  const tpl = templateFromC17Gltf(scene, clips);
  const rig = tpl.rig!;
  const wheels = rig.nodes.map((n, i) => (n.group === 'wheel' ? i : -1)).filter((i) => i >= 0);
  const noseWheel = wheels.find((i) => rig.nodes[rig.nodes[i]!.parent]!.group === 'steer')!;

  it('makes every wheel a spinning node, the nose wheel riding on the steering and oleo nodes', () => {
    // Nose: one node (its two wheels); mains: four legs x (a pair + a single).
    expect(wheels.length).toBe(9);
    expect(noseWheel).toBeDefined();
    const steer = rig.nodes[noseWheel]!.parent;
    expect(rig.nodes[rig.nodes[steer]!.parent]!.group).toBe('oleoNose');
    // Radii: the model's tyres (the real ones: nose 40x16 ~1.0 m, mains 50x21-20 ~1.27 m across).
    for (const i of wheels) {
      const r = 1 / Math.abs(rig.nodes[i]!.gain!);
      if (i === noseWheel) expect(r).toBeGreaterThan(0.4), expect(r).toBeLessThan(0.55);
      else expect(r).toBeGreaterThan(0.58), expect(r).toBeLessThan(0.7);
    }
    // An oleo group per leg with its tyre bottom near the ground line (body y ~ -4.25).
    expect(rig.contacts!.map((c) => c.group).sort()).toEqual(['oleo0', 'oleo1', 'oleo2', 'oleo3', 'oleoNose']);
    for (const c of rig.contacts!) expect(c.tyreBottom.y).toBeCloseTo(-4.25, 0);
  });

  it('turns each wheel so its bottom moves aft when rolling forwards, by distance over radius', () => {
    const p0 = createC17Pose();
    const p1 = createC17Pose();
    p1.rolled = 0.1;
    const m0 = poseWorld(rig, p0);
    const m1 = poseWorld(rig, p1);
    for (const i of wheels) {
      const b = extent(rig, m0, i);
      const bottom = new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y + 0.02, (b.min.z + b.max.z) / 2);
      const moved = bottom.clone().applyMatrix4(new THREE.Matrix4().copy(m0[i]!).invert()).applyMatrix4(m1[i]!);
      expect(moved.x - bottom.x, rig.nodes[i]!.name).toBeLessThan(-0.08);
      expect(moved.x - bottom.x).toBeGreaterThan(-0.12);
    }
  });

  it('steers the nose wheel about its leg: + turns its front to the left', () => {
    const p = createC17Pose();
    const m0 = poseWorld(rig, p);
    p.steer = 0.4;
    const m1 = poseWorld(rig, p);
    const b0 = extent(rig, m0, noseWheel);
    const b1 = extent(rig, m1, noseWheel);
    const front = new THREE.Vector3(b0.max.x, (b0.min.y + b0.max.y) / 2, (b0.min.z + b0.max.z) / 2);
    const moved = front.clone().applyMatrix4(new THREE.Matrix4().copy(m0[noseWheel]!).invert()).applyMatrix4(m1[noseWheel]!);
    expect(moved.z).toBeLessThan(front.z - 0.1);
    // Turned about its own leg: it stays where it was (its centre moves little).
    expect(b1.getCenter(new THREE.Vector3()).distanceTo(b0.getCenter(new THREE.Vector3()))).toBeLessThan(0.15);
  });

  it('slides the wheels up the legs with the oleo travel, and the mains with their own legs only', () => {
    const p = createC17Pose();
    const m0 = poseWorld(rig, p);
    p.oleo['oleoNose'] = 0.2;
    p.oleo['oleo0'] = 0.2;
    const m1 = poseWorld(rig, p);
    const up = (i: number): number => extent(rig, m1, i).min.y - extent(rig, m0, i).min.y;
    expect(up(noseWheel)).toBeCloseTo(0.2, 1);
    const moved = wheels.filter((i) => i !== noseWheel && Math.abs(up(i)) > 0.01);
    // oleo0 carries one leg's two wheel nodes, straight up.
    expect(moved.length).toBe(2);
    for (const i of moved) expect(up(i)).toBeCloseTo(0.2, 2);
  });

  it('hides the wheels with their legs when the gear is up, and keeps them on the legs in between', () => {
    const p = createC17Pose();
    p.gear = 0.5;
    p.rolled = 3;
    const m = poseWorld(rig, p);
    // Each wheel still rides its leg: spinning it does not move its centre.
    for (const i of wheels) {
      const box = extent(rig, m, i);
      expect(Number.isFinite(box.min.y)).toBe(true);
    }
    expect(rig.nodes.filter((n) => n.group === 'gear' && n.hideAt === 0).length).toBeGreaterThan(0);
  });
});

describe('C-17 gear pose inputs', () => {
  it('steers as the physics: rudder share of 60 deg, tapering with speed, centred in the air', () => {
    const max = (60 * Math.PI) / 180;
    // Rudder + (trailing edge left: the left pedal) turns the wheel left.
    expect(c17NoseSteerTarget((30 * Math.PI) / 180, 2, true, 1)).toBeCloseTo(max, 5);
    expect(c17NoseSteerTarget((-15 * Math.PI) / 180, 2, true, 1)).toBeCloseTo(-max / 2, 5);
    // Faster: the authority falls, and the lateral-acceleration cap bites.
    expect(Math.abs(c17NoseSteerTarget(0.5236, 30, true, 1))).toBeLessThan(0.1);
    expect(c17NoseSteerTarget(0.5, 2, false, 1)).toBe(0);
    expect(c17NoseSteerTarget(0.5, 2, true, 0.5)).toBe(0);
  });

  it('compresses with the ground over the tyre, within the stroke, extended in the air', () => {
    expect(c17OleoTarget(-0.1, 0, true, 1)).toBeCloseTo(0.1);
    expect(c17OleoTarget(-1, 0, true, 1)).toBe(C17_OLEO_COMPRESS_M);
    expect(c17OleoTarget(5, 0, false, 1)).toBe(-C17_OLEO_EXTEND_M);
    expect(c17OleoTarget(5, undefined, false, 1)).toBe(-C17_OLEO_EXTEND_M);
    expect(c17OleoTarget(0, undefined, true, 1)).toBe(0);
    // Retracting: back to the modelled pose (the keyframes' own) early in the travel.
    expect(c17OleoTarget(5, 0, false, 0.5)).toBeCloseTo(0);
    expect(c17GroupValue({ ...createC17Pose(), oleo: { oleo2: 0.13 } }, 'oleo2')).toBe(0.13);
  });
});
