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
