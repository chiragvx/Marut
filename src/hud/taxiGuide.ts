/**
 * src/hud/taxiGuide.ts — taxi guidance on the HUD: a follow-me cue along a taxi route
 * (src/airport/taxiGraph.ts, requested with the taxi-guide key).
 *
 * The route is drawn over the ground ahead as a line of dots (every 10 m, out to 200 m) with a
 * diamond a little ahead of the aircraft (further ahead the faster it taxis) to steer for, and one
 * instruction at a time: the next turn ("TURN LEFT 120 M"), "HOLD SHORT RWY 31" at the holding
 * point, "LINE UP RWY 31" once past it, or "STAND 12 - 40 M" on the way in. It clears itself on
 * arrival, at take-off speed, or when airborne.
 */
import type { CameraState } from '../contracts/render';

export interface TaxiGuideRoute {
  points: readonly (readonly [number, number])[];
  groundY: number;
  holdIndex: number;
  runwayId: string;
  standNumber: number;
}

export interface TaxiGuideState {
  route: (TaxiGuideRoute & { cum: Float64Array }) | undefined;
  message: string | undefined;
  messageUntilMs: number;
  arrivedAtMs: number;
}

export function createTaxiGuideState(): TaxiGuideState {
  return { route: undefined, message: undefined, messageUntilMs: 0, arrivedAtMs: 0 };
}

export function setTaxiGuide(st: TaxiGuideState, guide: TaxiGuideRoute | { message: string } | null, nowMs: number): void {
  st.arrivedAtMs = 0;
  if (!guide) {
    st.route = undefined;
    st.message = undefined;
    return;
  }
  if ('message' in guide) {
    st.route = undefined;
    st.message = guide.message;
    st.messageUntilMs = nowMs + 3000;
    return;
  }
  const cum = new Float64Array(guide.points.length);
  for (let i = 1; i < guide.points.length; i++) {
    const [ax, az] = guide.points[i - 1]!;
    const [bx, bz] = guide.points[i]!;
    cum[i] = cum[i - 1]! + Math.hypot(bx - ax, bz - az);
  }
  st.route = { ...guide, cum };
  st.message = undefined;
}

const TAU = Math.PI * 2;
const wrap = (a: number): number => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;

/** The point, and the heading of the route, at distance s along it. */
function at(r: NonNullable<TaxiGuideState['route']>, s: number, out: { x: number; z: number; h: number }): void {
  const n = r.points.length;
  const total = r.cum[n - 1]!;
  const t = Math.max(0, Math.min(total, s));
  let i = 1;
  while (i < n - 1 && r.cum[i]! < t) i++;
  const [ax, az] = r.points[i - 1]!;
  const [bx, bz] = r.points[i]!;
  const seg = r.cum[i]! - r.cum[i - 1]! || 1;
  const f = (t - r.cum[i - 1]!) / seg;
  out.x = ax + (bx - ax) * f;
  out.z = az + (bz - az) * f;
  out.h = Math.atan2(bx - ax, -(bz - az));
}

const scratch = { x: 0, z: 0, h: 0 };
const scratch2 = { x: 0, z: 0, h: 0 };

/** Draws the guidance; returns false once it has finished (arrived / took off) so the caller can drop it. */
export function drawTaxiGuide(
  ctx: CanvasRenderingContext2D,
  st: TaxiGuideState,
  player: { x: number; z: number },
  speedMps: number,
  camera: CameraState,
  widthPx: number,
  heightPx: number,
  nowMs: number
): boolean {
  const textY = heightPx * 0.72;
  ctx.save();
  ctx.font = '14px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#40ff60';
  ctx.strokeStyle = '#40ff60';
  if (!st.route) {
    if (st.message && nowMs < st.messageUntilMs) ctx.fillText(st.message, widthPx * 0.5, textY);
    ctx.restore();
    return st.message !== undefined && nowMs < st.messageUntilMs;
  }
  const r = st.route;
  if (speedMps > 60) {
    ctx.restore();
    return false;
  }
  // Where the aircraft is along the route.
  let s0 = 0;
  let lateral = Infinity;
  for (let i = 1; i < r.points.length; i++) {
    const [ax, az] = r.points[i - 1]!;
    const [bx, bz] = r.points[i]!;
    const ux = bx - ax;
    const uz = bz - az;
    const l2 = ux * ux + uz * uz || 1e-9;
    const t = Math.max(0, Math.min(1, ((player.x - ax) * ux + (player.z - az) * uz) / l2));
    const d = Math.hypot(player.x - (ax + ux * t), player.z - (az + uz * t));
    if (d < lateral) {
      lateral = d;
      s0 = r.cum[i - 1]! + t * Math.sqrt(l2);
    }
  }
  const total = r.cum[r.points.length - 1]!;
  const remaining = total - s0;

  // Project world (x, groundY, z) to the screen.
  const m = camera.viewProjectionMatrix;
  const o = camera.originWorld;
  const project = (x: number, z: number): [number, number] | undefined => {
    const px = x - o.x;
    const py = r.groundY + 0.5 - o.y;
    const pz = z - o.z;
    const cw = m[3]! * px + m[7]! * py + m[11]! * pz + m[15]!;
    if (cw <= 0.5) return undefined;
    const cx = (m[0]! * px + m[4]! * py + m[8]! * pz + m[12]!) / cw;
    const cy = (m[1]! * px + m[5]! * py + m[9]! * pz + m[13]!) / cw;
    return [(cx * 0.5 + 0.5) * widthPx, (1 - (cy * 0.5 + 0.5)) * heightPx];
  };

  // Dots along the next 200 m, and the follow-me diamond.
  for (let k = 1; k <= 20; k++) {
    const s = s0 + k * 10;
    if (s > total) break;
    at(r, s, scratch);
    const p = project(scratch.x, scratch.z);
    if (p) ctx.fillRect(p[0] - 2, p[1] - 2, 4, 4);
  }
  at(r, Math.min(total, s0 + 25 + speedMps * 1.5), scratch);
  const d = project(scratch.x, scratch.z);
  if (d) {
    const sz = 9;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(d[0], d[1] - sz);
    ctx.lineTo(d[0] + sz, d[1]);
    ctx.lineTo(d[0], d[1] + sz);
    ctx.lineTo(d[0] - sz, d[1]);
    ctx.closePath();
    ctx.stroke();
  }

  // The instruction.
  let text: string;
  let done = false;
  const toHold = r.holdIndex >= 0 ? r.cum[r.holdIndex]! - s0 : -Infinity;
  if (lateral > 40) {
    text = 'OFF ROUTE  —  PRESS H FOR A NEW ROUTE';
  } else if (r.runwayId && toHold <= 3) {
    text = `LINE UP RWY ${r.runwayId}`;
    if (remaining < 20 && speedMps > 35) done = true;
  } else if (!r.runwayId && remaining < 10) {
    text = `ON STAND ${r.standNumber}`;
    if (speedMps < 1.5) {
      if (!st.arrivedAtMs) st.arrivedAtMs = nowMs;
      if (nowMs - st.arrivedAtMs > 3000) done = true;
    }
  } else {
    // The next significant turn within 150 m (before the holding point).
    at(r, s0, scratch);
    let turn = '';
    for (let x = 20; x <= 150 && s0 + x < total; x += 10) {
      if (r.runwayId && x > toHold) break;
      at(r, s0 + x, scratch2);
      const dh = wrap(scratch2.h - scratch.h);
      if (Math.abs(dh) > (35 * Math.PI) / 180) {
        turn = `TURN ${dh > 0 ? 'RIGHT' : 'LEFT'}  ${Math.max(0, Math.round((x - 15) / 10) * 10)} M`;
        break;
      }
    }
    if (turn) text = turn;
    else if (r.runwayId && toHold < 300) text = `HOLD SHORT RWY ${r.runwayId}  ${Math.max(0, Math.round(toHold / 10) * 10)} M`;
    else if (r.runwayId) text = `TAXI TO RWY ${r.runwayId}  ${Math.round(Math.max(0, toHold) / 10) * 10} M`;
    else text = `STAND ${r.standNumber}  —  ${Math.round(remaining / 10) * 10} M`;
  }
  ctx.fillText(text, widthPx * 0.5, textY);
  ctx.restore();
  return !done;
}
