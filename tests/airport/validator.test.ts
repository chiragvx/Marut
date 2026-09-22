import { describe, expect, it } from 'vitest';
import { validateAirportLayout } from '../../src/airport/validator';
import type { AirportFlattenZone, AirportLayout, ApronDef, ParkingSpotDef, RunwayDef, TaxiwayDef } from '../../src/contracts/airport';
import rangpurJson from '../../src/airport/layouts/rangpur-afb.json';
import konarakJson from '../../src/airport/layouts/konarak-coastal.json';
import { parseAirportLayout } from '../../src/airport/parser';

function baseRunway(overrides: Partial<RunwayDef> = {}): RunwayDef {
  return {
    id: '09',
    thresholdWorldX: 0,
    thresholdWorldZ: 0,
    elevationM: 100,
    headingRad: 0,
    lengthM: 1000,
    widthM: 45,
    surface: 'concrete',
    ...overrides,
  };
}

function baseZone(overrides: Partial<AirportFlattenZone> = {}): AirportFlattenZone {
  return { centerWorldX: 0, centerWorldZ: -500, elevationM: 100, flatRadiusM: 600, blendRadiusM: 100, ...overrides };
}

function baseLayout(overrides: Partial<AirportLayout> = {}): AirportLayout {
  return {
    id: 'test-airport',
    name: 'Test Airport',
    referenceWorldX: 0,
    referenceWorldZ: 0,
    elevationM: 100,
    flattenZones: [baseZone()],
    runways: [baseRunway()],
    taxiways: [],
    aprons: [],
    parkingSpots: [],
    ...overrides,
  };
}

function findIssue(errors: readonly { code: string; path: string; severity: string }[], code: string) {
  return errors.find((e) => e.code === code);
}

describe('validateAirportLayout', () => {
  it('rule 1: duplicate_id among runways', () => {
    const layout = baseLayout({
      runways: [baseRunway({ id: '09' }), baseRunway({ id: '09', thresholdWorldX: 5000, thresholdWorldZ: 5000 })],
    });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    const issue = findIssue(result.error, 'duplicate_id');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(issue?.path).toBe('runways[1].id');
  });

  it('rule 2: invalid_runway_length', () => {
    const layout = baseLayout({ runways: [baseRunway({ lengthM: 100 })] });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(findIssue(result.error, 'invalid_runway_length')).toBeDefined();
  });

  it('rule 3: invalid_runway_width', () => {
    const layout = baseLayout({ runways: [baseRunway({ widthM: 10 })] });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(findIssue(result.error, 'invalid_runway_width')).toBeDefined();
  });

  it('rule 4: reciprocal_not_found', () => {
    const layout = baseLayout({ runways: [baseRunway({ reciprocalId: 'doesnotexist' })] });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(findIssue(result.error, 'reciprocal_not_found')).toBeDefined();
  });

  it('rule 5: reciprocal_not_mutual', () => {
    const a = baseRunway({ id: 'A', reciprocalId: 'B', headingRad: 0 });
    const b = baseRunway({
      id: 'B',
      headingRad: Math.PI,
      thresholdWorldX: 0,
      thresholdWorldZ: -1000,
      // no reciprocalId back to A
    });
    const layout = baseLayout({ runways: [a, b] });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(findIssue(result.error, 'reciprocal_not_mutual')).toBeDefined();
  });

  it('rule 6: reciprocal_heading_mismatch (headingRad 0 vs 3.0, expected ~PI)', () => {
    const a = baseRunway({ id: 'A', reciprocalId: 'B', headingRad: 0 });
    const b = baseRunway({ id: 'B', reciprocalId: 'A', headingRad: 3.0, thresholdWorldX: 0, thresholdWorldZ: -1000 });
    const layout = baseLayout({ runways: [a, b] });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(findIssue(result.error, 'reciprocal_heading_mismatch')).toBeDefined();
  });

  it('rule 7: reciprocal_distance_mismatch', () => {
    const a = baseRunway({ id: 'A', reciprocalId: 'B', headingRad: 0, lengthM: 1000 });
    // B sits at the SAME threshold as A instead of 1000m away.
    const b = baseRunway({ id: 'B', reciprocalId: 'A', headingRad: Math.PI, thresholdWorldX: 0, thresholdWorldZ: 0, lengthM: 1000 });
    const layout = baseLayout({ runways: [a, b] });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(findIssue(result.error, 'reciprocal_distance_mismatch')).toBeDefined();
  });

  it('rule 8: reciprocal_width_mismatch', () => {
    const a = baseRunway({ id: 'A', reciprocalId: 'B', headingRad: 0, lengthM: 1000, widthM: 45 });
    const b = baseRunway({
      id: 'B',
      reciprocalId: 'A',
      headingRad: Math.PI,
      thresholdWorldX: 0,
      thresholdWorldZ: -1000,
      lengthM: 1000,
      widthM: 30,
    });
    const layout = baseLayout({ runways: [a, b] });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(findIssue(result.error, 'reciprocal_width_mismatch')).toBeDefined();
  });

  it('rule 9: flatten_zone_radius_invalid', () => {
    const layout = baseLayout({ flattenZones: [baseZone({ flatRadiusM: 0, blendRadiusM: -5 })] });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(findIssue(result.error, 'flatten_zone_radius_invalid')).toBeDefined();
  });

  it('rule 10: runway_not_flattened (1000m runway, flatRadiusM:50 zone centered on the threshold)', () => {
    const layout = baseLayout({
      runways: [baseRunway({ lengthM: 1000 })],
      flattenZones: [baseZone({ centerWorldX: 0, centerWorldZ: 0, flatRadiusM: 50 })],
    });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    const issue = result.error.find((e) => e.code === 'runway_not_flattened' && e.path.includes('t=1'));
    expect(issue).toBeDefined();
  });

  it('rule 11: runway_elevation_mismatch', () => {
    const layout = baseLayout({
      runways: [baseRunway({ elevationM: 100 })],
      flattenZones: [baseZone({ elevationM: 106 })],
    });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(findIssue(result.error, 'runway_elevation_mismatch')).toBeDefined();
  });

  it('rule 12: ils_frequency_out_of_range', () => {
    const layout = baseLayout({ runways: [baseRunway({ ils: { frequencyMhz: 105.0 } })] });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(findIssue(result.error, 'ils_frequency_out_of_range')).toBeDefined();
  });

  it('rule 13: ils_glideslope_angle_out_of_range', () => {
    const layout = baseLayout({
      runways: [baseRunway({ ils: { frequencyMhz: 109.9, glideslopeAngleRad: 0.1 } })],
    });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(findIssue(result.error, 'ils_glideslope_angle_out_of_range')).toBeDefined();
  });

  it('rule 14: taxiway_too_few_points', () => {
    const taxiway: TaxiwayDef = { id: 'T1', widthM: 10, points: [{ worldX: 0, worldZ: 0 }] };
    const layout = baseLayout({ taxiways: [taxiway] });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(findIssue(result.error, 'taxiway_too_few_points')).toBeDefined();
  });

  it('rule 15: apron_too_few_points', () => {
    const apron: ApronDef = {
      id: 'A1',
      points: [
        { worldX: 0, worldZ: 0 },
        { worldX: 1, worldZ: 1 },
      ],
    };
    const layout = baseLayout({ aprons: [apron] });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(findIssue(result.error, 'apron_too_few_points')).toBeDefined();
  });

  it('rule 16: parking_spot_outside_apron is a warning, not an error', () => {
    const apron: ApronDef = {
      id: 'A1',
      points: [
        { worldX: -10, worldZ: -10 },
        { worldX: 10, worldZ: -10 },
        { worldX: 10, worldZ: 10 },
        { worldX: -10, worldZ: 10 },
      ],
    };
    const spot: ParkingSpotDef = { id: 'P1', worldX: 100000, worldZ: 100000, headingRad: 0, type: 'fighter' };
    const layout = baseLayout({ aprons: [apron], parkingSpots: [spot] });
    const result = validateAirportLayout(layout);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.warnings.length).toBe(1);
    expect(result.value.warnings[0]?.code).toBe('parking_spot_outside_apron');
    expect(result.value.warnings[0]?.severity).toBe('warning');
  });

  it('both built-in layouts validate with ok===true and zero warnings', () => {
    for (const json of [rangpurJson, konarakJson]) {
      const parsed = parseAirportLayout(json);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('expected parse success');
      const result = validateAirportLayout(parsed.value);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`expected validate success: ${JSON.stringify(result.error)}`);
      expect(result.value.warnings.length).toBe(0);
    }
  });
});
