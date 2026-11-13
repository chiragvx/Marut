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
 * Condensation in humid air (vapour.ts): the wing vapour sheet and tip trails in hard pulls, the
 * vapour cone near Mach 1, from each jet's own speed, height and angle of attack.
 */
import * as THREE from 'three';
import { StoreRack, storeSlotAt, storeSlotCode, storeSlotCount, storeSlotRack, storeSlotTwin, type QuatLike, type Vec3Like } from '../contracts/core';
import { AIRCRAFT_SHADOW_LAYER } from './sunShadows';
import type { AircraftModelTemplate, ArticulatedPart } from './aircraftModels/tejasModel';
import { buildStoreModels, BOMB_RACK_Z, TWIN_RAIL_FRAMES, type StoreModel } from './aircraftModels/stores';
import { createAircraftLights } from './aircraftLights';
import { buildShockConeGeometry, buildVapourConeGeometry, buildVapourWingGeometry, createVapourDrive, DEV_VAPOUR_FORCE, createVapourMeshes, createVapourTrails, vapourDrive, type VapourMeshes } from './vapour';
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

/** Nosewheel steering limit, rad, and the rudder's full deflection, rad (aircraft/tejasGeometry.ts
 *  gear 'nose' maxSteerAngleRad and controls maxRudderRad: the pedals drive both). */
const NOSE_STEER_MAX_RAD = 0.5236;
const RUDDER_MAX_RAD = 0.349066;
/** Steering authority fades with ground speed as in physics/landingGear.ts nwsAuthority (contracts/flight.ts NWS_*). */
const NWS_FULL_BELOW_MPS = 8;
const NWS_MIN_ABOVE_MPS = 45;
const NWS_MIN_FRAC = 0.2;
/** Oleo travel drawn: extension below the modelled (static) pose with no weight on the wheel, and compression above it, m. */
export const OLEO_EXTEND_M = 0.06;
export const OLEO_COMPRESS_M = 0.2;

/**
 * Nosewheel angle, rad (+ = wheel turned left, about the leg's upward axis), from the rudder's
 * deflection (pedals) on the ground; centred in the air. Same authority taper as the physics.
 */
export function noseSteerTarget(rudderRad: number, groundSpeedMps: number, onGround: boolean, gearPos: number): number {
  if (!onGround || gearPos < 0.99) return 0;
  const t = Math.min(1, Math.max(0, (groundSpeedMps - NWS_FULL_BELOW_MPS) / (NWS_MIN_ABOVE_MPS - NWS_FULL_BELOW_MPS)));
  const authority = 1 - t * (1 - NWS_MIN_FRAC);
  const cmd = Math.max(-1, Math.min(1, rudderRad / RUDDER_MAX_RAD));
  return cmd * NOSE_STEER_MAX_RAD * authority;
}

/**
 * Oleo slide up the leg, m (+ = compressed above the modelled pose), so the tyre sits on the ground:
 * how far the uncompressed tyre's bottom would be below the ground. With the gear moving or no
 * ground known, fully extended in the air and the modelled pose on the ground.
 */
export function oleoTarget(tyreBottomY: number, groundY: number | undefined, onGround: boolean, gearPos: number): number {
  if (gearPos < 0.99) return -OLEO_EXTEND_M;
  if (groundY === undefined) return onGround ? 0 : -OLEO_EXTEND_M;
  return Math.max(-OLEO_EXTEND_M, Math.min(OLEO_COMPRESS_M, groundY - tyreBottomY));
}

const scratchQ = new THREE.Quaternion();
const scratchV = new THREE.Vector3();
const scratchV2 = new THREE.Vector3();
const scratchV3 = new THREE.Vector3();
const scratchM = new THREE.Matrix4();
const scratchM2 = new THREE.Matrix4();

interface PartNode {
  node: THREE.Group;
  part: ArticulatedPart;
  axis: THREE.Vector3;
  /** Oleo: the node's position in its parent with the strut at the modelled pose. */
  base?: THREE.Vector3;
  /** Brace: the part carrying its far end, the anchor, the line to the end (gear down) and its length. */
  follows?: PartNode;
  anchor?: THREE.Vector3;
  dir0?: THREE.Vector3;
  len0?: number;
  /** Oleo: the tyre's bottom (body frame, modelled pose), from the wheel riding on it. */
  tyreBottom?: THREE.Vector3;
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
  /** Wheels: ground distance rolled (m) and the current rolling speed (m/s; spins down in the air). */
  rolled: number;
  rollSpeed: number;
  /** Nosewheel angle (rad) and oleo slide per leg (m), smoothed. */
  steer: number;
  oleo: Record<string, number>;
  /** Condensation: the wing veil and cone, and the smoothed strength of each form. */
  vapour: VapourMeshes;
  vapWing: number;
  vapTip: number;
  vapCone: number;
}

const NO_ID = -1;

export interface MeshAircraftRenderer {
  /** Once per frame before updateEntity: frame time, floating origin, camera (absolute world), clock. */
  beginFrame(dtSec: number, originWorld: Readonly<Vec3Like>, cameraWorld: Readonly<Vec3Like>, timeSec: number): void;
  updateEntity(entityId: number, pos: Readonly<Vec3Like>, rot: Readonly<QuatLike>, state: Readonly<MeshAircraftState>, originWorld: Readonly<Vec3Like>): void;
  /** A missile or bomb in flight: store code (STORE_IDS), pointing along its velocity (else `rot`). */
  updateMissile(code: number, pos: Readonly<Vec3Like>, vel: Readonly<Vec3Like>, rot: Readonly<QuatLike>, originWorld: Readonly<Vec3Like>, flags?: number): void;
  /** A store falling free (a jettisoned tank): store code (STORE_IDS) at its own attitude `rot`, centred on `pos`. */
  updateStore(code: number, pos: Readonly<Vec3Like>, rot: Readonly<QuatLike>, originWorld: Readonly<Vec3Like>): void;
  /** The drawing-buffer height (px) and the projection's [1][1] term, for sizing light glows. */
  setViewport(heightPx: number, projection11: number): void;
  /** How humid the air is, 0..1 (vapour.ts airHumidity). */
  setHumidity(h: number): void;
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
  const balluteBatches = storeModels.byCode.map((m) => (m?.ballute ? batch(m.ballute, 48) : undefined));
  const openBatches = storeModels.byCode.map((m) => (m?.bodyOpen ? batch(m.bodyOpen, 48) : undefined));
  const allBatches = [...storeBatches, ...balluteBatches, ...openBatches].filter((b): b is StoreBatch => !!b).concat(railBatch, twinBatch);
  const lights = createAircraftLights(root, template.lights, shared);
  // Lamps light the skin round them (the shader works in the model's own frame, as LIGHTS are).
  const lampPositions = template.lights;
  const landingPivot = template.parts.find((p) => p.name === template.landingPart)?.pivot ?? [0, 0, 0];
  const vapourWingGeom = template.vapourWing ? buildVapourWingGeometry(template.vapourWing) : undefined;
  const vapourConeGeom = template.vapourCone ? buildVapourConeGeometry(template.vapourCone) : undefined;
  const shockConeGeom = buildShockConeGeometry();
  const vapourTrails = createVapourTrails(root, shared);
  const vapourTip = template.vapourWing?.tipTe;
  const drive = createVapourDrive();
  const vapourNow = { wing: 0, tip: 0, cone: 0, loadFactor: 0, mach: 0 };
  const tipW = new THREE.Vector3();
  const tipQ = new THREE.Quaternion();
  let humidity = 0.45;

  /** Each pylon's attach frame in the aircraft's body frame. */
  const pylonFrames = [
    ...template.pylons.map((p) => new THREE.Matrix4().makeTranslation(p.x + template.offsetX, p.attachY, p.z)),
    ...(template.podMounts ?? []).map(([x, y, z]) => new THREE.Matrix4().makeTranslation(x + template.offsetX, y, z)),
  ];
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
    const body = createAircraftBodyMaterial(shared, template.nozzleAxisY, template.livery, template.textures, template.textures ? template.nozzleExitX + 0.7 : -1e9, lampPositions);
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
    // Parts that ride on another (wheels on their legs): placed in the parent's hinge frame.
    for (const pn of parts) {
      const parentName = pn.part.parent;
      const parent = parentName ? parts.find((q) => q.part.name === parentName) : undefined;
      if (!parent) continue;
      const pp = parent.part.pivot;
      pn.node.position.set(pn.part.pivot[0] - pp[0], pn.part.pivot[1] - pp[1], pn.part.pivot[2] - pp[2]);
      parent.node.add(pn.node);
    }
    for (const pn of parts) {
      if (pn.part.driver === 'oleo') {
        pn.base = pn.node.position.clone();
        // The tyre bottom: the lowest point of the wheel riding on this leg (axle centre less its radius).
        const wheel = parts.find((q) => q.part.parent === pn.part.name && q.part.driver === 'wheel');
        const wp = wheel?.part.pivot ?? pn.part.pivot;
        pn.tyreBottom = new THREE.Vector3(wp[0] + template.offsetX, wp[1] - (wheel?.part.radiusM ?? 0), wp[2]);
      }
      if (pn.part.driver === 'brace' && pn.part.follows && pn.part.target) {
        pn.follows = parts.find((q) => q.part.name === pn.part.follows);
        pn.anchor = new THREE.Vector3(...pn.part.pivot);
        pn.dir0 = new THREE.Vector3(...pn.part.target).sub(pn.anchor);
        pn.len0 = pn.dir0.length();
        pn.dir0.normalize();
        pn.node.matrixAutoUpdate = false;
      }
    }
    const flameMat = createAircraftFlameMaterial(shared, template.nozzleAxisY, template.nozzleExitX);
    flameMat.uniforms.uSeed.value = instances.length * 1.7;
    const flame = new THREE.Mesh(template.flame, flameMat);
    flame.visible = false;
    flame.renderOrder = 1;
    airframe.add(flame);
    root.add(group);
    const landingNode = parts.find((p) => p.part.name === template.landingPart)?.node;
    const vapour = createVapourMeshes(airframe, vapourWingGeom, vapourConeGeom, shared, shockConeGeom);
    return { root: group, parts, body, flameMat, flame, airframe, landingNode, assignedId: NO_ID, airbrake: 0, slat: 0, nozzle: 0, rolled: 0, rollSpeed: 0, steer: 0, oleo: {}, vapour, vapWing: 0, vapTip: 0, vapCone: 0 };
  }

  const camWorld = { x: 0, y: 0, z: 0 };
  const tmpCam = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  return {
    beginFrame(dtSec, origin, cam, timeSec) {
      touched.fill(0);
      for (const b of allBatches) b.n = 0;
      lights.begin(timeSec);
      vapourTrails.begin(timeSec, origin, cam);
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
      // Wheels roll with the ground speed; airborne they spin down (brakes on retraction) in ~3 s.
      const groundSpeed = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
      inst.rollSpeed = s.onGround ? groundSpeed : Math.max(0, inst.rollSpeed - Math.max(15, inst.rollSpeed * 0.8) * dt);
      inst.rolled = (inst.rolled + inst.rollSpeed * dt) % 10000;
      // Nosewheel steering follows the pedals; the oleos follow the ground (smoothed: ~60 ms).
      const kSmooth = fresh ? 1 : 1 - Math.exp(-dt / 0.06);
      inst.steer += (noseSteerTarget(s.rudder, Math.hypot(s.vel.x, s.vel.z), s.onGround, s.gearPos) - inst.steer) * kSmooth;

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
          case 'gear': {
            const r = 1 - s.gearPos;
            const w = p.travelWindow;
            const f = w ? Math.min(1, Math.max(0, (r - w[0]) / (w[1] - w[0]))) : r;
            angle = f * p.travelRad;
            // Legs are hidden once folded away (doors stay, closed over the bays).
            pn.node.visible = p.keepVisible === true || f < 0.99;
            break;
          }
          case 'wheel':
            // Rolling forwards turns the top of the wheel forwards: negative about the (+z) axle.
            angle = -((inst.rolled / (p.radiusM ?? 0.3)) % (2 * Math.PI));
            break;
          case 'slat':
            angle = inst.slat * p.travelRad;
            break;
          case 'airbrake':
            angle = inst.airbrake * p.travelRad;
            break;
          case 'oleo': {
            // Slides up the leg as the strut takes the weight; the nose leg also steers about it.
            const tb = pn.tyreBottom!;
            scratchQ.set(rot.x, rot.y, rot.z, rot.w);
            const tyreY = pos.y + scratchV.copy(tb).applyQuaternion(scratchQ).y;
            const key = p.leg ?? p.name;
            const prev = inst.oleo[key] ?? 0;
            const target = oleoTarget(tyreY, s.groundY, s.onGround, s.gearPos);
            const slide = fresh ? target : prev + (target - prev) * kSmooth;
            inst.oleo[key] = slide;
            pn.node.position.copy(pn.base!).addScaledVector(pn.axis, slide);
            angle = p.steer ? inst.steer : 0;
            break;
          }
          case 'brace':
            continue;
        }
        pn.node.quaternion.setFromAxisAngle(pn.axis, angle);
      }
      // Braces (the nose leg's retraction jack and drag struts): pinned at the anchor, aimed at their
      // end on the leg, stretched along their line as the leg swings (the jack extending).
      for (const pn of inst.parts) {
        if (pn.part.driver !== 'brace' || !pn.follows) continue;
        const fp = pn.follows.part;
        scratchV.set(...fp.pivot);
        // The end, carried round the followed part's hinge (its node is in the airframe frame, as is this one).
        scratchV2.set(...pn.part.target!).sub(scratchV).applyQuaternion(pn.follows.node.quaternion).add(scratchV).sub(pn.anchor!);
        const len = scratchV2.length();
        scratchV2.divideScalar(len || 1);
        scratchQ.setFromUnitVectors(pn.dir0!, scratchV2);
        // M = T(anchor) R S(dir0, len/len0); the mesh inside already carries T(-anchor).
        const k = len / pn.len0! - 1;
        const d = pn.dir0!;
        scratchM.set(1 + k * d.x * d.x, k * d.x * d.y, k * d.x * d.z, 0, k * d.y * d.x, 1 + k * d.y * d.y, k * d.y * d.z, 0, k * d.z * d.x, k * d.z * d.y, 1 + k * d.z * d.z, 0, 0, 0, 0, 1);
        scratchM2.makeRotationFromQuaternion(scratchQ).multiply(scratchM);
        scratchM2.setPosition(pn.anchor!);
        pn.node.matrix.copy(scratchM2);
        pn.node.visible = pn.follows.node.visible;
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

      // Condensation (vapour.ts): builds quickly as the pull comes on, clears a little slower.
      vapourDrive(pos.y, s.vel, rot, humidity, s.onGround, drive);
      if (DEV_VAPOUR_FORCE) {
        drive.wing = DEV_VAPOUR_FORCE[0] ?? 0;
        drive.tip = DEV_VAPOUR_FORCE[1] ?? 0;
        drive.cone = DEV_VAPOUR_FORCE[2] ?? 0;
      }
      if (fresh) {
        inst.vapWing = drive.wing;
        inst.vapTip = drive.tip;
        inst.vapCone = drive.cone;
      } else {
        inst.vapWing = approach(inst.vapWing, drive.wing, 5, 2.5, dt);
        inst.vapTip = approach(inst.vapTip, drive.tip, 6, 3, dt);
        inst.vapCone = approach(inst.vapCone, drive.cone, 4, 3, dt);
      }
      vapourNow.wing = inst.vapWing;
      vapourNow.tip = inst.vapTip;
      vapourNow.cone = inst.vapCone;
      vapourNow.mach = drive.mach;
      inst.vapour.set(vapourNow, Math.hypot(s.vel.x, s.vel.y, s.vel.z));
      if (vapourTip) {
        tipQ.set(rot.x, rot.y, rot.z, rot.w);
        for (const side of [1, -1]) {
          tipW.set(vapourTip[0] + template.offsetX, vapourTip[1], side * vapourTip[2]).applyQuaternion(tipQ);
          tipW.x += pos.x;
          tipW.y += pos.y;
          tipW.z += pos.z;
          vapourTrails.emit(entityId * 2 + (side > 0 ? 1 : 0), tipW, inst.vapTip);
        }
      }
    },

    setViewport(heightPx, projection11) {
      lights.setViewportHeight(heightPx, projection11);
    },

    updateMissile(code, pos, vel, rot, origin, flags = 0) {
      const model = storeModels.byCode[code];
      // Missiles and bombs (incl. guided and glide bombs) fly as missile entities; rocket pods stay on the pylon.
      if (!model || (model.kind !== 'missile' && model.kind !== 'bomb')) return;
      if (model.kind === 'bomb') {
        // Bombs fly at their own attitude (free-fall bombs are rigid bodies: the release wobble).
        qM.set(rot.x, rot.y, rot.z, rot.w);
      } else {
        vDir.set(vel.x, vel.y, vel.z);
        if (vDir.lengthSq() > 1) qM.setFromUnitVectors(X_AXIS, vDir.normalize());
        else qM.set(rot.x, rot.y, rot.z, rot.w);
      }
      mA.makeRotationFromQuaternion(qM).setPosition(pos.x - origin.x, pos.y - origin.y, pos.z - origin.z);
      const open = (flags & EntityFlag.TailOpen) !== 0;
      // A tail that opens (Snakeye blades) swaps the body; a ballute is drawn behind it.
      put(open && openBatches[code] ? openBatches[code] : storeBatches[code], mA);
      if (open) put(balluteBatches[code], mA);
    },

    updateStore(code, pos, rot, origin) {
      if (!storeModels.byCode[code]) return;
      qM.set(rot.x, rot.y, rot.z, rot.w);
      mA.makeRotationFromQuaternion(qM).setPosition(pos.x - origin.x, pos.y - origin.y, pos.z - origin.z);
      put(storeBatches[code], mA);
    },

    setHumidity(h) {
      humidity = h;
    },

    endFrame() {
      lights.end();
      vapourTrails.end();
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
        inst.vapour.dispose();
      }
      instances.length = 0;
      for (const b of allBatches) {
        root.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mesh.dispose();
      }
      storeMat.dispose();
      lights.dispose();
      vapourTrails.dispose();
      vapourWingGeom?.dispose();
      vapourConeGeom?.dispose();
      shockConeGeom.dispose();
      template.body.dispose();
      template.flame.dispose();
      for (const p of template.parts) p.geometry.dispose();
    },
  };
}
