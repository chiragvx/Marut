import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildTejasTestModel, LAYOUT_TO_BODY_X, PYLONS, wingAreaM2, type ArticulatedPart } from '../../src/render/aircraftModels/tejasTestModel';
import { nozzleTarget, slatDroopTarget } from '../../src/render/meshAircraftRenderer';
import { gear, stations, wingAreaM2 as dataWingArea, wingSpanM } from '../../src/aircraft/tejasGeometry';

const model = buildTejasTestModel();
const part = (name: string): ArticulatedPart => model.parts.find((p) => p.name === name)!;

function bbox(g: THREE.BufferGeometry): THREE.Box3 {
  g.computeBoundingBox();
  return g.boundingBox!;
}

/** Mean position of the lowest vertices (within 2 cm), layout frame. */
function lowest(g: THREE.BufferGeometry): THREE.Vector3 {
  const p = g.getAttribute('position');
  let minY = Infinity;
  for (let i = 0; i < p.count; i++) minY = Math.min(minY, p.getY(i));
  const s = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < minY + 0.02) {
      s.add(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)));
      n++;
    }
  }
  return s.divideScalar(n);
}

/** Rotates a layout point about a part's hinge by `angle`. */
function hinge(pt: THREE.Vector3, p: ArticulatedPart, angle: number): THREE.Vector3 {
  const pivot = new THREE.Vector3(...p.pivot);
  return pt.clone().sub(pivot).applyAxisAngle(new THREE.Vector3(...p.axis), angle).add(pivot);
}

describe('tejasTestModel: public Tejas dimensions', () => {
  const b = bbox(model.body);

  it('is 13.2 m long, pitot to nozzle', () => {
    expect(b.max.x - b.min.x).toBeCloseTo(13.2, 1);
  });

  it('spans 8.2 m (the data file agrees)', () => {
    expect(b.max.z - b.min.z).toBeGreaterThan(wingSpanM - 0.01);
    expect(b.max.z - b.min.z).toBeLessThan(wingSpanM + 0.06);
  });

  it('stands 4.4 m tall, ground to fin tip, gear down', () => {
    const contactY = gear[0]!.posBodyM.y;
    expect(b.max.y - contactY).toBeCloseTo(4.4, 1);
  });

  it('has the 38.4 m^2 reference wing area', () => {
    expect(wingAreaM2()).toBeCloseTo(dataWingArea, 1);
  });

  it('has finite geometry everywhere', () => {
    for (const g of [model.body, model.flame, ...model.parts.map((p) => p.geometry)]) {
      const a = g.getAttribute('position').array as Float32Array;
      expect(a.every(Number.isFinite)).toBe(true);
    }
  });
});

describe('tejasTestModel: matches src/aircraft', () => {
  it('puts each wheel on its gear leg, just above the fully extended contact point (static squat)', () => {
    const legs: [string, string][] = [
      ['noseGear', 'nose'],
      ['mainGearL', 'mainLeft'],
      ['mainGearR', 'mainRight'],
    ];
    for (const [name, id] of legs) {
      const w = lowest(part(name).geometry);
      const leg = gear.find((g) => g.id === id)!;
      expect(Math.abs(w.x + LAYOUT_TO_BODY_X - leg.posBodyM.x)).toBeLessThan(0.05);
      expect(Math.abs(w.z - leg.posBodyM.z)).toBeLessThan(0.05);
      const squat = w.y - leg.posBodyM.y;
      expect(squat).toBeGreaterThan(0.03);
      expect(squat).toBeLessThan(0.12);
    }
  });

  it('has a pylon under every wing and centreline station', () => {
    const pylonStations = stations.filter((s) => s.id.startsWith('wing-') || s.id === 'centreline');
    expect(pylonStations.length).toBe(PYLONS.length);
    for (const s of pylonStations) {
      const p = PYLONS.find((q) => Math.abs(q.x + LAYOUT_TO_BODY_X - s.posBodyM.x) < 0.01 && Math.abs(q.z - s.posBodyM.z) < 0.01);
      expect(p, s.id).toBeDefined();
      expect(p!.attachY).toBeCloseTo(s.posBodyM.y, 2);
    }
  });
});

describe('tejasTestModel: hinges', () => {
  const up = new THREE.Vector3(0, 1, 0);

  it('positive elevon moves the trailing edge down on both wings', () => {
    for (const name of ['elevonL', 'elevonR']) {
      const p = part(name);
      const te = bbox(p.geometry).getCenter(new THREE.Vector3());
      te.x = bbox(p.geometry).min.x;
      expect(hinge(te, p, 0.2).sub(te).dot(up)).toBeLessThan(-0.05);
    }
  });

  it('positive rudder moves the trailing edge left (-z), as src/physics defines it', () => {
    const p = part('rudder');
    const te = new THREE.Vector3(bbox(p.geometry).min.x, 2, 0);
    expect(hinge(te, p, 0.2).z - te.z).toBeLessThan(-0.05);
  });

  it('slats droop the leading edge, airbrakes lift their aft edges', () => {
    for (const name of ['slatL', 'slatR']) {
      const p = part(name);
      const le = bbox(p.geometry).getCenter(new THREE.Vector3());
      le.x = bbox(p.geometry).max.x;
      expect(hinge(le, p, p.travelRad).y).toBeLessThan(le.y - 0.05);
    }
    for (const name of ['airbrakeL', 'airbrakeR']) {
      const p = part(name);
      const c = bbox(p.geometry).getCenter(new THREE.Vector3());
      const aft = new THREE.Vector3(bbox(p.geometry).min.x, c.y, c.z);
      expect(hinge(aft, p, p.travelRad).y).toBeGreaterThan(aft.y + 0.3);
    }
  });

  it('stows every wheel inside the fuselage outline once retracted', () => {
    const b = bbox(model.body);
    for (const name of ['noseGear', 'mainGearL', 'mainGearR']) {
      const p = part(name);
      const w = hinge(lowest(p.geometry), p, p.travelRad);
      expect(w.y).toBeGreaterThan(b.min.y - 0.15);
    }
  });
});

describe('meshAircraftRenderer: slat and nozzle schedules', () => {
  const level = { x: 0, y: 0, z: 0, w: 1 };
  const vAt = (deg: number) => ({ x: 150 * Math.cos((deg * Math.PI) / 180), y: -150 * Math.sin((deg * Math.PI) / 180), z: 0 });

  it('slats stay up in cruise and on the ground, droop fully by 16 deg alpha', () => {
    expect(slatDroopTarget(level, vAt(2), false)).toBe(0);
    expect(slatDroopTarget(level, vAt(10), false)).toBeCloseTo(0.5, 2);
    expect(slatDroopTarget(level, vAt(16), false)).toBe(1);
    expect(slatDroopTarget(level, vAt(16), true)).toBe(0);
  });

  it('nozzle: open at idle, closed at military power, fully open in afterburner', () => {
    expect(nozzleTarget(0.1, false)).toBeCloseTo(0.5, 5);
    expect(nozzleTarget(0.85, false)).toBe(0);
    expect(nozzleTarget(1, true)).toBe(1);
  });
});
