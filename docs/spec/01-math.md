# 01 — Math library

**Read `docs/spec/00-architecture.md` and `docs/spec/contracts/core.ts` in full before this document. Where anything here appears to disagree with either, they win — see 00-architecture.md's own tie-breaker rule. `docs/spec/contracts/math.ts` is the literal, compilable surface this module implements; this document is the algorithm/derivation reference for that surface and restates every signature in it exactly.**

## 1. Purpose & scope

`src/math` is the **one shared runtime library** every other module may import from (00-architecture.md section 8/10). It has no dependencies of its own — not even on `src/contracts` at *runtime* (only `contracts/math.ts`'s own type declarations reference `contracts/core.ts`'s `Vec3Like`/`QuatLike` types, purely as compile-time types) — and it must run identically under Node (vitest, `tools/sim-check.ts`) and inside both workers and the main thread, per 00-architecture.md section 2's DOM-free rule.

Scope, precisely:

1. **Vec3** — mutable 3-vector operations (add/sub/scale/dot/cross/normalize/lerp/distance/…), all allocation-free with an explicit `out` parameter.
2. **Quat** — mutable unit-quaternion operations: Hamilton product, body↔world vector rotation, the project's exact yaw/pitch/roll↔quaternion convention (00-architecture.md section 3.3), first-order quaternion integration (`dq = 0.5*q⊗omega`), slerp/nlerp.
3. **Body rate accessors** (`bodyRateP`/`bodyRateQ`/`bodyRateR`) — the only sanctioned way to read the aerodynamic roll/pitch/yaw rate out of `EntityState.omega` (00-architecture.md section 3.4).
4. **Mat3** — mutable 3×3 matrix operations for the body-frame inertia tensor: build from `{xx,yy,zz,xy,xz,yz}`, multiply, transpose, determinant, invert, matrix×vector.
5. **Scalar helpers** — `clamp`, `lerp`, `smoothstep`, angle wrapping, deg/rad conversion, approximate equality.
6. **1D and bilinear 2D table interpolation with clamping** — the lookup primitives `src/aircraft`'s aero/engine data tables (Cl/Cd/Cm vs alpha and Mach, thrust vs altitude/Mach/throttle) are built on.
7. **`mulberry32` seeded PRNG** plus deterministic sub-seed derivation — the *only* source of randomness anywhere in sim code (00-architecture.md section 2's "no `Math.random()`" rule).
8. **First-order low-pass filter and rate limiter** — the two primitives `src/physics` builds engine-spool lag and control-surface rate limiting from.

Everything in this module is **pure and allocation-free** except the `create*` factories (used only at init/scratch-object-creation time, never in a hot loop) and `Vec3Static.equals`/`QuatStatic.equals`/`Mat3Static.equals`/`ApproxEqual` (test-only, not hot-path, but still allocation-free since they only return booleans).

## 2. Owned files

| file | purpose |
|---|---|
| `src/math/vec3.ts` | `Vec3` type + `Vec3Static` implementation (`export const Vec3`), `createVec3`. |
| `src/math/quat.ts` | `Quat` type + `QuatStatic` implementation (`export const Quat`), `createQuat`, `bodyRateP`/`bodyRateQ`/`bodyRateR`. |
| `src/math/mat3.ts` | `Mat3` + `Mat3Static` implementation (`export const Mat3`), `createMat3`. |
| `src/math/scalar.ts` | `clamp`, `clamp01`, `lerp`, `inverseLerp`, `smoothstep`, `wrapAngleSigned`, `wrapAngleUnsigned`, `degToRad`, `radToDeg`, `sign`, `approxEqual`. |
| `src/math/table1d.ts` | `interpolate1D` (1D linear lookup with edge clamping). |
| `src/math/table2d.ts` | `interpolate2D` (bilinear lookup with edge clamping on both axes). |
| `src/math/prng.ts` | `createPrng`, `nextFloat01`, `nextRange`, `nextInt`, `deriveSubSeed` (mulberry32 + FNV-1a sub-seed derivation). |
| `src/math/filters.ts` | `lowPassStep`, `rateLimitStep`. |
| `src/math/index.ts` | Barrel: re-exports every symbol above, plus re-exports every **type** from `contracts/math.ts` (`Vec3`, `Quat`, `Mat3`, `Table1D`, `Table2D`, `PrngState`, `YawPitchRoll`, `InertiaComponents`) so consumers need only `import { Vec3, Quat, ... } from '../math'`. |

No other files. `src/math` imports nothing from `src/*` (00-architecture.md section 10: "no `src/*` imports (leaf)") and, at runtime, nothing from `src/contracts` either — see section 3's note on why `contracts/math.ts`'s `declare const Vec3/Quat/Mat3` are type-only placeholders that `src/math/*.ts` provides the real values for, not something `src/math` imports.

## 3. Public API

This restates every export of `docs/spec/contracts/math.ts` and pins the exact runtime binding each one gets in `src/math`. Nothing here is left to implementer discretion: the left column is the contract's exported **type** (or, for `Vec3`/`Quat`/`Mat3`, the ambient `declare const`'s name), the right column is the **exact `src/math` export** that must satisfy it.

**Critical usage note:** `contracts/math.ts` declares `Vec3`/`Quat`/`Mat3` with `export declare const` purely so the contract's own text can type-check the dot-notation call sites 00-architecture.md mandates (`Quat.rotate(q,v,out)` etc. — see that file's own header comment for why this is a zero-implementation ambient declaration). **`src/contracts/math.ts` — the verbatim copy the scaffold step makes — therefore never produces a real `Vec3`/`Quat`/`Mat3` runtime value.** Every module, including `src/core`, imports the real values from `'../math'` (this module's barrel), never a value-import of `Vec3`/`Quat`/`Mat3`/etc. from `'../contracts/math'`. `import type { ... } from '../contracts/math'` for types is fine and expected; `import { Vec3 } from '../contracts/math'` as a value is a bug. The plain numeric constants (`DEFAULT_EPSILON`, `MAT3_INVERT_EPSILON`, `SLERP_DOT_THRESHOLD`, `FNV_OFFSET_BASIS_32`, `FNV_PRIME_32`, `SEED_MIX_MULTIPLIER_32`, `MULBERRY32_INCREMENT`) are the one exception: they are real `export const NUMBER = ...` statements already in `contracts/math.ts` (not ambient), so they **are** real values once copied to `src/contracts/math.ts`, and `src/math/*.ts` imports them from there directly (`import { MAT3_INVERT_EPSILON } from '../contracts/math';`) rather than redefining them.

### 3.1 Vec3 (`src/math/vec3.ts`)

```ts
export const Vec3: Vec3Static = {
  set(out, x, y, z): Vec3Like,
  copy(out, src): Vec3Like,
  add(a, b, out): Vec3Like,
  sub(a, b, out): Vec3Like,
  scale(a, s, out): Vec3Like,
  addScaled(a, b, s, out): Vec3Like,      // out = a + b*s
  negate(a, out): Vec3Like,
  dot(a, b): number,
  cross(a, b, out): Vec3Like,
  length(a): number,
  lengthSq(a): number,
  normalize(a, out): Vec3Like,
  distance(a, b): number,
  distanceSq(a, b): number,
  lerp(a, b, t, out): Vec3Like,
  equals(a, b, epsilon?): boolean,
};
export const createVec3: CreateVec3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
```

### 3.2 Quat (`src/math/quat.ts`)

```ts
export const Quat: QuatStatic = {
  set(out, x, y, z, w): QuatLike,
  copy(out, src): QuatLike,
  identity(out): QuatLike,
  multiply(a, b, out): QuatLike,          // Hamilton product a⊗b
  conjugate(q, out): QuatLike,
  length(q): number,
  normalize(q, out): QuatLike,
  dot(a, b): number,
  axisAngle(axis, angleRad, out): QuatLike,
  rotate(q, v, out): Vec3Like,            // body -> world
  rotateInverse(q, v, out): Vec3Like,     // world -> body
  fromYawPitchRoll(headingRad, pitchRad, rollRad, out): QuatLike,
  toYawPitchRoll(q, out): YawPitchRoll,
  integrate(q, omegaBody, dtSec, out): QuatLike,
  slerp(a, b, t, out): QuatLike,
  nlerp(a, b, t, out): QuatLike,
  equals(a, b, epsilon?): boolean,
};
export const createQuat: CreateQuat = (x = 0, y = 0, z = 0, w = 1) => ({ x, y, z, w });
export const bodyRateP: BodyRateP = (omega) => omega.x;
export const bodyRateQ: BodyRateQ = (omega) => omega.z;
export const bodyRateR: BodyRateR = (omega) => -omega.y;
```

### 3.3 Mat3 (`src/math/mat3.ts`)

```ts
export const Mat3: Mat3Static = {
  identity(out): Mat3,
  set(out, m00, m01, m02, m10, m11, m12, m20, m21, m22): Mat3,
  copy(out, src): Mat3,
  fromInertia(i, out): Mat3,
  multiply(a, b, out): Mat3,
  transpose(m, out): Mat3,
  determinant(m): number,
  invert(m, out): boolean,                // false + identity written on near-singular m
  transformVec3(m, v, out): Vec3Like,
  equals(a, b, epsilon?): boolean,
};
export const createMat3: CreateMat3 = () => ({ m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0, m20: 0, m21: 0, m22: 1 });
```

### 3.4 Scalar (`src/math/scalar.ts`), flat exports, one const per contract type alias

`clamp: Clamp`, `clamp01: Clamp01`, `lerp: Lerp`, `inverseLerp: InverseLerp`, `smoothstep: Smoothstep`, `wrapAngleSigned: WrapAngleSigned`, `wrapAngleUnsigned: WrapAngleUnsigned`, `degToRad: DegToRad`, `radToDeg: RadToDeg`, `sign: Sign`, `approxEqual: ApproxEqual`.

### 3.5 Tables

`src/math/table1d.ts`: `export const interpolate1D: Interpolate1D = (table, x) => { ... }`.
`src/math/table2d.ts`: `export const interpolate2D: Interpolate2D = (table, x, y) => { ... }`.

### 3.6 PRNG (`src/math/prng.ts`)

`createPrng: CreatePrng`, `nextFloat01: PrngNextFloat01`, `nextRange: PrngNextRange`, `nextInt: PrngNextInt`, `deriveSubSeed: DeriveSubSeed`.

### 3.7 Filters (`src/math/filters.ts`)

`lowPassStep: LowPassStep`, `rateLimitStep: RateLimitStep`.

## 4. Design & algorithms

All formulas below were numerically verified (not just derived by hand) against 00-architecture.md's own worked examples plus randomized round-trip tests before being written down here; the exact figures quoted are copy-pasteable test assertions, not rounded approximations of some "true" value.

### 4.1 Vec3 — standard formulas

`add/sub/scale/negate/dot/lengthSq/distance*` are the standard component-wise formulas; no special cases. `addScaled(a,b,s,out)`: `out.x=a.x+b.x*s` etc. — exists as one fused op so `src/physics`'s Euler integrator (`pos += vel*dt`) and `src/combat`'s proportional-navigation guidance don't need an intermediate `Vec3` per call.

`cross(a,b,out)`: `out.x = a.y*b.z - a.z*b.y; out.y = a.z*b.x - a.x*b.z; out.z = a.x*b.y - a.y*b.x`. **Read `a`/`b` into locals first** so `Vec3.cross(a,b,a)` (aliased `out`) is safe.

`normalize(a,out)`: `const l2 = a.x*a.x+a.y*a.y+a.z*a.z; if (l2 === 0) { out.x=0; out.y=0; out.z=0; return out; } const invL = 1/Math.sqrt(l2); out.x=a.x*invL; ...`. The `l2===0` branch is the **only** branch in this entire library that returns a non-unit, all-zero result instead of computing a real answer — documented explicitly here because every other function either has a real answer for every input or is covered by `Mat3.invert`'s boolean-failure convention.

**Worked example** (also ties into 3.4's right-handedness check in 00-architecture.md section 3.2, `X × Y = Z`):

```
Vec3.cross({x:1,y:0,z:0}, {x:0,y:1,z:0}, out)  ->  out = {x:0, y:0, z:1}   // bodyX × bodyY = bodyZ, confirms right-handed body frame
Vec3.add({x:1,y:2,z:3}, {x:4,y:5,z:6}, out)     ->  out = {x:5, y:7, z:9}
Vec3.dot({x:1,y:2,z:3}, {x:4,y:5,z:6})          ->  32
Vec3.normalize({x:3,y:4,z:0}, out)              ->  out = {x:0.6, y:0.8, z:0}
Vec3.lerp({x:0,y:0,z:0}, {x:10,y:0,z:0}, 0.25, out) -> out = {x:2.5, y:0, z:0}
```

### 4.2 Quat.rotate / Quat.rotateInverse — optimized vector rotation

Conceptually `rotate(q,v,out) = q ⊗ (0,v) ⊗ conj(q)`, vector part of the result. Implemented **without** building two intermediate quaternions, using the standard optimized expansion (verified below against the naive two-multiply form over 50,000 random `(q,v)` pairs, max component error `6.4e-15`):

```
tx = 2*(q.y*v.z - q.z*v.y)
ty = 2*(q.z*v.x - q.x*v.z)
tz = 2*(q.x*v.y - q.y*v.x)
out.x = v.x + q.w*tx + (q.y*tz - q.z*ty)
out.y = v.y + q.w*ty + (q.z*tx - q.x*tz)
out.z = v.z + q.w*tz + (q.x*ty - q.y*tx)
```

`rotateInverse(q,v,out)` is the same expansion with `q`'s vector part negated first (`qx,qy,qz -> -qx,-qy,-qz`, i.e. using `conj(q)`), computed inline — **do not** call `conjugate()` into a scratch `Quat` first; substitute `-q.x,-q.y,-q.z` directly into the formula above (still zero allocation, one fewer function call).

**Worked example**, `q = fromYawPitchRoll(0, 15°, 0)` (= `(x:0.09229595564125724, y:0.7010573846499778, z:0.09229595564125725, w:0.7010573846499779)`, see 4.3):

```
Quat.rotate(q, {x:1,y:0,z:0}, out) -> out = {x: 2.220446049250313e-16, y: 0.25881904510252074, z: -0.9659258262890681}
```

This matches 00-architecture.md section 3.3's worked example B (`forwardWorld = (0, sin15°, -cos15°) = (0, 0.2588190451, -0.9659258263)`) to `1e-9` — the `x` component is `~2.2e-16` (machine epsilon), not exactly `0`; tests must assert `Math.abs(out.x) < 1e-9`, not `out.x === 0`.

### 4.3 Quat.fromYawPitchRoll / Quat.toYawPitchRoll — closed form, derived and numerically verified

00-architecture.md section 3.3 fixes the composition `q = qYaw ⊗ qPitch ⊗ qRoll` with `qYaw = axisAngle(Y, φ)`, `φ = PI/2 - headingRad`; `qPitch = axisAngle(bodyZ, pitchRad)`; `qRoll = axisAngle(bodyX, rollRad)`. Expanding the two Hamilton products symbolically (full derivation available on request; the result below was independently confirmed by a 200,000-sample randomized round-trip test, max quaternion-component error `1.8e-13`, and matches 00-architecture.md's worked examples A and B exactly) gives a **direct closed form with no intermediate quaternion objects**:

```
sφ=sin(φ/2), cφ=cos(φ/2), φ = PI/2 - headingRad
sθ=sin(pitchRad/2), cθ=cos(pitchRad/2)
sρ=sin(rollRad/2), cρ=cos(rollRad/2)

out.x = cφ*cθ*sρ + sφ*sθ*cρ
out.y = sφ*cθ*cρ + cφ*sθ*sρ
out.z = cφ*sθ*cρ - sφ*cθ*sρ
out.w = cφ*cθ*cρ - sφ*sθ*sρ
```

**Worked examples** (00-architecture.md section 3.3's own fixtures, reproduced exactly):

```
fromYawPitchRoll(PI/2, 0, 0, out) -> out = {x:0, y:0, z:0, w:1}                         // identity, tolerance 1e-9
fromYawPitchRoll(0, 15*PI/180, 0, out) -> out = {
  x: 0.09229595564125724, y: 0.7010573846499778, z: 0.09229595564125725, w: 0.7010573846499779
}                                                                                         // tolerance 1e-9
```

**`toYawPitchRoll`** is the closed-form inverse, derived from the body→world rotation matrix (`R = Ry(φ)·Rz(θ)·Rx(ρ)`) built from the same composition and confirmed against the same 200,000-sample round-trip test:

```
pitchRad = asin(clamp(2*(q.x*q.y + q.w*q.z), -1, 1))
phi      = atan2(2*(q.w*q.y - q.x*q.z), 1 - 2*(q.y*q.y + q.z*q.z))
headingRad = wrapAngleUnsigned(PI/2 - phi)
rollRad    = atan2(2*(q.w*q.x - q.y*q.z), 1 - 2*(q.x*q.x + q.z*q.z))
```

**Edge case (gimbal-adjacent, `|pitchRad| -> PI/2`):** as `cos(pitchRad) -> 0`, the `atan2` arguments for both `phi` and `rollRad` shrink toward `(0,0)` together (a genuine, unavoidable singularity of any 3-angle Euler representation, not a bug in this formula), so `atan2` still returns a defined (if noisy) angle rather than `NaN` — no extra branch is required, but 01-math.md's own round-trip test deliberately excludes `|pitchRad| > 89.9°` (matching real aircraft flight envelopes; nobody flies exactly vertical for a whole tick) so this noise never surfaces in `tests/math/quat.test.ts`'s assertions. If module 06 (AI) or module 02 (flight model) ever need pitch exactly through ±90°, they read `q` directly rather than relying on Euler angles for control logic — Euler angles here are for HUD/telemetry display only, never for control law math (00-architecture.md's own frame comment: `omega`/`q` are the control-law source of truth, not extracted Euler angles).

**Worked example** (round-trip of worked example B):

```
toYawPitchRoll({x:0.09229595564125724, y:0.7010573846499778, z:0.09229595564125725, w:0.7010573846499779}, out)
  -> out = { headingRad: ~0 (abs < 1e-6), pitchRad: 0.2617993878 (=15° to 1e-9), rollRad: ~0 (abs < 1e-6) }
```

### 4.4 Quat — multiply, conjugate, normalize, axisAngle, integrate, slerp, nlerp

**`multiply(a,b,out)`** — Hamilton product `a⊗b`, exactly 00-architecture.md section 3.3's formula (read `a`/`b` into locals first so aliasing `out` with either input is safe):

```
out.w = a.w*b.w - a.x*b.x - a.y*b.y - a.z*b.z
out.x = a.w*b.x + a.x*b.w + a.y*b.z - a.z*b.y
out.y = a.w*b.y - a.x*b.z + a.y*b.w + a.z*b.x
out.z = a.w*b.z + a.x*b.y - a.y*b.x + a.z*b.w
```

**`conjugate(q,out)`**: `out.x=-q.x; out.y=-q.y; out.z=-q.z; out.w=q.w`.

**`normalize(q,out)`**: same zero-length policy as `Vec3.normalize`, but `|q|===0` should never occur for any `q` this library itself produces (only reachable via a caller building a raw `{0,0,0,0}` by hand); writes identity `(0,0,0,1)` into `out` in that case rather than `(0,0,0,0)` (an all-zero quaternion is never a valid rotation, so the safe fallback is identity, not zero).

**`axisAngle(axis,angleRad,out)`**: `const h=angleRad/2, s=Math.sin(h), c=Math.cos(h); out.x=axis.x*s; out.y=axis.y*s; out.z=axis.z*s; out.w=c;`. Precondition: `axis` unit length (never validated/renormalized here — see contract doc comment).

**`integrate(q,omegaBody,dtSec,out)`** — `dq = 0.5 * (q ⊗ (0,omegaBody)) * dtSec`, `out = normalize(q + dq)`:

```
p.x = q.w*omega.x + q.y*omega.z - q.z*omega.y
p.y = q.w*omega.y - q.x*omega.z + q.z*omega.x
p.z = q.w*omega.z + q.x*omega.y - q.y*omega.x
p.w =              - q.x*omega.x - q.y*omega.y - q.z*omega.z
sum.x = q.x + 0.5*p.x*dtSec   (same for y, z, w)
out = normalize(sum, out)
```

(`p = q ⊗ (0,omegaBody)`, i.e. the Hamilton product with the second operand's scalar part fixed at 0 — the four lines above are `multiply`'s formula with `b = (omega.x,omega.y,omega.z,0)` substituted and the `b.w` terms dropped.)

**Worked example**, `q=identity`, `omegaBody=(0,0,1)` rad/s (pure `+wz`, i.e. `bodyRateQ = +1` rad/s, nose-up pitch rate), `dtSec=0.01`:

```
integrate(identity, {x:0,y:0,z:1}, 0.01, out) -> out = {x:0, y:0, z:0.004999937501171851, w:0.9999875002343701}
```

For comparison, the *exact* rotation this rate would sweep in `0.01` s is `axisAngle(bodyZ, 0.01) = {x:0,y:0,z:0.0049999791667, w:0.9999875000260}` — the two agree to `~4e-8` (the expected `O(dt^2)` error of first-order quaternion integration, negligible at `dtSec=1/120`). Test `tests/math/quat.test.ts` against the **first** (first-order-integrator) value exactly (tolerance `1e-9`), since that is what the contract specifies — not against the exact-rotation value.

**`slerp(a,b,t,out)`**: shortest-path fix, then either the true spherical formula or an `nlerp`-equivalent fallback when `a`/`b` are nearly parallel (avoids a near-zero `sin(angle)` denominator):

```
d = Quat.dot(a,b)
bx,by,bz,bw = b.x,b.y,b.z,b.w
if (d < 0) { bx=-bx; by=-by; bz=-bz; bw=-bw; d=-d; }
if (d >= SLERP_DOT_THRESHOLD) {                 // = 0.9995
  out = normalize({x:a.x+(bx-a.x)*t, y:a.y+(by-a.y)*t, z:a.z+(bz-a.z)*t, w:a.w+(bw-a.w)*t})
} else {
  angle = Math.acos(clamp(d, -1, 1))
  s = Math.sin(angle)
  wa = Math.sin((1-t)*angle) / s
  wb = Math.sin(t*angle) / s
  out = {x:a.x*wa+bx*wb, y:a.y*wa+by*wb, z:a.z*wa+bz*wb, w:a.w*wa+bw*wb}
}
```

**Worked example**: `slerp(identity, axisAngle(Y,PI/2), 0.5, out) -> out = {x:0, y:0.3826834323650898, z:0, w:0.9238795325112868}` (exactly `axisAngle(Y, PI/4)`; `|out| = 1` to `1e-15`). **Shortest-path check**: `slerp(identity, negate-all-four-components-of(axisAngle(Y,PI/2)), 0.5, out)` must produce the **same** result (the `d<0` branch negates `b` back), not the long way around.

**`nlerp(a,b,t,out)`**: identical shortest-path fix (`d<0` negate `b`), then `out = normalize(lerp(a,b',t))` unconditionally (no `slerp`'s threshold branch — `nlerp` is always the cheap path).

### 4.5 Body rates

`bodyRateP(omega) = omega.x`, `bodyRateQ(omega) = omega.z`, `bodyRateR(omega) = -omega.y` — see 00-architecture.md section 3.4 for the full derivation (right-hand rule per axis in this project's Y-up body frame). These three one-line functions are the **only** contract requirement here; there is nothing to derive beyond what 00-architecture.md already fixed. `src/physics`'s FCS/damping code calls these instead of ever reading `.x`/`.y`/`.z` off `omega` directly with an inline comment claiming it's a body rate.

### 4.6 Mat3 — inertia tensor ops

**`fromInertia(i,out)`**: builds the symmetric tensor `[[xx,xy,xz],[xy,yy,yz],[xz,yz,zz]]`:

```
out.m00=i.xx; out.m01=i.xy; out.m02=i.xz;
out.m10=i.xy; out.m11=i.yy; out.m12=i.yz;
out.m20=i.xz; out.m21=i.yz; out.m22=i.zz;
```

**`multiply(a,b,out)`**: standard row×column product, 9 multiply-adds per output element, all 9 inputs read into locals before any write to `out` (so `out` may alias `a` or `b`).

**`transpose(m,out)`**: `out.m01=m.m10` etc. (swap off-diagonal pairs); diagonal unchanged. Read all off-diagonal pairs into locals first if `out === m` (in-place transpose needs the swap-via-temp pattern, not two independent assignments).

**`determinant(m)`**: `m00*(m11*m22-m12*m21) - m01*(m10*m22-m12*m20) + m02*(m10*m21-m11*m20)`.

**`invert(m,out)`** — adjugate/cofactor method (fine for 3×3; no need for LU/Gaussian elimination):

```
a,b,c = m00,m01,m02;  d,e,f = m10,m11,m12;  g,h,i = m20,m21,m22
det = a*(e*i-f*h) - b*(d*i-f*g) + c*(d*h-e*g)
if (Math.abs(det) < MAT3_INVERT_EPSILON) { Mat3.identity(out); return false }
invDet = 1/det
out.m00=(e*i-f*h)*invDet;  out.m01=-(b*i-c*h)*invDet;  out.m02=(b*f-c*e)*invDet
out.m10=-(d*i-f*g)*invDet; out.m11=(a*i-c*g)*invDet;   out.m12=-(a*f-c*d)*invDet
out.m20=(d*h-e*g)*invDet;  out.m21=-(a*h-b*g)*invDet;  out.m22=(a*e-b*d)*invDet
return true
```

**`transformVec3(m,v,out)`**: `out.x=m.m00*v.x+m.m01*v.y+m.m02*v.z` etc. — read `v.x/y/z` into locals first so `out` may alias `v`.

**Worked example** (a plausible Tejas-scale body-frame inertia tensor, kg·m², used purely to exercise the general off-diagonal case — module 03 owns the *real* Tejas figures):

```
I = fromInertia({xx:12874, yy:71265, zz:61948, xy:0, xz:1015, yz:0}, out)
  -> m00=12874, m11=71265, m22=61948, m02=m20=1015, rest 0
determinant(I) = m11*(m00*m22 - m02*m20) = 71265*(12874*61948 - 1015*1015) = 71265*(797518552 - 1030225) = 71265*796488327 = 56761740623655   (off-diagonal-zero terms drop out; nonzero, so invertible)
invert(I, Iinv) -> true, Iinv = {
  m00: 0.00007777640663401713, m02: -0.0000012743438486073381,
  m11: 0.000014032133585911739,
  m20: -0.0000012743438486073381, m22: 0.000016163450942828445,
  (all other off-diagonal fields 0)
}
Mat3.multiply(I, Iinv, out) -> out within 1e-9 of identity (off-diagonal terms ~1.4e-17, diagonal terms exactly 1)
```

Singular-matrix test: `invert({m00:1,m01:2,m02:3,m10:2,m11:4,m12:6,m20:1,m21:1,m22:1}, out)` (rows 0 and a scaled row 1 are linearly dependent: row1 = 2×row0 apart from the last row) `-> returns false`, `out` equals the identity matrix exactly.

### 4.7 Scalar helpers

`clamp(x,min,max) = x<min?min : x>max?max : x`. `clamp01(x) = clamp(x,0,1)`. `lerp(a,b,t) = a+(b-a)*t`. `inverseLerp(a,b,v) = a===b ? 0 : clamp01((v-a)/(b-a))`. `smoothstep(edge0,edge1,x)`: `if (edge0===edge1) return x<edge0?0:1; const t=clamp01((x-edge0)/(edge1-edge0)); return t*t*(3-2*t);`.

`wrapAngleSigned(rad)`: reduce into `[-PI,PI)` — `let r = rad % TWO_PI; if (r < -PI) r += TWO_PI; else if (r >= PI) r -= TWO_PI; return r;` (JS `%` keeps the operand's sign, so `rad<0` needs the same two-sided check, not just one branch).
`wrapAngleUnsigned(rad)`: reduce into `[0,TWO_PI)` — `let r = rad % TWO_PI; if (r < 0) r += TWO_PI; return r;`.
`degToRad(deg) = deg * PI / 180`. `radToDeg(rad) = rad * 180 / PI`.
`sign(x) = x>0?1 : x<0?-1 : 0` (explicitly `0` for `x===0` **and** `x===-0`, unlike raw `Math.sign(-0)===-0`).
`approxEqual(a,b,epsilon=DEFAULT_EPSILON) = Math.abs(a-b) <= epsilon`.

**Worked examples**:

```
clamp(5, 0, 1) -> 1
inverseLerp(10, 20, 15) -> 0.5
inverseLerp(10, 20, 5)  -> 0            // clamped (raw t = -0.5)
smoothstep(0, 10, 5)    -> 0.5
smoothstep(0, 10, 2.5)  -> 0.15625
wrapAngleUnsigned(-1)   -> 5.283185307179586   // = 2*PI - 1
wrapAngleSigned(4)      -> -2.283185307179586  // = 4 - 2*PI
```

### 4.8 Table1D — 1D linear interpolation with edge clamping

```
function interpolate1D(table, x):
  n = table.xs.length
  if (n === 1) return table.ys[0]
  xc = clamp(x, table.xs[0], table.xs[n-1])
  for i in 0 .. n-2:
    if (xc <= table.xs[i+1] or i === n-2):
      span = table.xs[i+1] - table.xs[i]
      t = span === 0 ? 0 : (xc - table.xs[i]) / span
      return lerp(table.ys[i], table.ys[i+1], t)
```

(Linear scan is intentional and sufficient — aero/engine tables have `<64` points; module 12's Audit phase has no per-call complexity requirement on this function, only a correctness requirement — see 01-math.md section 6.)

**Worked example**, `table = {xs:[-10,0,10,20], ys:[-0.5,0.05,0.9,0.95]}`:

```
interpolate1D(table, 5)   -> 0.475     // segment [0,10], t=0.5
interpolate1D(table, -20) -> -0.5      // clamped to xs[0]
interpolate1D(table, 100) -> 0.95      // clamped to xs[3]
```

### 4.9 Table2D — bilinear interpolation with edge clamping on both axes

```
function interpolate2D(table, x, y):
  nx = table.xs.length, ny = table.ys.length
  xc = clamp(x, table.xs[0], table.xs[nx-1])
  yc = clamp(y, table.ys[0], table.ys[ny-1])
  find i in [0,nx-2] s.t. xc is in segment [xs[i],xs[i+1]] (or i=0 if nx===1); tx = ... (same rule as interpolate1D)
  find j in [0,ny-2] s.t. yc is in segment [ys[j],ys[j+1]] (or j=0 if ny===1); ty = ... (same rule)
  z00 = table.zs[i][j];    z10 = table.zs[i+1][j]      (or z00 if nx===1)
  z01 = table.zs[i][j+1];  z11 = table.zs[i+1][j+1]    (or z00/z10 if ny===1)
  return lerp( lerp(z00, z10, tx), lerp(z01, z11, tx), ty )
```

**Worked example**, `table = {xs:[0,10], ys:[0,1], zs:[[0,1],[2,3]]}` (i.e. `z(0,0)=0, z(0,1)=1, z(10,0)=2, z(10,1)=3`):

```
interpolate2D(table, 5, 0.5)    -> 1.5    // tx=0.5,ty=0.5: lerp(lerp(0,2,0.5),lerp(1,3,0.5),0.5)=lerp(1,2,0.5)=1.5
interpolate2D(table, -100, 5)   -> 1      // x clamps to 0, y clamps to 1 -> z(0,1)=1
```

### 4.10 mulberry32 PRNG

`PrngState = { s: number }`, `s` always treated as an unsigned 32-bit integer (`s >>> 0`). `createPrng(seed) = { s: seed >>> 0 }`.

```
function nextFloat01(state):
  state.s = (state.s + MULBERRY32_INCREMENT) | 0        // 0x6D2B79F5
  let t = state.s
  t = Math.imul(t ^ (t >>> 15), 1 | t)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
```

This is the standard, public-domain mulberry32 algorithm (Tommy Ettinger), bit-for-bit, restated here so `src/math/prng.ts` has exactly one legal implementation. `nextRange(state,min,max) = min + nextFloat01(state)*(max-min)`. `nextInt(state,minIncl,maxExcl) = minIncl + Math.floor(nextFloat01(state)*(maxExcl-minIncl))`. Both advance `state` by **exactly one** `nextFloat01` step — never call `nextFloat01` twice for one `nextRange`/`nextInt`, or downstream streams silently desync from any test or replay that computed expected values by calling `nextFloat01` directly.

**Worked examples (bit-exact — `tests/math/prng.test.ts` must use exact equality, not a tolerance, since every operation here is spec'd integer/IEEE-754-double arithmetic; determinism requires this)**:

```
s = createPrng(1)
nextFloat01(s) -> 0.6270739405881613
nextFloat01(s) -> 0.002735721180215478
nextFloat01(s) -> 0.5274470399599522

s2 = createPrng(12345)
[nextFloat01(s2) x5] -> [0.9797282677609473, 0.3067522644996643, 0.484205421525985, 0.817934412509203, 0.5094283693470061]
```

### 4.11 `deriveSubSeed` — deterministic sub-stream derivation

```
function fnv1a32(str):                       // internal helper, not exported
  h = FNV_OFFSET_BASIS_32                     // 2166136261
  for each char c of str: h = Math.imul(h ^ c.charCodeAt(0), FNV_PRIME_32) >>> 0   // 16777619
  return h >>> 0

function deriveSubSeed(rootSeed, tag):
  h = fnv1a32(tag)
  mixed = Math.imul(rootSeed >>> 0, SEED_MIX_MULTIPLIER_32) >>> 0   // 0x9E3779B1
  return (h ^ mixed) >>> 0
```

**Worked examples**:

```
deriveSubSeed(42, "terrain")   -> 2176990980
deriveSubSeed(42, "ai:red-1")  -> 1195213530
deriveSubSeed(42, "terrain")   -> 2176990980   // called again: identical (pure function, no hidden state)
createPrng(deriveSubSeed(42,"terrain")); [nextFloat01 x3] -> [0.35095783742144704, 0.29663478187285364, 0.6339825305622071]
```

Usage convention (00-architecture.md section 13): every subsystem that needs its own randomness derives its seed from the mission's one root seed via a short, stable tag — `deriveSubSeed(worldConfig.seed, 'ai:' + aircraftId)` (module 06), `deriveSubSeed(worldConfig.seed, 'wind')` (module 02/10's gust PRNG stream), etc. — so changing how heavily one subsystem draws from its PRNG never perturbs another subsystem's stream. (`src/terrain`, module 04, is the one deliberate exception: `contracts/terrain.ts`'s own header explains it does not import `src/math` at all and instead derives its 5 noise sub-seeds via its own `deriveTerrainSubSeed` — an FNV+xorshift32 function, NOT mulberry32 — so terrain generation stays fully self-contained; see 04-terrain.md section 4.3.1.)

### 4.12 Low-pass filter and rate limiter

**`lowPassStep(prevOutput,target,tauSec,dtSec)`**: `if (tauSec <= 0) return target; const alpha = 1 - Math.exp(-dtSec/tauSec); return prevOutput + (target-prevOutput)*alpha;` — the **exact** discretization of `dy/dt = (target-y)/tau` for constant `dtSec` (not the `dt/tau` small-step approximation, which under-damps for `dtSec` a non-negligible fraction of `tauSec`).

**Worked example**, `tauSec=0.5`, `dtSec=0.1` (so `alpha=1-e^-0.2=0.18126924692...`), starting `prevOutput=0`, `target=1`:

```
step 1: lowPassStep(0, 1, 0.5, 0.1)                    -> 0.18126924692201818
step 2: lowPassStep(0.18126924692201818, 1, 0.5, 0.1)  -> 0.3296799539643608
```

**`rateLimitStep(prevValue,target,maxRatePerSec,dtSec)`**: `const maxDelta = maxRatePerSec*dtSec; const delta = target-prevValue; if (delta > maxDelta) return prevValue+maxDelta; if (delta < -maxDelta) return prevValue-maxDelta; return target;` (reaches `target` exactly, never overshoots, the moment the remaining delta is within one step's budget).

**Worked examples**:

```
rateLimitStep(0, 10, 5, 0.1)   -> 0.5   // wants +10, capped to +0.5 (5 units/s * 0.1s)
rateLimitStep(5, 5.1, 5, 0.1)  -> 5.1   // wants +0.1, within budget (+0.5) -> reaches target exactly
```

## 5. Data

This module has no large data tables of its own (those belong to module 03). Every magic number it introduces is a small, load-bearing numeric constant, all exported from `contracts/math.ts` (section 0) so no other file redefines them:

| constant | value | unit | justification |
|---|---|---|---|
| `DEFAULT_EPSILON` | `1e-6` | (matches the field it compares) | Default tolerance for `*.equals`/`approxEqual`, test-only. Tight enough to catch real bugs, loose enough to absorb float64 accumulation over a few hundred operations. |
| `MAT3_INVERT_EPSILON` | `1e-9` | (determinant units, kg³·m⁶ for an inertia tensor) | Below this `|det|`, `Mat3.invert` refuses rather than dividing by ~0. A real rigid-body inertia tensor's determinant is many orders of magnitude above this (see section 4.6's worked example: `~5.7e10`); this only fires on a genuine programmer/data error. |
| `SLERP_DOT_THRESHOLD` | `0.9995` | (dot product, unitless, `[0,1]` after shortest-path fix) | Standard value (used by, e.g., other quaternion libraries in the wild) below which `sin(acos(dot))` is still numerically healthy; above it, linear+normalize (`nlerp`'s formula) is visually and numerically indistinguishable from true `slerp`. |
| `FNV_OFFSET_BASIS_32` | `2166136261` | — | FNV-1a's standard 32-bit offset basis (published constant, not tunable). |
| `FNV_PRIME_32` | `16777619` | — | FNV-1a's standard 32-bit prime (published constant). |
| `SEED_MIX_MULTIPLIER_32` | `0x9E3779B1` (`2654435761`) | — | 32-bit odd constant derived from the golden ratio (`2^32/φ`, rounded to odd), a standard multiplicative-hash mixing constant (same family as used in splitmix/xxHash-style seed mixing); makes `deriveSubSeed` sensitive to small changes in `rootSeed`, not just `tag`. |
| `MULBERRY32_INCREMENT` | `0x6D2B79F5` | — | mulberry32's own published per-call state increment; part of the algorithm, not independently tunable. |

## 6. Performance budget

- **Zero heap allocation** in every function in sections 3.1–3.3, 3.5–3.7 (Vec3/Quat/Mat3/Table/PRNG/filters) when called with pre-existing `out`/`state` arguments — every one of them is either pure scalar arithmetic or writes fields directly onto an object the caller already owns. Verified structurally in section 4: no function there constructs a `{}`/`[]`/`new` internally except the `create*` factories, which section 3's table marks as init-only.
- `createVec3`/`createQuat`/`createMat3`/`createPrng` each allocate exactly one small object; call these only at aircraft/mission init, scratch-object setup, or pool pre-sizing — **never** inside `src/physics`'s per-tick step, `src/ai`'s per-tick `Pilot.update`, or `src/combat`'s per-tick guidance update.
- Every hot-path function (called at `SIM_HZ=120` or, for `src/render`'s `Quat.slerp`/`nlerp`, at display refresh rate up to ~240 Hz) is O(1) with a small constant factor (at most ~20 multiply-adds — `Mat3.multiply` is the heaviest single call in this module, and it is only ever invoked once per aircraft at init to precompute `Mat3.invert(inertiaTensor, inertiaInverse)`, never per tick — `src/physics`'s per-tick angular-acceleration solve reuses the cached inverse via `Mat3.transformVec3`, one 9-multiply-add call).
- `interpolate1D`/`interpolate2D` are linear-scan over table length `n` (`Table1D`) or `nx+ny` (`Table2D`); with aero/engine tables capped well under 64 points per axis (module 03's concern, not enforced here), this is under 100 comparisons worst case — negligible next to the trig calls elsewhere in one physics tick.
- Mobile: nothing in this module differs between quality tiers (00-architecture.md section 14 — quality tiers affect rendering only) and nothing here is platform-specific; the same code runs at the same cost on desktop and mobile JS engines.
- Determinism note tied to performance: because `nextFloat01`/`nextRange`/`nextInt` are specified as **exactly** one mulberry32 step each (section 4.10), a caller must never "peek and discard" a PRNG value to implement some other operation (e.g. don't implement a Fisher–Yates shuffle by calling `nextFloat01` an accidental extra time in a bugged loop) — any implementation detail that changes call **count** changes every subsequent value in that stream and breaks replay/determinism tests.

## 7. Unit tests to write

File paths mirror `src/math/*.ts` under `tests/math/*.test.ts` (00-architecture.md section 13's naming rule). All numeric assertions below are copy-pasteable from section 4's worked examples.

- **`tests/math/vec3.test.ts`**
  - `Vec3.cross({x:1,y:0,z:0},{x:0,y:1,z:0},out)` equals `{x:0,y:0,z:1}` exactly.
  - `Vec3.add({x:1,y:2,z:3},{x:4,y:5,z:6},out)` equals `{x:5,y:7,z:9}` exactly.
  - `Vec3.dot({x:1,y:2,z:3},{x:4,y:5,z:6})` `=== 32`.
  - `Vec3.normalize({x:3,y:4,z:0},out)` equals `{x:0.6,y:0.8,z:0}` within `1e-9`.
  - `Vec3.normalize({x:0,y:0,z:0},out)` equals `{x:0,y:0,z:0}` exactly (zero-length branch, no `NaN`).
  - `Vec3.lerp({x:0,y:0,z:0},{x:10,y:0,z:0},0.25,out)` equals `{x:2.5,y:0,z:0}` exactly.
  - Aliasing: `const v={x:1,y:0,z:0}; Vec3.cross(v,{x:0,y:1,z:0},v);` leaves `v` equal to `{x:0,y:0,z:1}` (in-place `out===a` safety).
- **`tests/math/quat.test.ts`**
  - `Quat.fromYawPitchRoll(Math.PI/2,0,0,out)` equals `{x:0,y:0,z:0,w:1}` within `1e-9` (00-architecture.md worked example A).
  - `Quat.fromYawPitchRoll(0,15*Math.PI/180,0,out)` equals `{x:0.09229595564125724,y:0.7010573846499778,z:0.09229595564125725,w:0.7010573846499779}` within `1e-9` (worked example B).
  - `Quat.rotate(qB,{x:1,y:0,z:0},out)`: `Math.abs(out.x) < 1e-9`, `out.y` within `1e-9` of `Math.sin(15*Math.PI/180)`, `out.z` within `1e-9` of `-Math.cos(15*Math.PI/180)`.
  - Round trip: `Quat.toYawPitchRoll(qB,out)`: `out.headingRad` within `1e-6` of `0`, `out.pitchRad` within `1e-9` of `0.2617993878`, `out.rollRad` within `1e-6` of `0`.
  - Randomized round trip (this file's own, smaller-scale version of section 4.3's 200,000-sample check): for `2000` random `(heading in [0,2PI), pitch in (-89.9deg,89.9deg), roll in (-PI,PI))` triples, `fromYawPitchRoll` then `toYawPitchRoll` then `fromYawPitchRoll` again reproduces the first quaternion within `1e-6` per component (accounting for the `q==-q` double cover: accept either sign).
  - `Quat.integrate(identity,{x:0,y:0,z:1},0.01,out)` equals `{x:0,y:0,z:0.004999937501171851,w:0.9999875002343701}` within `1e-9`.
  - `Quat.slerp(identity, axisAngle(Y,PI/2), 0.5, out)` equals `{x:0,y:0.3826834323650898,z:0,w:0.9238795325112868}` within `1e-9`; `Quat.length(out)` within `1e-9` of `1`.
  - Shortest path: `Quat.slerp(identity, negateAll(axisAngle(Y,PI/2)), 0.5, out)` equals the same result as the line above (not the long way around).
  - `bodyRateP({x:2,y:3,z:5})===2`, `bodyRateQ({x:2,y:3,z:5})===5`, `bodyRateR({x:2,y:3,z:5})===-3`.
- **`tests/math/mat3.test.ts`**
  - `Mat3.fromInertia({xx:12874,yy:71265,zz:61948,xy:0,xz:1015,yz:0},out)` then `Mat3.invert(out,inv)` returns `true`; `Mat3.multiply(out,inv,prod)` has every diagonal element within `1e-9` of `1` and every off-diagonal element within `1e-9` of `0`.
  - `Mat3.invert({m00:1,m01:2,m02:3,m10:2,m11:4,m12:6,m20:1,m21:1,m22:1},out)` returns `false`; `out` equals the identity matrix exactly.
  - `Mat3.transformVec3(Mat3.identity(out), {x:7,y:8,z:9}, r)` equals `{x:7,y:8,z:9}` exactly.
- **`tests/math/scalar.test.ts`**
  - `clamp(5,0,1)===1`; `clamp01(-3)===0`.
  - `inverseLerp(10,20,15)===0.5`; `inverseLerp(10,20,5)===0`.
  - `smoothstep(0,10,5)===0.5`; `smoothstep(0,10,2.5)` within `1e-9` of `0.15625`.
  - `wrapAngleUnsigned(-1)` within `1e-9` of `5.283185307179586`; `wrapAngleSigned(4)` within `1e-9` of `-2.283185307179586`.
  - `sign(-0)===0` (not `-0`).
- **`tests/math/table1d.test.ts`**
  - Table `{xs:[-10,0,10,20],ys:[-0.5,0.05,0.9,0.95]}`: `interpolate1D(t,5)===0.475`; `interpolate1D(t,-20)===-0.5`; `interpolate1D(t,100)===0.95`.
  - Single-point table `{xs:[3],ys:[42]}`: `interpolate1D(t,-100)===42` and `interpolate1D(t,100)===42`.
- **`tests/math/table2d.test.ts`**
  - Table `{xs:[0,10],ys:[0,1],zs:[[0,1],[2,3]]}`: `interpolate2D(t,5,0.5)===1.5`; `interpolate2D(t,-100,5)===1`.
- **`tests/math/prng.test.ts`**
  - `createPrng(1)` then three `nextFloat01` calls equal exactly `[0.6270739405881613, 0.002735721180215478, 0.5274470399599522]`.
  - `createPrng(12345)` then five `nextFloat01` calls equal exactly `[0.9797282677609473, 0.3067522644996643, 0.484205421525985, 0.817934412509203, 0.5094283693470061]`.
  - `deriveSubSeed(42,"terrain")===2176990980`; `deriveSubSeed(42,"ai:red-1")===1195213530`; calling it again with the same arguments returns the same value (pure function).
  - Every `nextFloat01` output over `100000` calls from `createPrng(999)` is `>= 0` and `< 1` (range check, catches an off-by-one in the `/4294967296` divisor).
- **`tests/math/filters.test.ts`**
  - `lowPassStep(0,1,0.5,0.1)` within `1e-9` of `0.18126924692201818`; feeding that result back in a second call gives `0.3296799539643608` within `1e-9`.
  - `lowPassStep(0,1,0,0.1)===1` (non-positive `tauSec` -> instant).
  - `rateLimitStep(0,10,5,0.1)===0.5`; `rateLimitStep(5,5.1,5,0.1)===5.1` (reaches target exactly, no overshoot).

## 8. Acceptance criteria

Mechanically checkable; module 12's audit phase and the tests in section 7 verify all of these:

1. `docs/spec/contracts/math.ts` compiles standalone with `tsc --noEmit --strict --noUncheckedIndexedAccess --noImplicitOverride --noFallthroughCasesInSwitch --forceConsistentCasingInFileNames --skipLibCheck --esModuleInterop --isolatedModules` alongside `docs/spec/contracts/core.ts` only (no other contract files, no npm packages) — **already verified** while drafting this spec.
2. Every export listed in section 3 exists in `src/math` with exactly that name and, per its contract signature, exactly that parameter count/order/types (`tsc --noEmit --strict` over the whole `src/` tree, module 12's Integration phase, must show zero errors attributable to `src/math`).
3. `src/math/*.ts` contains zero references to `window`, `document`, `localStorage`, or any other DOM global (grep-checkable; also mechanically enforced by `tools/sim-check.ts` importing `src/math` under Node).
4. `src/math/*.ts` contains zero calls to `Math.random()`.
5. Every function in sections 3.1–3.3 and 3.5–3.7 (excluding the four `create*` factories) performs **zero** heap allocations when invoked — checkable via a Node micro-benchmark that calls each function `1e6` times with pre-allocated arguments and asserts `process.memoryUsage().heapUsed` growth is within noise (module 12's own acceptance-test mechanism; see 12-verification.md).
6. All of section 7's listed assertions pass under `vitest run tests/math`.
7. `Quat.length(q)` stays within `1e-9` of `1` after `10000` sequential `Quat.integrate` calls at `dtSec=1/120` with a constant nonzero `omegaBody` (drift/renormalization check — catches a forgotten `normalize` inside `integrate`).
8. For `2000` random `(heading,pitch,roll)` triples with `|pitch| < 89.9°`, `toYawPitchRoll(fromYawPitchRoll(heading,pitch,roll,q),ypr)` reproduces `(heading,pitch,roll)` within `1e-6` radians per component.

## 9. Open assumptions

Public reference material for a hand-derived math library is not the issue here (these are standard, well-published algorithms — mulberry32, FNV-1a, quaternion Hamilton products, bilinear interpolation, 3×3 cofactor inversion); the assumptions below are specifically about **the seams with sibling modules I cannot see while drafting this spec**, per the single-pass build's isolation rule:

1. **`InertiaComponents` vs. `AircraftDefinition.inertiaBodyKgM2`.** 00-architecture.md section 9.1 fixes `AircraftDefinition.inertiaBodyKgM2: {xx,yy,zz,xy,xz,yz: number}` inline in `contracts/aircraft.ts` (module 03), and `contracts/math.ts` cannot import `contracts/aircraft.ts` (leaf contracts import only `./core`/`./math`, never the reverse — 00-architecture.md section 8). I defined `Mat3Static.fromInertia`'s parameter as a **locally-declared** `InertiaComponents` interface with the identical six fields, relying on TypeScript's structural typing to make `AircraftDefinition.inertiaBodyKgM2` assignable to it with zero import and zero cast. This only breaks if module 03 spells any of the six field names differently (e.g. `Ixx` instead of `xx`) — 00-architecture.md's own text already fixes the field names as `xx,yy,zz,xy,xz,yz` (section 9.1's literal code block), so I'm confident this is safe, but flagging it since it is the one place this module's contract silently depends on another leaf module matching a shape by convention rather than by import.
2. **`Table1D`/`Table2D` as the assumed shape for `AeroTables`/`EngineTables`.** 00-architecture.md leaves `AeroTables`/`EngineTables` (module 03) and their consumption in `aeroForces.ts`/`engine.ts` (module 02) fully undefined beyond "module 03 defines fully." I designed `Table1D`/`Table2D` to be the obvious, natural fit for "Cl/Cd/Cm vs alpha" (1D) and "vs alpha and Mach" (2D) data, and expect modules 02/03 to use them directly (`import { Table1D, Table2D, interpolate1D, interpolate2D } from '../math'`). If module 03 instead invents its own bespoke table representation (e.g. baking Mach bands into separate named fields), nothing in *this* module breaks — `interpolate1D`/`interpolate2D` remain available, just possibly unused by `AeroTables` — but modules 02/03 would then need to reimplement equivalent clamped-linear/bilinear logic themselves; section 4.8/4.9's algorithms are written precisely enough (including the exact clamping and degenerate-table rules) that a from-scratch reimplementation by module 02/03 would still be numerically identical to using `Table1D`/`Table2D` directly, so this is a "possible duplicated effort," not a correctness risk.
3. **Which axis is alpha vs. Mach in a `Table2D`.** Deliberately left unfixed (`Table2D` is axis-agnostic, `xs` paired with the first interpolation argument, `ys` with the second) since that choice belongs to module 03's `AeroTables` design, not to this module.
4. **Nobody else redefines `mulberry32`/FNV-1a independently.** Because `src/math/prng.ts` is the sole owner of `createPrng`/`nextFloat01`/`deriveSubSeed`, and 00-architecture.md section 2 mandates "the one and only PRNG is `mulberry32` in `src/math`," I assume every module needing randomness (04 terrain, 06 AI, 02/10 weather gust) imports these functions rather than hand-rolling an equivalent — there is no contract mechanism that could *prevent* a module from calling `Math.random()` or writing its own PRNG other than 00-architecture.md's prose rule plus module 12's grep-based acceptance check (section 8, item 4, generalized project-wide in `12-verification.md`).
