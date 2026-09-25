import { describe, expect, it } from 'vitest';
import { missileLockCue } from '../../src/hud/weaponStatus';

describe('missileLockCue', () => {
  it('shows nothing for the gun', () => {
    expect(missileLockCue('gun', 'locked', true)).toBeUndefined();
  });
  it('prompts for a target before a lock can start', () => {
    expect(missileLockCue('ir_missile', 'none', false)).toBe('T: TGT');
  });
  it('walks SRCH -> TRK -> LOCK as the lock builds', () => {
    expect(missileLockCue('radar_missile', 'none', true)).toBe('SRCH');
    expect(missileLockCue('radar_missile', 'searching', true)).toBe('SRCH');
    expect(missileLockCue('radar_missile', 'tracking', true)).toBe('TRK');
    expect(missileLockCue('radar_missile', 'locked', true)).toBe('LOCK');
  });
});
