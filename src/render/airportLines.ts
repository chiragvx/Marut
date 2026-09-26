/**
 * src/render/airportLines.ts
 *
 * Runway rectangle + ILS localiser/glideslope guide-line geometry built from
 * AirportNavDb. 08-render.md section 4.13. Built once at `setNavDb` time,
 * never rebuilt per-frame; only the containing group's position is updated
 * every frame for the floating origin (section 4.3).
 */

import * as THREE from 'three';
import type { AirportNavDb, RunwayInfo, Vec3Like } from '../contracts/core';

/** Table 5.6. Length of the ILS approach guide-line cue drawn from each antenna origin. */
export const ILS_GUIDE_LINE_LENGTH_M = 3000;

function forwardWorld(headingRad: number): Vec3Like {
  return { x: Math.sin(headingRad), y: 0, z: -Math.cos(headingRad) };
}

function pushEdge(verts: number[], a: Readonly<Vec3Like>, b: Readonly<Vec3Like>): void {
  verts.push(a.x, a.y, a.z, b.x, b.y, b.z);
}

function buildRunway(runway: RunwayInfo, verts: number[]): void {
  const halfWidth = runway.widthM / 2;
  const fwd = forwardWorld(runway.headingRad);
  const p0 = runway.thresholdPos;
  const p1: Vec3Like = { x: p0.x + fwd.x * runway.lengthM, y: p0.y + fwd.y * runway.lengthM, z: p0.z + fwd.z * runway.lengthM };
  const leftDir: Vec3Like = { x: Math.cos(runway.headingRad), y: 0, z: Math.sin(runway.headingRad) };

  const r0: Vec3Like = { x: p0.x - leftDir.x * halfWidth, y: p0.y, z: p0.z - leftDir.z * halfWidth };
  const r1: Vec3Like = { x: p0.x + leftDir.x * halfWidth, y: p0.y, z: p0.z + leftDir.z * halfWidth };
  const r2: Vec3Like = { x: p1.x + leftDir.x * halfWidth, y: p1.y, z: p1.z + leftDir.z * halfWidth };
  const r3: Vec3Like = { x: p1.x - leftDir.x * halfWidth, y: p1.y, z: p1.z - leftDir.z * halfWidth };

  pushEdge(verts, r0, r1);
  pushEdge(verts, r1, r2);
  pushEdge(verts, r2, r3);
  pushEdge(verts, r3, r0);
  pushEdge(verts, p0, p1);

  if (runway.ils) {
    const ils = runway.ils;
    const locFwd = forwardWorld(ils.localiserHeadingRad);
    const locEnd: Vec3Like = {
      x: ils.localiserOriginPos.x - locFwd.x * ILS_GUIDE_LINE_LENGTH_M,
      y: ils.localiserOriginPos.y,
      z: ils.localiserOriginPos.z - locFwd.z * ILS_GUIDE_LINE_LENGTH_M,
    };
    pushEdge(verts, ils.localiserOriginPos, locEnd);

    const gsEnd: Vec3Like = {
      x: ils.glideslopeOriginPos.x - locFwd.x * ILS_GUIDE_LINE_LENGTH_M,
      y: ils.glideslopeOriginPos.y,
      z: ils.glideslopeOriginPos.z - locFwd.z * ILS_GUIDE_LINE_LENGTH_M,
    };
    pushEdge(verts, ils.glideslopeOriginPos, gsEnd);
  }
}

export interface AirportLinesSystem {
  setNavDb(navDb: AirportNavDb): void;
  updateOrigin(originWorld: Readonly<Vec3Like>): void;
  /** Dims the (unlit) runway outline with the daylight, 0..1. */
  setBrightness(b: number): void;
  dispose(): void;
}

export function createAirportLinesSystem(root: THREE.Object3D): AirportLinesSystem {
  const material = new THREE.LineBasicMaterial({ color: 0xffffff });
  let group: THREE.Group | null = null;
  let lineSegments: THREE.LineSegments | null = null;

  return {
    setNavDb(navDb) {
      if (group) {
        root.remove(group);
      }
      if (lineSegments) {
        lineSegments.geometry.dispose();
      }

      const verts: number[] = [];
      for (const airport of navDb.listAirports()) {
        for (const runway of airport.runways) buildRunway(runway, verts);
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
      lineSegments = new THREE.LineSegments(geometry, material);
      lineSegments.frustumCulled = false;
      lineSegments.matrixAutoUpdate = false;

      group = new THREE.Group();
      group.add(lineSegments);
      root.add(group);
    },

    setBrightness(b) {
      material.color.setScalar(b);
    },

    updateOrigin(originWorld) {
      if (!group) return;
      group.position.set(-originWorld.x, -originWorld.y, -originWorld.z);
      group.updateMatrix();
    },

    dispose() {
      if (group) root.remove(group);
      if (lineSegments) lineSegments.geometry.dispose();
      material.dispose();
      group = null;
      lineSegments = null;
    },
  };
}
