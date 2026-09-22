# 03 — Tejas Mk1 aircraft data

Read `00-architecture.md` and `contracts/core.ts` in full before this document; where anything here appears to disagree with either, they win. This module implements `contracts/aircraft.ts` (module 03's own contract, pinned field-for-field by `00-architecture.md` section 9.1) inside `src/aircraft/`.

## 1. Purpose & scope

`src/aircraft` is a pure DATA module: it exports one `AircraftDefinition` value (`tejasDefinition`) describing the HAL Tejas Mk1 — mass/inertia/geometry, the GE F404-IN20 engine's thrust/fuel tables, the aerodynamic coefficient tables and derivatives, the three-leg landing-gear model, the fly-by-wire control-law limits (`FcsLimits`), the seven weapon/store hardpoints, and the placeholder wireframe visual model (vertices/edges/moving groups). It contains no algorithms of its own — every formula that consumes this data (aero force/moment assembly, engine thrust/fuel lookup, gear contact, the FCS control laws) lives in `src/physics` (module 02), which was drafted blind to this file and instead assumes the exact shape `00-architecture.md` section 9.1 pins. This module's only job is to populate that shape with real-world-plausible numbers for a single-engine, tailless, cranked-delta, relaxed-static-stability light fighter, and to document exactly which numbers are genuine public figures versus engineering-judgment approximations (section 9).

This module never touches the DOM, never calls `Math.random()`, and its one exported value is a `const` object literal — no runtime computation, no allocation beyond module load.

## 2. Owned files

| path | purpose |
|---|---|
| `src/aircraft/tejasGeometry.ts` | Mass, inertia, CG offset, wing geometry, the seven `Hardpoint`s, the three `GearDefinition` legs, `FcsLimits`. |
| `src/aircraft/tejasAeroTables.ts` | The `AeroTables` object: `CL`/`CD`/`Cm` `Table2D`s vs (alphaRad, mach) plus every derivative/scalar (section 5.1). |
| `src/aircraft/tejasEngineTables.ts` | The `EngineTables` object: F404-IN20 thrust/fuel-flow `Table2D`s vs (mach, altitudeM) (section 5.2). |
| `src/aircraft/tejasWireframe.json` | The `WireframeModel` data (vertices/edges/groups), authored at zero-deflection / gearPos=0 rest pose (section 5.4). |
| `src/aircraft/wireframeTypes.ts` | Re-exports `WireframeModel`/`WireframeGroup` from `contracts/aircraft.ts`; a thin, non-contract local alias so `tejasWireframe.json` has a typed import site (`import wireframeJson from './tejasWireframe.json'` with `resolveJsonModule` per `00-architecture.md` section 13's tsconfig). |
| `src/aircraft/tejasDefinition.ts` | Assembles the above into one `export const tejasDefinition: AircraftDefinition = { id: 'tejas-mk1', ... }`. |
| `src/aircraft/index.ts` | Barrel re-export: `export { tejasDefinition } from './tejasDefinition';` — the ONE symbol every other module (`src/core/flightModelAdapter.ts`, `tools/lib/trimSolver.ts` fixtures, `tests/aircraft/*`, `tests/integration/trimAndPerformance.test.ts`) imports from this module. |

No other files. No sub-directories. `src/aircraft` imports only `src/contracts/*` (per `00-architecture.md` section 10 — it does NOT import `src/math`, even though it legitimately could: every number in this module is a static data value, never computed at runtime, so there is nothing for a math helper to do here).

## 3. Public API

This restates `contracts/aircraft.ts` (the authoritative file — this section must not diverge from it). See that file for full doc comments; every shape below is pinned, field-for-field, by `00-architecture.md` section 9.1.

```ts
import type { Vec3Like } from '../contracts/core';
import type { Table2D } from '../contracts/math';

export interface Hardpoint { id: string; posBodyM: Vec3Like; type: 'gun' | 'ir_missile' | 'radar_missile' | 'fuel_tank'; }
export interface WireframeGroup { name: string; vertexIndices: readonly number[]; pivotBodyM: Vec3Like; axisBody: Vec3Like; }
export interface WireframeModel { vertices: readonly (readonly [number, number, number])[]; edges: readonly (readonly [number, number])[]; groups: readonly WireframeGroup[]; }

export interface AeroTables {
  CL: Table2D; CD: Table2D; Cm: Table2D;
  CY_beta: number; Cl_beta: number; Cn_beta: number;
  CL_elevon: number; CD_elevon: number; Cm_elevon: number; Cl_elevon: number; Cn_elevon: number;
  CY_rudder: number; Cl_rudder: number; Cn_rudder: number;
  Cl_p: number; Cl_r: number; Cm_q: number; Cn_p: number; Cn_r: number;
  groundEffectMaxDeltaCL: number; stallAlphaRad: number;
}
export interface EngineTables {
  militaryThrustN: Table2D; afterburnerThrustN: Table2D;
  militaryFuelFlowKgS: Table2D; afterburnerFuelFlowKgS: Table2D;
  idleFuelFlowKgS: number; spoolTimeConstantSec: number;
}
export interface GearDefinition {
  id: string; posBodyM: Vec3Like; maxCompressionM: number; springNPerM: number; damperNPerMPerS: number;
  kineticFrictionCoefficient: number; steerable: boolean; maxSteerAngleRad: number; brakeCapable: boolean;
}
export interface FcsLimits {
  maxAlphaRad: number; minAlphaRad: number; maxGLoadPos: number; maxGLoadNeg: number; maxRollRateRadS: number;
  maxElevonRad: number; maxRudderRad: number; maxElevonRateRadS: number; maxRudderRateRadS: number;
  pitchRateGain: number; rollRateGain: number; yawRateGain: number; alphaLimitGain: number; gLoadGain: number;
}
export interface AircraftDefinition {
  id: string; massKg: number; emptyMassKg: number; maxFuelKg: number;
  inertiaBodyKgM2: { xx: number; yy: number; zz: number; xy: number; xz: number; yz: number };
  cgOffsetBodyM: Vec3Like; wingAreaM2: number; wingSpanM: number; meanChordM: number;
  hardpoints: readonly Hardpoint[]; wireframe: WireframeModel;
  aero: AeroTables; engine: EngineTables; gear: readonly GearDefinition[]; fcsLimits: FcsLimits;
}
```

`src/aircraft/index.ts` exports exactly one runtime value beyond the re-exported types: `export const tejasDefinition: AircraftDefinition`. `id: 'tejas-mk1'` — this is the exact string `10-core-worker.md` section 5.3's built-in missions and section 4.2's player-spawn default already assume (that document flagged it as "this module's guess at module 03's `AircraftDefinition.id`" — it is not a guess, it is this value).

## 4. Design & algorithms

This module has no per-tick algorithm (section 1). The one piece of "design" is HOW the data below was derived, so a reviewer can tell approximation from fabrication:

- **Mass/geometry** (section 5.1) are transcribed from commonly-cited public HAL Tejas Mk1 figures (empty weight, wing area/span, internal fuel capacity), the same class of general reference material `12-verification.md`'s own `tools/lib/perfTargets.ts` (module 12) independently draws its performance targets from — the two are cross-checkable against each other (section 9).
- **Aerodynamic coefficients** (section 5.2) have no public source at this level of detail for any Tejas variant (classified/proprietary flight-test data). They are engineering-judgment values constructed to satisfy three hard requirements this project's other modules already depend on: (a) `CL`/`CD` shape and magnitude typical of a clean cranked-delta at subsonic-to-low-supersonic Mach (vortex-lift-extended stall to ~22°, CLmax ≈ 1.15–1.2); (b) `Cm(alpha)` has a POSITIVE slope through the trim region at subsonic Mach — i.e. genuinely open-loop UNSTABLE, matching the product brief's "relaxed static stability" requirement and `02-flight-model.md` section 8 criterion 9's mechanical test; (c) `Cm_elevon` is negative, per `00-architecture.md` section 6.2's elevon sign rule (00-architecture.md's own worked derivation: +elevon = trailing-edge-down = nose-down moment).
- **Engine thrust/fuel tables** (section 5.3) are derived from GE F404-IN20's publicly cited sea-level static ratings (dry ≈ 53.9 kN / afterburner ≈ 84.5 kN) with a standard ISA-density altitude lapse and a simple proportional (TSFC-based) fuel-flow model — not a real engine deck.
- **Landing gear** (section 5.5) spring/damper values are chosen to satisfy `02-flight-model.md` section 5.4's stability bound exactly, with headroom (section 6 of this document shows the arithmetic), and a damping ratio in its required `[0.3, 0.7]` band.
- **Wireframe** (section 5.6) is a deliberately simple placeholder polyline model per the product brief ("placeholder WIREFRAME aircraft model") — visual fidelity is explicitly out of scope; only structural validity (edge indices in range, group vertex indices declared, group names matching `contracts/render.ts`'s `WIREFRAME_CONTROL_GROUP_NAMES`) is normative.

## 5. Data

### 5.1 Mass, geometry, hardpoints

| field | value | unit | source/justification |
|---|---|---|---|
| `id` | `'tejas-mk1'` | — | fixed identifier every mission/AI/test in this project references |
| `emptyMassKg` | 6560 | kg | commonly cited public HAL Tejas Mk1 empty weight |
| `maxFuelKg` | 2458 | kg | commonly cited public internal fuel capacity |
| `massKg` | 8500 | kg | fixed reference combat weight the integrator uses (`02-flight-model.md` section 9: `stepAircraft` treats mass as constant, not `emptyMassKg + fuelKg`) — empty weight plus a representative internal-fuel-plus-light-loadout combat weight, deliberately below max takeoff weight since this is the integrator's one FIXED reference mass, not a snapshot of any single instant |
| `wingAreaM2` | 38.4 | m² | public reference figure; matches `tools/lib/perfTargets.ts`'s own asserted bound [34, 43] (`12-verification.md`) exactly |
| `wingSpanM` | 8.2 | m | public reference figure; matches the same bound [8.0, 8.4] |
| `meanChordM` | 4.68 | m | `wingAreaM2 / wingSpanM`, a simplified rectangular-reference MAC approximation (a cranked-delta's true MAC integral needs planform data not publicly available at this precision) |
| `cgOffsetBodyM` | `{x: -0.15, y: 0.05, z: 0}` | m | small offset between the wireframe's body-frame origin (fuselage reference line intersection) and the CG; magnitude chosen small and physically unremarkable (no public CG-travel data exists) |
| `inertiaBodyKgM2` | see below | kg·m² | scaled from an F-16-class light-fighter analogue (see section 9) |

`inertiaBodyKgM2 = { xx: 5700, yy: 38000, zz: 33000, xy: -300, xz: 0, yz: 0 }`. Recall this project's body frame is Y-up (canopy), Z-right (starboard): `xx` is about the roll axis (X, nose-tail — smallest, mass concentrated near the fuselage centerline), `yy` is about the YAW axis (Y, up — largest, both fuselage length and wingspan contribute), `zz` is about the PITCH axis (Z, right — middle). `xy` (the one nonzero product term, coupling the two axes that lie IN the aircraft's left-right symmetry plane — see 00-architecture.md section 3.2, our symmetry plane is X-Y since Z is lateral) is a small placeholder reflecting that mass is not perfectly symmetric fore-aft/up-down (engine mass low and aft, avionics forward and higher); `xz`/`yz` are exactly zero, the standard simplification for a left-right-symmetric aircraft (no product of inertia may couple the lateral axis Z with either in-plane axis for a rigid body symmetric about the X-Y plane). The inertia-triangle inequality (`xx+yy>=zz`, `yy+zz>=xx`, `xx+zz>=yy`) holds: `5700+38000=43700>=33000` ✓, `38000+33000=71000>=5700` ✓, `5700+33000=38700>=38000` ✓ (this last one is the tightest — verified explicitly since it is the closest margin).

**Hardpoints** (seven total, covering every `Hardpoint.type`):

| id | posBodyM (x,y,z) | type |
|---|---|---|
| `gun-1` | (3.5, -0.2, 0.3) | `gun` |
| `wingtip-l` | (-0.5, 0, -4.0) | `ir_missile` |
| `wingtip-r` | (-0.5, 0, 4.0) | `ir_missile` |
| `pylon-outer-l` | (-0.3, -0.3, -3.0) | `radar_missile` |
| `pylon-outer-r` | (-0.3, -0.3, 3.0) | `radar_missile` |
| `pylon-inner-l` | (-0.1, -0.3, -1.8) | `fuel_tank` |
| `pylon-inner-r` | (-0.1, -0.3, 1.8) | `fuel_tank` |

(`+z` is starboard per `00-architecture.md` section 3.2 — `wingtip-r`/`pylon-outer-r`/`pylon-inner-r` are the RIGHT/starboard stations, `-l` the left/port ones, placed symmetrically.)

### 5.2 Aerodynamic tables (`AeroTables`)

`CL`/`CD`/`Cm` are `Table2D`s indexed `(alphaRad, mach)` — i.e. `interpolate2D(table, alphaRad, mach)` (`contracts/math.ts`). Alpha breakpoints (`xs`, rad): `[-10, -5, 0, 5, 10, 15, 20, 22]` degrees converted (`DEG2RAD = PI/180`): `[-0.174533, -0.087266, 0, 0.087266, 0.174533, 0.261799, 0.349066, 0.383972]`. `stallAlphaRad = 0.383972` (22°) — the LAST alpha breakpoint, so `CL` is authored monotonically non-decreasing across the table's ENTIRE alpha range (the domain `02-flight-model.md` section 8 criterion 9 and `12-verification.md` section 4.3's monotonicity test both sample). Mach breakpoints (`ys`): `[0.2, 0.6, 0.9, 1.2, 1.6]`.

`CL.zs[i][j]` (alpha row `i`, mach column `j`):

| alpha\mach | 0.2 | 0.6 | 0.9 | 1.2 | 1.6 |
|---|---|---|---|---|---|
| -10° | -0.55 | -0.50 | -0.42 | -0.30 | -0.22 |
| -5° | -0.20 | -0.18 | -0.15 | -0.10 | -0.07 |
| 0° | 0.18 | 0.17 | 0.15 | 0.10 | 0.07 |
| 5° | 0.55 | 0.52 | 0.46 | 0.32 | 0.24 |
| 10° | 0.85 | 0.80 | 0.72 | 0.52 | 0.40 |
| 15° | 1.05 | 0.98 | 0.88 | 0.66 | 0.52 |
| 20° | 1.15 | 1.06 | 0.95 | 0.74 | 0.60 |
| 22° | 1.18 | 1.08 | 0.97 | 0.76 | 0.62 |

Every column is strictly non-decreasing top-to-bottom (verified by inspection) — this is what `02-flight-model.md` section 8 criterion 9 and `12-verification.md` section 4.3's `tests/aircraft/tejasAeroTables.test.ts` both check mechanically.

`CD.zs[i][j]` (never negative, per the same acceptance criteria; `CD(0°, 0.3)` — interpolated between the 0.2 and 0.6 mach columns — must fall in `[0.015, 0.06]`, verified below):

| alpha\mach | 0.2 | 0.6 | 0.9 | 1.2 | 1.6 |
|---|---|---|---|---|---|
| -10° | 0.085 | 0.095 | 0.130 | 0.210 | 0.165 |
| -5° | 0.035 | 0.040 | 0.060 | 0.110 | 0.090 |
| 0° | 0.022 | 0.025 | 0.040 | 0.085 | 0.070 |
| 5° | 0.045 | 0.050 | 0.075 | 0.140 | 0.115 |
| 10° | 0.090 | 0.098 | 0.130 | 0.220 | 0.180 |
| 15° | 0.160 | 0.170 | 0.210 | 0.320 | 0.260 |
| 20° | 0.260 | 0.270 | 0.320 | 0.440 | 0.370 |
| 22° | 0.310 | 0.320 | 0.370 | 0.490 | 0.420 |

`interpolate2D(CD, 0, 0.3)`: linearly interpolating the mach axis between `(0.2, 0.022)` and `(0.6, 0.025)` at `mach=0.3` gives `0.022 + (0.025-0.022)*(0.3-0.2)/(0.6-0.2) = 0.022 + 0.003*0.25 = 0.02275` — inside `[0.015, 0.06]` ✓.

`Cm.zs[i][j]` (about the CG; POSITIVE slope through the trim region at low mach — the relaxed-static-stability requirement):

| alpha\mach | 0.2 | 0.6 | 0.9 | 1.2 | 1.6 |
|---|---|---|---|---|---|
| -10° | -0.080 | -0.070 | -0.060 | -0.050 | -0.040 |
| -5° | -0.030 | -0.025 | -0.020 | -0.015 | -0.010 |
| 0° | 0.010 | 0.008 | 0.006 | 0.004 | 0.002 |
| 5° | 0.050 | 0.045 | 0.035 | 0.020 | 0.010 |
| 10° | 0.090 | 0.080 | 0.065 | 0.040 | 0.022 |
| 15° | 0.110 | 0.098 | 0.080 | 0.050 | 0.030 |
| 20° | 0.100 | 0.090 | 0.075 | 0.048 | 0.028 |
| 22° | 0.080 | 0.072 | 0.060 | 0.040 | 0.024 |

**Cm(alpha) slope at trim (documenting `02-flight-model.md` section 8 criterion 9's required value).** For a combat-weight, subsonic (`mach≈0.2`) level-flight trim, the required `CL` (from `massKg=8500`, a representative trim speed ≈220 m/s at 5000 m altitude — see `02-flight-model.md` section 4.1's ISA table for `rho(5000m)≈0.7361 kg/m3`) is `CL = 2*W/(rho*V^2*S) = 2*8500*9.80665/(0.7361*220^2*38.4) ≈ 166713/(1366170) ≈ 0.122`, which per the `CL` table above at `mach=0.2` sits between the `0°` row (`CL=0.18`) — actually slightly BELOW it, meaning trim alpha is slightly negative-to-zero for this particular speed/altitude combination; a lower trim speed or higher weight shifts it into the `0°–5°` band where the table is sampled below. Taking the `0°→5°` interval as the representative trim-region slope (this is the band `stepAircraft`'s FCS is actively working in across the flight envelope, not just the single trim point above): `dCm/dalpha ≈ (0.050 - 0.010) / (0.087266 - 0) = 0.040 / 0.087266 ≈ 0.4585 per rad` at `mach=0.2`. This is the number `02-flight-model.md` section 8 criterion 9(a)'s open-loop divergence test exercises: a `+1°` (`0.01745 rad`) alpha perturbation from trim grows, over 1 s of frozen-surface flight, at a rate whose sign is set by this positive slope (the exact growth magnitude also depends on `Cm_q`'s damping and the pitch inertia `Izz=33000`, both given below — criterion 9 only asserts the SIGN/direction of divergence, not a specific growth-rate number, since deriving that closed-form would require linearizing the full 6-DOF model, out of this document's scope).

**Derivatives and scalars** (per rad unless noted):

| field | value | note |
|---|---|---|
| `CY_beta` | -0.90 | sideforce due to sideslip |
| `Cl_beta` | -0.12 | dihedral effect (roll due to sideslip; negative = restoring) |
| `Cn_beta` | 0.15 | weathercock stability (positive = restoring/stable) |
| `CL_elevon` | 0.42 | +elevon (TE down) increases CL |
| `CD_elevon` | 0.15 | per rad \|elevonSym\| |
| `Cm_elevon` | **-0.85** | MUST be negative — see section 1/4 and `00-architecture.md` section 6.2 |
| `Cl_elevon` | 0.12 | +elevonDiff (`elevonL-elevonR`) → right wing down → positive roll, per `02-flight-model.md` section 4.5's own sign derivation |
| `Cn_elevon` | -0.015 | small adverse yaw from differential elevon |
| `CY_rudder` | -0.35 | side force from rudder |
| `Cl_rudder` | 0.01 | small roll coupling from rudder |
| `Cn_rudder` | -0.09 | matches `core.ts`'s `EntityState.rudder` doc comment: "+rudder (TE left) produces nose-LEFT" |
| `Cl_p` | -0.35 | roll damping (always negative) |
| `Cl_r` | 0.18 | roll due to yaw rate (proverse) |
| `Cm_q` | -2.50 | pitch damping (smaller magnitude than a tailed aircraft — no long tail moment arm on a tailless delta) |
| `Cn_p` | -0.05 | yaw due to roll rate |
| `Cn_r` | -0.28 | yaw damping (always negative) |
| `groundEffectMaxDeltaCL` | 0.15 | 15% CL boost at h/b=0, standard order-of-magnitude for a low-wing delta in ground effect |
| `stallAlphaRad` | 0.383972 | = 22°, the last `CL`/`CD`/`Cm` alpha breakpoint |

### 5.3 Engine tables (`EngineTables`, F404-IN20)

`militaryThrustN`/`afterburnerThrustN`/`militaryFuelFlowKgS`/`afterburnerFuelFlowKgS` are `Table2D`s indexed `(mach, altitudeM)` — `interpolate2D(table, mach, altitudeM)`. Mach breakpoints (`xs`): `[0, 0.3, 0.6, 0.9, 1.2, 1.6]`. Altitude breakpoints (`ys`, m): `[0, 5000, 11000, 15000]`.

`militaryThrustN.zs[i][j]` (mach row `i`, altitude column `j`), N:

| mach\alt | 0 | 5000 | 11000 | 15000 |
|---|---|---|---|---|
| 0 | 53900 | 33400 | 16000 | 8600 |
| 0.3 | 50000 | 31000 | 14850 | 7950 |
| 0.6 | 46000 | 28500 | 13650 | 7300 |
| 0.9 | 42000 | 26000 | 12500 | 6700 |
| 1.2 | 39000 | 24200 | 11600 | 6200 |
| 1.6 | 34000 | 21100 | 10100 | 5400 |

Sea-level-static value at `mach=0` (53900 N) matches the publicly cited GE F404-IN20 dry rating (≈53.9 kN); the altitude lapse approximates the ISA density ratio (`rho(5000m)/rho(0)≈0.62`, `rho(11000m)/rho(0)≈0.297`, `rho(15000m)/rho(0)≈0.159`, `02-flight-model.md` section 4.1's own ISA table) applied to sea-level thrust; the Mach lapse (thrust falling off with increasing Mach for a NON-augmented turbofan, since dry power alone cannot compensate for intake/ram losses at high speed) is a standard qualitative trend for this engine class.

`afterburnerThrustN.zs[i][j]`, N (afterburner thrust RISES with Mach up to a point — ram-air effect — then falls off at the highest Mach as intake losses dominate; sea-level-static ≈84.5 kN matches the publicly cited F404-IN20 afterburning rating):

| mach\alt | 0 | 5000 | 11000 | 15000 |
|---|---|---|---|---|
| 0 | 84500 | 52400 | 25100 | 13400 |
| 0.3 | 88000 | 54600 | 26100 | 14000 |
| 0.6 | 92000 | 57000 | 27300 | 14600 |
| 0.9 | 96000 | 59500 | 28500 | 15300 |
| 1.2 | 99000 | 61400 | 29400 | 15700 |
| 1.6 | 95000 | 58900 | 28200 | 15100 |

`militaryFuelFlowKgS.zs[i][j] = round(militaryThrustN.zs[i][j] * 1.05e-5, 3)` (a simple, constant-TSFC-style proportionality, ≈0.566 kg/s at the sea-level-static military point — a plausible dry-power fuel flow for this thrust class):

| mach\alt | 0 | 5000 | 11000 | 15000 |
|---|---|---|---|---|
| 0 | 0.566 | 0.351 | 0.168 | 0.090 |
| 0.3 | 0.525 | 0.326 | 0.156 | 0.083 |
| 0.6 | 0.483 | 0.299 | 0.143 | 0.077 |
| 0.9 | 0.441 | 0.273 | 0.131 | 0.070 |
| 1.2 | 0.410 | 0.254 | 0.122 | 0.065 |
| 1.6 | 0.357 | 0.222 | 0.106 | 0.057 |

`afterburnerFuelFlowKgS.zs[i][j] = round(afterburnerThrustN.zs[i][j] * 5.3e-5, 2)` (a higher constant-TSFC-style proportionality reflecting afterburning's much poorer specific fuel consumption, ≈4.48 kg/s at the sea-level-static full-afterburner point):

| mach\alt | 0 | 5000 | 11000 | 15000 |
|---|---|---|---|---|
| 0 | 4.48 | 2.78 | 1.33 | 0.71 |
| 0.3 | 4.66 | 2.89 | 1.38 | 0.74 |
| 0.6 | 4.88 | 3.02 | 1.45 | 0.77 |
| 0.9 | 5.09 | 3.15 | 1.51 | 0.81 |
| 1.2 | 5.25 | 3.25 | 1.56 | 0.83 |
| 1.6 | 5.04 | 3.12 | 1.49 | 0.80 |

`idleFuelFlowKgS = 0.09` (representative idle consumption for this thrust class). `spoolTimeConstantSec = 2.5` (typical afterburning-turbofan idle-to-military spool lag).

### 5.4 Landing gear (`GearDefinition[3]`)

`02-flight-model.md` section 5.4's required stability bound: `springNPerM <= 0.25*(massKg/3)/(GEAR_HARD_STOP_STIFFNESS_MULTIPLIER * dtSub^2)` with `massKg=8500`, `GEAR_HARD_STOP_STIFFNESS_MULTIPLIER=20`, `dtSub=1/240 s` (so `dtSub^2 = 1/57600`): bound `= 0.25*(8500/3)*57600/20 = 0.25*2833.33*2880 = 2,040,000 N/m`. Both leg types below stay well under this bound (≈4.5x and ≈8x margin respectively):

| id | posBodyM (x,y,z) | maxCompressionM | springNPerM | damperNPerMPerS | kineticFrictionCoefficient | steerable | maxSteerAngleRad | brakeCapable |
|---|---|---|---|---|---|---|---|---|
| `nose` | (4.3, -1.1, 0) | 0.28 | 250000 | 26000 | 0.6 | true | 0.5236 (30°) | false |
| `mainLeft` | (-0.2, -1.1, -1.1) | 0.35 | 450000 | 35000 | 0.6 | false | 0 | true |
| `mainRight` | (-0.2, -1.1, 1.1) | 0.35 | 450000 | 35000 | 0.6 | false | 0 | true |

Damping-ratio check (target `zeta` in `[0.3, 0.7]`, `damperNPerMPerS ≈ 2*zeta*sqrt(springNPerM*(massKg/3))`): main gear `sqrt(450000*2833.33) = sqrt(1.275e9) ≈ 35707`; solving `35000 = 2*zeta*35707` gives `zeta ≈ 0.490` — inside `[0.3, 0.7]` ✓. Nose gear `sqrt(250000*2833.33) = sqrt(7.083e8) ≈ 26614`; `zeta = 26000/(2*26614) ≈ 0.489` ✓. `kineticFrictionCoefficient = 0.6` matches `contracts/airport.ts`'s own `SURFACE_BRAKING_FRICTION_PAVED_DRY` constant exactly (module 05, drafted independently — both describing the same real-world dry-tire-on-paved-runway friction coefficient).

### 5.5 FCS limits (`FcsLimits`)

| field | value | unit | note |
|---|---|---|---|
| `maxAlphaRad` | 0.383972 | rad (22°) | equals `stallAlphaRad` — the alpha limiter engages exactly at the aerodynamic stall boundary |
| `minAlphaRad` | -0.20944 | rad (-12°) | negative-alpha (pushover) protection |
| `maxGLoadPos` | 8.0 | g | commonly cited Tejas structural limit |
| `maxGLoadNeg` | -3.0 | g | commonly cited Tejas structural limit |
| `maxRollRateRadS` | 5.236 | rad/s (300°/s) | typical light-fighter commanded roll rate |
| `maxElevonRad` | 0.436332 | rad (25°) | matches `02-flight-model.md` section 5.3's own `FCS_TRIM_INTEGRAL_MAX_RAD` derivation, which assumed exactly this value ("half of a typical `maxElevonRad≈0.4363 rad`/25°") |
| `maxRudderRad` | 0.349066 | rad (20°) | typical rudder travel |
| `maxElevonRateRadS` | 3.0 | rad/s | ≈172°/s, typical fighter elevon actuator rate |
| `maxRudderRateRadS` | 3.0 | rad/s | typical rudder actuator rate |
| `pitchRateGain` | 0.3 | rad/(rad/s) | Kq pitch damper |
| `rollRateGain` | 0.5 | rad/(rad/s) | Kp roll rate-command gain |
| `yawRateGain` | 0.4 | rad/(rad/s) | Kr yaw damper |
| `alphaLimitGain` | 3.0 | 1/rad | Ka alpha-limiter proportional gain |
| `gLoadGain` | 1.0 | rad/g | Kg — matches `02-flight-model.md` section 4.9's own worked auto-trim example exactly, which assumed "`Kg=1 rad/g`" |

### 5.6 Wireframe model (`WireframeModel`, `src/aircraft/tejasWireframe.json`)

Authored at rest pose: zero elevon/rudder deflection, `gearPos=0` (fully retracted), per `contracts/render.ts`'s documented convention. 19 vertices (body-frame metres, `[x,y,z]`), indices 0–18:

```
 0: [ 6.6,  0.3,  0.0]   nose tip
 1: [ 3.0,  1.0,  0.0]   canopy apex
 2: [-6.6,  0.4,  0.0]   tail cone
 3: [-6.0,  2.8,  0.0]   fin tip
 4: [-6.8,  0.5,  0.0]   fin trailing-edge base
 5: [-6.9,  2.6,  0.0]   rudder trailing-edge tip      (rudder group)
 6: [-6.9,  0.6,  0.0]   rudder trailing-edge base      (rudder group)
 7: [ 1.0,  0.0,  0.4]   wing root leading edge, right
 8: [-1.0,  0.0,  3.0]   wing crank, right
 9: [-4.0,  0.0,  4.1]   wing tip leading edge, right
10: [-4.3,  0.0,  4.05]  wing tip trailing edge, right
11: [-4.5,  0.0,  1.0]   elevon inboard trailing edge, right
12: [-4.5,  0.0,  3.9]   elevon outboard trailing edge, right   (elevonR group)
13: [ 1.0,  0.0, -0.4]   wing root leading edge, left
14: [-1.0,  0.0, -3.0]   wing crank, left
15: [-4.0,  0.0, -4.1]   wing tip leading edge, left
16: [-4.3,  0.0, -4.05]  wing tip trailing edge, left
17: [-4.5,  0.0, -1.0]   elevon inboard trailing edge, left
18: [-4.5,  0.0, -3.9]   elevon outboard trailing edge, left    (elevonL group)
```

Edges (index pairs): fuselage `[0,1],[1,2]`; fin `[2,3],[3,4],[4,2]`; rudder `[4,5]` (fin-to-rudder-tip, static) and `[5,6]` (the moving rudder trailing edge itself); right wing planform `[7,8],[8,9],[9,10],[10,11],[11,7]` plus the elevon leading edge `[11,12]`; left wing mirrored `[13,14],[14,15],[15,16],[16,17],[17,13]` plus `[17,18]`.

Gear wheel points (indices 19–21, added to the vertex list above), each its own single-vertex group:

```
19: [ 4.3, -0.95,  0.0]   nose wheel (retracted)     (noseGear group)
20: [-0.2, -0.95, -1.1]   left main wheel (retracted) (mainGearL group)
21: [-0.2, -0.95,  1.1]   right main wheel (retracted)(mainGearR group)
```

No edges connect to the gear wheel vertices in the base `edges` list (a real strut line is cosmetic-only and not required for structural validity — `tests/aircraft/wireframe.test.ts`, section 7, only checks that `edges` index pairs and `groups[].vertexIndices` reference valid, in-range vertex indices, per `12-verification.md` section 4.3's own invariant-testing pattern, not that every vertex is drawn as part of an edge).

**Groups** (six total, matching `contracts/render.ts`'s `WIREFRAME_CONTROL_GROUP_NAMES` exactly):

| name | vertexIndices | pivotBodyM | axisBody |
|---|---|---|---|
| `elevonL` | `[18]` | `(-4.5, 0, -1.0)` | `(0, 0, 1)` |
| `elevonR` | `[12]` | `(-4.5, 0, 1.0)` | `(0, 0, 1)` |
| `rudder` | `[5, 6]` | `(-6.8, 0.5, 0)` | `(0, 1, 0)` |
| `noseGear` | `[19]` | `(4.3, 0.15, 0)` | `(0, 0, 1)` |
| `mainGearL` | `[20]` | `(-0.2, 0.15, -1.1)` | `(0, 0, 1)` |
| `mainGearR` | `[21]` | `(-0.2, 0.15, 1.1)` | `(0, 0, 1)` |

(Rotation axis `(0,0,1)` for the elevons/gear means the swing happens in the body X-Y plane — trailing edge up/down for the elevons, retracted/extended for the gear; `(0,1,0)` for the rudder means it swings left/right in the X-Z plane, matching a vertical-fin-mounted control surface. The exact visual sweep this produces at `elevonL=fcsLimits.maxElevonRad`/`gearPos=1` is a cosmetic placeholder detail, not independently verified beyond the structural checks in section 7 — see section 4's scope note.)

## 6. Performance budget

`tejasDefinition` is a single `const` object literal, built once at module load and never mutated. Zero allocation after that (every consumer — `src/physics`, `src/render`, `src/ai` indirectly via `PilotContext`, `tools/sim-check.ts` — reads fields off the same shared object; nobody clones it). The `Table2D` lookups this data feeds (`interpolate2D`, `contracts/math.ts`) are a fixed, small (5–6 breakpoint) bilinear search per call, per `02-flight-model.md` section 6's own performance budget — this module contributes no additional per-tick cost of its own beyond being the data those lookups read.

## 7. Unit tests to write

All in `tests/aircraft/*.test.ts`, mirroring `src/aircraft/*.ts`. `12-verification.md` section 2 lists these same four files; the invariant-style assertions below are this document's own (module 12's structural/invariant tests, section 4.3 of `12-verification.md`, are a supplementary black-box layer over the same data, not a replacement).

**`tests/aircraft/tejasDefinition.test.ts`**
1. `tejasDefinition.id === 'tejas-mk1'` exactly.
2. `tejasDefinition.massKg > tejasDefinition.emptyMassKg` (combat weight exceeds empty weight).
3. `tejasDefinition.massKg <= tejasDefinition.emptyMassKg + tejasDefinition.maxFuelKg` (never claims more mass than empty + full internal fuel could support).
4. Inertia triangle inequality holds for `inertiaBodyKgM2` (`xx+yy>=zz`, `yy+zz>=xx`, `xx+zz>=yy`), per section 5.1's worked check.
5. `wingAreaM2` in `[34, 43]`, `wingSpanM` in `[8.0, 8.4]` (matches `12-verification.md` section 4.3's own bounds exactly).
6. Exactly 3 `gear` entries with ids `'nose'`, `'mainLeft'`, `'mainRight'` (order-independent — assert via a `Set`).
7. Exactly 7 `hardpoints`, with all four `Hardpoint.type` values represented at least once.

**`tests/aircraft/tejasAeroTables.test.ts`**
8. `interpolate2D(aero.CL, alphaRad, mach)` is non-decreasing in `alphaRad` (sampled at 40 points from -5° to `stallAlphaRad`) for every one of the 5 mach breakpoints — per-column monotonicity, matching section 5.2's worked table.
9. `interpolate2D(aero.CD, alphaRad, mach) >= 0` for every `(alphaRad, mach)` combination of the 8×5 breakpoint grid.
10. `interpolate2D(aero.CD, 0, 0.3)` in `[0.015, 0.06]` — the exact worked value from section 5.2 (`0.02275`).
11. `aero.Cm_elevon < 0` exactly (the sign-rule regression test — this is the single check that would have caught the elevon-sign defect `00-architecture.md`'s own cross-module reconciliation found and fixed).
12. `dCm/dalpha` computed via central difference at `alphaRad=0.0436` (2.5°, the midpoint of the 0°–5° trim band) at `mach=0.2` is strictly positive — mechanically re-derives section 5's documented `≈0.4585/rad` figure to within `10%`.

**`tests/aircraft/tejasEngineTables.test.ts`**
13. `interpolate2D(engine.militaryThrustN, 0, 0)` within `1%` of `53900`; `interpolate2D(engine.afterburnerThrustN, 0, 0)` within `1%` of `84500` (the two sea-level-static reference points section 5.3 cites).
14. For every mach breakpoint, `militaryThrustN` is non-increasing in altitude (thrust falls as the air thins).
15. `afterburnerThrustN.zs[i][j] > militaryThrustN.zs[i][j]` for every `(i,j)` — afterburner always produces more thrust than dry power at the same flight condition.
16. `afterburnerFuelFlowKgS.zs[i][j] > militaryFuelFlowKgS.zs[i][j]` for every `(i,j)`.

**`tests/aircraft/wireframe.test.ts`**
17. Every `edges[k]` pair and every `groups[k].vertexIndices[m]` is a valid index into `vertices` (`0 <= idx < vertices.length`).
18. All six `WIREFRAME_CONTROL_GROUP_NAMES` values (`elevonL`, `elevonR`, `rudder`, `noseGear`, `mainGearL`, `mainGearR`) appear as exactly one `groups[].name` each, no duplicates, no missing.
19. `groups` contains no name outside the six control names PLUS no name collides case-insensitively with a different one (guards against an accidental `ElevonL`/`elevonl` typo that `contracts/render.ts`'s exact-string-match animation would silently treat as static).

## 8. Acceptance criteria

1. `src/aircraft/*.ts` (and `contracts/aircraft.ts`) compile with `tsc --noEmit --strict` with zero errors, as part of the whole-`src/` strict compile (`00-architecture.md` section 12 step 4) — this is the mechanical check that closes the blocker `contracts/flight.ts`'s `import type { AircraftDefinition } from './aircraft'` depended on.
2. `docs/spec/contracts/aircraft.ts` compiles standalone (with `core.ts` and `math.ts` present alongside it) under `tsc --noEmit --strict`, per module 12's contract-audit step (`00-architecture.md` section 8, `12-verification.md` section 4.9).
3. All 4 files under `tests/aircraft/` exist and pass (`vitest run tests/aircraft`), covering the 19 assertions in section 7.
4. `aero.Cm_elevon < 0` (test 11) and the `dCm/dalpha > 0` sign at the trim band (test 12) both pass — the two mechanical checks that make this module's relaxed-static-stability and elevon-sign claims (section 4) verifiable, not just asserted in prose.
5. `02-flight-model.md` section 8 criterion 9's open-loop/closed-loop stability round trip (in `tests/physics/relaxedStability.test.ts`, module 02/12) passes when run against `tejasDefinition` specifically (in addition to that module's own synthetic fixture) — exercised by `tests/integration/trimAndPerformance.test.ts` (module 12).
6. `tools/sim-check.ts --mode trim` (module 12) runs against `tejasDefinition` without `MaxIterationsExceeded`/`OutOfControlAuthority` for every condition in `12-verification.md` section 5.1's target table — a genuine integration-time check, not something this document can verify standalone, but this module's data is designed (section 4/9) to make it plausible.
7. No file exists under `src/aircraft/` other than those listed in section 2.
8. No `Math.random()` call anywhere under `src/aircraft/` (grep-checkable; this module has no randomness at all).

## 9. Open assumptions

- **Public performance/technical data for the Tejas Mk1 at the precision this module needs (aerodynamic derivatives, an engine deck, inertia tensor, gear spring/damper constants) does not exist outside classified/proprietary sources.** Every number in section 5 is either (a) a genuinely public headline figure (empty weight, wing area/span, internal fuel, engine sea-level-static thrust ratings, structural g-limits) transcribed as-is, or (b) an engineering-judgment approximation constructed to satisfy this project's own physical/structural requirements (relaxed static stability's positive `Cm_alpha`, the negative `Cm_elevon` sign rule, the gear stability bound, plausible mass/inertia/control-derivative magnitudes for a light single-engine delta fighter). Category (b) values are NOT flight-test data and should not be read as such.
- **Inertia tensor is scaled from an F-16-class light-fighter analogue**, since no public Tejas mass-properties report exists. The scaling used: taking published-order-of-magnitude F-16 inertia figures (`Ixx≈9500`, `Iyy(pitch)≈55000`, `Izz(yaw)≈63000` kg·m² in the classical x-forward/y-right/z-down convention) and applying a combined mass-ratio × length-ratio² scale factor (`(6560/8570) × (13.2/15)² ≈ 0.596`) to account for the Tejas's smaller size and lower weight, then remapping into this project's Y-up body frame (our `yy` = classical yaw = largest; our `zz` = classical pitch = middle; our `xx` = classical roll = smallest, unchanged since the roll axis is shared).
- **Aerodynamic derivatives (`Cl_beta`, `Cn_beta`, `Cl_p`, `Cm_q`, etc.) are representative magnitudes for a tailless cranked-delta fighter**, not derived from any specific published Tejas stability-and-control report — chosen to be dimensionally sound, correctly signed for basic static/dynamic stability in every axis EXCEPT pitch (where the positive `Cm_alpha` is the deliberate, required exception), and stable-looking in the sense that `Cl_p`/`Cn_r`/`Cm_q` (all damping derivatives) are negative as physically required for any flyable airframe.
- **Ground-effect and stall-AoA values (`groundEffectMaxDeltaCL=0.15`, `stallAlphaRad=22°`) follow the STANDARD FUNCTIONAL FORM `02-flight-model.md` section 4.4 fixes** (monotonic CL increase approaching the ground, gentle high-AoA stall typical of vortex-lift delta wings), with the specific numeric values chosen as plausible order-of-magnitude figures for this wing planform, not measured.
- **Engine fuel-flow tables use a simple constant-proportionality (TSFC-style) model** (`fuelFlowKgS = thrustN * constant`), not a real engine deck's actual (non-linear, altitude/Mach-dependent-efficiency) fuel consumption curve — adequate for this project's scope (a flight sim's fuel gauge and range/endurance behaviour, not a propulsion-engineering tool).
- **The wireframe model's visual geometry (vertex positions, gear-swing/elevon-swing axis choices) is a deliberately simple placeholder**, consistent with the product brief's explicit "placeholder WIREFRAME aircraft model" requirement — no attempt was made to reproduce the Tejas's actual external mold line beyond a recognizable cranked-delta-with-fin silhouette; only structural validity (section 7/8) is normative.
- **Cross-check against `12-verification.md`'s independently-derived `tools/lib/perfTargets.ts` performance targets was NOT performed by hand in this document** (that would require running the actual trim-solver numerics this document has no execution environment for). `12-verification.md` section 9 assumption #1 already anticipates this: if `tools/sim-check.ts --mode trim` finds a trimmed performance figure outside that document's tolerance bands once both modules' data exist together, that is flagged there as a legitimate integration-time finding to review (is this module's aero/engine data wrong, or was module 12's independent public-data approximation wrong?), not an automatic verdict against either document.
