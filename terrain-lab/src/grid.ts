/** terrain-lab/src/grid.ts - ring grid layout shared by the worker and the viewer. */

/** Grid indices of the ring's edge, in order round it (4n of them). */
export function perimeter(n: number): number[] {
  const out: number[] = [];
  const at = (i: number, j: number): number => j * (n + 1) + i;
  for (let i = 0; i < n; i++) out.push(at(i, 0));
  for (let j = 0; j < n; j++) out.push(at(n, j));
  for (let i = n; i > 0; i--) out.push(at(i, n));
  for (let j = n; j > 0; j--) out.push(at(0, j));
  return out;
}
