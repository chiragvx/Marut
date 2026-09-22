import { describe, it, expect } from 'vitest';
import { interpolate2D } from '../../src/math';
import { tejasDefinition } from '../../src/aircraft';

const aero = tejasDefinition.aero;

describe('tejasAeroTables', () => {
  it('CL is non-decreasing in alpha for every mach breakpoint', () => {
    const machBreakpoints = aero.CL.ys;
    const startAlphaDeg = -5;
    const endAlphaRad = aero.stallAlphaRad;
    const startAlphaRad = (startAlphaDeg * Math.PI) / 180;
    for (const mach of machBreakpoints) {
      let prev = -Infinity;
      for (let k = 0; k <= 40; k++) {
        const alphaRad = startAlphaRad + ((endAlphaRad - startAlphaRad) * k) / 40;
        const cl = interpolate2D(aero.CL, alphaRad, mach);
        expect(cl).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = cl;
      }
    }
  });

  it('CD is never negative across the full breakpoint grid', () => {
    for (const alphaRad of aero.CD.xs) {
      for (const mach of aero.CD.ys) {
        expect(interpolate2D(aero.CD, alphaRad, mach)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('CD(0, 0.3) falls in [0.015, 0.06]', () => {
    const cd = interpolate2D(aero.CD, 0, 0.3);
    expect(cd).toBeCloseTo(0.02275, 5);
    expect(cd).toBeGreaterThanOrEqual(0.015);
    expect(cd).toBeLessThanOrEqual(0.06);
  });

  it('Cm_elevon is negative (the elevon sign-rule regression test)', () => {
    expect(aero.Cm_elevon).toBeLessThan(0);
  });

  it('dCm/dalpha at the trim band midpoint (2.5 deg, mach 0.2) is strictly positive', () => {
    const alphaRad = 0.0436;
    const h = 0.001;
    const cmPlus = interpolate2D(aero.Cm, alphaRad + h, 0.2);
    const cmMinus = interpolate2D(aero.Cm, alphaRad - h, 0.2);
    const dCmDAlpha = (cmPlus - cmMinus) / (2 * h);
    expect(dCmDAlpha).toBeGreaterThan(0);
    expect(dCmDAlpha).toBeCloseTo(0.4585, 1);
  });
});
