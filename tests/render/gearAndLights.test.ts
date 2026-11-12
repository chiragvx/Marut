import { describe, expect, it } from 'vitest';
import { noseSteerTarget, oleoTarget, OLEO_COMPRESS_M, OLEO_EXTEND_M } from '../../src/render/meshAircraftRenderer';

describe('nose wheel steering', () => {
  it('follows the rudder on the ground with the gear down, full authority at taxi speed', () => {
    expect(noseSteerTarget(0.349066, 3, true, 1)).toBeCloseTo(0.5236, 3);
    expect(noseSteerTarget(-0.349066, 3, true, 1)).toBeCloseTo(-0.5236, 3);
  });
  it('loses authority with speed', () => {
    const slow = noseSteerTarget(0.349066, 3, true, 1);
    const fast = noseSteerTarget(0.349066, 60, true, 1);
    expect(fast).toBeGreaterThan(0);
    expect(fast).toBeLessThan(slow * 0.3);
  });
  it('is centred in the air and while the gear moves', () => {
    expect(noseSteerTarget(0.3, 3, false, 1)).toBe(0);
    expect(noseSteerTarget(0.3, 3, true, 0.5)).toBe(0);
  });
});

describe('oleo', () => {
  it('hangs fully extended in the air and with the gear moving', () => {
    expect(oleoTarget(10, 0, false, 1)).toBe(-OLEO_EXTEND_M);
    expect(oleoTarget(-1, 0, true, 0.5)).toBe(-OLEO_EXTEND_M);
  });
  it('compresses to put the tyre on the ground, within its stroke', () => {
    expect(oleoTarget(-0.05, 0, true, 1)).toBeCloseTo(0.05, 6);
    expect(oleoTarget(-1, 0, true, 1)).toBe(OLEO_COMPRESS_M);
  });
  it('sits in the modelled pose on the ground when no ground height is known', () => {
    expect(oleoTarget(0, undefined, true, 1)).toBe(0);
  });
});

describe('AI exterior lights', async () => {
  const { aiLights } = await import('../../src/ai/pilotAi');
  const { EntityFlag } = await import('../../src/contracts/core');
  const { TacticalState } = await import('../../src/contracts/ai');
  it('full lights on the ground and landing, the landing light only with the gear down', () => {
    expect(aiLights(TacticalState.Patrol, EntityFlag.OnGround, 1)).toBe(EntityFlag.Lights | EntityFlag.LightsStrobe | EntityFlag.LightsLanding);
    expect(aiLights(TacticalState.Land, 0, 0)).toBe(EntityFlag.Lights | EntityFlag.LightsStrobe);
  });
  it('covert formation strips in transit, dark in a fight', () => {
    expect(aiLights(TacticalState.Patrol, 0, 0)).toBe(EntityFlag.LightsFormation);
    expect(aiLights(TacticalState.Rtb, 0, 0)).toBe(EntityFlag.LightsFormation);
    for (const s of [TacticalState.Intercept, TacticalState.EngageBvr, TacticalState.Merge, TacticalState.Bfm, TacticalState.Defensive, TacticalState.Disengage]) {
      expect(aiLights(s, 0, 0)).toBe(0);
    }
  });
});
