import { describe, expect, it } from 'vitest';
import { ILS_NEEDLE_MAX_OFFSET_PX, ilsOffsetPx } from '../../src/hud/ilsNeedles';

describe('ilsNeedles', () => {
  it('ILS_LOC=1.0 -> offset exactly ILS_NEEDLE_MAX_OFFSET_PX', () => {
    expect(ilsOffsetPx(1.0)).toBe(ILS_NEEDLE_MAX_OFFSET_PX);
  });

  it('ILS_LOC=-0.5 -> -40', () => {
    expect(ilsOffsetPx(-0.5)).toBe(-40);
  });

  it('ILS_LOC=0 -> 0', () => {
    expect(ilsOffsetPx(0)).toBe(0);
  });
});
