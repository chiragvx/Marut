/**
 * terrain-lab/src/airports.ts — draws the Himalaya airports from the game's own layout JSON
 * (src/airport/layouts/*.json): runway quads with centreline dashes and threshold bars, taxiway
 * strips, apron polygons and plain boxes for the structures. Everything sits a little above the
 * level pads (the lab uses a logarithmic depth buffer, so 0.4 m is enough).
 */
import * as THREE from 'three';
import ngari from '../../src/airport/layouts/ngari-gunsa.json';
import simikot from '../../src/airport/layouts/simikot.json';
import fukche from '../../src/airport/layouts/fukche-alg.json';

interface P { worldX: number; worldZ: number }
interface Layout {
  id: string; elevationM: number;
  runways: { id: string; thresholdWorldX: number; thresholdWorldZ: number; headingRad: number; lengthM: number; widthM: number; reciprocalId?: string }[];
  taxiways: { widthM: number; points: P[] }[];
  aprons: { points: P[] }[];
  structures?: { worldX: number; worldZ: number; headingRad: number; widthM: number; lengthM: number; heightM: number }[];
}

export const LAB_AIRPORTS = [ngari, simikot, fukche] as unknown as Layout[];

const LIFT = 0.4;
const ASPHALT = new THREE.MeshBasicMaterial({ color: 0x3a3a3c });
const TAXI = new THREE.MeshBasicMaterial({ color: 0x47474a });
const APRON = new THREE.MeshBasicMaterial({ color: 0x5a5856, side: THREE.DoubleSide });
const PAINT = new THREE.MeshBasicMaterial({ color: 0xe8e8e2 });
const BOX = new THREE.MeshLambertMaterial({ color: 0x9a8f80 });

/** A flat quad centred at (x, z), `len` along heading h (world convention: forward = (sin h, -cos h)), `wid` across. */
function quad(x: number, y: number, z: number, h: number, len: number, wid: number, mat: THREE.Material): THREE.Mesh {
  const g = new THREE.PlaneGeometry(wid, len);
  g.rotateX(-Math.PI / 2); // plane now in xz, its "len" along -z
  const m = new THREE.Mesh(g, mat);
  m.position.set(x, y, z);
  m.rotation.y = -h; // turn -z (heading 0 = north) to heading h
  return m;
}

export function buildAirports(withLights: THREE.Light | null = null): THREE.Group {
  const grp = new THREE.Group();
  if (withLights) grp.add(withLights);
  for (const L of LAB_AIRPORTS) {
    const y = L.elevationM + LIFT;
    const done = new Set<string>();
    for (const r of L.runways) {
      if (done.has(r.id)) continue;
      done.add(r.id);
      if (r.reciprocalId) done.add(r.reciprocalId);
      const fx = Math.sin(r.headingRad), fz = -Math.cos(r.headingRad);
      const at = (d: number): [number, number] => [r.thresholdWorldX + fx * d, r.thresholdWorldZ + fz * d];
      const [mx, mz] = at(r.lengthM / 2);
      grp.add(quad(mx, y, mz, r.headingRad, r.lengthM, r.widthM, ASPHALT));
      // Centreline dashes (30 m on, 20 m off) and threshold bars at both ends.
      for (let d = 60; d + 30 < r.lengthM - 60; d += 50) {
        const [x, z] = at(d + 15);
        grp.add(quad(x, y + 0.05, z, r.headingRad, 30, Math.max(0.6, r.widthM * 0.02), PAINT));
      }
      for (const d of [6, r.lengthM - 6]) {
        const [x, z] = at(d);
        grp.add(quad(x, y + 0.05, z, r.headingRad, 3, r.widthM * 0.9, PAINT));
      }
    }
    for (const t of L.taxiways) {
      for (let i = 0; i + 1 < t.points.length; i++) {
        const a = t.points[i], b = t.points[i + 1];
        const dx = b.worldX - a.worldX, dz = b.worldZ - a.worldZ, len = Math.hypot(dx, dz);
        if (len < 0.1) continue;
        grp.add(quad((a.worldX + b.worldX) / 2, y - 0.1, (a.worldZ + b.worldZ) / 2, Math.atan2(dx, -dz), len, t.widthM, TAXI));
      }
      for (const p of t.points) {
        const g = new THREE.CircleGeometry(t.widthM / 2, 16);
        g.rotateX(-Math.PI / 2);
        const m = new THREE.Mesh(g, TAXI);
        m.position.set(p.worldX, y - 0.1, p.worldZ);
        grp.add(m);
      }
    }
    for (const a of L.aprons) {
      // Shape in (x, -z) so that rotating -90 deg about x puts it back on (x, z).
      const s = new THREE.Shape(a.points.map((p) => new THREE.Vector2(p.worldX, -p.worldZ)));
      const g = new THREE.ShapeGeometry(s);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, APRON);
      m.position.y = y - 0.2;
      grp.add(m);
    }
    for (const s of L.structures ?? []) {
      const g = new THREE.BoxGeometry(s.widthM, s.heightM, s.lengthM);
      const m = new THREE.Mesh(g, BOX);
      m.position.set(s.worldX, L.elevationM + s.heightM / 2, s.worldZ);
      m.rotation.y = -s.headingRad;
      grp.add(m);
    }
  }
  return grp;
}
