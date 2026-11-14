/**
 * src/hud/flapStatus.ts — the flap setting in words, for the HUD's status corner, the on-screen
 * Flaps − / + buttons and the system notices (src/ui/systemNotices.ts).
 *
 * Inputs are the snapshot's SnapshotHudExt.FLAP_LEVER (the lever's detent, 0 = UP) and FLAP_POS (the
 * flaps' position in detent units, fractional while they travel), with the aircraft's detent names
 * (AircraftDefinition.highLift.detents, e.g. UP / SLATS / 1/2 / 3/4 / FULL on the C-17).
 */

/** Flaps closer than this to the lever's detent (detent units) count as there. */
export const FLAP_SETTLED_EPS = 0.01;

export interface FlapSetting {
  /** The lever's detent name ('UP', 'SLATS', '1/2', ...). */
  name: string;
  /** The flaps are still moving to it. */
  transit: boolean;
  /** Moving down (more flap) / up, while in transit. */
  extending: boolean;
}

/** The detent's name, or its number when the aircraft gave none. */
export function flapDetentName(names: readonly string[] | undefined, detent: number): string {
  const i = Math.max(0, Math.round(detent));
  return names?.[i] ?? String(i);
}

/** The setting for a lever position and the flaps' position; undefined for aircraft without flaps (negative values). */
export function flapSetting(names: readonly string[] | undefined, lever: number, pos: number): FlapSetting | undefined {
  if (!(lever >= 0) || !(pos >= 0)) return undefined;
  const transit = Math.abs(pos - lever) > FLAP_SETTLED_EPS;
  return { name: flapDetentName(names, lever), transit, extending: transit && lever > pos };
}

/** The HUD's cue: "FLAPS UP", "FLAPS 1/2", "SLATS"; with an arrow (down / up) while they travel. */
export function flapHudText(s: Readonly<FlapSetting>): string {
  const label = s.name === 'SLATS' ? 'SLATS' : `FLAPS ${s.name}`;
  return s.transit ? `${label} ${s.extending ? '↓' : '↑'}` : label;
}

/**
 * The flap cue under the gear cue: green when set, amber while travelling. Nothing for aircraft
 * without flaps.
 */
export function drawFlapIndicator(ctx: CanvasRenderingContext2D, names: readonly string[] | undefined, lever: number, pos: number, xPx: number, yPx: number): void {
  const s = flapSetting(names, lever, pos);
  if (!s) return;
  ctx.save();
  ctx.font = '12px monospace';
  ctx.fillStyle = s.transit ? '#ffc040' : s.name === 'UP' ? 'rgba(64, 255, 96, 0.45)' : '#40ff60';
  ctx.fillText(flapHudText(s), xPx, yPx);
  ctx.restore();
}
