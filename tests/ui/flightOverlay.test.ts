// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createFlightOverlay, hintText, pickHint, type CoachState, type HintId } from '../../src/ui/flightOverlay';

const base: CoachState = {
  t: 0,
  start: 'runway',
  mission: false,
  onGround: true,
  speedMps: 0,
  aglM: 0,
  vsMps: 0,
  gearPos: 1,
  taxiGuideOn: false,
  hasTarget: false,
  locked: false,
  missileSelected: false,
  missilesFired: 0,
};

/** Runs a sequence of states through one flight's hint memory. */
function run(states: Partial<CoachState>[]): (HintId | undefined)[] {
  const done = new Set<HintId>();
  return states.map((s) => pickHint({ ...base, ...s }, done));
}

describe('first-flight hints', () => {
  it('walks a runway take-off: throttle, rotate, gear up, then nothing', () => {
    expect(
      run([
        {},
        { speedMps: 30 },
        { speedMps: 70 },
        { onGround: false, speedMps: 90, aglM: 60, vsMps: 8 },
        { onGround: false, speedMps: 120, aglM: 200, vsMps: 10, gearPos: 0 },
      ])
    ).toEqual(['throttle', undefined, 'rotate', 'gearUp', undefined]);
  });

  it('from a shelter, taxi guidance first, and it retires once used', () => {
    expect(run([{ start: 'parked' }, { start: 'parked', taxiGuideOn: true }, { start: 'parked' }])).toEqual(['taxi', undefined, undefined]);
  });

  it('in a mission: designate after 20 s airborne, then fire on lock', () => {
    const air = { mission: true, onGround: false, start: 'air' as const, gearPos: 0, aglM: 3000, speedMps: 180 };
    expect(
      run([
        { ...air, t: 10 },
        { ...air, t: 25 },
        { ...air, t: 30, hasTarget: true },
        { ...air, t: 40, hasTarget: true, locked: true, missileSelected: true },
        { ...air, t: 45, hasTarget: true, locked: true, missileSelected: true, missilesFired: 1 },
      ])
    ).toEqual([undefined, 'designate', undefined, 'fire', undefined]);
  });

  it('reminds about the gear on a slow, low descent', () => {
    expect(run([{ start: 'air', onGround: false, gearPos: 0, aglM: 200, speedMps: 90, vsMps: -4 }])).toEqual(['gearDown']);
  });

  it('shows keys from the key map as key caps', () => {
    const container = document.createElement('div');
    const o = createFlightOverlay(container);
    o.setHint(hintText('gearUp', { throttleUp: 'Z', throttleDown: 'X', afterburner: 'Shift', noseUp: 'S', gear: 'G', taxiGuide: 'H', target: 'T', launch: 'Enter', weapon: 'Tab' }));
    const hint = container.querySelector('[data-role="hint"]')!;
    expect(hint.textContent).toBe('Gear is down. Press G to raise it.');
    expect(hint.querySelector('.tj-key')!.textContent).toBe('G');
  });
});
