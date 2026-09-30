import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SnapshotHud, HUD_BLOCK_FLOATS, EntityFlag } from '../../src/contracts/core';
import { extractHeadingPitchRoll } from '../../src/core/hudTelemetry';
import { attitudeDeg, createAvionics, createAvionicsState, engineSchedule, toBody, toWorld, updateAvionics } from '../../src/render/cockpit/avionics';
import { createHeadState, lookHead, recenterHead, updateHead } from '../../src/render/cockpit/head';
import { HudProjector } from '../../src/render/cockpit/components/hudSymbology';
import { computeCockpitPose, createCameraPose } from '../../src/render/cameraModes';
import type { CockpitFlight } from '../../src/render/cockpit/types';
import { COCKPIT3D_MAX_YAW_RAD, COCKPIT3D_VERTICAL_FOV_DEG } from '../../src/contracts/render';

const DEG = Math.PI / 180;

function randomQuat(seed: number): THREE.Quaternion {
  const r = (k: number): number => Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453 % 1;
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(r(1) * 3, r(2) * 3, r(3) * 3, 'YXZ'));
}

function flight(over: Partial<CockpitFlight> = {}): CockpitFlight {
  return {
    valid: true,
    simTimeSec: 0,
    pos: { x: 0, y: 1000, z: 0 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 200, y: 0, z: 0 },
    hud: new Float64Array(HUD_BLOCK_FLOATS),
    flags: 0,
    throttle: 0.8,
    afterburner: false,
    gearPos: 0,
    elevonL: 0,
    elevonR: 0,
    rudder: 0,
    stores: 0,
    storesB: 0,
    targetValid: false,
    targetPos: { x: 0, y: 0, z: 0 },
    sunDir: { x: 0, y: 1, z: 0 },
    sunCol: { r: 1, g: 1, b: 1 },
    ambSky: { r: 0.4, g: 0.4, b: 0.4 },
    ambGround: { r: 0.3, g: 0.3, b: 0.3 },
    night: 0,
    ...over,
  };
}

describe('cockpit avionics', () => {
  it('attitude from the orientation matches the sim (hudTelemetry)', () => {
    for (let i = 1; i < 40; i++) {
      const q = randomQuat(i);
      const mine = { headingDeg: 0, pitchDeg: 0, rollDeg: 0 };
      attitudeDeg(q, mine);
      const sim = extractHeadingPitchRoll(q, { headingRad: 0, pitchRad: 0, rollRad: 0 });
      expect(mine.pitchDeg).toBeCloseTo(sim.pitchRad / DEG, 6);
      expect(mine.rollDeg).toBeCloseTo(sim.rollRad / DEG, 6);
      const dh = ((mine.headingDeg - sim.headingRad / DEG + 540) % 360) - 180;
      expect(Math.abs(dh)).toBeLessThan(1e-6);
    }
  });

  it('toBody undoes toWorld', () => {
    const q = randomQuat(7);
    const v = { x: 1.5, y: -2, z: 0.25 };
    const w = toWorld(q, v, { x: 0, y: 0, z: 0 });
    const b = toBody(q, w, { x: 0, y: 0, z: 0 });
    expect(b.x).toBeCloseTo(v.x, 9);
    expect(b.y).toBeCloseTo(v.y, 9);
    expect(b.z).toBeCloseTo(v.z, 9);
  });

  it('engine schedule: spools up with the lever, nozzle closes towards military and opens in reheat', () => {
    const idle = engineSchedule(0, 0);
    const mil = engineSchedule(1, 0);
    const ab = engineSchedule(1, 1);
    expect(idle.nh).toBeCloseTo(70, 5);
    expect(mil.nh).toBeCloseTo(100, 5);
    expect(ab.nh).toBeGreaterThan(mil.nh);
    expect(mil.ftit).toBeGreaterThan(idle.ftit);
    expect(idle.nozzle).toBeGreaterThan(mil.nozzle);
    expect(ab.nozzle).toBeGreaterThan(mil.nozzle);
  });

  it('flight path marker, units, and fuel flow measured from the burn', () => {
    const av = createAvionics();
    const st = createAvionicsState();
    // Climbing at 10 deg flight path, nose level: the FPM sits 10 deg above the waterline.
    const f = flight({ vel: { x: Math.cos(10 * DEG) * 100, y: Math.sin(10 * DEG) * 100, z: 0 } });
    f.hud[SnapshotHud.IAS_MPS] = 100;
    f.hud[SnapshotHud.ALT_MSL_M] = 1000;
    // Burn 1 kg/s for 20 s.
    for (let t = 0; t <= 20; t += 0.05) {
      f.simTimeSec = t;
      f.hud[SnapshotHud.FUEL_KG] = 2000 - t;
      updateAvionics(av, st, f, 0.05);
    }
    expect(Math.atan2(av.fpm.y, av.fpm.x) / DEG).toBeCloseTo(10, 6);
    expect(av.iasKt).toBeCloseTo(194.38, 1);
    expect(av.altFt).toBeCloseTo(3280.8, 0);
    expect(av.ffKgH).toBeGreaterThan(3500);
    expect(av.ffKgH).toBeLessThan(3700);
    expect(av.vsFpm).toBeCloseTo(Math.sin(10 * DEG) * 100 * 196.85, 0);
  });

  it('no angle of attack when stopped (the sim reports ~180 deg on the runway)', () => {
    const av = createAvionics();
    const f = flight({ vel: { x: 0, y: 0, z: 0 }, flags: EntityFlag.OnGround });
    f.hud[SnapshotHud.AOA_RAD] = Math.PI;
    updateAvionics(av, createAvionicsState(), f, 0.016);
    expect(av.aoaDeg).toBe(0);
  });
});

describe('cockpit HUD projection', () => {
  it('is gnomonic about the optical axis (straight lines stay straight, conformal angles)', () => {
    const P = new HudProjector(1024, Math.tan(13.5 * DEG), -6.5 * DEG);
    // The optical axis lands in the middle.
    expect(P.project({ x: Math.cos(-6.5 * DEG), y: Math.sin(-6.5 * DEG), z: 0 })).toBe(true);
    expect(P.x).toBeCloseTo(512, 6);
    expect(P.y).toBeCloseTo(512, 6);
    // 5 deg right of the axis: tan(5 deg) * scale to the right.
    const ax = new THREE.Vector3(Math.cos(-6.5 * DEG), Math.sin(-6.5 * DEG), 0);
    const d = ax.clone().applyAxisAngle(new THREE.Vector3(P.u.x, P.u.y, P.u.z), -5 * DEG);
    P.project(d);
    expect(P.x - 512).toBeCloseTo(Math.tan(5 * DEG) * P.scale, 6);
    expect(P.y).toBeCloseTo(512, 6);
    // The boresight (body +x) is 6.5 deg above the centre.
    P.project({ x: 1, y: 0, z: 0 });
    expect(512 - P.y).toBeCloseTo(Math.tan(6.5 * DEG) * P.scale, 6);
    // Behind: not drawn.
    expect(P.project({ x: -1, y: 0, z: 0 })).toBe(false);
  });
});

describe('cockpit head', () => {
  it('looking straight ahead: eye at the design eye point, camera along the nose', () => {
    const h = createHeadState();
    const eye = new THREE.Vector3();
    const rot = new THREE.Quaternion();
    const fov = updateHead(h, 1 / 60, { g: 1, aoaDeg: 2, mach: 0.6, iasKt: 300, onGround: false, groundSpeedMps: 150 }, eye, rot);
    expect(eye.length()).toBeLessThan(1e-3);
    expect(fov).toBeCloseTo(COCKPIT3D_VERTICAL_FOV_DEG, 6);
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(rot);
    expect(look.x).toBeCloseTo(1, 6);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rot);
    expect(up.y).toBeCloseTo(1, 6);
  });

  it('turning the head: limits, the eye swings about the neck, recentre', () => {
    const h = createHeadState();
    lookHead(h, 10, 0, 0);
    expect(h.yaw).toBe(COCKPIT3D_MAX_YAW_RAD);
    const eye = new THREE.Vector3();
    const rot = new THREE.Quaternion();
    for (let i = 0; i < 120; i++) updateHead(h, 1 / 60, { g: 1, aoaDeg: 0, mach: 0.5, iasKt: 250, onGround: false, groundSpeedMps: 130 }, eye, rot);
    // Looking back over the left shoulder: the head leans out to the left.
    expect(eye.z).toBeLessThan(-0.1);
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(rot);
    expect(look.x).toBeLessThan(-0.5);
    expect(look.z).toBeLessThan(0);
    recenterHead(h);
    expect(h.yaw).toBe(0);
    expect(h.fovDeg).toBe(COCKPIT3D_VERTICAL_FOV_DEG);
  });

  it('G pushes the head down', () => {
    const h = createHeadState();
    const eye = new THREE.Vector3();
    const rot = new THREE.Quaternion();
    for (let i = 0; i < 180; i++) updateHead(h, 1 / 60, { g: 7, aoaDeg: 8, mach: 0.7, iasKt: 400, onGround: false, groundSpeedMps: 200 }, eye, rot);
    expect(eye.y).toBeLessThan(-0.02);
  });
});

describe('HUD-only cockpit camera', () => {
  it('looks along the nose (it used to look out along the left wing)', () => {
    const out = createCameraPose();
    computeCockpitPose({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, out);
    const q = new THREE.Quaternion(out.rot.x, out.rot.y, out.rot.z, out.rot.w);
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    expect(look.x).toBeCloseTo(1, 6);
    expect(Math.abs(look.z)).toBeLessThan(1e-6);
  });
});
