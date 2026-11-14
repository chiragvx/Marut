/**
 * src/render/aircraftModels/trackRig.ts — moving parts driven by an imported model's own keyframes.
 *
 * Some source models move their parts in compound ways a single hinge can't copy (the C-17's main
 * gear twists and translates up into its pod, the ramp swings down while its toes unfold, the slats
 * slide out and droop). Rather than refit those as hinges, the renderer samples the model's own
 * animation tracks: each rig node keeps its translation / rotation / scale keyframes, and a pose
 * value 0..1 per group picks the time inside that group's window of the source's timeline.
 *
 * Three ways a node is driven:
 * - 'track': its keyframes at the group's time;
 * - 'spin':  its rest rotation turned about the axis its keyframes spin it about (engine fans), by an angle;
 * - 'hinge': its rest translation, rotated from its neutral key about the axis between its window's
 *            two ends, by a signed angle (control surfaces: + = trailing edge down / left).
 *
 * Matrices: every node's world matrix is in the aircraft's body frame; the parts' geometry is baked
 * in the body frame at the rest pose, so each part is drawn with W(t) * W(rest)^-1.
 * Pure three.js math (no WebGL), so it is unit-testable.
 */
import * as THREE from 'three';

/** One keyframe channel (LINEAR): times, s, and values (3 per key, or 4 for a quaternion). */
export interface RigTrack {
  times: Float32Array;
  values: Float32Array;
}

export type RigMode = 'track' | 'spin' | 'hinge';

export interface RigNodeDef {
  name: string;
  /** Pose group (e.g. 'gear', 'flaps', 'reverser2'); several nodes share one. */
  group: string;
  mode: RigMode;
  /** Index of the nearest rig node above this one, or -1 (then `base` starts at the body frame). */
  parent: number;
  /** Parent rig node's frame (or the body frame) -> this node's parent frame (the static nodes between). */
  base: THREE.Matrix4;
  /** Rest local transform (the model as loaded). */
  restT: THREE.Vector3;
  restR: THREE.Quaternion;
  restS: THREE.Vector3;
  t?: RigTrack;
  r?: RigTrack;
  s?: RigTrack;
  /** Inverse of the node's rest world matrix (body frame). */
  invRest: THREE.Matrix4;
  /** 'spin' / 'hinge': the axis in the parent frame, and the rotation it turns from. */
  axis?: THREE.Vector3;
  from?: THREE.Quaternion;
  /** Hidden at this group value (e.g. legs folded away, reverser vanes stowed). */
  hideAt?: number;
}

/** Keyframed parts of an imported model (c17Model.ts), drawn by meshAircraftRenderer.ts. */
export interface AircraftRig {
  nodes: RigNodeDef[];
  /** Each node's geometry (body frame, rest pose); undefined for a node that only carries others. */
  geometry: (THREE.BufferGeometry | undefined)[];
  /** Each keyframed group's span of the source timeline, s: [fully out, clean]. */
  windows: Record<string, [number, number]>;
}

/** Linear sample of a 3-vector channel at time t (clamped to its ends). */
export function sampleVec3(tr: RigTrack, t: number, out: THREE.Vector3): THREE.Vector3 {
  const { times, values } = tr;
  const n = times.length;
  if (t <= times[0]!) return out.fromArray(values, 0);
  if (t >= times[n - 1]!) return out.fromArray(values, (n - 1) * 3);
  const i = keyIndex(times, t);
  const k = (t - times[i]!) / (times[i + 1]! - times[i]! || 1);
  const a = i * 3;
  const b = a + 3;
  return out.set(values[a]! + (values[b]! - values[a]!) * k, values[a + 1]! + (values[b + 1]! - values[a + 1]!) * k, values[a + 2]! + (values[b + 2]! - values[a + 2]!) * k);
}

const slerpOut = new Float32Array(4);

/** Spherical-linear sample of a quaternion channel at time t (clamped to its ends). */
export function sampleQuat(tr: RigTrack, t: number, out: THREE.Quaternion): THREE.Quaternion {
  const { times, values } = tr;
  const n = times.length;
  if (t <= times[0]!) return out.fromArray(values, 0);
  if (t >= times[n - 1]!) return out.fromArray(values, (n - 1) * 4);
  const i = keyIndex(times, t);
  const k = (t - times[i]!) / (times[i + 1]! - times[i]! || 1);
  const a = slerpOut;
  const v = values as unknown as number[];
  THREE.Quaternion.slerpFlat(a as unknown as number[], 0, v, i * 4, v, (i + 1) * 4, k);
  return out.set(a[0]!, a[1]!, a[2]!, a[3]!);
}

/** Index i with times[i] <= t < times[i + 1] (keys are usually evenly spaced: guess, then step). */
function keyIndex(times: Float32Array, t: number): number {
  const n = times.length;
  const span = times[n - 1]! - times[0]!;
  let i = Math.min(n - 2, Math.max(0, Math.floor(((t - times[0]!) / span) * (n - 1))));
  while (i > 0 && times[i]! > t) i--;
  while (i < n - 2 && times[i + 1]! <= t) i++;
  return i;
}

/** The active span of a channel: first and last time its value changes (undefined if it never does). */
export function activeSpan(tr: RigTrack, size: number): [number, number] | undefined {
  let t0: number | undefined;
  let t1 = 0;
  for (let k = 1; k < tr.times.length; k++) {
    let d = 0;
    for (let j = 0; j < size; j++) d = Math.max(d, Math.abs(tr.values[k * size + j]! - tr.values[(k - 1) * size + j]!));
    if (d > 1e-5) {
      if (t0 === undefined) t0 = tr.times[k - 1]!;
      t1 = tr.times[k]!;
    }
  }
  return t0 === undefined ? undefined : [t0, t1];
}

const tV = new THREE.Vector3();
const tS = new THREE.Vector3();
const tQ = new THREE.Quaternion();
const tQ2 = new THREE.Quaternion();

/**
 * A node's local matrix: `x` is the time for 'track', the angle (rad) for 'spin' and 'hinge'.
 */
export function rigLocal(node: RigNodeDef, x: number, out: THREE.Matrix4): THREE.Matrix4 {
  if (node.mode === 'track') {
    if (node.t) sampleVec3(node.t, x, tV);
    else tV.copy(node.restT);
    if (node.r) sampleQuat(node.r, x, tQ);
    else tQ.copy(node.restR);
    if (node.s) sampleVec3(node.s, x, tS);
    else tS.copy(node.restS);
    return out.compose(tV, tQ, tS);
  }
  tQ2.setFromAxisAngle(node.axis!, x);
  tQ.multiplyQuaternions(tQ2, node.from!);
  return out.compose(node.restT, tQ, node.restS);
}

/** World (body-frame) matrix of node i from its parent's (already computed, in `world`). */
export function rigWorld(nodes: readonly RigNodeDef[], i: number, x: number, world: readonly THREE.Matrix4[], scratch: THREE.Matrix4): THREE.Matrix4 {
  const n = nodes[i]!;
  const w = world[i]!;
  rigLocal(n, x, scratch);
  if (n.parent >= 0) w.multiplyMatrices(world[n.parent]!, n.base);
  else w.copy(n.base);
  return w.multiply(scratch);
}

/**
 * The axis (parent frame) and angle a rotation channel turns through between times a and b:
 * q(b) = R(axis, angle) * q(a).
 */
export function rotationBetween(tr: RigTrack, a: number, b: number): { axis: THREE.Vector3; angle: number } {
  const qa = sampleQuat(tr, a, new THREE.Quaternion());
  const qb = sampleQuat(tr, b, new THREE.Quaternion());
  const d = qb.clone().multiply(qa.clone().invert());
  if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
  const angle = 2 * Math.acos(Math.min(1, d.w));
  const s = Math.sqrt(Math.max(0, 1 - d.w * d.w));
  const axis = s < 1e-6 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(d.x / s, d.y / s, d.z / s);
  return { axis, angle };
}

/** Parents before children (rig nodes reference parents by index). */
export function checkRigOrder(nodes: readonly RigNodeDef[]): boolean {
  return nodes.every((n, i) => n.parent < i);
}
