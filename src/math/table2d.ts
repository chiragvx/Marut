/**
 * src/math/table2d.ts — bilinear lookup-table interpolation with edge clamping on both axes.
 * See docs/spec/01-math.md section 4.9.
 *
 * Allocation-free: segment search is inlined (no helper returning an
 * {index,t} object) since this runs every physics tick from src/physics's
 * aero/engine table lookups (00-architecture.md section 2's hot-path rule).
 */
import type { Interpolate2D } from '../contracts/math';
import { clamp, lerp } from './scalar';

export const interpolate2D: Interpolate2D = (table, x, y) => {
  const xs = table.xs;
  const ys = table.ys;
  const zs = table.zs;
  const nx = xs.length;
  const ny = ys.length;

  const xc = clamp(x, xs[0] as number, xs[nx - 1] as number);
  const yc = clamp(y, ys[0] as number, ys[ny - 1] as number);

  let i = 0;
  let tx = 0;
  if (nx === 1) {
    i = 0;
    tx = 0;
  } else {
    for (let k = 0; k < nx - 1; k++) {
      const xkNext = xs[k + 1] as number;
      if (xc <= xkNext || k === nx - 2) {
        const xk = xs[k] as number;
        const span = xkNext - xk;
        i = k;
        tx = span === 0 ? 0 : (xc - xk) / span;
        break;
      }
    }
  }

  let j = 0;
  let ty = 0;
  if (ny === 1) {
    j = 0;
    ty = 0;
  } else {
    for (let k = 0; k < ny - 1; k++) {
      const ykNext = ys[k + 1] as number;
      if (yc <= ykNext || k === ny - 2) {
        const yk = ys[k] as number;
        const span = ykNext - yk;
        j = k;
        ty = span === 0 ? 0 : (yc - yk) / span;
        break;
      }
    }
  }

  const rowI = zs[i] as readonly number[];
  const z00 = rowI[j] as number;
  const z01 = ny === 1 ? z00 : (rowI[j + 1] as number);

  let z10: number;
  let z11: number;
  if (nx === 1) {
    z10 = z00;
    z11 = z01;
  } else {
    const rowI1 = zs[i + 1] as readonly number[];
    z10 = rowI1[j] as number;
    z11 = ny === 1 ? z10 : (rowI1[j + 1] as number);
  }

  return lerp(lerp(z00, z10, tx), lerp(z01, z11, tx), ty);
};
