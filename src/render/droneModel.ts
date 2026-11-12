/**
 * src/render/droneModel.ts — the target drone (Flight School): a jet-powered aerial target in the
 * class of DRDO's Lakshya. About 4.2 m long and 3 m span: a slim orange fuselage with an ogive nose,
 * a swept low wing, a conventional tail and the turbojet slung under the belly. Drawn for aircraft
 * entities flagged EntityFlag.Drone instead of the fighter model.
 *
 * Body frame as the aircraft: +x nose, +y up, +z right. Lit by the scene's sun, with a little
 * emissive for the sky's ambient light (the fighters' material does its own lighting).
 */
import * as THREE from 'three';
import type { QuatLike, Vec3Like } from '../contracts/core';

const MAX_DRONES = 8;

/** A flat, swept, tapered surface (a wing or tail half), thickness `t`, in the x-z plane (z outward). */
function sweptPanel(rootChord: number, tipChord: number, span: number, sweep: number, t: number, side: 1 | -1): THREE.BufferGeometry {
  const s = new THREE.Shape();
  // In shape space: x = chordwise (+ forward), y = spanwise.
  s.moveTo(0, 0);
  s.lineTo(-sweep, span);
  s.lineTo(-sweep - tipChord, span);
  s.lineTo(-rootChord, 0);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false });
  g.translate(0, 0, -t / 2);
  // Shape y -> body z (outward), shape z (thickness) -> body y.
  g.rotateX(side === 1 ? Math.PI / 2 : -Math.PI / 2);
  return g;
}

/** A vertical fin: like sweptPanel, standing up (+y). */
function fin(rootChord: number, tipChord: number, height: number, sweep: number, t: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(-sweep, height);
  s.lineTo(-sweep - tipChord, height);
  s.lineTo(-rootChord, 0);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false });
  g.translate(0, 0, -t / 2);
  return g;
}

export function buildDroneGroup(): THREE.Group {
  const orange = new THREE.MeshLambertMaterial({ color: 0xe0521c, emissive: 0x5a1e08 });
  const white = new THREE.MeshLambertMaterial({ color: 0xe8ebee, emissive: 0x3a3c40 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x2b2f33, emissive: 0x0c0d0e });
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  // Fuselage: a cylinder along x (radius 0.24), ogive nose, tapered tail cone.
  const R = 0.24;
  add(new THREE.CylinderGeometry(R, R, 2.6, 16).rotateZ(-Math.PI / 2), orange, 0.1, 0, 0);
  add(new THREE.ConeGeometry(R, 0.9, 16).rotateZ(-Math.PI / 2), white, 1.85, 0, 0);
  add(new THREE.CylinderGeometry(R, 0.12, 0.8, 16).rotateZ(-Math.PI / 2), orange, -1.6, 0, 0);
  // Wing: low-mounted, swept, white tips.
  for (const side of [1, -1] as const) {
    add(sweptPanel(1.0, 0.45, 1.25, 0.55, 0.06, side), orange, 0.55, -0.12, side * R * 0.8);
    add(sweptPanel(0.45, 0.35, 0.28, 0.12, 0.065, side), white, 0, -0.12, side * (R * 0.8 + 1.25 - 0.02));
    // Tailplane.
    add(sweptPanel(0.5, 0.28, 0.6, 0.3, 0.04, side), orange, -1.35, 0.02, side * 0.12);
  }
  // Fin.
  add(fin(0.7, 0.32, 0.65, 0.45, 0.05), orange, -1.25, R * 0.7, 0);
  // Belly turbojet pod and its intake / nozzle.
  add(new THREE.CylinderGeometry(0.16, 0.16, 1.3, 14).rotateZ(-Math.PI / 2), white, -0.55, -R - 0.12, 0);
  add(new THREE.CylinderGeometry(0.17, 0.12, 0.12, 14).rotateZ(-Math.PI / 2), dark, 0.15, -R - 0.12, 0);
  add(new THREE.CylinderGeometry(0.12, 0.1, 0.16, 14).rotateZ(-Math.PI / 2), dark, -1.25, -R - 0.12, 0);
  // Wingtip pods (scoring / tracking flares on the real thing).
  for (const side of [1, -1]) add(new THREE.CylinderGeometry(0.05, 0.05, 0.6, 8).rotateZ(-Math.PI / 2), dark, -0.1, -0.12, side * (R * 0.8 + 1.25));
  g.traverse((o) => {
    o.frustumCulled = false;
  });
  return g;
}

export interface DroneRenderer {
  beginFrame(): void;
  update(entityId: number, pos: Readonly<Vec3Like>, rot: Readonly<QuatLike>, originWorld: Readonly<Vec3Like>): void;
  endFrame(): void;
  dispose(): void;
}

export function createDroneRenderer(root: THREE.Object3D): DroneRenderer {
  const pool: { id: number; group: THREE.Group; used: boolean }[] = [];
  return {
    beginFrame() {
      for (const p of pool) p.used = false;
    },
    update(entityId, pos, rot, origin) {
      let p = pool.find((x) => x.id === entityId) ?? pool.find((x) => x.id === -1 && !x.used);
      if (!p) {
        if (pool.length >= MAX_DRONES) return;
        p = { id: -1, group: buildDroneGroup(), used: false };
        root.add(p.group);
        pool.push(p);
      }
      p.id = entityId;
      p.used = true;
      p.group.visible = true;
      p.group.position.set(pos.x - origin.x, pos.y - origin.y, pos.z - origin.z);
      p.group.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    },
    endFrame() {
      for (const p of pool) {
        if (p.used) continue;
        p.id = -1;
        p.group.visible = false;
      }
    },
    dispose() {
      for (const p of pool) {
        root.remove(p.group);
        p.group.traverse((o) => {
          if (o instanceof THREE.Mesh) o.geometry.dispose();
        });
      }
      pool.length = 0;
    },
  };
}
