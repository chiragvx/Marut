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
    // Regression-pinned: 0.016, the corrected subsonic zero-lift drag (was 0.03775 while an old
    // +0.015 bump for an earlier, under-powered engine table was still in; see the CD table note).
    expect(cd).toBeCloseTo(0.016, 5);
    expect(cd).toBeGreaterThanOrEqual(0.015);
    expect(cd).toBeLessThanOrEqual(0.06);
  });

  // Regression test for the "CL table tuned to a landing-configuration
  // CLmax" review finding: an earlier pass inflated CL at alpha>=15deg on
  // the Mach-0.6 column (as well as Mach-0.2) to satisfy the stall_landing
  // performance target's assumed landing-configuration CLmax (1.6), but
  // Mach-0.6 is also the exact Mach turn_5000_m06 (a CLEAN-configuration
  // sustained-turn target) is evaluated at, and this table has no
  // landing-config gate — so that inflation leaked into clean combat
  // physics. The Mach-0.2 column remains intentionally elevated (needed
  // for stall_landing/landing_roll until a real landing-configuration CL
  // increment is modeled — see tejasAeroTables.ts's own comment); this test
  // pins ONLY the Mach-0.6+ columns to 03-tejas-data.md section 4's stated
  // clean-configuration realism bound (CLmax ~= 1.15-1.2).
  it('CL at Mach 0.6 and above stays within the clean-configuration realism bound (CLmax <= 1.2)', () => {
    for (let mi = 1; mi < aero.CL.ys.length; mi++) {
      const mach = aero.CL.ys[mi] as number;
      for (const alphaRad of aero.CL.xs) {
        expect(interpolate2D(aero.CL, alphaRad, mach)).toBeLessThanOrEqual(1.2);
      }
    }
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
