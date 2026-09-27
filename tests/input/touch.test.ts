// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createTouchReader } from '../../src/input/touch';
import { TouchZoneId } from '../../src/contracts/input';

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

// Regression coverage for two fixes made after a user report that several HUD/menu elements
// were plain empty bordered boxes: (1) every touch button now renders an inline SVG icon
// instead of nothing, and (2) the whole overlay is hidden by default until setVisible(true) is
// called (previously it was unconditionally visible even on a desktop keyboard/mouse session
// with zero touch points).
describe('TouchReader — icons and visibility (previously untested file)', () => {
  it('attach() renders a non-empty SVG icon inside every button zone, not an empty box', () => {
    const container = makeContainer();
    const reader = createTouchReader();
    reader.attach(container);

    const buttons = container.querySelectorAll('[aria-label]');
    // 10 buttons (Trigger, Launch, CycleWeapon, CycleTarget, GearToggle, AirbrakeToggle,
    // Afterburner, Brakes, CameraCycle, MenuToggle) + yawBar + throttle = 12 labeled.
    expect(buttons.length).toBe(12);
    for (const el of Object.values(TouchZoneId)) {
      if (el === TouchZoneId.Stick) continue; // the stick has no fixed rect/icon, it floats
      const labeled = container.querySelector(`[aria-label="${el}"]`);
      expect(labeled, `missing labeled element for zone "${el}"`).not.toBeNull();
    }
    // Only the 10 real buttons (not yawBar/throttle, which are axes with no button icon) get an SVG.
    const buttonZones = [
      TouchZoneId.Trigger, TouchZoneId.Launch, TouchZoneId.CycleWeapon, TouchZoneId.CycleTarget,
      TouchZoneId.GearToggle, TouchZoneId.AirbrakeToggle, TouchZoneId.Afterburner,
      TouchZoneId.Brakes, TouchZoneId.CameraCycle, TouchZoneId.MenuToggle,
    ];
    for (const zone of buttonZones) {
      const btn = container.querySelector(`[aria-label="${zone}"]`)!;
      const svg = btn.querySelector('svg');
      expect(svg, `zone "${zone}" has no <svg> icon`).not.toBeNull();
      expect(svg!.innerHTML.trim().length, `zone "${zone}"'s <svg> is empty`).toBeGreaterThan(0);
    }

    reader.dispose();
  });

  it('every button zone has a distinct icon (no two zones accidentally share identical markup)', () => {
    const container = makeContainer();
    const reader = createTouchReader();
    reader.attach(container);

    const zones = [
      TouchZoneId.Trigger, TouchZoneId.Launch, TouchZoneId.CycleWeapon, TouchZoneId.CycleTarget,
      TouchZoneId.GearToggle, TouchZoneId.AirbrakeToggle, TouchZoneId.Afterburner,
      TouchZoneId.Brakes, TouchZoneId.CameraCycle, TouchZoneId.MenuToggle,
    ];
    const innerMarkups = zones.map((z) => container.querySelector(`[aria-label="${z}"] svg`)!.innerHTML);
    expect(new Set(innerMarkups).size).toBe(zones.length);

    reader.dispose();
  });

  it('setVisible(false) hides the whole overlay in one call, setVisible(true) shows it again', () => {
    // touch.ts itself is deliberately policy-free (see this file's own header note) — attach()
    // leaves visibility at the CSS default (visible); it's playerPilot.ts's job to call
    // setVisible() right after attach() based on the actual InputControlScheme (confirmed by a
    // separate wiring, not re-tested here). This test just proves the toggle itself works.
    const container = makeContainer();
    const reader = createTouchReader();
    reader.attach(container);

    // The wrapper (overlayRootEl) is the only element besides the invisible safe-area probe
    // directly under container; find it by locating a button's parent.
    const anyButton = container.querySelector(`[aria-label="${TouchZoneId.Trigger}"]`) as HTMLElement;
    const wrapper = anyButton.parentElement as HTMLElement;
    expect(wrapper.parentElement).toBe(container);

    expect(wrapper.style.display).not.toBe('none'); // attach()'s own default: visible
    reader.setVisible(false);
    expect(wrapper.style.display).toBe('none');
    reader.setVisible(true);
    expect(wrapper.style.display).not.toBe('none');

    reader.dispose();
  });

  it('setVisible before attach() and after dispose() is a safe no-op', () => {
    const reader = createTouchReader();
    expect(() => reader.setVisible(true)).not.toThrow();
    const container = makeContainer();
    reader.attach(container);
    reader.dispose();
    expect(() => reader.setVisible(true)).not.toThrow();
  });

  it('dispose() removes every element this module added, leaving the container empty', () => {
    const container = makeContainer();
    const reader = createTouchReader();
    reader.attach(container);
    expect(container.children.length).toBeGreaterThan(0);
    reader.dispose();
    expect(container.children.length).toBe(0);
  });
});
