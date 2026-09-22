/**
 * src/math/table1d.ts — 1D linear lookup-table interpolation with edge clamping.
 * See docs/spec/01-math.md section 4.8.
 */
import type { Interpolate1D } from '../contracts/math';
import { clamp } from './scalar';

export const interpolate1D: Interpolate1D = (table, x) => {
  const xs = table.xs;
  const ys = table.ys;
  const n = xs.length;
  if (n === 1) return ys[0] as number;
  const x0 = xs[0] as number;
  const xLast = xs[n - 1] as number;
  const xc = clamp(x, x0, xLast);
  for (let i = 0; i < n - 1; i++) {
    const xiNext = xs[i + 1] as number;
    if (xc <= xiNext || i === n - 2) {
      const xi = xs[i] as number;
      const span = xiNext - xi;
      const t = span === 0 ? 0 : (xc - xi) / span;
      const yi = ys[i] as number;
      const yiNext = ys[i + 1] as number;
      return yi + (yiNext - yi) * t;
    }
  }
  // Unreachable given n >= 2, but keeps control flow total for strict TS.
  return ys[n - 1] as number;
};
