import { describe, expect, it } from 'vitest';
import { papiColorAt } from '../../src/airport/lights';
import type { PapiState, RunwayDef } from '../../src/contracts/airport';
import { ILS_DEFAULT_GLIDESLOPE_RAD } from '../../src/contracts/core';

function papiRunway(papi: boolean): RunwayDef {
  return {
    id: '06',
    thresholdWorldX: 0,
    thresholdWorldZ: 0,
    elevationM: 100,
    headingRad: 0,
    lengthM: 3000,
    widthM: 45,
    surface: 'concrete',
    lights: { edgeLights: false, thresholdLights: false, approachLights: false, papi },
  };
}

function freshOut(): PapiState {
  return { runwayId: '', colors: ['red', 'red', 'red', 'red'] };
}

describe('papiColorAt', () => {
  it('on the nominal glidepath is [white,white,red,red]', () => {
    const runway = papiRunway(true);
    // glideslopeOriginPos = threshold + d*300 (default offset), d = (0,0,-1) at headingRad 0.
    const gsOriginZ = -300;
    const range = 5000;
    const heightAbove = range * Math.tan(ILS_DEFAULT_GLIDESLOPE_RAD);
    const out = papiColorAt(runway, { x: 0, y: runway.elevationM + heightAbove, z: gsOriginZ + range }, freshOut());
    expect(out).toBeDefined();
    expect(out?.colors).toEqual(['white', 'white', 'red', 'red']);
  });

  it('0.3 degrees below the glidepath is [white,red,red,red]', () => {
    const runway = papiRunway(true);
    const gsOriginZ = -300;
    const range = 5000;
    const belowAngle = ILS_DEFAULT_GLIDESLOPE_RAD - 0.005236;
    const heightAbove = range * Math.tan(belowAngle);
    const out = papiColorAt(runway, { x: 0, y: runway.elevationM + heightAbove, z: gsOriginZ + range }, freshOut());
    expect(out).toBeDefined();
    expect(out?.colors).toEqual(['white', 'red', 'red', 'red']);
  });

  it('returns undefined and leaves out unmodified when lights.papi is false', () => {
    const runway = papiRunway(false);
    const out = freshOut();
    const before = { ...out, colors: [...out.colors] };
    const result = papiColorAt(runway, { x: 0, y: 500, z: 3000 }, out);
    expect(result).toBeUndefined();
    expect(out.runwayId).toBe(before.runwayId);
    expect(out.colors).toEqual(before.colors);
  });
});
