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
 * Stores (aircraftModels/stores.ts) hang on the pylons as the snapshot's STORES field says: missiles
 * on single or twin rails (a twin rail's outboard missile stays when one has gone), drop tanks while
 * attached. Missiles in flight are drawn along their velocity. One instanced mesh per store type
 * for every aircraft, so they cost a few draw calls in all.
 * Every mesh also draws into the aircraft sun-shadow cascade (AIRCRAFT_SHADOW_LAYER).
 */
import * as THREE from 'three';
import { StoreRack, storeSlotAt, storeSlotCode, storeSlotCount, storeSlotRack, storeSlotTwin, type QuatLike, type Vec3Like } from '../contracts/core';
import { AIRCRAFT_SHADOW_LAYER } from './sunShadows';
import type { AircraftModelTemplate, ArticulatedPart } from './aircraftModels/tejasModel';
import { buildStoreModels, BOMB_RACK_Z, TWIN_RAIL_FRAMES, type StoreModel } from './aircraftModels/stores';
import { createAircraftLights } from './aircraftLights';
import { EntityFlag } from '../contracts/core';
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
  /** Packed stores (contracts/core.ts STORES / STORES_B layout). */
  stores: number;
  storesB: number;
  /** EntityFlags (exterior lights). */
  flags: number;
  /** Ground height under the aircraft, world metres, when known (for the landing light's pool). */
  groundY?: number;
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
  airframe: THREE.Group;
  landingNode: THREE.Object3D | undefined;
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
  /** A missile in flight: store code (STORE_IDS), pointing along its velocity (else `rot`). */
  updateMissile(code: number, pos: Readonly<Vec3Like>, vel: Readonly<Vec3Like>, rot: Readonly<QuatLike>, originWorld: Readonly<Vec3Like>): void;
  /** The drawing-buffer height (px) and the projection's [1][1] term, for sizing light glows. */
  setViewport(heightPx: number, projection11: number): void;
  /** Hides instances not updated this frame and uploads the stores. */
  endFrame(): void;
  dispose(): void;
}

/** Moves `cur` towards `target` at up to `rateUp`/`rateDown` per second. */
function approach(cur: number, target: number, rateUp: number, rateDown: number, dt: number): number {
  return target > cur ? Math.min(target, cur + rateUp * dt) : Math.max(target, cur - rateDown * dt);
}

/** One instanced mesh drawing every copy of one store (or rail) this frame. */
interface StoreBatch {
  mesh: THREE.InstancedMesh;
  n: number;
}

export function createMeshAircraftRenderer(root: THREE.Object3D, template: AircraftModelTemplate, capacity = MAX_MESH_AIRCRAFT): MeshAircraftRenderer {
  const shared = createAircraftSharedUniforms();
  const instances: Instance[] = [];
  const touched = new Uint8Array(capacity);
  let dt = 1 / 60;

  // Stores: shared material (stores carry no team markings), one batch per model.
  const storeModels = buildStoreModels();
  const storeMat = createAircraftBodyMaterial(shared, template.nozzleAxisY);
  const batch = (geometry: THREE.BufferGeometry, max: number): StoreBatch => {
    const mesh = new THREE.InstancedMesh(geometry, storeMat, max);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.layers.enable(AIRCRAFT_SHADOW_LAYER);
    root.add(mesh);
    return { mesh, n: 0 };
  };
  const storeBatches = storeModels.byCode.map((m) => (m ? batch(m.geometry, m.kind === 'missile' ? 512 : 192) : undefined));
  const railBatch = batch(storeModels.rail, 512);
  const twinBatch = batch(storeModels.twinRail, 256);
  const allBatches = [...storeBatches.filter((b): b is StoreBatch => !!b), railBatch, twinBatch];
  const lights = createAircraftLights(root, template.lights, shared);
  const landingPivot = template.parts.find((p) => p.name === template.landingPart)?.pivot ?? [0, 0, 0];

  /** Each pylon's attach frame in the aircraft's body frame. */
  const pylonFrames = template.pylons.map((p) => new THREE.Matrix4().makeTranslation(p.x + template.offsetX, p.attachY, p.z));
  const mA = new THREE.Matrix4();
  const mB = new THREE.Matrix4();
  const mC = new THREE.Matrix4();
  const qM = new THREE.Quaternion();
  const vDir = new THREE.Vector3();
  const X_AXIS = new THREE.Vector3(1, 0, 0);

  function put(b: StoreBatch | undefined, m: THREE.Matrix4): void {
    if (!b || b.n >= b.mesh.instanceMatrix.count) return;
    b.mesh.setMatrixAt(b.n++, m);
  }

  /** Stores on one aircraft whose body -> render matrix is `body`. */
  function putStores(body: THREE.Matrix4, packedA: number, packedB: number): void {
    for (let k = 0; k < pylonFrames.length; k++) {
      const slot = storeSlotAt(packedA, packedB, k);
      const code = storeSlotCode(slot);
      const model: StoreModel | undefined = storeModels.byCode[code];
      if (!model) continue;
      const count = storeSlotCount(slot);
      mA.multiplyMatrices(body, pylonFrames[k]!);
      if (model.kind === 'tank') {
        if (count > 0) put(storeBatches[code], mB.multiplyMatrices(mA, model.mount));
        continue;
      }
      if (model.kind === 'pod') {
        put(storeBatches[code], mB.multiplyMatrices(mA, model.mount));
        continue;
      }
      if (model.kind === 'bomb') {
        if (storeSlotRack(slot) !== StoreRack.MultiRack) {
          if (count > 0) put(storeBatches[code], mB.multiplyMatrices(mA, model.mount));
          continue;
        }
        // Twin carrier: bombs either side (the outboard one goes last).
        const outboard = template.pylons[k]!.z >= 0 ? 1 : -1;
        for (const side of [-1, 1]) {
          if (count >= 2 || (count === 1 && side === outboard)) {
            mB.makeTranslation(0, 0, side * BOMB_RACK_Z).premultiply(mA);
            put(storeBatches[code], mC.multiplyMatrices(mB, model.mount));
          }
        }
        continue;
      }
      if (!storeSlotTwin(slot)) {
        put(railBatch, mA);
        if (count > 0) put(storeBatches[code], mB.multiplyMatrices(mA, model.mount));
        continue;
      }
      put(twinBatch, mA);
      // Both rails loaded, or only the outboard one (the inboard missile goes first).
      const outboard = template.pylons[k]!.z >= 0 ? 1 : 0;
      for (let side = 0; side < 2; side++) {
        if (count >= 2 || (count === 1 && side === outboard)) {
          mB.multiplyMatrices(mA, TWIN_RAIL_FRAMES[side]!);
          put(storeBatches[code], mC.multiplyMatrices(mB, model.mount));
        }
      }
    }
  }

  function build(): Instance {
    const group = new THREE.Group();
    group.visible = false;
    const airframe = new THREE.Group();
    airframe.position.x = template.offsetX;
    group.add(airframe);
    const body = createAircraftBodyMaterial(shared, template.nozzleAxisY, template.livery);
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
    const flameMat = createAircraftFlameMaterial(shared, template.nozzleAxisY, template.nozzleExitX);
    flameMat.uniforms.uSeed.value = instances.length * 1.7;
    const flame = new THREE.Mesh(template.flame, flameMat);
    flame.visible = false;
    flame.renderOrder = 1;
    airframe.add(flame);
    root.add(group);
    const landingNode = parts.find((p) => p.part.name === template.landingPart)?.node;
    return { root: group, parts, body, flameMat, flame, airframe, landingNode, assignedId: NO_ID, airbrake: 0, slat: 0, nozzle: 0 };
  }

  const camWorld = { x: 0, y: 0, z: 0 };
  const tmpCam = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  return {
    beginFrame(dtSec, origin, cam, timeSec) {
      touched.fill(0);
      for (const b of allBatches) b.n = 0;
      lights.begin(timeSec);
      dt = dtSec;
      shared.uOrigin.value.set(origin.x, origin.y, origin.z);
      shared.uCamRel.value.set(cam.x - origin.x, cam.y - origin.y, cam.z - origin.z);
      shared.uTime.value = timeSec % 3600;
      camWorld.x = cam.x;
      camWorld.y = cam.y;
      camWorld.z = cam.z;
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
      // From inside this aircraft's canopy (the 3D cockpit), its exterior canopy frame isn't drawn.
      tmpCam.set(camWorld.x - pos.x, camWorld.y - pos.y, camWorld.z - pos.z).applyQuaternion(tmpQ.set(-rot.x, -rot.y, -rot.z, rot.w));
      const ci = template.canopyInterior;
      inst.body.uniforms.uInterior.value = tmpCam.x > ci.min[0] && tmpCam.x < ci.max[0] && tmpCam.y > ci.min[1] && tmpCam.y < ci.max[1] && tmpCam.z > ci.min[2] && tmpCam.z < ci.max[2] ? 1 : 0;
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
            pn.node.visible = p.keepVisible === true || s.gearPos > 0.01;
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
      if (s.stores > 0 || s.storesB > 0) {
        inst.root.updateMatrix();
        putStores(inst.root.matrix, s.stores, s.storesB);
      }

      // Exterior lights: the lamps (shader) and their glows, beam and pool (aircraftLights.ts).
      const lightBits = s.flags & (EntityFlag.Lights | EntityFlag.LightsStrobe | EntityFlag.LightsLanding | EntityFlag.LightsFormation);
      let strobe = 0;
      if (lightBits !== 0) {
        inst.root.updateMatrixWorld(true);
        const res = lights.add({
          airframe: inst.airframe.matrixWorld,
          landingPart: (inst.landingNode ?? inst.airframe).matrixWorld,
          landingPivot: inst.landingNode ? landingPivot : [0, 0, 0],
          flags: lightBits,
          gearPos: s.gearPos,
          phase: (entityId % 97) * 0.113,
          ...(s.groundY !== undefined ? { groundY: s.groundY - origin.y } : {}),
        });
        strobe = res.strobe;
      }
      u.uLightState.value.set(
        lightBits & EntityFlag.Lights ? 1 : 0,
        strobe,
        lightBits & EntityFlag.LightsLanding && s.gearPos > 0.9 ? 1 : 0,
        lightBits & EntityFlag.LightsFormation ? 1 : 0
      );
    },

    setViewport(heightPx, projection11) {
      lights.setViewportHeight(heightPx, projection11);
    },

    updateMissile(code, pos, vel, rot, origin) {
      const model = storeModels.byCode[code];
      if (!model || model.kind !== 'missile') return;
      vDir.set(vel.x, vel.y, vel.z);
      if (vDir.lengthSq() > 1) qM.setFromUnitVectors(X_AXIS, vDir.normalize());
      else qM.set(rot.x, rot.y, rot.z, rot.w);
      mA.makeRotationFromQuaternion(qM).setPosition(pos.x - origin.x, pos.y - origin.y, pos.z - origin.z);
      put(storeBatches[code], mA);
    },

    endFrame() {
      lights.end();
      for (const b of allBatches) {
        b.mesh.count = b.n;
        b.mesh.instanceMatrix.needsUpdate = true;
      }
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
      for (const b of allBatches) {
        root.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mesh.dispose();
      }
      storeMat.dispose();
      lights.dispose();
      template.body.dispose();
      template.flame.dispose();
      for (const p of template.parts) p.geometry.dispose();
    },
  };
}
