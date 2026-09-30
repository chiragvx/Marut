import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildTejasModel, INTAKE_STATION, NOSE_TIP_X, NOZZLE_EXIT_X, PYLONS, wingAreaM2, wingLEst, wingTEst, type ArticulatedPart } from '../../src/render/aircraftModels/tejasModel';
import { nozzleTarget, slatDroopTarget } from '../../src/render/meshAircraftRenderer';
import { buildStoreModels, storeDimensions } from '../../src/render/aircraftModels/stores';
import { STORE_IDS } from '../../src/contracts/core';
import { airframeContactPoints, gear, stations, wingAreaM2 as dataWingArea, wingSpanM } from '../../src/aircraft/tejasGeometry';

const model = buildTejasModel();
const part = (name: string): ArticulatedPart => model.parts.find((p) => p.name === name)!;
const partsOf = (prefix: string): ArticulatedPart[] => model.parts.filter((p) => p.name.startsWith(prefix));
const DEG = Math.PI / 180;

function bbox(g: THREE.BufferGeometry): THREE.Box3 {
  g.computeBoundingBox();
  return g.boundingBox!;
}

/** Mean position of the lowest vertices (within 2 cm). */
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

/** Rotates a point about a part's hinge by `angle`. */
function hinge(pt: THREE.Vector3, p: ArticulatedPart, angle: number): THREE.Vector3 {
  const pivot = new THREE.Vector3(...p.pivot);
  return pt.clone().sub(pivot).applyAxisAngle(new THREE.Vector3(...p.axis), angle).add(pivot);
}

describe('tejasModel: published Tejas dimensions', () => {
  const b = bbox(model.body);
  const groundY = gear[0]!.posBodyM.y + 0.08;

  it('is 13.2 m long radome tip to nozzle, 13.4 m with the nose probe (HAL: 13.23 / 13.43)', () => {
    expect(NOSE_TIP_X - NOZZLE_EXIT_X).toBeCloseTo(13.2, 2);
    expect(b.max.x - b.min.x).toBeCloseTo(13.42, 1);
  });

  it('spans 8.2 m (the data file agrees)', () => {
    expect(b.max.z - b.min.z).toBeGreaterThan(wingSpanM - 0.01);
    expect(b.max.z - b.min.z).toBeLessThan(wingSpanM + 0.06);
  });

  it('stands 4.4 m tall, ground to fin tip', () => {
    expect(b.max.y - groundY).toBeCloseTo(4.4, 1);
  });

  it('has the 38.4 m^2 reference wing area', () => {
    expect(wingAreaM2()).toBeCloseTo(dataWingArea, 1);
  });

  it('is a compound delta: 50 deg inboard and 62.5 deg outboard of the crank, trailing edge swept forward', () => {
    const sweep = (z0: number, z1: number): number => Math.atan((wingLEst(z1) - wingLEst(z0)) / (z1 - z0)) / DEG;
    expect(sweep(0.8, 1.6)).toBeCloseTo(50, 0);
    expect(Math.abs(sweep(2.0, 4.0) - 62.5)).toBeLessThan(0.5);
    expect(wingTEst(4.0)).toBeLessThan(wingTEst(1.0));
  });

  it('has finite geometry everywhere', () => {
    for (const g of [model.body, model.flame, ...model.parts.map((p) => p.geometry)]) {
      const a = g.getAttribute('position').array as Float32Array;
      expect(a.every(Number.isFinite)).toBe(true);
    }
  });
});

describe('tejasModel: matches src/aircraft', () => {
  it('puts each wheel on its gear leg, just above the fully extended contact point (static squat)', () => {
    const legs: [string, string][] = [
      ['noseGear', 'nose'],
      ['mainGearL', 'mainLeft'],
      ['mainGearR', 'mainRight'],
    ];
    for (const [name, id] of legs) {
      const w = lowest(part(name).geometry);
      const leg = gear.find((g) => g.id === id)!;
      expect(Math.abs(w.x - leg.posBodyM.x)).toBeLessThan(0.05);
      expect(Math.abs(w.z - leg.posBodyM.z)).toBeLessThan(0.08);
      const squat = w.y - leg.posBodyM.y;
      expect(squat).toBeGreaterThan(0.03);
      expect(squat).toBeLessThan(0.12);
    }
  });

  it('has the published wheelbase (4.34 m) and track (2.2 m)', () => {
    const nose = gear.find((g) => g.id === 'nose')!;
    const l = gear.find((g) => g.id === 'mainLeft')!;
    const r = gear.find((g) => g.id === 'mainRight')!;
    expect(nose.posBodyM.x - l.posBodyM.x).toBeCloseTo(4.34, 2);
    expect(r.posBodyM.z - l.posBodyM.z).toBeCloseTo(2.2, 2);
  });

  it('lists its pylons in store-slot order: the stations without the gun', () => {
    const slots = stations.filter((s) => s.id !== 'gun').map((s) => s.id);
    expect(model.pylons.map((p) => p.stationId)).toEqual(slots.slice(0, model.pylons.length));
  });

  it('has a pylon at every wing and centreline station, and the intake station L', () => {
    const pylonStations = stations.filter((s) => s.id.startsWith('wing-') || s.id === 'centreline');
    expect(pylonStations.length).toBe(PYLONS.length);
    for (const s of pylonStations) {
      const p = PYLONS.find((q) => Math.abs(q.x - s.posBodyM.x) < 0.01 && Math.abs(q.z - s.posBodyM.z) < 0.01);
      expect(p, s.id).toBeDefined();
      expect(p!.attachY).toBeCloseTo(s.posBodyM.y, 2);
    }
    const l = stations.find((s) => s.id === 'intake-pod')!;
    expect([l.posBodyM.x, l.posBodyM.y, l.posBodyM.z]).toEqual(INTAKE_STATION);
  });
});

describe('tejasModel: airframe contact points (ground-contact crash, src/core/world.ts)', () => {
  // The skin: the body plus the control surfaces at rest (the elevons carry the wing's trailing edge).
  const skin = [model.body, ...model.parts.filter((q) => q.driver !== 'gear').map((q) => q.geometry)].map((g) => g.getAttribute('position'));
  const nearest = (q: { x: number; y: number; z: number }): number => {
    let best = Infinity;
    for (const p of skin) for (let i = 0; i < p.count; i++) best = Math.min(best, Math.hypot(p.getX(i) - q.x, p.getY(i) - q.y, p.getZ(i) - q.z));
    return best;
  };

  it('each lies on the model skin', () => {
    for (const q of airframeContactPoints) expect(nearest(q), `${q.x},${q.y},${q.z}`).toBeLessThan(0.3);
  });

  it('parked, none is near the ground; the tail and wing tips touch at the real angles', () => {
    const groundY = gear[0]!.posBodyM.y + 0.08;
    const main = gear.find((g) => g.id === 'mainRight')!.posBodyM;
    expect(Math.min(...airframeContactPoints.map((q) => q.y)) - groundY).toBeGreaterThan(0.8);
    // Tail-strike angle on the main wheels: the lowest aft point's rise over its run behind them.
    const tail = airframeContactPoints.reduce((a, b) => (Math.atan2(b.y - groundY, main.x - b.x) < Math.atan2(a.y - groundY, main.x - a.x) && b.x < main.x ? b : a));
    const tailDeg = (Math.atan2(tail.y - groundY, main.x - tail.x) * 180) / Math.PI;
    expect(tailDeg).toBeGreaterThan(13);
    expect(tailDeg).toBeLessThan(16);
    const tip = airframeContactPoints.reduce((a, b) => (b.z > a.z ? b : a));
    const tipDeg = (Math.atan2(tip.y - groundY, tip.z - main.z) * 180) / Math.PI;
    expect(tipDeg).toBeGreaterThan(24);
  });
});

describe('tejasModel: hinges', () => {
  const up = new THREE.Vector3(0, 1, 0);

  it('positive elevon moves the trailing edge down on both wings', () => {
    for (const p of [...partsOf('elevonL'), ...partsOf('elevonR')]) {
      const te = bbox(p.geometry).getCenter(new THREE.Vector3());
      te.x = bbox(p.geometry).min.x;
      expect(hinge(te, p, 0.2).sub(te).dot(up), p.name).toBeLessThan(-0.05);
    }
    expect(partsOf('elevon').length).toBe(4);
  });

  it('positive rudder moves the trailing edge left (-z), as src/physics defines it', () => {
    const p = part('rudder');
    const c = bbox(p.geometry).getCenter(new THREE.Vector3());
    const te = new THREE.Vector3(bbox(p.geometry).min.x, c.y, 0);
    expect(hinge(te, p, 0.2).z - te.z).toBeLessThan(-0.05);
  });

  it('slats droop the leading edge, airbrakes lift their aft edges', () => {
    for (const p of partsOf('slat')) {
      const le = bbox(p.geometry).getCenter(new THREE.Vector3());
      le.x = bbox(p.geometry).max.x;
      expect(hinge(le, p, p.travelRad).y, p.name).toBeLessThan(le.y - 0.03);
    }
    expect(partsOf('slat').length).toBe(6);
    for (const name of ['airbrakeL', 'airbrakeR']) {
      const p = part(name);
      const c = bbox(p.geometry).getCenter(new THREE.Vector3());
      const aft = new THREE.Vector3(bbox(p.geometry).min.x, c.y, c.z);
      expect(hinge(aft, p, p.travelRad).y).toBeGreaterThan(aft.y + 0.3);
    }
  });

  it('retracts the nose gear forwards and the main gear inwards, into the fuselage', () => {
    const b = bbox(model.body);
    const nose = part('noseGear');
    const nw = lowest(nose.geometry);
    const nr = hinge(nw, nose, nose.travelRad);
    expect(nr.x).toBeGreaterThan(nw.x + 0.6);
    expect(nr.y).toBeGreaterThan(b.min.y);
    for (const name of ['mainGearL', 'mainGearR']) {
      const p = part(name);
      const w = lowest(p.geometry);
      const r = hinge(w, p, p.travelRad);
      expect(Math.abs(r.z), name).toBeLessThan(Math.abs(w.z) - 0.5);
      expect(r.y).toBeGreaterThan(b.min.y);
    }
  });

  it('keeps the bay doors (closed) when the gear is up, and hides the legs', () => {
    for (const p of model.parts.filter((q) => q.driver === 'gear')) {
      expect(p.keepVisible === true, p.name).toBe(p.name.includes('Door'));
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

describe('stores: public dimensions', () => {
  const models = buildStoreModels();
  it('draws every store in the catalogue to its length and diameter', () => {
    for (let code = 1; code < STORE_IDS.length; code++) {
      const id = STORE_IDS[code]!;
      const dims = storeDimensions(id)!;
      const b = bbox(models.byCode[code]!.geometry);
      expect(b.max.x - b.min.x, id).toBeCloseTo(dims.len, 1);
      // The body's diameter; fins reach further out.
      expect(b.max.y - b.min.y, id).toBeGreaterThanOrEqual(dims.dia - 0.005);
    }
  });

  it('hangs each tank clear of the ground, gear down, on the stations that take it', () => {
    for (const p of model.pylons) {
      const accepts = stations.find((s) => s.id === p.stationId)!.accepts;
      for (const id of ['tank-1200l', 'tank-725l'].filter((t) => accepts.includes(t))) {
        const m = models.byCode[STORE_IDS.indexOf(id)]!;
        const bottom = p.attachY + new THREE.Vector3().setFromMatrixPosition(m.mount).y - storeDimensions(id)!.dia / 2;
        expect(bottom, `${id} on ${p.stationId}`).toBeGreaterThan(gear[0]!.posBodyM.y);
      }
    }
  });
});
