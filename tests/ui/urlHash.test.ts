import { describe, it, expect } from 'vitest';
import { encodeLayoutToUrlHash, decodeLayoutFromUrlHash } from '../../src/ui/airportEditorExport';
import type { EditorAirportLayout } from '../../src/contracts/ui';

function fixture(): EditorAirportLayout {
  return {
    id: 'test-field',
    name: 'Test Field',
    referenceXM: 0,
    referenceZM: 0,
    elevationM: 10,
    runways: [{ id: 'runway-1', centerXM: 0, centerZM: 0, headingRad: 0, lengthM: 2500, widthM: 45, elevationM: 10 }],
    taxiways: [{ id: 'taxiway-1', widthM: 20, points: [{ xM: 0, zM: 0 }, { xM: 100, zM: 0 }] }],
    aprons: [{ id: 'apron-1', elevationM: 10, points: [{ xM: 0, zM: 200 }, { xM: 80, zM: 200 }, { xM: 80, zM: 260 }, { xM: 0, zM: 260 }] }],
  };
}

describe('EncodeLayoutToUrlHash / DecodeLayoutFromUrlHash', () => {
  it('produces a URL-safe string', () => {
    const encoded = encodeLayoutToUrlHash(fixture());
    expect(/^[A-Za-z0-9_-]+$/.test(encoded)).toBe(true);
  });

  it('round-trips a layout', () => {
    const layout = fixture();
    const encoded = encodeLayoutToUrlHash(layout);
    const result = decodeLayoutFromUrlHash(encoded);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(layout.id);
      expect(result.value.runways[0]?.lengthM).toBe(2500);
    }
  });

  it('accepts a leading #', () => {
    const encoded = encodeLayoutToUrlHash(fixture());
    const result = decodeLayoutFromUrlHash(`#${encoded}`);
    expect(result.ok).toBe(true);
  });

  it('rejects an invalid base64url string', () => {
    expect(decodeLayoutFromUrlHash('not-valid-base64!!!').ok).toBe(false);
  });
});
