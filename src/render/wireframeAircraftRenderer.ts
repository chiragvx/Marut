/**
 * src/render/wireframeAircraftRenderer.ts
 *
 * Consumes a registered WireframeModel + per-entity live deflections; builds
 * one THREE.LineSegments per aircraft entity, re-derived from rest pose every
 * frame. 08-render.md section 4.4.
 */

import * as THREE from 'three';
import type { QuatLike, Vec3Like } from '../contracts/core';
import { GEAR_TRAVEL_RAD, WIREFRAME_CONTROL_GROUP_NAMES, type WireframeModel } from '../contracts/render';
import { rotateVecByAxisAngle, rotateVecByQuat } from './mathInternal';

/** Max concurrently-drawn aircraft LineSegments instances (pooled, capped — section 4.4/6). */
export const MAX_WIREFRAME_INSTANCES = 64;

export interface ArticulationFields {
  elevonL: number;
  elevonR: number;
  rudder: number;
  gearPos: number;
}

/** Table 5.3/5.8 mapping: group name -> live rotation angle, rad. Pure function. */
export function computeGroupTheta(groupName: string, fields: Readonly<ArticulationFields>): number {
  switch (groupName) {
    case WIREFRAME_CONTROL_GROUP_NAMES.ElevonL:
      return fields.elevonL;
    case WIREFRAME_CONTROL_GROUP_NAMES.ElevonR:
      return fields.elevonR;
    case WIREFRAME_CONTROL_GROUP_NAMES.Rudder:
      return fields.rudder;
    case WIREFRAME_CONTROL_GROUP_NAMES.NoseGear:
    case WIREFRAME_CONTROL_GROUP_NAMES.MainGearL:
    case WIREFRAME_CONTROL_GROUP_NAMES.MainGearR:
      return fields.gearPos * GEAR_TRAVEL_RAD;
    default:
      return 0;
  }
}

const scratchRelativeToPivot: Vec3Like = { x: 0, y: 0, z: 0 };

/** Rotates a body-frame rest-pose `vertex` about `pivotBodyM` along `axisBody` by `thetaRad` (Rodrigues). */
export function articulateVertex(
  vertex: Readonly<Vec3Like>,
  pivotBodyM: Readonly<Vec3Like>,
  axisBody: Readonly<Vec3Like>,
  thetaRad: number,
  out: Vec3Like
): Vec3Like {
  scratchRelativeToPivot.x = vertex.x - pivotBodyM.x;
  scratchRelativeToPivot.y = vertex.y - pivotBodyM.y;
  scratchRelativeToPivot.z = vertex.z - pivotBodyM.z;
  rotateVecByAxisAngle(scratchRelativeToPivot, axisBody, thetaRad, out);
  out.x += pivotBodyM.x;
  out.y += pivotBodyM.y;
  out.z += pivotBodyM.z;
  return out;
}

interface WireframeInstance {
  lineSegments: THREE.LineSegments;
  assignedId: number;
}

const NO_ASSIGNED_ID = -1;

export interface WireframeAircraftRenderer {
  registerModel(model: WireframeModel): void;
  /** Call once at the start of each renderFrame, before any updateEntity calls. */
  beginFrame(): void;
  /** Call once per alive, kind==='aircraft' entity this frame. */
  updateEntity(
    entityId: number,
    pos: Readonly<Vec3Like>,
    rot: Readonly<QuatLike>,
    fields: Readonly<ArticulationFields>,
    originWorld: Readonly<Vec3Like>
  ): void;
  /** Call once at the end of each renderFrame: hides instances not touched this frame. */
  endFrame(): void;
  dispose(): void;
}

const scratchVertex: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchArticulated: Vec3Like = { x: 0, y: 0, z: 0 };
const scratchRender: Vec3Like = { x: 0, y: 0, z: 0 };

export function createWireframeAircraftRenderer(root: THREE.Object3D, capacity: number = MAX_WIREFRAME_INSTANCES): WireframeAircraftRenderer {
  let model: WireframeModel | null = null;
  let material: THREE.LineBasicMaterial | null = null;
  const instances: WireframeInstance[] = [];
  const touchedThisFrame = new Uint8Array(capacity);

  function buildInstance(m: WireframeModel): WireframeInstance {
    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(new Float32Array(m.vertices.length * 3), 3);
    geometry.setAttribute('position', posAttr);
    const indexArray = new Uint32Array(m.edges.length * 2);
    for (let i = 0; i < m.edges.length; i++) {
      const e = m.edges[i]!;
      indexArray[i * 2] = e[0];
      indexArray[i * 2 + 1] = e[1];
    }
    geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
    const lineSegments = new THREE.LineSegments(geometry, material!);
    lineSegments.visible = false;
    lineSegments.matrixAutoUpdate = false;
    lineSegments.frustumCulled = false;
    root.add(lineSegments);
    return { lineSegments, assignedId: NO_ASSIGNED_ID };
  }

  return {
    registerModel(m: WireframeModel) {
      model = m;
      material = new THREE.LineBasicMaterial({ color: 0xd8e8ff });
    },

    beginFrame() {
      touchedThisFrame.fill(0);
    },

    updateEntity(entityId, pos, rot, fields, originWorld) {
      if (!model) return;
      const m = model;

      let idx = -1;
      for (let i = 0; i < instances.length; i++) {
        if (instances[i]!.assignedId === entityId) {
          idx = i;
          break;
        }
      }
      if (idx === -1) {
        for (let i = 0; i < instances.length; i++) {
          if (instances[i]!.assignedId === NO_ASSIGNED_ID) {
            idx = i;
            break;
          }
        }
      }
      if (idx === -1 && instances.length < capacity) {
        instances.push(buildInstance(m));
        idx = instances.length - 1;
      }
      if (idx === -1) return; // pool exhausted — drop silently, no allocation beyond capacity.

      const inst = instances[idx]!;
      inst.assignedId = entityId;
      inst.lineSegments.visible = true;
      touchedThisFrame[idx] = 1;

      const posAttr = inst.lineSegments.geometry.getAttribute('position') as THREE.BufferAttribute;
      const posArr = posAttr.array as Float32Array;

      for (let vi = 0; vi < m.vertices.length; vi++) {
        const rest = m.vertices[vi]!;
        scratchVertex.x = rest[0];
        scratchVertex.y = rest[1];
        scratchVertex.z = rest[2];

        let articulated: Vec3Like = scratchVertex;
        for (let gi = 0; gi < m.groups.length; gi++) {
          const g = m.groups[gi]!;
          if (g.vertexIndices.indexOf(vi) === -1) continue;
          const theta = computeGroupTheta(g.name, fields);
          if (theta === 0) continue;
          articulateVertex(articulated, g.pivotBodyM, g.axisBody, theta, scratchArticulated);
          articulated = scratchArticulated;
        }

        rotateVecByQuat(rot, articulated, scratchRender);
        posArr[vi * 3] = scratchRender.x + (pos.x - originWorld.x);
        posArr[vi * 3 + 1] = scratchRender.y + (pos.y - originWorld.y);
        posArr[vi * 3 + 2] = scratchRender.z + (pos.z - originWorld.z);
      }
      posAttr.needsUpdate = true;
    },

    endFrame() {
      for (let i = 0; i < instances.length; i++) {
        if (!touchedThisFrame[i]) {
          instances[i]!.lineSegments.visible = false;
          instances[i]!.assignedId = NO_ASSIGNED_ID;
        }
      }
    },

    dispose() {
      for (const inst of instances) {
        root.remove(inst.lineSegments);
        inst.lineSegments.geometry.dispose();
      }
      instances.length = 0;
      if (material) {
        material.dispose();
        material = null;
      }
      model = null;
    },
  };
}
