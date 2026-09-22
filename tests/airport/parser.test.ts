import { describe, expect, it } from 'vitest';
import { parseAirportLayout } from '../../src/airport/parser';
import rangpurJson from '../../src/airport/layouts/rangpur-afb.json';

describe('parseAirportLayout', () => {
  it('reports a missing_field issue at path "id" for an empty object', () => {
    const result = parseAirportLayout({});
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    const idIssue = result.error.find((e) => e.code === 'missing_field' && e.path === 'id');
    expect(idIssue).toBeDefined();
  });

  it('parses the rangpur-afb.json object successfully', () => {
    const result = parseAirportLayout(rangpurJson);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.value.runways.length).toBe(2);
    expect(result.value.runways[0]?.id).toBe('06');
  });

  it('reports wrong_type when a field has the wrong type', () => {
    const bad = { ...rangpurJson, elevationM: 'not-a-number' };
    const result = parseAirportLayout(bad);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    const issue = result.error.find((e) => e.code === 'wrong_type' && e.path === 'elevationM');
    expect(issue).toBeDefined();
  });

  it('reports invalid_enum_value for an unknown runway surface', () => {
    const bad = {
      ...rangpurJson,
      runways: [{ ...rangpurJson.runways[0], surface: 'dirt' }, rangpurJson.runways[1]],
    };
    const result = parseAirportLayout(bad);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    const issue = result.error.find((e) => e.code === 'invalid_enum_value' && e.path === 'runways[0].surface');
    expect(issue).toBeDefined();
  });

  it('rejects a non-object root value', () => {
    const result = parseAirportLayout(42);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.some((e) => e.code === 'not_an_object')).toBe(true);
  });
});
