/**
 * =============================================================================
 * TEJAS SIM — MATH CONTRACT (docs/spec/contracts/math.ts)
 * =============================================================================
 * Owner: module 01 (docs/spec/01-math.md). This is the ONE shared runtime
 * library every other module may depend on (00-architecture.md section 8).
 * It imports only from './core'. Every other contract file may
 * `import type { ... } from './math'` in addition to `'./core'`.
 *
 * This file contains ONLY interfaces, type aliases, `as const`/plain numeric
 * constants, and bare function-signature type aliases. It also uses the
 * standard TypeScript "instance-type + value-of-static-shape" pattern (the
 * same pattern `lib.es5.d.ts` uses for `Array`/`String`: an `interface Foo`
 * or `type Foo = ...` declares the TYPE `Foo`, and a separate
 * `export declare const Foo: FooStatic` declares that a VALUE named `Foo`
 * will exist at that type — this is a pure ambient declaration, it contains
 * NO body and emits NO code under `tsc --noEmit`). This lets the contract
 * pin down the exact dot-notation call sites `Vec3.add(...)`,
 * `Quat.rotate(...)`, `Quat.fromYawPitchRoll(...)`, `Mat3.invert(...)` etc.
 * that 00-architecture.md section 3 mandates verbatim, while still
 * containing zero implementation. `src/math/*.ts` is the ONLY place that
 * actually assigns a real object to `Vec3`/`Quat`/`Mat3`.
 *
 * ALL functions below are allocation-free and hot-path-safe UNLESS their doc
 * comment says otherwise. `out` is always the LAST parameter, is always
 * written unconditionally (every field, every call, even on edge cases —
 * never partially written), is always returned, and MAY safely alias any
 * `Vec3Like`/`QuatLike`/`Mat3` input argument (in-place update), e.g.
 * `Vec3.add(a, b, a)` is legal and writes the sum into `a`. Implementations
 * must read every input value they need BEFORE writing to `out` to make
 * aliasing safe (see 01-math.md section 4 for the exact per-function
 * aliasing note where it is non-obvious, e.g. `Mat3.multiply`).
 *
 * Full derivations, worked numeric examples (cross-checked against
 * 00-architecture.md section 3's own worked examples, and additionally
 * verified by a 200,000-sample randomized round-trip test — see
 * 01-math.md section 4) and algorithms live in `docs/spec/01-math.md`.
 * This file is the terse, compilable surface; 01-math.md is the tie-breaker
 * only for prose explanation, never for the shapes below (which are law).
 * =============================================================================
 */

import type { Vec3Like, QuatLike } from './core';

// -----------------------------------------------------------------------------
// 0. Shared numeric constants. Every module reads these from here; nobody
//    redefines them locally. See 01-math.md section 5 for derivation of the
//    PRNG/hash magic numbers.
// -----------------------------------------------------------------------------

/** Default absolute-difference tolerance used by `Vec3.equals`/`Quat.equals`/`Mat3.equals` when no `epsilon` argument is given. */
export const DEFAULT_EPSILON = 1e-6;
/** Below this absolute determinant magnitude, `Mat3.invert` treats the matrix as singular: it writes the identity into `out` and returns `false` rather than dividing by (near-)zero. */
export const MAT3_INVERT_EPSILON = 1e-9;
/** `Quat.slerp` falls back to `Quat.nlerp`'s formula (see 01-math.md section 4.4) when `|dot(a,b)| >= SLERP_DOT_THRESHOLD`, to avoid the numerically unstable `sin(angle)` denominator for near-identical or near-opposite quaternions. */
export const SLERP_DOT_THRESHOLD = 0.9995;
/** FNV-1a 32-bit offset basis, used by `deriveSubSeed`. */
export const FNV_OFFSET_BASIS_32 = 2166136261;
/** FNV-1a 32-bit prime, used by `deriveSubSeed`. */
export const FNV_PRIME_32 = 16777619;
/** 32-bit odd multiplicative mixing constant (2^32 / golden ratio, rounded to odd), used by `deriveSubSeed` to mix `rootSeed` into the FNV-1a hash of `tag`. */
export const SEED_MIX_MULTIPLIER_32 = 0x9e3779b1;
/** mulberry32 per-call state increment. See 01-math.md section 4.6 for the full algorithm. */
export const MULBERRY32_INCREMENT = 0x6d2b79f5;

// -----------------------------------------------------------------------------
// 1. Vec3 — mutable 3-vector. `Vec3` is a type alias for `Vec3Like` (plain
//    mutable {x,y,z}); there is no wrapper class. All operations are static
//    methods reached through the `Vec3` namespace value.
// -----------------------------------------------------------------------------

/** A mutable 3-vector. Structurally identical to `Vec3Like`; this alias exists so math signatures read `Vec3` while remaining 100% interchangeable with any `{x,y,z}` object from core.ts or any other contract. */
export type Vec3 = Vec3Like;

export interface Vec3Static {
  /** Writes `(x,y,z)` into `out` and returns it. */
  set(out: Vec3Like, x: number, y: number, z: number): Vec3Like;
  /** Copies `src` into `out` and returns it. */
  copy(out: Vec3Like, src: Readonly<Vec3Like>): Vec3Like;
  /** `out = a + b`. */
  add(a: Readonly<Vec3Like>, b: Readonly<Vec3Like>, out: Vec3Like): Vec3Like;
  /** `out = a - b`. */
  sub(a: Readonly<Vec3Like>, b: Readonly<Vec3Like>, out: Vec3Like): Vec3Like;
  /** `out = a * s` (component-wise scalar multiply). */
  scale(a: Readonly<Vec3Like>, s: number, out: Vec3Like): Vec3Like;
  /** `out = a + b * s`. The single fused op the integrator (`src/physics`) and PN guidance (`src/combat`) use to avoid an intermediate `scale`+`add` pair per call. */
  addScaled(a: Readonly<Vec3Like>, b: Readonly<Vec3Like>, s: number, out: Vec3Like): Vec3Like;
  /** `out = -a`. */
  negate(a: Readonly<Vec3Like>, out: Vec3Like): Vec3Like;
  /** Dot product, no allocation (returns a number, not an object). */
  dot(a: Readonly<Vec3Like>, b: Readonly<Vec3Like>): number;
  /** `out = a × b` (right-handed cross product). Safe when `out` aliases `a` or `b` (reads both fully into locals before writing `out`). */
  cross(a: Readonly<Vec3Like>, b: Readonly<Vec3Like>, out: Vec3Like): Vec3Like;
  /** Euclidean length of `a`. */
  length(a: Readonly<Vec3Like>): number;
  /** Squared length of `a` (no `sqrt`; prefer this for comparisons, e.g. nearest-contact selection). */
  lengthSq(a: Readonly<Vec3Like>): number;
  /** `out = a / |a|`. If `|a| === 0` (exactly), writes `out = (0,0,0)` and returns `out` — never divides by zero, never returns NaN (see 01-math.md section 4.1). */
  normalize(a: Readonly<Vec3Like>, out: Vec3Like): Vec3Like;
  /** Euclidean distance between `a` and `b`. */
  distance(a: Readonly<Vec3Like>, b: Readonly<Vec3Like>): number;
  /** Squared distance between `a` and `b`. */
  distanceSq(a: Readonly<Vec3Like>, b: Readonly<Vec3Like>): number;
  /** `out = a + (b - a) * t`, `t` unclamped (callers that want clamping call `clamp(t, 0, 1)` themselves first — kept unclamped here so extrapolation, e.g. snapshot interpolation overshoot, stays possible). */
  lerp(a: Readonly<Vec3Like>, b: Readonly<Vec3Like>, t: number, out: Vec3Like): Vec3Like;
  /** Component-wise approximate equality, `|a.x-b.x| <= epsilon` etc. `epsilon` defaults to `DEFAULT_EPSILON`. For tests, not hot paths. */
  equals(a: Readonly<Vec3Like>, b: Readonly<Vec3Like>, epsilon?: number): boolean;
}

/** The one runtime value implementing `Vec3Static`. `src/math/vec3.ts` exports exactly this: `export const Vec3: Vec3Static = { ... }`. */
export declare const Vec3: Vec3Static;

/** Allocates a new `Vec3`. Defaults to `(0,0,0)`. Use only outside hot paths (init, pool pre-sizing, scratch-object creation) — see 01-math.md section 6. */
export type CreateVec3 = (x?: number, y?: number, z?: number) => Vec3;

// -----------------------------------------------------------------------------
// 2. Quat — mutable unit quaternion, body→world rotation representation.
//    `Quat` is a type alias for `QuatLike` (plain mutable {x,y,z,w}); no
//    wrapper class. See 00-architecture.md section 3.2–3.4 for the frame
//    conventions these formulas implement; 01-math.md section 4 restates and
//    numerically verifies every one of them.
// -----------------------------------------------------------------------------

export type Quat = QuatLike;

/** Output shape of `Quat.toYawPitchRoll`; also the natural input shape a caller assembles before calling `Quat.fromYawPitchRoll`. */
export interface YawPitchRoll {
  /** `[0, 2*PI)`. 0 = north, `PI/2` = east, increasing clockwise from above — see 00-architecture.md section 3.1. */
  headingRad: number;
  /** `+` = nose up. Extraction is exact (via `asin`) for `|pitchRad| < PI/2`; see 01-math.md section 4.3 for the `|pitchRad| -> PI/2` gimbal-adjacent behaviour. */
  pitchRad: number;
  /** `+` = right wing down. */
  rollRad: number;
}

export interface QuatStatic {
  /** Writes `(x,y,z,w)` into `out` and returns it. Does NOT normalize — caller's responsibility if the components aren't already unit length. */
  set(out: QuatLike, x: number, y: number, z: number, w: number): QuatLike;
  /** Copies `src` into `out` and returns it. */
  copy(out: QuatLike, src: Readonly<QuatLike>): QuatLike;
  /** Writes the identity quaternion `(0,0,0,1)` into `out` and returns it. */
  identity(out: QuatLike): QuatLike;
  /** Hamilton product `out = a ⊗ b` (see 00-architecture.md section 3.3 for the exact per-component formula this must implement). Safe when `out` aliases `a` or `b`. NOT commutative: `a⊗b !== b⊗a` in general. */
  multiply(a: Readonly<QuatLike>, b: Readonly<QuatLike>, out: QuatLike): QuatLike;
  /** `out = (-q.x,-q.y,-q.z,q.w)`. For a unit quaternion this equals the inverse. */
  conjugate(q: Readonly<QuatLike>, out: QuatLike): QuatLike;
  /** Magnitude of `q` as a 4-vector. Should be `~1` for any quaternion produced by this library; tests use this to check drift after repeated `integrate` calls. */
  length(q: Readonly<QuatLike>): number;
  /** `out = q / |q|`. If `|q| === 0` (only reachable via caller error, never via `integrate`/`multiply` of valid inputs), writes identity into `out`. */
  normalize(q: Readonly<QuatLike>, out: QuatLike): QuatLike;
  /** 4-component dot product `a.x*b.x + a.y*b.y + a.z*b.z + a.w*b.w`. */
  dot(a: Readonly<QuatLike>, b: Readonly<QuatLike>): number;
  /** Builds the rotation of `angleRad` about `axis` into `out`. PRECONDITION: `axis` must already be unit length (callers always pass a fixed unit axis — world Y, body X, body Z — per 00-architecture.md section 3.3; this function does not normalize `axis` itself, to stay a pure 4-multiply+2-trig-call operation). */
  axisAngle(axis: Readonly<Vec3Like>, angleRad: number, out: QuatLike): QuatLike;
  /** Body→world: `out = q * v * conj(q)`, computed via the allocation-free optimized form (01-math.md section 4.2), NOT via two quaternion multiplies. Safe when `out` aliases `v`. */
  rotate(q: Readonly<QuatLike>, v: Readonly<Vec3Like>, out: Vec3Like): Vec3Like;
  /** World→body: `out = conj(q) * v * q`. Equivalent to, but must NOT be implemented as, `rotate(conjugate(q,...), v, out)` (that would need a scratch quaternion) — implement directly per 01-math.md section 4.2. */
  rotateInverse(q: Readonly<QuatLike>, v: Readonly<Vec3Like>, out: Vec3Like): Vec3Like;
  /** Builds `q = qYaw ⊗ qPitch ⊗ qRoll` exactly per 00-architecture.md section 3.3's formula and axis choices. `out` is normalized before return (normalization is a no-op to numerical precision — the closed form in 01-math.md section 4.3 already produces a unit quaternion — but is still required so accumulated float error never compounds). Implemented via the closed-form expansion in 01-math.md section 4.3: pure scalar arithmetic, no intermediate `Quat` objects, no allocation. */
  fromYawPitchRoll(headingRad: number, pitchRad: number, rollRad: number, out: QuatLike): QuatLike;
  /** Inverse of `fromYawPitchRoll`: extracts `(headingRad, pitchRad, rollRad)` from `q` into `out` and returns `out`. `q` is assumed unit length (caller normalizes upstream if needed — this function does not renormalize `q` itself). Exact closed-form, no iteration; see 01-math.md section 4.3 for the derivation and the `|pitchRad| -> PI/2` edge case. */
  toYawPitchRoll(q: Readonly<QuatLike>, out: YawPitchRoll): YawPitchRoll;
  /** First-order quaternion integration: `dq = 0.5 * (q ⊗ (0,omegaBody)) * dtSec`, `out = normalize(q + dq)`. `omegaBody` is the entity's body-frame angular velocity (rad/s) — the same `EntityState.omega` field, NOT the aerodynamic p/q/r triple. Safe when `out` aliases `q` (this is how `src/physics`'s integrator updates `EntityState.rot` in place every tick). */
  integrate(q: Readonly<QuatLike>, omegaBody: Readonly<Vec3Like>, dtSec: number, out: QuatLike): QuatLike;
  /** Shortest-path spherical interpolation, `t` clamped to `[0,1]` internally. Automatically negates `b` first if `dot(a,b) < 0` (shortest-path fix). Falls back to `nlerp`'s formula when `|dot(a,b)| >= SLERP_DOT_THRESHOLD` (see that constant's doc comment). Used by `src/render`'s snapshot interpolation (module 08) at up to 240 Hz — must be allocation-free. */
  slerp(a: Readonly<QuatLike>, b: Readonly<QuatLike>, t: number, out: QuatLike): QuatLike;
  /** Normalized linear interpolation: `out = normalize(lerp(a,b,t))`, `t` clamped to `[0,1]`, with the same shortest-path `dot<0` fix as `slerp`. Cheaper than `slerp`; visually indistinguishable for the small per-frame angular deltas snapshot interpolation actually sees. */
  nlerp(a: Readonly<QuatLike>, b: Readonly<QuatLike>, t: number, out: QuatLike): QuatLike;
  /** Component-wise approximate equality (does NOT account for the `q == -q` double-cover — callers that care about that compare both `equals(a,b,eps)` and `equals(a,negated_b,eps)`). `epsilon` defaults to `DEFAULT_EPSILON`. */
  equals(a: Readonly<QuatLike>, b: Readonly<QuatLike>, epsilon?: number): boolean;
}

/** The one runtime value implementing `QuatStatic`. `src/math/quat.ts` exports exactly this: `export const Quat: QuatStatic = { ... }`. */
export declare const Quat: QuatStatic;

/** Allocates a new `Quat`, defaulting to identity `(0,0,0,1)`. Use only outside hot paths. */
export type CreateQuat = (x?: number, y?: number, z?: number, w?: number) => Quat;

// -----------------------------------------------------------------------------
// 2.1 Body rates — the ONLY legal way to read an aerodynamic roll/pitch/yaw
//     rate out of `EntityState.omega`. Per 00-architecture.md section 3.4:
//     `p = wx`, `q = wz`, `r = -wy` (Y-up body frame, NOT the textbook
//     Z-down aero body frame). These are flat top-level functions (not
//     grouped under a namespace) because 00-architecture.md's own contract
//     text names them flat: `bodyRateP(omega)`, `bodyRateQ(omega)`,
//     `bodyRateR(omega)`. `src/math/quat.ts` exports all three.
// -----------------------------------------------------------------------------

export type BodyRateP = (omega: Readonly<Vec3Like>) => number; // = omega.x
export type BodyRateQ = (omega: Readonly<Vec3Like>) => number; // = omega.z
export type BodyRateR = (omega: Readonly<Vec3Like>) => number; // = -omega.y

// -----------------------------------------------------------------------------
// 3. Mat3 — mutable 3×3 matrix, row-major. Used for the body-frame inertia
//    tensor (`AircraftDefinition.inertiaBodyKgM2`, contracts/aircraft.ts
//    section 9.1 of 00-architecture.md) and its inverse, which `src/physics`
//    needs every tick to turn net body-frame torque into angular
//    acceleration: `alphaBody = I^-1 * (torque - omega × (I * omega))`.
// -----------------------------------------------------------------------------

/** Row-major 3×3 matrix: row `i`, column `j` is field `m{i}{j}`. `y = M*x` (see `Mat3Static.transformVec3`) reads `y.x = m00*x.x + m01*x.y + m02*x.z`, etc. */
export interface Mat3 {
  m00: number; m01: number; m02: number;
  m10: number; m11: number; m12: number;
  m20: number; m21: number; m22: number;
}

/**
 * The six independent components of a symmetric body-frame inertia tensor,
 * about the CG, kg·m^2. Field names deliberately match
 * `AircraftDefinition.inertiaBodyKgM2` (00-architecture.md section 9.1)
 * structurally (TS structural typing means any `{xx,yy,zz,xy,xz,yz}` object,
 * including that exact field, satisfies this interface with no import and
 * no cast needed) — see 01-math.md section 9 for why `contracts/math.ts`
 * does not import `contracts/aircraft.ts` to name this shape directly.
 */
export interface InertiaComponents {
  xx: number; yy: number; zz: number;
  xy: number; xz: number; yz: number;
}

export interface Mat3Static {
  /** Writes the identity matrix into `out` and returns it. */
  identity(out: Mat3): Mat3;
  /** Writes all nine components (row-major order) into `out` and returns it. */
  set(out: Mat3, m00: number, m01: number, m02: number, m10: number, m11: number, m12: number, m20: number, m21: number, m22: number): Mat3;
  /** Copies `src` into `out` and returns it. */
  copy(out: Mat3, src: Readonly<Mat3>): Mat3;
  /** Builds the symmetric inertia-tensor matrix `[[xx,xy,xz],[xy,yy,yz],[xz,yz,zz]]` into `out` and returns it. */
  fromInertia(i: Readonly<InertiaComponents>, out: Mat3): Mat3;
  /** Matrix product `out = a * b`. Safe when `out` aliases `a` or `b` (reads all nine of each into locals first). */
  multiply(a: Readonly<Mat3>, b: Readonly<Mat3>, out: Mat3): Mat3;
  /** `out = transpose(m)`. Safe when `out` aliases `m`. */
  transpose(m: Readonly<Mat3>, out: Mat3): Mat3;
  /** Determinant of `m`. */
  determinant(m: Readonly<Mat3>): number;
  /** Writes the inverse of `m` into `out` and returns `true`, UNLESS `|determinant(m)| < MAT3_INVERT_EPSILON`, in which case it writes the identity into `out` and returns `false` (never divides by ~zero, never produces `NaN`/`Infinity` — see the "pure math never throws" rule in 00-architecture.md section 13). `out` may alias `m`. */
  invert(m: Readonly<Mat3>, out: Mat3): boolean;
  /** `out = m * v` (matrix-vector product). Safe when `out` aliases `v`. */
  transformVec3(m: Readonly<Mat3>, v: Readonly<Vec3Like>, out: Vec3Like): Vec3Like;
  /** Component-wise approximate equality across all nine fields. `epsilon` defaults to `DEFAULT_EPSILON`. For tests. */
  equals(a: Readonly<Mat3>, b: Readonly<Mat3>, epsilon?: number): boolean;
}

/** The one runtime value implementing `Mat3Static`. `src/math/mat3.ts` exports exactly this: `export const Mat3: Mat3Static = { ... }`. */
export declare const Mat3: Mat3Static;

/** Allocates a new `Mat3`, defaulting to identity. Use only outside hot paths (e.g. once, to build and invert `AircraftDefinition`'s inertia tensor at aircraft-init time). */
export type CreateMat3 = () => Mat3;

// -----------------------------------------------------------------------------
// 4. Scalar helpers. Flat top-level functions (no grouping namespace — none
//    of these are ever written as `Scalar.clamp(...)` anywhere in
//    00-architecture.md, so they stay flat like `bodyRateP` above).
//    `src/math/scalar.ts` exports one const per alias below, using the exact
//    lower-camelCase name obtained by lower-casing the alias's first letter
//    (`Clamp` -> `clamp`, `WrapAngleSigned` -> `wrapAngleSigned`, etc.) —
//    01-math.md section 3 restates every exact export name explicitly.
// -----------------------------------------------------------------------------

/** Clamps `x` into `[min, max]`. PRECONDITION: `min <= max` (undefined result otherwise — caller error, per the "pure math never throws" rule; 01-math.md's tests only exercise `min<=max`). */
export type Clamp = (x: number, min: number, max: number) => number;
/** `clamp(x, 0, 1)`. */
export type Clamp01 = (x: number) => number;
/** `a + (b - a) * t`, `t` unclamped. */
export type Lerp = (a: number, b: number, t: number) => number;
/** Inverse of `lerp`: returns the `t` such that `lerp(a,b,t) === v`, clamped to `[0,1]`. If `a === b`, returns `0` (never divides by zero). */
export type InverseLerp = (a: number, b: number, v: number) => number;
/** Hermite smoothstep: `0` for `x <= edge0`, `1` for `x >= edge1`, cubic ease `3t^2-2t^3` (`t = clamp01((x-edge0)/(edge1-edge0))`) between. If `edge0 === edge1`, returns `x < edge0 ? 0 : 1` (never divides by zero). Used by `HeightSampler`'s flatten-zone blend (00-architecture.md section 9.2) and by fade effects in `src/render`/`src/hud`. */
export type Smoothstep = (edge0: number, edge1: number, x: number) => number;
/** Wraps `rad` into `[-PI, PI)`. */
export type WrapAngleSigned = (rad: number) => number;
/** Wraps `rad` into `[0, 2*PI)`. This is the convention `AircraftTelemetry.headingRad` and `SnapshotHud.HEADING_RAD` use. */
export type WrapAngleUnsigned = (rad: number) => number;
/** `deg * PI / 180`. The only sanctioned way to convert a `*Deg`-suffixed data-table field (00-architecture.md section 2) into the radians the sim runs on. */
export type DegToRad = (deg: number) => number;
/** `rad * 180 / PI`. Used only by data-table authoring tools and UI/HUD display text, never inside `src/physics`/`src/ai`/`src/combat`. */
export type RadToDeg = (rad: number) => number;
/** `-1` if `x < 0`, `1` if `x > 0`, `0` if `x === 0` (including `-0`, which returns `0` not `-0`, unlike raw `Math.sign`). */
export type Sign = (x: number) => number;
/** `Math.abs(a - b) <= epsilon`. `epsilon` defaults to `DEFAULT_EPSILON`. For tests. */
export type ApproxEqual = (a: number, b: number, epsilon?: number) => boolean;

// -----------------------------------------------------------------------------
// 5. 1D / bilinear 2D table interpolation, with clamping (never extrapolate
//    past the table's domain). Used by `src/aircraft`'s `AeroTables` (Cl/Cd/
//    Cm vs alpha and vs alpha+Mach) and `EngineTables` (thrust/fuel-flow vs
//    altitude/Mach/throttle), consumed every physics tick by `src/physics`.
// -----------------------------------------------------------------------------

/** A 1D lookup table. PRECONDITION: `xs.length === ys.length >= 1` and `xs` strictly increasing (`xs[k] < xs[k+1]`). Not validated at this type level — `src/aircraft`'s own data and `tests/aircraft/*` are responsible for that; `interpolate1D` on a malformed table is undefined behaviour, never a throw (00-architecture.md section 13's "pure math never throws" rule). */
export interface Table1D {
  readonly xs: readonly number[];
  readonly ys: readonly number[];
}

/** Linearly interpolates `table.ys` at `x`, clamping `x` to `[xs[0], xs[xs.length-1]]` first (flat extrapolation past the domain edges — never linearly extrapolates). If `table.xs.length === 1`, always returns `table.ys[0]`. See 01-math.md section 4.7 for the exact segment-search algorithm and a worked numeric example. */
export type Interpolate1D = (table: Table1D, x: number) => number;

/**
 * A 2D lookup table for bilinear interpolation. PRECONDITION: `xs` and `ys`
 * each strictly increasing, `zs.length === xs.length`, and
 * `zs[i].length === ys.length` for every `i`. `zs[i][j]` is the table value
 * at `(xs[i], ys[j])`. Which axis (`x` or `y`) represents alpha vs Mach is
 * the *consuming* module's (03's) choice to document, not fixed here —
 * `Table2D` itself is axis-agnostic.
 */
export interface Table2D {
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  readonly zs: readonly (readonly number[])[];
}

/** Bilinearly interpolates `table.zs` at `(x,y)`, clamping `x` to `[xs[0],xs[last]]` and `y` to `[ys[0],ys[last]]` independently first (flat extrapolation on both axes). Degenerates correctly to 1D linear interpolation if `xs.length===1` or `ys.length===1`. See 01-math.md section 4.8 for the exact bilinear formula and a worked numeric example. */
export type Interpolate2D = (table: Table2D, x: number, y: number) => number;

// -----------------------------------------------------------------------------
// 6. Seeded PRNG (mulberry32) and deterministic sub-seed derivation. THE one
//    PRNG for this entire project (00-architecture.md section 2): plain
//    mutable state object + pure `next*` functions, NOT a closure, so it
//    matches this library's out-param/mutable-state style everywhere else
//    and so its state can be snapshotted/logged for replay debugging.
// -----------------------------------------------------------------------------

/** mulberry32 internal state: one 32-bit integer, always treated as unsigned (`s >>> 0`). The ENTIRE state — snapshot `state.s` to save/restore a PRNG stream exactly. */
export interface PrngState {
  s: number;
}

/** Creates a `PrngState` seeded from `seed` (any finite number; only the low 32 bits matter, via `seed >>> 0`). Not hot-path (called once per stream, at init or in `deriveSubSeed` consumers' own init). */
export type CreatePrng = (seed: number) => PrngState;

/** Advances `state` by one step (mutates `state.s`) and returns the next pseudo-random float in `[0,1)`. See 01-math.md section 4.6 for the exact mulberry32 algorithm and worked-example output sequences (these are exact test assertions, not "close to"). */
export type PrngNextFloat01 = (state: PrngState) => number;

/** `min + nextFloat01(state) * (max - min)`. Advances `state` by exactly one step, same as `nextFloat01`. */
export type PrngNextRange = (state: PrngState, min: number, max: number) => number;

/** `minInclusive + floor(nextFloat01(state) * (maxExclusive - minInclusive))`. Advances `state` by exactly one step. PRECONDITION: `maxExclusive > minInclusive`. */
export type PrngNextInt = (state: PrngState, minInclusive: number, maxExclusive: number) => number;

/**
 * Deterministically derives an independent 32-bit sub-seed from a root seed
 * and a string tag, so e.g. terrain noise, each AI aircraft's decision PRNG,
 * and gust jitter all get independent-looking but fully reproducible
 * streams from the one `WorldConfig.seed` (00-architecture.md section 2 /
 * section 13's "no Math.random" rule). Algorithm (see 01-math.md section 4.9
 * for the worked example): `h = fnv1a32(tag)` (offset `FNV_OFFSET_BASIS_32`,
 * prime `FNV_PRIME_32`); `mixed = imul(rootSeed >>> 0, SEED_MIX_MULTIPLIER_32) >>> 0`;
 * return `(h ^ mixed) >>> 0`. Pure, no allocation, not itself a PRNG step
 * (does not take or mutate a `PrngState`).
 */
export type DeriveSubSeed = (rootSeed: number, tag: string) => number;

// -----------------------------------------------------------------------------
// 7. First-order low-pass filter and rate limiter. Both are PURE functions
//    over a caller-held "previous value" number — no separate state object,
//    matching how `src/physics` already threads state through `EntityState`
//    fields (e.g. `EntityState.throttle` IS the low-pass filter's own
//    persisted `prevOutput` between ticks; no extra struct needed).
// -----------------------------------------------------------------------------

/**
 * One step of an exponential (first-order-lag) low-pass filter with time
 * constant `tauSec`: `alpha = 1 - exp(-dtSec / tauSec)`,
 * `return prevOutput + (target - prevOutput) * alpha`. Exact discretization
 * of a continuous first-order lag for constant `dtSec` (not the `dt/tau`
 * approximation, which is only accurate for `dt << tau`). If `tauSec <= 0`,
 * returns `target` exactly (instantaneous, `alpha` clamped to `1`, no
 * division by zero). Used by `src/physics`'s engine-spool and
 * actuator-position dynamics (02's own spec picks the `tauSec` constants).
 */
export type LowPassStep = (prevOutput: number, target: number, tauSec: number, dtSec: number) => number;

/**
 * One step of a slew-rate limiter: moves `prevValue` toward `target` by at
 * most `maxRatePerSec * dtSec`, in either direction, then returns the
 * result (does not overshoot `target`). `maxRatePerSec` must be `>= 0`
 * (a signed max rate is meaningless — the limiter is symmetric). Used by
 * `src/physics`'s FCS control-surface-rate limiting (elevon/rudder max
 * deg/s from `AircraftDefinition.fcsLimits`) and gear
 * extend/retract animation.
 */
export type RateLimitStep = (prevValue: number, target: number, maxRatePerSec: number, dtSec: number) => number;
