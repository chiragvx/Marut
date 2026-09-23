/**
 * src/input/touchIcons.ts — icon markup for the touch-control overlay's buttons (touch.ts).
 *
 * Every touch button used to render as a plain, empty bordered box with no icon at all — this
 * fills that gap. Icons are hand-copied inner-SVG markup from Lucide (https://lucide.dev,
 * ISC license — permissive, attribution not required but given here anyway), fetched directly
 * from https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/<name>.svg on 2026-09-23
 * and pasted verbatim (not re-typed/approximated) so the path data is exact. Deliberately NOT an
 * npm dependency: this project has a "no other runtime deps" rule and an already-flagged 604KB
 * bundle-size warning, so only the ~11 icons actually needed are inlined here rather than pulling
 * in an icon package.
 *
 * Each entry is the *inner* markup of a 24x24-viewBox Lucide icon (its own <svg> wrapper is not
 * included — touch.ts wraps this in one shared <svg> per button, see applyButtonIcon below).
 */
import type { TouchZoneId as TouchZoneIdType } from '../contracts/input';
import { TouchZoneId } from '../contracts/input';

type ButtonZoneId = Exclude<TouchZoneIdType, 'stick' | 'yawBar' | 'throttle'>;

// prettier-ignore
export const TOUCH_ZONE_ICON_INNER_SVG: Readonly<Record<ButtonZoneId, string>> = {
  // crosshair — a weapon reticle is the natural fit for firing the gun.
  [TouchZoneId.Trigger]: '<circle cx="12" cy="12" r="10"/><line x1="22" x2="18" y1="12" y2="12"/><line x1="6" x2="2" y1="12" y2="12"/><line x1="12" x2="12" y1="6" y2="2"/><line x1="12" x2="12" y1="22" y2="18"/>',
  // rocket — missile launch.
  [TouchZoneId.Launch]: '<path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09"/><path d="M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05"/>',
  // refresh-cw — cycling through the weapon loadout.
  [TouchZoneId.CycleWeapon]: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  // target — target-lock cycling.
  [TouchZoneId.CycleTarget]: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  // disc — Lucide has no literal landing-gear glyph; a wheel is the closest stand-in.
  [TouchZoneId.GearToggle]: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="2"/>',
  // chevrons-up — deployed airbrake/speedbrake panels.
  [TouchZoneId.AirbrakeToggle]: '<path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/>',
  // flame — afterburner.
  [TouchZoneId.Afterburner]: '<path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4"/>',
  // move-horizontal — Lucide has no steering-wheel glyph; left-right motion reads as nosewheel steer.
  [TouchZoneId.NwsToggle]: '<path d="m18 8 4 4-4 4"/><path d="M2 12h20"/><path d="m6 8-4 4 4 4"/>',
  // octagon — universal stop/brake sign, visually distinct from AirbrakeToggle's chevrons.
  [TouchZoneId.Brakes]: '<path d="M2.586 16.726A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2h6.624a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586z"/>',
  // camera — camera-mode cycle.
  [TouchZoneId.CameraCycle]: '<path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"/><circle cx="12" cy="13" r="3"/>',
  // menu — pause/menu toggle.
  [TouchZoneId.MenuToggle]: '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',
};

/**
 * Builds a self-contained inline `<svg>` string sized to fill its parent button (assumes the
 * button is the `position:relative`/`absolute`-positioned element from createOverlayDiv, so a
 * centered, size-capped icon just needs simple percentage sizing — see touch.ts's
 * applyButtonIcon). `pointer-events:none` keeps the existing touchstart/touchmove hit-testing
 * (which uses rectContains against buttonRects, not DOM event targets) untouched.
 */
export function buttonIconSvgMarkup(zone: ButtonZoneId): string {
  const inner = TOUCH_ZONE_ICON_INNER_SVG[zone];
  return (
    '<svg viewBox="0 0 24 24" width="60%" height="60%" ' +
    'style="position:absolute;top:20%;left:20%;pointer-events:none" ' +
    'fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    inner +
    '</svg>'
  );
}
