/**
 * The C-17's renderer model: its keyframe rig (trackRig.ts), the pose that drives it (c17Pose.ts),
 * the GLB's moving nodes each in a pose group, and the outside cameras scaling with its size.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { AIRCRAFT_MODEL_MASK, AIRCRAFT_MODEL_SHIFT, AircraftModel, aircraftModelOf } from '../../src/contracts/core';
import { activeSpan, rigLocal, rotationBetween, sampleQuat, sampleVec3, type RigNodeDef, type RigTrack } from '../../src/render/aircraftModels/trackRig';
import {
  applyC17PoseOverride,
  c17GroupOf,
  c17GroupValue,
  c17PoseTarget,
  C17_IDLE_N1,
  C17_TRAVEL_SEC,
  createC17Pose,
  parseC17PoseOverride,
  stepC17Pose,
} from '../../src/render/aircraftModels/c17Pose';
import type { MeshAircraftState } from '../../src/render/meshAircraftRenderer';
import { computeChasePose, createCameraPose, createChaseCameraState } from '../../src/render/cameraModes';

function state(over: Partial<MeshAircraftState> = {}): MeshAircraftState {
  return {
    elevonL: 0,
    elevonR: 0,
    rudder: 0,
    gearPos: 1,
    throttle: 0,
    afterburner: false,
    airbrakeOut: false,
    onGround: false,
    team: 0,
    vel: { x: 0, y: 0, z: 0 },
    stores: 0,
    storesB: 0,
    flags: 0,
    ...over,
  };
}

describe('C-17 model code', () => {
  it('is its own model, carried in the entity flags beside the others', () => {
    expect(AircraftModel.C17).toBe(2);
    const flags = (1 << 3) | (AircraftModel.C17 << AIRCRAFT_MODEL_SHIFT);
    expect(aircraftModelOf(flags)).toBe(AircraftModel.C17);
    expect(flags & ~AIRCRAFT_MODEL_MASK).toBe(1 << 3);
  });
});

describe('keyframe rig sampling', () => {
  const tr: RigTrack = { times: Float32Array.from([0, 1, 2, 3]), values: Float32Array.from([0, 0, 0, 0, 0, 0, 2, 4, 6, 2, 4, 6]) };
  it('interpolates linearly between keys and holds at the ends', () => {
    const v = new THREE.Vector3();
    expect(sampleVec3(tr, 1.5, v).toArray()).toEqual([1, 2, 3]);
    expect(sampleVec3(tr, -1, v).toArray()).toEqual([0, 0, 0]);
    expect(sampleVec3(tr, 9, v).toArray()).toEqual([2, 4, 6]);
    expect(activeSpan(tr, 3)).toEqual([1, 2]);
  });

  it('slerps rotations, and finds the axis and angle a channel turns through', () => {
    const q0 = new THREE.Quaternion();
    const q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const r: RigTrack = { times: Float32Array.from([0, 1]), values: Float32Array.from([...q0.toArray(), ...q1.toArray()]) };
    const half = sampleQuat(r, 0.5, new THREE.Quaternion());
    expect(half.angleTo(q0)).toBeCloseTo(Math.PI / 4, 5);
    const { axis, angle } = rotationBetween(r, 0, 1);
    expect(angle).toBeCloseTo(Math.PI / 2, 5);
    expect(axis.z).toBeCloseTo(1, 5);
  });

  it('turns a hinge node about its axis from its neutral rotation', () => {
    const n: RigNodeDef = {
      name: 'h',
      group: 'aileronR',
      mode: 'hinge',
      parent: -1,
      base: new THREE.Matrix4(),
      restT: new THREE.Vector3(1, 0, 0),
      restR: new THREE.Quaternion(),
      restS: new THREE.Vector3(1, 1, 1),
      invRest: new THREE.Matrix4(),
      axis: new THREE.Vector3(0, 0, 1),
      from: new THREE.Quaternion(),
    };
    const m = rigLocal(n, Math.PI / 2, new THREE.Matrix4());
    // (1, 0, 0) local -> rotated to (0, 1, 0), then the node's translation.
    const p = new THREE.Vector3(1, 0, 0).applyMatrix4(m);
    expect(p.x).toBeCloseTo(1, 6);
    expect(p.y).toBeCloseTo(1, 6);
  });
});

describe('C-17 pose', () => {
  it('wires gear, spoilers (airbrake), ailerons and fans from what the renderer has now', () => {
    const p = c17PoseTarget(state({ gearPos: 0.4, airbrakeOut: true, elevonL: 0.2, elevonR: -0.2, throttle: 1 }), createC17Pose());
    expect(p.gear).toBeCloseTo(0.4);
    expect(p.spoilers).toBe(1);
    expect(p.aileronL).toBeCloseTo(0.2);
    expect(p.aileronR).toBeCloseTo(-0.2);
    expect(p.n1).toEqual([1, 1, 1, 1]);
    // Unset parts rest stowed; the fans idle at zero throttle.
    const q = c17PoseTarget(state(), createC17Pose());
    expect([q.flaps, q.slats, q.ramp, q.crewDoor, q.troopDoors, ...q.reversers]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(q.n1[0]).toBeCloseTo(C17_IDLE_N1);
  });

  it('takes the flight model fields when given (the merge-time hookup), slats with the flaps', () => {
    const p = c17PoseTarget(state({ flaps: 0.5, spoilers: 0.25, reversers: [1, 0, 0, 1], ramp: 1, crewDoor: 0.5, troopDoors: 1, n1: [0.3, 0.4, 0.5, 0.6] }), createC17Pose());
    expect(p.flaps).toBe(0.5);
    expect(p.slats).toBe(1);
    expect(p.spoilers).toBe(0.25);
    expect(p.reversers).toEqual([1, 0, 0, 1]);
    expect([p.ramp, p.crewDoor, p.troopDoors]).toEqual([1, 0.5, 1]);
    expect(p.n1).toEqual([0.3, 0.4, 0.5, 0.6]);
    expect(c17GroupValue(p, 'reverser3')).toBe(1);
    expect(c17GroupValue(p, 'reverser1')).toBe(0);
    expect(c17GroupValue(p, 'ramp')).toBe(1);
    expect(c17GroupValue(p, 'unknown')).toBe(0);
  });

  it('moves each group at its travel rate (gear and ailerons follow at once) and spins the fans', () => {
    const cur = createC17Pose();
    const target = c17PoseTarget(state({ gearPos: 0, flaps: 1, ramp: 1, throttle: 1 }), createC17Pose());
    stepC17Pose(cur, target, 1, false);
    expect(cur.gear).toBe(0);
    expect(cur.flaps).toBeCloseTo(1 / C17_TRAVEL_SEC.flaps);
    expect(cur.ramp).toBeCloseTo(1 / C17_TRAVEL_SEC.ramp);
    expect(cur.fanAngle[0]).toBeGreaterThan(0);
    stepC17Pose(cur, target, 0, true);
    expect(cur.flaps).toBe(1);
    expect(cur.ramp).toBe(1);
  });

  it('parses the dev pose override', () => {
    expect(parseC17PoseOverride('flaps:1,ramp:0.5,gear:0,rev:1,bogus:3,door:x')).toEqual({ flaps: 1, ramp: 0.5, gear: 0, reversers: 1 });
    expect(parseC17PoseOverride('cycle')).toEqual({ cycle: true });
    // Surface angles in rad, within +-0.6.
    expect(parseC17PoseOverride('elev:-0.4,rud:0.9')).toEqual({ elevator: -0.4, rudder: 0.6 });
    expect(parseC17PoseOverride('')).toBeUndefined();
    const s = state();
    applyC17PoseOverride({ gear: 0, reversers: 1 }, s);
    expect(s.gearPos).toBe(0);
    expect(s.reversers).toEqual([1, 1, 1, 1]);
  });
});

describe('C-17 GLB', () => {
  // GLB: 12-byte header, then the JSON chunk (length, type, data).
  const buf = readFileSync('public/models/c17.glb');
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + len))) as {
    nodes: { name?: string }[];
    materials: { name?: string }[];
    animations: { channels: { target: { node: number } }[] }[];
  };
  // three.js's GLTFLoader names nodes this way (PropertyBinding.sanitizeNodeName).
  const sanitize = (n: string): string => THREE.PropertyBinding.sanitizeNodeName(n);

  it('is one texture set (and the glass), for the aircraft shader', () => {
    expect(gltf.materials.map((m) => m.name).sort()).toEqual(['c17', 'glass']);
  });

  it('puts every moving node in a pose group, and has every group the pose drives', () => {
    const moving = new Set(gltf.animations.flatMap((a) => a.channels.map((c) => c.target.node)));
    const groups = new Set<string>();
    for (const i of moving) {
      const name = sanitize(gltf.nodes[i]!.name ?? '');
      const g = c17GroupOf(name);
      expect(g, name).toBeDefined();
      groups.add(g!.group);
    }
    expect([...groups].sort()).toEqual(['aileron', 'crewDoor', 'fan', 'flaps', 'gear', 'ramp', 'reverser', 'slats', 'spoilers', 'troopDoors']);
    // Four fans (one per engine), two ailerons.
    const named = (g: string): number => [...moving].filter((i) => c17GroupOf(sanitize(gltf.nodes[i]!.name ?? ''))?.group === g).length;
    expect(named('fan')).toBe(4);
    expect(named('aileron')).toBe(2);
  });
});

describe('outside cameras and a big aircraft', () => {
  it('chase from proportionally further back for a C-17', () => {
    const pos = { x: 0, y: 1000, z: 0 };
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    const a = computeChasePose(pos, rot, createChaseCameraState(), 1 / 60, createCameraPose());
    const da = Math.hypot(a.pos.x - pos.x, a.pos.y - pos.y, a.pos.z - pos.z);
    const b = computeChasePose(pos, rot, createChaseCameraState(), 1 / 60, createCameraPose(), -Infinity, 4);
    const db = Math.hypot(b.pos.x - pos.x, b.pos.y - pos.y, b.pos.z - pos.z);
    expect(db / da).toBeCloseTo(4, 5);
  });
});

describe('C-17 tail surfaces and pitch/yaw pose', () => {
  it('drives the elevators by the elevons\' pitch part and the rudders by the rudder', () => {
    const p = c17PoseTarget(state({ elevonL: 0.3, elevonR: 0.1, rudder: -0.2 }), createC17Pose());
    expect(p.elevator).toBeCloseTo(0.2);
    expect(p.rudder).toBeCloseTo(-0.2);
    expect(c17GroupValue(p, 'elevator')).toBeCloseTo(0.2);
    expect(c17GroupValue(p, 'rudder')).toBeCloseTo(-0.2);
  });
});

describe('C-17 GLB geometry', () => {
  const buf = readFileSync('public/models/c17.glb');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const jlen = dv.getUint32(12, true);
  type Acc = { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string };
  const gltf = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jlen))) as {
    nodes: { name?: string; extras?: { marut?: { group?: string; hinge?: number[] } } }[];
    meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
    accessors: Acc[];
    bufferViews: { byteOffset?: number; byteStride?: number }[];
  };
  const bin = 20 + jlen + 8;
  const read = (i: number, n: number): number[] => {
    const a = gltf.accessors[i]!;
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

  it('winds every face the way its normals face (the back-face-culled shader shows them all)', () => {
    // The source's left side was wound inside out (its faces vanished); the build turns them round.
    let total = 0;
    let against = 0;
    for (const m of gltf.meshes)
      for (const p of m.primitives) {
        if (p.indices === undefined || p.attributes['NORMAL'] === undefined) continue;
        const pos = read(p.attributes['POSITION']!, 3);
        const nor = read(p.attributes['NORMAL']!, 3);
        const idx = read(p.indices, 1);
        for (let t = 0; t + 2 < idx.length; t += 3) {
          const [a, b, c] = [idx[t]! * 3, idx[t + 1]! * 3, idx[t + 2]! * 3];
          const u = [pos[b]! - pos[a]!, pos[b + 1]! - pos[a + 1]!, pos[b + 2]! - pos[a + 2]!];
          const v = [pos[c]! - pos[a]!, pos[c + 1]! - pos[a + 1]!, pos[c + 2]! - pos[a + 2]!];
          const w = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
          const s = [0, 1, 2].map((k) => nor[a + k]! + nor[b + k]! + nor[c + k]!);
          const d = w[0]! * s[0]! + w[1]! * s[1]! + w[2]! * s[2]!;
          const lw = Math.hypot(w[0]!, w[1]!, w[2]!);
          const ls = Math.hypot(s[0]!, s[1]!, s[2]!);
          if (lw < 1e-9 || ls < 1e-9) continue;
          total++;
          if (d < -0.3 * lw * ls) against++;
        }
      }
    expect(total).toBeGreaterThan(50000);
    expect(against).toBe(0);
  });

  it('has the four elevators and two rudders cut out of the tail, each with its hinge line', () => {
    const surf = gltf.nodes.filter((n) => n.extras?.marut?.hinge);
    const groups = surf.map((n) => n.extras!.marut!.group).sort();
    expect(groups).toEqual(['elevator', 'elevator', 'elevator', 'elevator', 'rudder', 'rudder']);
    for (const n of surf) {
      const h = n.extras!.marut!.hinge!;
      expect(h).toHaveLength(6);
      // Model frame: the tail is aft (x < -15) and high (y > 8).
      expect(h[0]!).toBeLessThan(-15);
      expect(h[1]!).toBeGreaterThan(8);
    }
  });
});