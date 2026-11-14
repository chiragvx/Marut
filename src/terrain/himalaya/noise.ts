/**
 * src/terrain/himalaya/noise.ts - seeded 2D gradient noise with analytic derivatives, and the fractal
 * sums built on it (plain fbm, "eroded" fbm, ridged multifractal). Deterministic: the same seed
 * gives the same mountains on every machine and in every worker.
 */

export class Noise2 {
  private readonly perm = new Uint16Array(512);
  private readonly gx = new Float64Array(256);
  private readonly gz = new Float64Array(256);
  /** Scratch for derivative-free callers. */
  private readonly scratch = new Float64Array(2);

  constructor(seed: number) {
    let s = seed >>> 0 || 1;
    const rnd = (): number => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
    const p: number[] = [];
    for (let i = 0; i < 256; i++) p.push(i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = p[i]!; p[i] = p[j]!; p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
    for (let i = 0; i < 256; i++) {
      const a = rnd() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gz[i] = Math.sin(a);
    }
  }

  /** Gradient noise in about [-1, 1]; its x/z derivatives go to d[0], d[1]. */
  noised(x: number, z: number, d: Float64Array): number {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    const dux = 30 * fx * fx * (fx * (fx - 2) + 1);
    const duz = 30 * fz * fz * (fz * (fz - 2) + 1);
    const P = this.perm, GX = this.gx, GZ = this.gz;
    const xi = ix & 255, zi = iz & 255;
    const a = P[P[xi]! + zi]!, b = P[P[xi + 1]! + zi]!, c = P[P[xi]! + zi + 1]!, e = P[P[xi + 1]! + zi + 1]!;
    const gax = GX[a]!, gaz = GZ[a]!, gbx = GX[b]!, gbz = GZ[b]!, gcx = GX[c]!, gcz = GZ[c]!, gdx = GX[e]!, gdz = GZ[e]!;
    const va = gax * fx + gaz * fz;
    const vb = gbx * (fx - 1) + gbz * fz;
    const vc = gcx * fx + gcz * (fz - 1);
    const vd = gdx * (fx - 1) + gdz * (fz - 1);
    const k = va - vb - vc + vd;
    const v = va + ux * (vb - va) + uz * (vc - va) + ux * uz * k;
    d[0] = 1.4 * (gax + ux * (gbx - gax) + uz * (gcx - gax) + ux * uz * (gax - gbx - gcx + gdx) + dux * (uz * k + vb - va));
    d[1] = 1.4 * (gaz + ux * (gbz - gaz) + uz * (gcz - gaz) + ux * uz * (gaz - gbz - gcz + gdz) + duz * (ux * k + vc - va));
    return 1.4 * v;
  }

  noise(x: number, z: number): number {
    return this.noised(x, z, this.scratch);
  }

  /** Plain fractal sum, about [-1, 1]. */
  fbm(x: number, z: number, octaves: number): number {
    let sum = 0, amp = 1, norm = 0, px = x, pz = z;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise(px, pz);
      norm += amp;
      amp *= 0.5;
      const nx = 1.6 * px - 1.2 * pz;
      pz = 1.2 * px + 1.6 * pz + 17.3;
      px = nx + 31.7;
    }
    return sum / norm;
  }

  /**
   * "Eroded" fbm: each octave is damped where the octaves above it are already steep, so slopes
   * stay smooth and long while crests and gullies stay sharp (the derivative-damped sum used for
   * procedural mountains). About [-1, 1].
   */
  erodedFbm(x: number, z: number, octaves: number): number {
    const d = this.scratch;
    let sum = 0, amp = 1, norm = 0, dx = 0, dz = 0, px = x, pz = z;
    for (let i = 0; i < octaves; i++) {
      const v = this.noised(px, pz, d);
      dx += d[0]!;
      dz += d[1]!;
      sum += amp * v / (1 + 0.7 * (dx * dx + dz * dz));
      norm += amp;
      amp *= 0.5;
      const nx = 1.6 * px - 1.2 * pz;
      pz = 1.2 * px + 1.6 * pz + 17.3;
      px = nx + 31.7;
    }
    return sum / norm * 1.6;
  }

  /** Ridged multifractal: sharp crests where the noise crosses zero, about [0, 1]. */
  ridged(x: number, z: number, octaves: number): number {
    let sum = 0, amp = 1, norm = 0, w = 1, px = x, pz = z;
    for (let i = 0; i < octaves; i++) {
      let n = 1 - Math.abs(this.noise(px, pz));
      n *= n;
      n *= w;
      w = Math.min(1, Math.max(0, n * 1.8));
      sum += amp * n;
      norm += amp;
      amp *= 0.5;
      const nx = 1.6 * px - 1.2 * pz;
      pz = 1.2 * px + 1.6 * pz + 17.3;
      px = nx + 31.7;
    }
    return sum / norm * 1.5;
  }
}

/**
 * Analytic erosion ("gully noise"): stripes running down the slope (perpendicular to `dir`, which
 * is the slope gradient turned 90 degrees), blended over jittered cell points. Summed over octaves,
 * each octave's stripes bend along the gullies of the one before, which reads as branching
 * drainage. After the eroded-terrain technique popularised on Shadertoy (C. John, 2022).
 * Returns value in about [-1, 1]; its derivative (per cell unit) goes to d[0], d[1].
 */
function gullyCell(px: number, pz: number, dirx: number, dirz: number, d: Float64Array): number {
  const ix = Math.floor(px), iz = Math.floor(pz);
  const fx = px - ix, fz = pz - iz;
  let v = 0, dx = 0, dz = 0, wt = 0;
  for (let i = -2; i <= 1; i++) {
    for (let j = -2; j <= 1; j++) {
      // Jittered cell point (integer hash, no tables).
      let hsh = (Math.imul(ix - i, 374761393) + Math.imul(iz - j, 668265263)) | 0;
      hsh = Math.imul(hsh ^ (hsh >>> 13), 1274126177);
      hsh ^= hsh >>> 16;
      const ppx = fx + i - (hsh & 0xffff) * (0.5 / 65535);
      const ppz = fz + j - ((hsh >>> 16) & 0xffff) * (0.5 / 65535);
      // exp(-2 r^2), approximated by a smooth compact bump.
      const q = 1 - (ppx * ppx + ppz * ppz) * 0.4;
      if (q <= 0) continue;
      const q2 = q * q;
      const w = q2 * q2;
      wt += w;
      // sin/cos of 2*pi*t by a parabolic approximation (max error ~0.001).
      let t = ppx * dirx + ppz * dirz;
      t -= Math.round(t);
      const s = fastSin2Pi(t);
      let tc = t + 0.25;
      tc -= Math.round(tc);
      const c = fastSin2Pi(tc);
      v += c * w;
      dx -= s * dirx * w;
      dz -= s * dirz * w;
    }
  }
  const iw = wt > 0 ? 1 / wt : 0;
  d[0] = dx * iw;
  d[1] = dz * iw;
  return v * iw;
}

/** sin(2 pi t) for t in [-0.5, 0.5]. */
function fastSin2Pi(t: number): number {
  const s0 = 8 * t - 16 * t * Math.abs(t);
  return 0.225 * (s0 * Math.abs(s0) - s0) + s0;
}

const gd = new Float64Array(2);

/**
 * Gully field at world (x, z) for a terrain whose slope (m/m) is (gx, gz): cells of `cellM` metres,
 * `octaves` octaves. About [-1, 1]: negative in gullies, positive on the spurs between them.
 */
export function gullies(x: number, z: number, gx: number, gz: number, cellM: number, octaves: number, slopeStrength = 2.5, branch = 1.5): number {
  // Perpendicular to the gradient: stripes then run downhill.
  const dirx = gz * slopeStrength, dirz = -gx * slopeStrength;
  let v = 0, hdx = 0, hdz = 0, a = 0.5, f = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const val = gullyCell((x / cellM) * f, (z / cellM) * f, dirx + hdz * branch, dirz - hdx * branch, gd);
    v += val * a;
    hdx += gd[0]! * a * f;
    hdz += gd[1]! * a * f;
    norm += a;
    a *= 0.5;
    f *= 2;
  }
  return v / norm;
}
