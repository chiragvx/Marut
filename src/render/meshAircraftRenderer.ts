/**
 * src/render/meshAircraftRenderer.ts — draws every aircraft as a solid, articulated mesh built from
 * an AircraftModelTemplate (for now the procedural Tejas, aircraftModels/tejasTestModel.ts).
 *
 * One pooled instance per aircraft entity: a body mesh plus one hinged node per moving part, all
 * sharing the template's geometry; each instance has its own material (team colours, nozzle and
 * engine state) on one shared shader program. Moving parts:
 * - elevons and rudder follow the snapshot's surface deflections;
 * - gear folds with gearPos (hidden once stowed);
 * - airbrakes run out/in with the entity's AirbrakeOut flag (~1.2 s out, ~1.0 s in, as the sim's panels);
 * - leading-edge slats droop with angle of attack (from the velocity in body axes), 4-16 deg alpha;
 * - nozzle petals open at idle and in afterburner, close at military power; afterburner flame.
 * Every mesh also draws into the aircraft sun-shadow cascade (AIRCRAFT_SHADOW_LAYER).
 */
import * as THREE from 'three';
import type { QuatLike, Vec3Like } from '../contracts/core';
import { AIRCRAFT_SHADOW_LAYER } from './sunShadows';
import type { AircraftModelTemplate, ArticulatedPart } from './aircraftModels/tejasTestModel';
import { createAircraftBodyMaterial, createAircraftFlameMaterial, createAircraftSharedUniforms, type AircraftBodyUniforms, type AircraftFlameUniforms } from './aircraftMaterial';

export const MAX_MESH_AIRCRAFT = 64;

export interface MeshAircraftState {
  elevonL: number;
  elevonR: number;
  rudder: number;
  /** 0 = retracted .. 1 = down. */
  gearPos: number;
  /** 0..1. */
  throttle: number;
  afterburner: boolean;
  airbrakeOut: boolean;
  onGround: boolean;
  /** 0 = friendly, 1 = hostile. */
  team: number;
  /** World velocity, m/s. */
  vel: Readonly<Vec3Like>;
}

/** Slat droop, 0..1, for the velocity in world axes and orientation `rot`. */
export function slatDroopTarget(rot: Readonly<QuatLike>, vel: Readonly<Vec3Like>, onGround: boolean): number {
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  if (onGround || speed < 30) return 0;
  const q = scratchQ.set(rot.x, rot.y, rot.z, rot.w).invert();
  const v = scratchV.set(vel.x, vel.y, vel.z).applyQuaternion(q);
  const alpha = Math.atan2(-v.y, v.x);
  return Math.min(1, Math.max(0, (alpha - (4 * Math.PI) / 180) / ((12 * Math.PI) / 180)));
}

/** Nozzle opening, 0 (closed) .. 1 (afterburner): open at idle, closed at military power. */
export function nozzleTarget(throttle: number, afterburner: boolean): number {
  if (afterburner) return 1;
  return 0.5 * Math.min(1, Math.max(0, (0.8 - throttle) / 0.6));
}

const scratchQ = new THREE.Quaternion();
const scratchV = new THREE.Vector3();

interface PartNode {
  node: THREE.Group;
  part: ArticulatedPart;
  axis: THREE.Vector3;
}

interface Instance {
  root: THREE.Group;
  parts: PartNode[];
  body: THREE.ShaderMaterial & { uniforms: AircraftBodyUniforms };
  flameMat: THREE.ShaderMaterial & { uniforms: AircraftFlameUniforms };
  flame: THREE.Mesh;
  assignedId: number;
  airbrake: number;
  slat: number;
  nozzle: number;
}

const NO_ID = -1;

export interface MeshAircraftRenderer {
  /** Once per frame before updateEntity: frame time, floating origin, camera (absolute world), clock. */
  beginFrame(dtSec: number, originWorld: Readonly<Vec3Like>, cameraWorld: Readonly<Vec3Like>, timeSec: number): void;
  updateEntity(entityId: number, pos: Readonly<Vec3Like>, rot: Readonly<QuatLike>, state: Readonly<MeshAircraftState>, originWorld: Readonly<Vec3Like>): void;
  /** Hides instances not updated this frame. */
  endFrame(): void;
  dispose(): void;
}

/** Moves `cur` towards `target` at up to `rateUp`/`rateDown` per second. */
function approach(cur: number, target: number, rateUp: number, rateDown: number, dt: number): number {
  return target > cur ? Math.min(target, cur + rateUp * dt) : Math.max(target, cur - rateDown * dt);
}

export function createMeshAircraftRenderer(root: THREE.Object3D, template: AircraftModelTemplate, capacity = MAX_MESH_AIRCRAFT): MeshAircraftRenderer {
  const shared = createAircraftSharedUniforms();
  const instances: Instance[] = [];
  const touched = new Uint8Array(capacity);
  let dt = 1 / 60;

  function build(): Instance {
    const group = new THREE.Group();
    group.visible = false;
    const airframe = new THREE.Group();
    airframe.position.x = template.offsetX;
    group.add(airframe);
    const body = createAircraftBodyMaterial(shared, template.nozzleAxisY);
    const bodyMesh = new THREE.Mesh(template.body, body);
    bodyMesh.layers.enable(AIRCRAFT_SHADOW_LAYER);
    airframe.add(bodyMesh);
    const parts: PartNode[] = template.parts.map((part) => {
      const node = new THREE.Group();
      node.name = part.name;
      node.position.set(...part.pivot);
      const mesh = new THREE.Mesh(part.geometry, body);
      mesh.position.set(-part.pivot[0], -part.pivot[1], -part.pivot[2]);
      mesh.layers.enable(AIRCRAFT_SHADOW_LAYER);
      node.add(mesh);
      airframe.add(node);
      return { node, part, axis: new THREE.Vector3(...part.axis) };
    });
    const flameMat = createAircraftFlameMaterial(shared, template.nozzleAxisY);
    flameMat.uniforms.uSeed.value = instances.length * 1.7;
    const flame = new THREE.Mesh(template.flame, flameMat);
    flame.visible = false;
    flame.renderOrder = 1;
    airframe.add(flame);
    root.add(group);
    return { root: group, parts, body, flameMat, flame, assignedId: NO_ID, airbrake: 0, slat: 0, nozzle: 0 };
  }

  return {
    beginFrame(dtSec, origin, cam, timeSec) {
      touched.fill(0);
      dt = dtSec;
      shared.uOrigin.value.set(origin.x, origin.y, origin.z);
      shared.uCamRel.value.set(cam.x - origin.x, cam.y - origin.y, cam.z - origin.z);
      shared.uTime.value = timeSec % 3600;
    },

    updateEntity(entityId, pos, rot, s, origin) {
      let idx = instances.findIndex((i) => i.assignedId === entityId);
      const fresh = idx === -1;
      if (fresh) idx = instances.findIndex((i) => i.assignedId === NO_ID);
      if (idx === -1 && instances.length < capacity) {
        instances.push(build());
        idx = instances.length - 1;
      }
      if (idx === -1) return; // pool exhausted: drop, as the wireframe renderer did.
      const inst = instances[idx]!;
      touched[idx] = 1;

      const brakeTarget = s.airbrakeOut ? 1 : 0;
      const slatTarget = slatDroopTarget(rot, s.vel, s.onGround);
      const nozTarget = nozzleTarget(s.throttle, s.afterburner);
      if (fresh) {
        inst.assignedId = entityId;
        inst.airbrake = brakeTarget;
        inst.slat = slatTarget;
        inst.nozzle = nozTarget;
      } else {
        inst.airbrake = approach(inst.airbrake, brakeTarget, 1 / 1.2, 1 / 1.0, dt);
        inst.slat = approach(inst.slat, slatTarget, 1.5, 1.5, dt);
        inst.nozzle = approach(inst.nozzle, nozTarget, 1.5, 1.0, dt);
      }

      inst.root.visible = true;
      inst.root.position.set(pos.x - origin.x, pos.y - origin.y, pos.z - origin.z);
      inst.root.quaternion.set(rot.x, rot.y, rot.z, rot.w);
      for (const pn of inst.parts) {
        const p = pn.part;
        let angle = 0;
        switch (p.driver) {
          case 'elevonL':
            angle = s.elevonL;
            break;
          case 'elevonR':
            angle = s.elevonR;
            break;
          case 'rudder':
            angle = s.rudder;
            break;
          case 'gear':
            angle = (1 - s.gearPos) * p.travelRad;
            pn.node.visible = s.gearPos > 0.01;
            break;
          case 'slat':
            angle = inst.slat * p.travelRad;
            break;
          case 'airbrake':
            angle = inst.airbrake * p.travelRad;
            break;
        }
        pn.node.quaternion.setFromAxisAngle(pn.axis, angle);
      }
      const u = inst.body.uniforms;
      u.uTeam.value = s.team;
      u.uThrottle.value = s.throttle;
      u.uAB.value = s.afterburner ? 1 : 0;
      u.uNozzle.value = inst.nozzle;
      inst.flame.visible = s.afterburner;
      inst.flameMat.uniforms.uAB.value = s.afterburner ? 1 : 0;
      inst.flameMat.uniforms.uNozzle.value = inst.nozzle;
    },

    endFrame() {
      for (let i = 0; i < instances.length; i++) {
        if (touched[i]) continue;
        instances[i]!.root.visible = false;
        instances[i]!.assignedId = NO_ID;
      }
    },

    dispose() {
      for (const inst of instances) {
        root.remove(inst.root);
        inst.body.dispose();
        inst.flameMat.dispose();
      }
      instances.length = 0;
      template.body.dispose();
      template.flame.dispose();
      for (const p of template.parts) p.geometry.dispose();
    },
  };
}
