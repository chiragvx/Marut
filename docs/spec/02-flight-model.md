# 02 — Flight model (physics)

Read `00-architecture.md` and `contracts/core.ts` in full before this document. Where anything here appears to disagree with either, they win; see section 9 for the one place this spec extends `Environment` beyond architecture section 9.1's literal four-field sketch, and why.

## 1. Purpose & scope

This module is `src/physics`: the aircraft-agnostic 6-DOF rigid-body flight model. It owns rigid-body integration, the ISA atmosphere, aerodynamic force/moment assembly from an `AircraftDefinition`'s data tables, the engine (thrust/fuel/spool-lag) model, the landing-gear contact model, the fly-by-wire flight control system (FCS), and wind/gust injection. It is a **pure function library**: given a state, a set of pilot inputs, an environment and an aircraft definition, it produces the next state. It has no knowledge of which aircraft it is flying (Tejas-specific numbers live in module 03's `AircraftDefinition` data, not here) and no knowledge of terrain beyond the single ground-elevation/normal sample `src/core` hands it each tick (module 04 owns the actual `HeightSampler`).

This module never touches the DOM, never calls `Math.random()` (the only randomness — wind gust — is driven by a PRNG stream `src/core` injects), and allocates nothing after module load.

## 2. Owned files

| path | purpose |
|---|---|
| `src/physics/atmosphere.ts` | ISA density/pressure/temperature/speed-of-sound model, 0–20 km. Implements `SampleAtmosphere`. |
| `src/physics/rigidBody.ts` | Semi-implicit Euler translational + rotational integration given a total body-frame force/moment; quaternion derivative and renormalization. |
| `src/physics/aeroForces.ts` | Airspeed/alpha/beta/dynamic-pressure computation, and the CL/CD/CY/Cl/Cm/Cn buildup → body-frame force/moment, including control-derivative and damping-derivative terms and ground effect. |
| `src/physics/engine.ts` | Thrust and fuel-flow lookup, first-order throttle spool lag, flameout logic. |
| `src/physics/landingGear.ts` | Per-leg spring-damper ground contact, tyre rolling/lateral friction, braking, nose-wheel steering, weight-on-wheels. |
| `src/physics/fcs.ts` | Pitch g/alpha-command law, roll rate-command law, yaw direct law + damper, on-ground law, actuator rate-limiting, damage-authority scaling. |
| `src/physics/wind.ts` | `SampleWind`/`CreateGustState`: steady wind + low-pass-filtered PRNG gust. |
| `src/physics/telemetry.ts` | `ComputeTelemetry` implementation. |
| `src/physics/integrator.ts` | Top-level `stepAircraft`, implementing `StepAircraft` from `contracts/flight.ts`; owns the substep loop and calls the files above in order. |
| `src/physics/index.ts` | Barrel re-export: `stepAircraft`, `computeTelemetry`, `sampleAtmosphere`, `sampleWind`, `createGustState`. |

No other files. No sub-directories.

## 3. Public API

This restates `contracts/flight.ts` (module 02's own contract; the authoritative file — this section must not diverge from it). See that file for full doc-comments.

```ts
import type { Vec3Like, EntityState, PilotInputs, DamageState, AircraftTelemetry, WeatherConfig } from '../contracts/core';
import type { AircraftDefinition } from '../contracts/aircraft';

export interface Environment {
  airDensityKgM3: number;
  soundSpeedMps: number;
  windWorldMps: Vec3Like;
  gravityMps2: number;
  groundElevationM: number;
  groundNormalWorld: Vec3Like;
}

export interface AtmosphereSample { densityKgM3: number; pressurePa: number; temperatureK: number; soundSpeedMps: number; }
export type SampleAtmosphere = (altitudeMslM: number, out: AtmosphereSample) => AtmosphereSample;

export type StepAircraft = (
  state: EntityState, damage: DamageState, inputs: PilotInputs,
  env: Environment, def: AircraftDefinition, dtSec: number, out: EntityState
) => void;

export type ComputeTelemetry = (
  state: EntityState, def: AircraftDefinition, env: Environment,
  damage: DamageState, out: AircraftTelemetry
) => AircraftTelemetry;

export interface GustState { filteredGustWorld: Vec3Like; }
export type CreateGustState = () => GustState;
export type SampleWind = (weather: WeatherConfig, state: GustState, rngNext: () => number, dtSec: number, out: Vec3Like) => Vec3Like;

export const FLIGHT_MODEL_SUBSTEPS = 2;
export const MIN_AIRSPEED_FOR_AERO_MPS = 1.0;
export const GEAR_CONTACT_GEARPOS_THRESHOLD = 0.98;
export const ROLLING_RESISTANCE_COEFFICIENT = 0.02;
export const GEAR_HARD_STOP_STIFFNESS_MULTIPLIER = 20;
export const GEAR_LATERAL_STIFFNESS_N_PER_MPS = 50000;
export const GROUND_LAW_MAX_ROTATION_RATE_RAD_S = 0.174533  // 10 deg/s; see section 5.3's own note
```

`src/physics/index.ts` exports five concrete functions implementing the five function-typed contract members: `stepAircraft: StepAircraft`, `computeTelemetry: ComputeTelemetry`, `sampleAtmosphere: SampleAtmosphere`, `sampleWind: SampleWind`, `createGustState: CreateGustState`. It additionally exports one non-contract convenience function, `resetFcsTrimState(entityIndex: number): void`, which zeroes `fcs.ts`'s private `trimIntegralRad[entityIndex]`/`lastGLoadRad[entityIndex]` (see section 9) — `src/core` calls this whenever it recycles a pooled entity-pool slot (by `UnpackEntityId(id).index`) for a newly-spawned aircraft, so the new aircraft never inherits a stale trim/gLoad value from whichever previous occupant used that slot. This function is NOT part of `contracts/flight.ts` (not needed by any module outside `src/core`/`src/physics`) and is safe to call for an index that was never used (no-op, since the arrays start zero-initialized).

**Tick order src/core must follow** (this module's functions compose correctly only in this order):

```
1. env.airDensityKgM3, env.soundSpeedMps   = sampleAtmosphere(state.pos.y, scratch)
2. env.groundElevationM, env.groundNormalWorld = sampler.heightAt/normalAt(state.pos.x, state.pos.z)
3. env.windWorldMps                        = sampleWind(mission.weather, entityGustState, entityRng, dtSec, scratch)
4. env.gravityMps2                         = GRAVITY_MPS2  (core.ts)
5. telemetry                               = computeTelemetry(state, def, env, damage, telemetryScratch)
6. pilotCtx.telemetry = telemetry; pilot.update(pilotCtx, dtSec, inputsScratch)
7. stepAircraft(state, damage, inputsScratch, env, def, dtSec, state)   // out aliases state
```

## 4. Design & algorithms

### 4.1 ISA atmosphere (`sampleAtmosphere`)

Two-layer International Standard Atmosphere, valid 0–20000 m (per project scope):

Constants: `T0=288.15 K`, `p0=101325 Pa`, `L=0.0065 K/m`, `g0=9.80665 m/s²`, `R=8.3144598 J/(mol·K)`, `M_air=0.0289644 kg/mol`, `R_specific = R/M_air = 287.05287 J/(kg·K)`, `gamma=1.4`, `T11=216.65 K` (temperature at 11000 m), `h_tropopause=11000 m`.

```
if altitudeMslM <= 11000:
  T = T0 - L*altitudeMslM
  p = p0 * (T/T0) ^ (g0*M_air/(R*L))          // = (T/T0)^5.25588
else:
  h' = clamp(altitudeMslM, 11000, 20000) - 11000
  T  = T11                                     // isothermal layer
  p11 = p0 * (T11/T0) ^ (g0*M_air/(R*L))
  p  = p11 * exp( -g0*M_air*h' / (R*T11) )

rho = p / (R_specific * T)
soundSpeedMps = sqrt(gamma * R_specific * T)
```

For `altitudeMslM > 20000`, clamp to the h'=9000 (i.e. 20000 m) formula (no third layer — out of project scope; a Tejas never flies there and this only prevents NaN if a bug sends an entity too high). For `altitudeMslM < 0`, extrapolate the layer-1 formula unclamped (still well-defined algebraically; airports can be below MSL-referenced 0 only in principle, this project's terrain doesn't go below sea level, this is just a safety net).

Reference check values (standard ISA table, used as unit-test fixtures, section 7):

| h (m) | T (K) | p (Pa) | ρ (kg/m³) | a (m/s) |
|---|---|---|---|---|
| 0 | 288.15 | 101325.0 | 1.2250 | 340.294 |
| 11000 | 216.65 | 22632.1 | 0.36392 | 295.069 |
| 20000 | 216.65 | 5474.89 | 0.088035 | 295.069 |

### 4.2 Substepping & tick structure (`stepAircraft`, `integrator.ts`)

`stepAircraft` runs `FLIGHT_MODEL_SUBSTEPS` (= 2) identical inner iterations, each of length `dtSub = dtSec / FLIGHT_MODEL_SUBSTEPS`, copying `state` into `out` once at entry and then integrating `out` in place substep-by-substep (so `out` may alias `state`; each substep reads the PREVIOUS substep's result). Per substep, in order:

1. Compute airspeed, alpha, beta, `Vt`, `mach`, `qBar` from `out` + `env` (4.3).
2. Compute aero force/moment in body frame from `out`'s CURRENT `elevonL/R/rudder` (4.4, 4.5).
3. Compute engine thrust (body +X) from `out`'s CURRENT `throttle`/`afterburnerOn` (4.7).
4. Compute landing-gear contact force/moment (4.8), using `out`'s CURRENT `gearPos`.
5. Sum to `totalForceWorld`, `totalMomentBody`; compute `gLoad` from the non-gravity part (needed by step 6).
6. Run the FCS (4.9): produces new elevon/rudder DEFLECTION COMMANDS and a new throttle COMMAND (the throttle command is just `inputs.throttle`/`afterburner`, FCS only shapes the control surfaces); rate-limit/lag `out.elevonL/R/rudder/throttle/afterburnerOn` toward those commands (so the effect is visible starting next substep — see 4.9 for why this one-substep lag is intentional and harmless at 240 Hz).
7. Integrate rigid body (4.10): update `out.vel`, `out.pos`, `out.omega`, `out.rot`.
8. Burn fuel, clamp ≥ 0 (4.7); update `out.gearPos` toward `inputs.gearDown ? 1 : 0` at a fixed rate (4.8); update `out.flags` (`OnGround`, `GearDownCommanded`, `AirbrakeOut`).

This ordering means force calculation in a substep uses the PREVIOUS substep's control-surface state (a ≤4.17 ms lag at 240 Hz internal rate) — physically equivalent to an actuator computational delay, not a bug.

### 4.3 Airspeed, alpha, beta, dynamic pressure

Per `00-architecture.md` section 3.5, computed from AIRSPEED (velocity minus wind), not ground velocity:

```
v_air_world = out.vel - env.windWorldMps
v_air_body  = Quat.rotateInverse(out.rot, v_air_world, scratch)      // math.ts
Vt = |v_air_body|
if Vt < MIN_AIRSPEED_FOR_AERO_MPS:
    alpha = 0; beta = 0; qBar = 0                                     // 4.12 edge case
else:
    alpha = atan2(-v_air_body.y, v_air_body.x)
    beta  = asin( clamp(v_air_body.z / Vt, -1, 1) )
    qBar  = 0.5 * env.airDensityKgM3 * Vt * Vt
mach = Vt / env.soundSpeedMps
```

### 4.4 Aero FORCE assembly

Coefficient buildup (using the assumed `AeroTables` shape, section 5.1; `def.aero` below means that shape):

```
elevonSym  = (out.elevonL + out.elevonR) / 2          // pitch (elevator) channel
groundEffectMultiplier = 1 + def.aero.groundEffectMaxDeltaCL * (1 - smoothstep01(clamp(telemetryAltAglM / def.wingSpanM, 0, 1)))
  where smoothstep01(x) = x*x*(3 - 2*x)                // math.ts scalar.ts
  and telemetryAltAglM = out.pos.y - env.groundElevationM   // same quantity ComputeTelemetry reports (4.11)

CL = ( interpolate2D(def.aero.CL, alpha, mach) + def.aero.CL_elevon * elevonSym ) * groundEffectMultiplier
CD = interpolate2D(def.aero.CD, alpha, mach) + def.aero.CD_elevon * abs(elevonSym)
CY = def.aero.CY_beta * beta + def.aero.CY_rudder * out.rudder

D = CD * qBar * def.wingAreaM2       // drag magnitude
L = CL * qBar * def.wingAreaM2       // lift magnitude
Y = CY * qBar * def.wingAreaM2       // side-force magnitude
```

**Wind-axes → body-axes transform** (derived from the alpha/beta parametrization `core.ts` fixes; see the derivation note below — this exact transform is mandatory, do not substitute a different one):

```
Fx_body = -D*cos(alpha)*cos(beta) - Y*cos(alpha)*sin(beta) + L*sin(alpha)
Fy_body =  D*sin(alpha)*cos(beta) + Y*sin(alpha)*sin(beta) + L*cos(alpha)
Fz_body = -D*sin(beta)            + Y*cos(beta)
```

*Derivation summary (do not re-derive differently):* `core.ts`'s `alpha = atan2(-v_body.y, v_body.x)`, `beta = asin(v_body.z/Vt)` is numerically identical to the classical Z-down aerospace body-frame `(alpha_std, beta_std)` once the axis relabelling `x_ours=x_std, y_ours=-z_std, z_ours=y_std` is applied (both frames share body X; our Y-up is the classical Z-down frame's negated Z; our Z-right is the classical frame's Y-right). Applying the standard wind-axes-to-body-axes rotation `R_bw(alpha,beta)` in the classical frame and then the same relabelling to its output gives exactly the three equations above. **Sanity check** (use as a unit-test fixture): `alpha=0, beta=0` ⇒ `Fx=-D, Fy=L, Fz=0` — straight-and-level, drag aft, lift up, no side force, as expected.

### 4.5 Aero MOMENT assembly and the (L,M,N) → (Mx,My,Mz) sign mapping

**This is the single easiest place to introduce a silent sign bug — read this subsection fully before implementing `aeroForces.ts`.**

Non-dimensional rates (using `src/math`'s named accessors, never `omega.y` etc. directly — see `00-architecture.md` section 3.4):

```
p = bodyRateP(out.omega)   // = omega.x
q = bodyRateQ(out.omega)   // = omega.z
r = bodyRateR(out.omega)   // = -omega.y
p_hat = p * def.wingSpanM  / (2*Vt)     // 0 if Vt < MIN_AIRSPEED_FOR_AERO_MPS
q_hat = q * def.meanChordM / (2*Vt)
r_hat = r * def.wingSpanM  / (2*Vt)
elevonDiff = out.elevonL - out.elevonR      // roll channel; +elevonDiff => left TE more down => left wing more lift => left wing rises => RIGHT wing down => positive roll (matches core.ts's "roll +1 = roll right" and telemetry.rollRad "+=right wing down")
```

Classical (textbook, Z-down body frame) non-dimensional moment coefficients:

```
Cl_std = def.aero.Cl_beta*beta + def.aero.Cl_p*p_hat + def.aero.Cl_r*r_hat + def.aero.Cl_elevon*elevonDiff + def.aero.Cl_rudder*out.rudder
Cm_std = interpolate2D(def.aero.Cm, alpha, mach) + def.aero.Cm_elevon*elevonSym + def.aero.Cm_q*q_hat
Cn_std = def.aero.Cn_beta*beta + def.aero.Cn_p*p_hat + def.aero.Cn_r*r_hat + def.aero.Cn_elevon*elevonDiff + def.aero.Cn_rudder*out.rudder

L_mom = Cl_std * qBar * def.wingAreaM2 * def.wingSpanM     // rolling moment, classical convention: + = right wing down
M_mom = Cm_std * qBar * def.wingAreaM2 * def.meanChordM    // pitching moment, classical convention: + = nose up
N_mom = Cn_std * qBar * def.wingAreaM2 * def.wingSpanM     // yawing moment, classical convention: + = nose right
```

**Axis mapping** (derived, same relabelling as 4.4: our body X = classical body x (shared, no flip); our body Z = classical body y (both point out the STARBOARD wing, same direction, no flip); our body Y = classical body z NEGATED, i.e. our Y=up=−(classical z=down)). A moment about a shared axis with an UNFLIPPED sign convention carries straight through; a moment about our-Y/classical-(-z) carries through NEGATED:

```
Mx_body = L_mom          // roll: shared axis, "+ = right wing down" in BOTH conventions → no flip. Matches p = wx directly (00-architecture.md §3.4).
Mz_body = M_mom          // pitch: shared "out the right wing" axis, "+ = nose up" in BOTH conventions → no flip. Matches q = wz directly.
My_body = -N_mom         // yaw: our +Y (up) is classical −z (down) → FLIP. Matches r = -wy: a moment that increases the classical nose-right yaw rate N_mom>0 must DECREASE wy (since r=-wy), i.e. My_body must be negative for positive N_mom.
```

**Worked sanity check** (unit-test fixture, section 7): with `Cn_std=0.1` (from e.g. a positive `rudder` deflection, all else zero) and `qBar=1000 Pa, S=1 m², b=1 m` ⇒ `N_mom = 100 N·m` ⇒ `My_body = -100 N·m`. With a diagonal inertia `Iyy=100 kg·m²` and zero initial `omega`, after one `dtSec=1/120 s` semi-implicit step: `omega.y_new ≈ My_body/Iyy * dtSec = -100/100 * (1/120) = -0.008333 rad/s` ⇒ `bodyRateR(omega_new) = -omega.y_new = +0.008333 rad/s` — **positive**, i.e. nose-right yaw rate increased, matching the physically-expected sign of a positive `Cn` (nose-right-producing) input. If an implementation instead applies `My_body = +N_mom`, this test fails with the opposite sign — this is exactly the bug this worked example exists to catch.

Total body-frame aero moment: `M_aero_body = (Mx_body, My_body, Mz_body)`.

### 4.6 Wind and gust (`sampleWind`, `wind.ts`)

```
steadyWorld = weather.windWorldMps
// Ornstein-Uhlenbeck-style low-pass-filtered random walk per axis, using math.ts's LowPassFilter / a manual exponential filter:
tau = 2.0 seconds                                    // gust filter time constant (fixed; gives ~0.1–2 Hz gust content, typical low-altitude turbulence bandwidth)
alphaFilt = 1 - exp(-dtSec / tau)
for axis in {x, y, z}:
    whiteNoise = (rngNext() * 2 - 1) * weather.gustMps * (1 + 2*weather.turbulence)   // weather.turbulence in [0,1] widens the noise envelope on top of gustMps
    state.filteredGustWorld[axis] += (whiteNoise - state.filteredGustWorld[axis]) * alphaFilt
out = steadyWorld + state.filteredGustWorld
```

`rngNext` MUST be a stream derived from `WorldConfig.seed` (`src/core`'s job; see `00-architecture.md` §2 and §13 on sub-seed derivation) — never `Math.random`. `CreateGustState()` returns `{ filteredGustWorld: {x:0,y:0,z:0} }`; `src/core` calls it once per aircraft at spawn and keeps the resulting object alive (mutated in place) for the aircraft's lifetime.

### 4.7 Engine (`engine.ts`)

Using the assumed `EngineTables` shape (section 5.2):

```
throttleCmd = inputs.throttle                                    // [0,1]
abCmd = inputs.afterburner && throttleCmd >= 0.999

// first-order spool lag, exact exponential form (stable for any dtSub):
out.throttle = throttleCmd + (out.throttle - throttleCmd) * exp(-dtSub / def.engine.spoolTimeConstantSec)
out.afterburnerOn = abCmd && out.throttle >= 0.999

fuelAvailable = out.fuelKg > 0
engineOk = damage.engineHealthPct > 0 && fuelAvailable

militaryThrustN = interpolate2D(def.engine.militaryThrustN, mach, out.pos.y)
thrustN = engineOk ? out.throttle * militaryThrustN * damage.engineHealthPct : 0
if out.afterburnerOn && engineOk:
    thrustN = interpolate2D(def.engine.afterburnerThrustN, mach, out.pos.y) * damage.engineHealthPct

fuelFlowKgS = !engineOk ? 0
  : out.afterburnerOn ? interpolate2D(def.engine.afterburnerFuelFlowKgS, mach, out.pos.y)
  : out.throttle > 0.02 ? lerp(def.engine.idleFuelFlowKgS, interpolate2D(def.engine.militaryFuelFlowKgS, mach, out.pos.y), out.throttle)
  : def.engine.idleFuelFlowKgS
leakKgS = damage.fuelLeak ? FUEL_LEAK_RATE_KG_S : 0                // = 0.5 kg/s, section 5.3
out.fuelKg = max(0, out.fuelKg - (fuelFlowKgS + leakKgS) * dtSub)

thrustForceBody = (thrustN, 0, 0)          // thrust line assumed through CG along body +X — see section 9
```

### 4.8 Landing gear (`landingGear.ts`)

For each `legDef` in `def.gear` (assumed `GearDefinition` shape, section 5.4), skip entirely unless `out.gearPos >= GEAR_CONTACT_GEARPOS_THRESHOLD`:

```
wheelWorld = out.pos + Quat.rotate(out.rot, legDef.posBodyM, scratch)   // posBodyM = contact point in body frame at full extension
penetrationM = env.groundElevationM - wheelWorld.y
if penetrationM <= 0: no contact this leg, continue

compressionM = min(penetrationM, legDef.maxCompressionM)
overtravelM  = max(0, penetrationM - legDef.maxCompressionM)

pointVelWorld = out.vel + Quat.rotate(out.rot, cross(out.omega, legDef.posBodyM, scratch2), scratch3)   // velocity of the contact point
compressionRateMps = -pointVelWorld.y                                    // + = compressing further

springForce  = legDef.springNPerM * compressionM + legDef.springNPerM * GEAR_HARD_STOP_STIFFNESS_MULTIPLIER * overtravelM
damperForce  = legDef.damperNPerMPerS * compressionRateMps
normalForceMag = max(0, springForce + damperForce)         // clamp: gear can only push, never pull
normalForceWorld = (0, normalForceMag, 0)                  // world +Y approximation — see section 9

// tyre friction, in the ground plane (world XZ):
fwdWorld = Quat.rotate(out.rot, (1,0,0), scratch4)
rollDirWorld = normalize( (fwdWorld.x, 0, fwdWorld.z) )     // project aircraft-forward onto ground plane
if legDef.steerable && inputs.nwsEnabled:
    steerRad = inputs.yaw * legDef.maxSteerAngleRad
    rollDirWorld = rotateAroundWorldY(rollDirWorld, steerRad, scratch5)
lateralDirWorld = (rollDirWorld.z, 0, -rollDirWorld.x)      // 90° from rollDirWorld in the ground plane

slideVelWorld = (pointVelWorld.x, 0, pointVelWorld.z)
vRoll = dot(slideVelWorld, rollDirWorld)
vLat  = dot(slideVelWorld, lateralDirWorld)

longCoef = legDef.brakeCapable ? lerp(ROLLING_RESISTANCE_COEFFICIENT, legDef.kineticFrictionCoefficient, inputs.brakes) : ROLLING_RESISTANCE_COEFFICIENT
Flong = abs(vRoll) < 1e-4 ? 0 : -sign(vRoll) * longCoef * normalForceMag
Flat  = -clamp(vLat * GEAR_LATERAL_STIFFNESS_N_PER_MPS, -legDef.kineticFrictionCoefficient*normalForceMag, legDef.kineticFrictionCoefficient*normalForceMag)

frictionForceWorld = rollDirWorld*Flong + lateralDirWorld*Flat
legForceWorld = normalForceWorld + frictionForceWorld
legMomentBody = Quat.rotateInverse(out.rot, cross(wheelWorld - out.pos, legForceWorld, scratch6), scratch7)

accumulate legForceWorld into totalForceWorld, legMomentBody into totalMomentBody
if normalForceMag > 0: out.flags |= EntityFlag.OnGround (set at least once this substep loop; cleared at the START of stepAircraft each tick, before substeps, then OR'd in per leg per substep)
```

`out.gearPos` itself moves toward `inputs.gearDown ? 1 : 0` at a fixed rate `GEAR_TRAVEL_RATE_PER_SEC = 0.5` (2 s full travel; section 5.3), clamped to `[0,1]`, EXCEPT `damage.gearHealthPct <= 0` forces it toward 0 regardless of `inputs.gearDown` (gear cannot be lowered / collapses if already down — the next tick's `penetrationM` check then simply finds `out.gearPos < GEAR_CONTACT_GEARPOS_THRESHOLD` and stops generating contact force, which is this module's entire treatment of "gear collapse": no explicit crash event, no `DamageState` mutation — see section 9 on why `stepAircraft` never writes `DamageState`).

### 4.9 Flight control system (`fcs.ts`)

All deflection COMMANDS below are computed per substep from THIS substep's `alpha`, `p/q/r`, `gLoad` (4.1–4.5's outputs earlier in the same substep — see 4.2's ordering) and `def.fcsLimits` (assumed shape, section 5.5). `healthL/R/rudder = damage.controlSurfaces.elevonL/elevonR/rudder` (each 0..1); if `!damage.hydraulicsOk`, ALL three commands are simply set equal to the surface's CURRENT position (freeze in place) before rate-limiting, so the slew step below is a no-op.

**Trim-integral state (module-private, not part of `EntityState`/`contracts/flight.ts`):** `fcs.ts` module-level `const trimIntegralRad = new Float64Array(MAX_ENTITIES)` (`MAX_ENTITIES` from `contracts/core.ts`; zero-initialized, allocated once at module load — no per-tick allocation). The array is indexed by `UnpackEntityId(state.id).index` (`contracts/core.ts`'s `UnpackEntityId`); call this index `i` below. Reset `trimIntegralRad[i] = 0` whenever `!damage.hydraulicsOk`, OR on the tick `(out.flags & EntityFlag.OnGround)` transitions from clear to set or set to clear (i.e. touchdown or liftoff — compare against the entity's `OnGround` state from the START of this `stepAircraft` call, before 4.8 runs), OR on-ground (direct law never accumulates trim).

**Pitch — normal law (g-command + trim integral) when airborne, direct law when on ground:**

```
gLoad = dot( Quat.rotateInverse(out.rot, (totalForceWorld - (0,-def.massKg*env.gravityMps2,0)), scratch8), (0,1,0) ) / (def.massKg * env.gravityMps2)
lastGLoadRad[i] = gLoad   // cache this substep's gLoad for computeTelemetry to read back — see 4.11; `lastGLoadRad` is a second
                           // module-private Float64Array(MAX_ENTITIES) alongside `trimIntegralRad`, same indexing, overwritten every substep
                           // (so after stepAircraft returns it holds the LAST substep's settled value, i.e. "now")

if (out.flags & EntityFlag.OnGround) == 0:                              // airborne: cascaded outer g-command loop -> inner rate-command loop
    gCmd = inputs.pitch >= 0
        ? lerp(1.0, def.fcsLimits.maxGLoadPos, inputs.pitch)
        : lerp(1.0, def.fcsLimits.maxGLoadNeg, -inputs.pitch)
    if alpha > def.fcsLimits.maxAlphaRad:
        gCmd = min(gCmd, 1.0 - def.fcsLimits.alphaLimitGain * (alpha - def.fcsLimits.maxAlphaRad))
    if alpha < def.fcsLimits.minAlphaRad:
        gCmd = max(gCmd, 1.0 - def.fcsLimits.alphaLimitGain * (alpha - def.fcsLimits.minAlphaRad))
    // shipped fcs.ts also predicts/blends this against alphaAnticipated (rate-predicted alpha),
    // not raw alpha alone -- this pseudocode block predates that refinement, see the ground law's
    // own NOTE below and fcs.ts itself for the exact current shape.

    if damage.hydraulicsOk:                                              // integral action (see "Trim-integral state" above)
        trimIntegralRad[i] = clamp(
            trimIntegralRad[i] + FCS_TRIM_INTEGRAL_GAIN * (gCmd - gLoad) * dtSub,
            -FCS_TRIM_INTEGRAL_MAX_RAD, FCS_TRIM_INTEGRAL_MAX_RAD)        // anti-windup clamp, independent of maxElevonRad
    else:
        trimIntegralRad[i] = 0

    // OUTER LOOP: g-error -> a target pitch rate qCmdAir, capped and onset-shaped (see the
    // "Outer/inner-loop restructuring" note below) so the INNER loop can never be asked to hold
    // more than a bounded fraction of maxElevonRad in steady state.
    qCmdAir = clamp(FCS_PITCH_OUTER_LOOP_GAIN * (gCmd - gLoad), -qCmdCapRadS, qCmdCapRadS)   // rate-limited toward this raw value at FCS_PITCH_RATE_CMD_ONSET_RAD_S2 (section 5.3)
    // INNER LOOP: rate error -> elevon, same shape as the roll/ground-pitch rate-command laws.
    // innerSchedule uses its OWN (gentler) qBar exponent, FCS_PITCH_INNER_QBAR_EXPONENT, not the
    // gainSchedule used elsewhere in this section -- see the restructuring note below for why.
    elevonSymCmd = FCS_PITCH_INNER_LOOP_GAIN_MULT * innerSchedule * def.fcsLimits.pitchRateGain * (qCmdAir - q) + trimIntegralRad[i]
else:                                                                     // on ground: RATE-command law (same shape as the roll law below), no trim integral
    trimIntegralRad[i] = 0
    qCmdGround = inputs.pitch * GROUND_LAW_MAX_ROTATION_RATE_RAD_S
    // alphaAnticipated/ALPHA_LIMIT_ANTICIPATION_SEC/ALPHA_LIMIT_BLEND_RAD: module-private
    // constants in fcs.ts itself, not contracts/flight.ts exports, so not in section 5.3's
    // table -- see that file for their exact values/derivation. NOTE: the shipped fcs.ts also
    // predicts/blends the AIRBORNE alpha limiter just above this same way; this pseudocode block
    // predates that refinement and still shows the airborne law's simpler reactive form -- see
    // fcs.ts itself, not this comment, for that law's exact current shape.
    alphaAnticipated = alpha + q * ALPHA_LIMIT_ANTICIPATION_SEC
    if alphaAnticipated > def.fcsLimits.maxAlphaRad:
        overshootRad = alphaAnticipated - def.fcsLimits.maxAlphaRad
        blend = clamp(overshootRad / ALPHA_LIMIT_BLEND_RAD, 0, 1)
        qCmdGround = lerp(qCmdGround, 0, blend)                           // taper toward zero authority, never reverse -- see note below
    elevonSymCmd = gainSchedule * def.fcsLimits.pitchRateGain * (qCmdGround - q)  // gainSchedule: see the pitch-axis qBar gain-scheduling note (section 5.3) -- a fixed gain here let the ACTUAL torque this produces grow unboundedly with qBar as speed built through the roll, the same instability gainSchedule exists to prevent for the airborne law above, just rediscovered here (an earlier version of this rate-command law omitted it and still showed q overshooting qCmdGround by 3x+, well before any ground/air transition)
elevonSymCmd = clamp(elevonSymCmd, -def.fcsLimits.maxElevonRad, def.fcsLimits.maxElevonRad)
```

*Outer/inner-loop restructuring (airborne law; this pseudocode was previously a single-loop form, `elevonSymCmd = gLoadGain*(gCmd-gLoad) - pitchRateGain*q + trimIntegralRad[i]`, driving elevonSymCmd directly off the g-error):* root-caused (cross-module control-theory + real-FBW-architecture review) to actuator POSITION/RATE SATURATION, not underdamped gains — live-testing a sustained hard pull showed gLoad cycling roughly 3g-9g and elevon swinging near its full travel in a non-decaying ~0.6-0.8s-period pattern, while the linearized loop's own damping ratio (computed from the real Cm_elevon/Cm_q/inertia data) stayed in a healthy 0.58-0.92 range across 100-160 m/s — gains were never the problem. The commanded elevon POSITION for a realistic g-error was roughly 2x `maxElevonRad`, so the surface railed at its travel/rate limit and rang at very nearly the linear plant's own natural frequency instead of settling. The fix mirrors this project's own roll law and ground pitch law (both already rate-command laws, above/below): an OUTER loop converts the g-error into a target pitch rate `qCmdAir`, capped (`qCmdCapRadS`, sized so the INNER loop's own steady-state response at that target never exceeds a fixed margin of `maxElevonRad`) and onset-rate-limited (module-private state, reset at ground/air transitions like the pitch/roll stick shaping below), and a fast INNER loop tracks that target — self-limiting by construction, exactly like the roll/ground-pitch laws. The inner loop's own qBar schedule (`innerSchedule`, `FCS_PITCH_INNER_QBAR_EXPONENT=1.0`) deliberately uses a GENTLER rolloff exponent than `gainSchedule`'s 1.5 (used by the outer loop's cap and by the ground law) — reusing the steeper schedule left the inner loop, now the SOLE source of elevon authority, too weak at high dynamic pressure to counter this airframe's own open-loop instability (relaxed static stability) during a transient, confirmed by direct trim-convergence tracing across the speed/altitude envelope (`tools/lib/trimSolver.ts`'s own `findGCommandTrim`). `FCS_PITCH_INNER_LOOP_GAIN_MULT=2` (section 5.3) gives the now-qBar-independent corrective torque enough absolute margin for this airframe specifically. `gLoadGain` is no longer a direct multiplier in this formula; it is kept only to source `Math.sign(gLoadGain)` for the trim-integral's accumulation direction, unchanged from before (see `fcs.ts`'s own comment at that call site).

*Sign note (corrected; this formula's direct term was originally pinned positive here and carried that sign into the implementation unnoticed for some time):* this project's elevon convention (section 6.2 of `00-architecture.md`) is `+elevonSym` = trailing-edge-down = NOSE-DOWN moment, and `inputs.pitch = +1` means "stick full aft = nose-up command" (`contracts/core.ts`'s `PilotInputs.pitch` doc comment). `qCmdGround` must therefore be POSITIVE for `inputs.pitch=+1` to end up commanding nose-up authority through `pitchRateGain` (itself negative) below — without that, pulling up during the ground roll commands nose-DOWN instead, and the aircraft only leaves the ground once raw aerodynamic lift overpowers that for itself, well past a normal rotation speed. This mirrors exactly how `gLoadGain` (the airborne law's own pitch term, before this section's own outer/inner-loop restructuring) had to be negative for the same reason.

*Rate-command note (this formula was restructured here, from an earlier direct-position form `elevonSymCmd = -inputs.pitch*maxElevonRad*GROUND_LAW_PITCH_AUTHORITY_FRACTION - pitchRateGain*q`, once the sign fix above exposed a second problem):* a fixed position command has no target RATE to settle at — only ever-growing damping error as `q` builds — so live-testing a sustained full-aft-stick rotation (once correctly signed) showed pitch rate itself running away (`q` climbing past 19 deg/s, pitch attitude 1 deg to 24 deg in under 3s) well before the aircraft actually left the ground, handing an already-overcooked high-alpha, high-rate state straight to the airborne law's alpha limiter at the exact instant of the ground/air transition — a violent, oscillating liftoff. A pure alpha-based cap (tried first, same shape as the taper below) did not fix this on its own: the runaway acceleration mostly happens *below* `maxAlphaRad`, while alpha is still climbing through it, so by the time an alpha-based cap engages, rotational momentum has already built up too far to arrest in time. Restructuring to a rate-command law — same shape as the roll law below, `qCmdGround` in place of `pCmd` — is self-limiting by construction: once `q` reaches `qCmdGround` the error driving `elevonSymCmd` goes to zero and the command settles to whatever holds that rate steady, instead of continuing to accelerate. `GROUND_LAW_MAX_ROTATION_RATE_RAD_S` (section 5.3) has the live-tested numbers behind the 10 deg/s choice. The `alphaAnticipated`-based taper is kept as a second line of defence (a rotation held long enough post-liftoff could still climb alpha past the limit at a steady 10 deg/s) — tapering `qCmdGround` toward zero, never negative, so the ground law never commands an active nose-down push while still substantially on the runway, which would risk a nose-gear slam instead. Not gated by `minAlphaRad`/the symmetric case: a ground rotation excursion only ever runs away in the nose-up direction.

*Auto-trim*: because `gCmd = 1.0` exactly at `inputs.pitch = 0` (both branches of the lerp meet at 1.0), stick-centered flight always commands 1 g, not a fixed elevon angle. The outer/inner rate-command loop alone only APPROXIMATES this: in a true steady state (`q = 0`, hence `qCmdAir` also settled to 0, hence `gCmd = gLoad`), the inner loop's own rate-error term contributes nothing, and without a trim term `elevonSymCmd` would simply sit at 0 — not, in general, the elevon deflection this airframe actually needs to hold 1 g level (or banked) flight. The `trimIntegralRad[i]` term above is what supplies that steady-state offset: it integrates the g-error at rate `FCS_TRIM_INTEGRAL_GAIN` (section 5.3) for as long as `gCmd ≠ gLoad`, so `elevonSymCmd` keeps climbing until `gLoad` reaches `gCmd` exactly (integral action drives DC error to zero at steady state, independent of any of the loop's proportional/rate gains) — this integral state is the auto-trim mechanism, and it IS persisted state (per-entity, held in `trimIntegralRad`, reset on hydraulics loss or ground contact as above). See section 9 for why this state lives in `src/physics`-private storage rather than `EntityState`/`DamageState`.

**Roll — rate-command law, always (airborne and on ground):**

```
pCmd = inputs.roll * def.fcsLimits.maxRollRateRadS
elevonDiffCmd = clamp( def.fcsLimits.rollRateGain * (pCmd - p), -def.fcsLimits.maxElevonRad, def.fcsLimits.maxElevonRad )
```

**Yaw — direct law + damper, always:**

```
rudderCmd = clamp( -inputs.yaw * def.fcsLimits.maxRudderRad - def.fcsLimits.yawRateGain * r, -def.fcsLimits.maxRudderRad, def.fcsLimits.maxRudderRad )
```

*Sign note (corrected, same class of error as the ground pitch law above):* `Cn_rudder < 0` (section 5.2) combined with this project's `r = -omega.y` mapping means `+rudder` (trailing-edge left) produces a NOSE-LEFT moment, while `inputs.yaw = +1` means "nose-right command" (`PilotInputs.yaw`'s doc comment). The direct stick term must be negated for right rudder input to actually yaw the nose right; the un-negated form pinned here originally did the opposite. `yawRateGain`'s own sign (the damping term just after) was already corrected elsewhere in this section's history — only this direct term was missed, for the same reason noted above: it carries no gain constant of its own for a sign-sweep review to catch.

**Combine and rate-limit (actuator model, applied to ALL three every substep):**

```
elevonLCmd = clamp(elevonSymCmd + elevonDiffCmd/2, -def.fcsLimits.maxElevonRad*healthL, def.fcsLimits.maxElevonRad*healthL)
elevonRCmd = clamp(elevonSymCmd - elevonDiffCmd/2, -def.fcsLimits.maxElevonRad*healthR, def.fcsLimits.maxElevonRad*healthR)
rudderCmdFinal = clamp(rudderCmd, -def.fcsLimits.maxRudderRad*healthRudder, def.fcsLimits.maxRudderRad*healthRudder)

out.elevonL = moveToward(out.elevonL, elevonLCmd, def.fcsLimits.maxElevonRateRadS * healthL * dtSub)
out.elevonR = moveToward(out.elevonR, elevonRCmd, def.fcsLimits.maxElevonRateRadS * healthR * dtSub)
out.rudder  = moveToward(out.rudder,  rudderCmdFinal, def.fcsLimits.maxRudderRateRadS * healthRudder * dtSub)
// moveToward(current, target, maxDelta) = current + clamp(target-current, -maxDelta, maxDelta)
```

If `!damage.hydraulicsOk`: skip the whole block above and instead leave `out.elevonL/R/rudder` unchanged this substep (surfaces jam at their last commanded position).

### 4.10 Rigid body integration (`rigidBody.ts`)

Semi-implicit (symplectic) Euler: velocities updated from this substep's forces FIRST, then position/orientation updated using the NEW velocities.

```
totalForceWorld = Quat.rotate(out.rot, aeroForceBody + thrustForceBody, scratch9) + sum(legForceWorld) + (0, -def.massKg*env.gravityMps2, 0)
totalMomentBody = aeroMomentBody + sum(legMomentBody)                      // thrust moment omitted — thrust line through CG, section 9

// translational:
accelWorld = totalForceWorld / def.massKg
out.vel = out.vel + accelWorld * dtSub                                     // velocity FIRST
out.pos = out.pos + out.vel * dtSub                                        // position from the NEW velocity

// rotational — full inertia tensor, Euler's equation: I*omegaDot = M - omega x (I*omega)
Iomega = Mat3.multiplyVec3(def.inertiaBodyKgM2AsMat3, out.omega, scratch10)   // Mat3 built once from {xx,yy,zz,xy,xz,yz} at spawn, not per substep — see section 6
gyroTerm = cross(out.omega, Iomega, scratch11)
omegaDot = Mat3.multiplyVec3(inertiaInverseMat3, (totalMomentBody - gyroTerm), scratch12)   // inertiaInverseMat3 also precomputed once at spawn
out.omega = out.omega + omegaDot * dtSub

// orientation — quaternion derivative qDot = 0.5 * q ⊗ (0, omega.x, omega.y, omega.z), then renormalize:
qDot = Quat.multiply(out.rot, (out.omega.x, out.omega.y, out.omega.z, 0), scratch13) * 0.5
out.rot = normalize(out.rot + qDot * dtSub)
```

Structural failure: if `damage.structurePct <= 0` (checked once at `stepAircraft` ENTRY, not per substep), skip 4.4/4.5/4.9 entirely (zero aero force/moment, surfaces frozen) and integrate ballistic + gear only — this is this module's entire "airframe breakup" behaviour; `src/core`/`src/combat` are responsible for having already set `alive=false` and/or emitted a `CrashEvent` by the time `structurePct` reaches 0 (that transition is combat's write, not physics's — see section 9).

### 4.11 Telemetry (`telemetry.ts`, `computeTelemetry`)

Computed from `state` (pre-step) so it reflects "now", matching what `stepAircraft` will read as ITS `out`'s starting point next tick:

```
(v_air_body, Vt, alpha, beta, qBar, mach) as in 4.3, using `state` in place of `out`
iasMps = Vt * sqrt(env.airDensityKgM3 / RHO0_KG_M3)         // RHO0_KG_M3 = 1.2250, section 5.3; standard IAS≈TAS*sqrt(rho/rho0) approximation, no compressibility/position-error correction
tasMps = Vt
altMslM = state.pos.y
altAglM = state.pos.y - env.groundElevationM
gLoad = lastGLoadRad[i]   // i = UnpackEntityId(state.id).index; read back from fcs.ts's module-private cache (see 4.9), NOT recomputed —
                           // computeTelemetry never re-runs aeroForces/engine/gear. This is the LAST substep's settled gLoad from the
                           // most recent stepAircraft call for this entity (a legitimate one-tick-old value: state IS last tick's stepAircraft
                           // output, and lastGLoadRad[i] was written during that same call). If computeTelemetry is ever called for an entity
                           // BEFORE stepAircraft has run at least once for it this session, lastGLoadRad[i] reads its zero-initialized default
                           // (gLoad=0); src/core must not treat pre-first-step telemetry as meaningful (true for every other telemetry field too)
headingRad, pitchRad, rollRad = Quat.toYawPitchRoll(state.rot, scratch).{headingRad,pitchRad,rollRad}
vspeedMps = state.vel.y
fuelKg = state.fuelKg   // EntityState.fuelKg (core.ts) — this module is the sole writer of this field (4.7 burns it every substep); computeTelemetry just reads it back
fuelFrac = state.fuelKg / def.maxFuelKg
thrustFrac = out.throttle already-applied value / max(mil, ab) thrust at current mach/alt — recomputed identically to 4.7's thrustN formula, divided by militaryThrustN (or afterburnerThrustN if afterburnerOn)
onGround = (state.flags & EntityFlag.OnGround) != 0
stalled = alpha > def.aero.stallAlphaRad
```

### 4.12 Edge cases

- **`Vt < MIN_AIRSPEED_FOR_AERO_MPS`**: alpha/beta/qBar forced to 0 (4.3); all aero force/moment terms become 0; engine/gear/gravity still apply. Prevents `atan2(0,0)`/`asin(NaN)` and matches physical reality (no meaningful aerodynamic force below ~1 m/s).
- **`def.massKg` degenerate**: never — `AircraftDefinition.massKg` is a fixed positive constant per aircraft (module 03's data), not runtime-mutated; no fuel-dependent mass update in this version (see section 9 — `massKg` is treated as constant, not `emptyMassKg + fuelKg`, a deliberate simplification).
- **`structurePct <= 0`**: see 4.10 — ballistic-only integration, no aero/FCS.
- **`engineHealthPct <= 0` or `fuelKg <= 0`**: `thrustN = 0` (4.7), no special-case elsewhere.
- **`hydraulicsOk === false`**: surfaces frozen (4.9); gear can still move under its own fixed-rate actuator (assumed electrically, not hydraulically, actuated — reasonable for gear vs. flight-control surfaces).
- **Quaternion drift**: `out.rot` is renormalized every substep (4.10) — `|q|` never drifts more than one substep's floating-point error from 1.
- **NaN guard**: none needed by design — every division above (`/Vt`, `/def.massKg`, `/(R_specific*T)`, …) is guarded by the `Vt` threshold or by `def`'s fields being fixed positive constants; no runtime branch divides by a value that can reach exactly 0 other than `Vt`, which is guarded.

## 5. Data

### 5.1 `AeroTables` shape (part of `AircraftDefinition.aero`, module 03's data)

Architecture section 9.1 pins `AeroTables`'s full internal shape authoritatively (not merely this module's assumption — module 03 is pinned to the identical shape independently, so the two agree by construction, not by luck):

```ts
interface AeroTables {
  CL: Table2D;                 // lift coefficient vs (alphaRad, mach)
  CD: Table2D;                 // drag coefficient vs (alphaRad, mach)
  Cm: Table2D;                 // pitching-moment coefficient vs (alphaRad, mach)
  CY_beta: number;              // per rad sideslip
  Cl_beta: number;              // per rad sideslip
  Cn_beta: number;              // per rad sideslip
  CL_elevon: number;             // per rad symmetric elevon
  CD_elevon: number;             // per rad |symmetric elevon| (induced drag from control deflection)
  Cm_elevon: number;             // per rad symmetric elevon — MUST be negative (00-architecture.md section 6.2's elevon sign rule: +elevonSym is trailing-edge-down, which is nose-down)
  Cl_elevon: number;             // per rad (elevonL - elevonR)
  Cn_elevon: number;             // per rad (elevonL - elevonR) — adverse/proverse yaw from differential elevon
  CY_rudder: number; Cl_rudder: number; Cn_rudder: number;   // per rad rudder
  Cl_p: number; Cl_r: number;    // per non-dim roll/yaw rate
  Cm_q: number;                  // per non-dim pitch rate
  Cn_p: number; Cn_r: number;    // per non-dim roll/yaw rate
  groundEffectMaxDeltaCL: number; // fractional CL increase at h/b=0 (e.g. 0.15)
  stallAlphaRad: number;          // alpha above which AircraftTelemetry.stalled = true
}
interface Table1D { xs: readonly number[]; ys: readonly number[]; }               // strictly increasing xs, same length
interface Table2D { xs: readonly number[]; ys: readonly number[]; zs: readonly (readonly number[])[]; } // zs[i][j] at (xs[i],ys[j]); linear/bilinear interpolation, clamped at table edges
```

`interpolate2D(table, x, y)` — `contracts/math.ts`'s real exported `Interpolate2D` (bilinear, edge-clamped over `Table2D`'s `xs`/`ys`/`zs`).

### 5.2 `EngineTables` shape (`AircraftDefinition.engine`) — pinned by 00-architecture.md section 9.1

```ts
interface EngineTables {
  militaryThrustN: Table2D;         // thrust vs (mach, altitudeM), throttle=1, no afterburner
  afterburnerThrustN: Table2D;      // thrust vs (mach, altitudeM), full afterburner
  militaryFuelFlowKgS: Table2D;     // vs (mach, altitudeM), at throttle=1 military
  afterburnerFuelFlowKgS: Table2D;  // vs (mach, altitudeM), full afterburner
  idleFuelFlowKgS: number;
  spoolTimeConstantSec: number;      // first-order lag time constant, throttle response
}
```

### 5.3 This module's fixed constants (not aircraft-specific)

| name | value | unit | used in | justification |
|---|---|---|---|---|
| `FLIGHT_MODEL_SUBSTEPS` | 2 | — | 4.2 | 240 Hz internal integration for gear/high-rate stability at 2x cost |
| `MIN_AIRSPEED_FOR_AERO_MPS` | 1.0 | m/s | 4.3 | below this, alpha/beta ill-conditioned; aero negligible |
| `GEAR_CONTACT_GEARPOS_THRESHOLD` | 0.98 | — | 4.8 | gear must be ≥98% extended before contact physics |
| `ROLLING_RESISTANCE_COEFFICIENT` | 0.02 | — | 4.8 | typical aviation tyre rolling-resistance coefficient (published range 0.015–0.03) |
| `GEAR_HARD_STOP_STIFFNESS_MULTIPLIER` | 20 | — | 4.8 | strut bottom-out stiffening factor |
| `GEAR_LATERAL_STIFFNESS_N_PER_MPS` | 50000 | N/(m/s) | 4.8 | cornering-stiffness-style saturating lateral friction gain |
| `GROUND_LAW_MAX_ROTATION_RATE_RAD_S` | 0.174533 | rad/s | 4.9 | on-ground rate-command law's target pitch rate for full aft stick (10 deg/s; see 4.9's own rate-command note for why this replaced a fixed authority fraction) |
| `RHO0_KG_M3` | 1.2250 | kg/m³ | 4.11 | ISA sea-level density, for IAS formula |
| `FUEL_LEAK_RATE_KG_S` | 4.1667 | kg/s | 4.7 | `damage.fuelLeak` extra burn rate; `500 kg / 4.1667 kg/s = 120 s`, i.e. ~2 min to empty a 500 kg internal tank if undetected, gives the player/AI a meaningful but not instant window to react |
| `GEAR_TRAVEL_RATE_PER_SEC` | 0.5 | 1/s | 4.8 | gear fully transitions in 2 s |
| `FCS_TRIM_INTEGRAL_GAIN` | 0.02 | rad/(g·s) | 4.9 | `Ki`; pitch trim-integral gain — slow enough not to fight the proportional/rate terms substep-to-substep, fast enough to cancel a ~10% P-loop g-error within a few seconds (empirically: at `Kg=1`, a 0.1 g steady error drives `trimIntegralRad` by `0.02*0.1=0.002 rad/s`, reaching a typical few-degree trim correction in 1-3 s) |
| `FCS_TRIM_INTEGRAL_MAX_RAD` | 0.2094 | rad | 4.9 | anti-windup clamp on `trimIntegralRad`, = 12° (half of a typical `maxElevonRad≈0.4363 rad`/25°, leaving authority for the proportional/rate terms on top of full trim) |
| `FCS_PITCH_OUTER_LOOP_GAIN` | 0.12 | rad/(s·g) | 4.9 | "Kgq"; airborne outer loop's g-error-to-target-rate gain — sized so a representative full-aft-stick pull (7 g) lands close to (not exceeding) the reference-speed saturation-safe cap below |
| `FCS_PITCH_RATE_CMD_SATURATION_MARGIN` | 0.75 | — | 4.9 | fraction of `maxElevonRad` the outer loop's rate-target cap (`qCmdCapRadS`) is sized to, leaving headroom for the inner loop's own `q` term and transient overshoot |
| `FCS_MAX_PITCH_RATE_CMD_RAD_S` | 1.0472 | rad/s | 4.9 | absolute ceiling on the outer loop's target rate (60 deg/s) — deliberately much gentler than roll's `maxRollRateRadS` (300 deg/s); binds only at very high dynamic pressure where the saturation-margin formula alone would otherwise allow an unrealistic figure |
| `FCS_PITCH_RATE_CMD_ONSET_RAD_S2` | 5 | rad/s² | 4.9 | onset-rate limit on the outer loop's shaped target itself, defence in depth against a fast-moving `gLoad` measurement jumping the target instantly |
| `FCS_PITCH_INNER_QBAR_EXPONENT` | 1.0 | — | 4.9 | airborne inner loop's OWN qBar-schedule exponent (vs. `gainSchedule`'s 1.5 used by the outer loop's cap and by the ground law) — gentler rolloff keeps corrective torque roughly qBar-independent instead of shrinking with it, needed once the inner loop became the sole source of elevon authority (see 4.9's outer/inner-loop restructuring note) |
| `FCS_PITCH_INNER_LOOP_GAIN_MULT` | 2 | — | 4.9 | multiplies the airborne inner loop's `pitchRateGain*innerSchedule` product; found empirically necessary (direct trim-convergence tracing across the speed/altitude envelope) for adequate disturbance-rejection authority against this airframe's open-loop instability |

### 5.4 `GearDefinition` shape (`AircraftDefinition.gear`, three entries: nose, mainLeft, mainRight) — pinned by 00-architecture.md section 9.1

```ts
interface GearDefinition {
  id: string;                        // 'nose' | 'mainLeft' | 'mainRight'
  posBodyM: Vec3Like;                 // wheel-ground contact point, body frame, at full extension (gearPos=1)
  maxCompressionM: number;
  springNPerM: number;
  damperNPerMPerS: number;
  kineticFrictionCoefficient: number;
  steerable: boolean;                 // true only for 'nose'
  maxSteerAngleRad: number;           // 0 for main gear
  brakeCapable: boolean;              // true only for main gear
}
```

**Required stability bound on `springNPerM`/`damperNPerMPerS` (module 03's data MUST respect this).** §4.8's spring-damper contact model integrates with semi-implicit Euler at `dtSub = SIM_DT_SEC/FLIGHT_MODEL_SUBSTEPS = 1/240 s`, and the hard-stop term (`GEAR_HARD_STOP_STIFFNESS_MULTIPLIER = 20`) can multiply the effective stiffness by 20× during a hard landing's overtravel. An explicit integrator of a mass-spring-damper system is only stable when the timestep resolves the system's natural frequency; for a single leg treating roughly `massKg/3` as the effective sprung mass per leg (three legs share the aircraft's weight), the required bound is:

```
sqrt( springNPerM * GEAR_HARD_STOP_STIFFNESS_MULTIPLIER / (massKg/3) ) * dtSub <= 0.5
  ⇔  springNPerM <= 0.25 * (massKg/3) / (GEAR_HARD_STOP_STIFFNESS_MULTIPLIER * dtSub^2)
```

and `damperNPerMPerS` should target a damping ratio in `[0.3, 0.7]` at that stiffness: `damperNPerMPerS ≈ 2 * zeta * sqrt(springNPerM * (massKg/3))` for `zeta` in that range. `03-tejas-data.md` documents, for each of the three legs, the resulting bound and confirms its chosen `springNPerM`/`damperNPerMPerS` values satisfy it (see that document's section 6).

### 5.5 `FcsLimits` shape (`AircraftDefinition.fcsLimits`) — pinned by 00-architecture.md section 9.1

```ts
interface FcsLimits {
  maxAlphaRad: number; minAlphaRad: number;         // alpha protection limits
  maxGLoadPos: number; maxGLoadNeg: number;          // structural g limits (maxGLoadNeg is negative)
  maxRollRateRadS: number;
  maxElevonRad: number; maxRudderRad: number;         // physical surface travel limits
  maxElevonRateRadS: number; maxRudderRateRadS: number; // actuator rate limits
  pitchRateGain: number;  // Kq, pitch damper
  rollRateGain: number;   // Kp, roll rate-command loop gain
  yawRateGain: number;    // Kr, yaw damper
  alphaLimitGain: number; // Ka, alpha-limiter proportional gain
  gLoadGain: number;      // Kg, g-command loop proportional gain
}
```

## 6. Performance budget

- **Allocation**: zero after module load. All `Vec3`/`Quat`/`Mat3` scratch values used in sections 4.4–4.10 (`scratch` through `scratch13` above) are module-level mutable objects created once, reused across every call and every substep — never `new Vec3(...)` inside `stepAircraft`, `computeTelemetry`, `sampleAtmosphere`, or `sampleWind`. The one exception, `createGustState()`, allocates its single returned object — called once per aircraft at spawn, never in the hot path. `fcs.ts`'s `trimIntegralRad`/`lastGLoadRad` (4.9/4.11) are each one `Float64Array(MAX_ENTITIES)` allocated once at module load (≈3.2 KB each for `MAX_ENTITIES=400`) — a fixed, tiny, one-time cost, not a per-tick one.
- **`computeTelemetry`'s gLoad cost**: one array read (`lastGLoadRad[i]`), not a recomputation — it does NOT re-run 4.4's aero-coefficient table lookups, 4.7's engine thrust lookup, or 4.8's gear contact model (see 4.11). This keeps `computeTelemetry`'s own cost near-negligible (a handful of trig/vector ops for alpha/beta/Euler angles) rather than duplicating `stepAircraft`'s ~15 µs budget below.
- **Inertia tensor**: `def.inertiaBodyKgM2` (the six-component struct from `AircraftDefinition`) is converted to a `Mat3` and inverted ONCE, either at aircraft spawn (`src/core`'s job, cached alongside the `AircraftDefinition` reference) or lazily-cached inside `src/physics` keyed by `def.id` — NOT re-inverted every substep (a 3×3 inverse is cheap but pointless to repeat 240×/s/aircraft when `def` is immutable).
- **Per-call cost target**: ≤ 15 µs per `stepAircraft` call (both substeps combined) on a mid-tier mobile CPU (e.g. a 2021-era mid-range Android SoC single core, ~2 GFLOPS sustained scalar-equivalent) — roughly 400–600 floating point operations total, dominated by the two `Table2D` bilinear lookups (CL, CD) × 2 substeps and the 3×3 matrix-vector products.
- **Aggregate**: with up to 24 simultaneously-active aircraft entities (a generous combat scenario cap — see section 9), physics for all aircraft must fit in ≤ 0.4 ms of the fixed step's 8.33 ms (1/120 s) budget, leaving the remainder for AI, combat, gear/terrain queries and the render/HUD/input work on other threads.
- **No dynamic dispatch surprises**: `AeroTables`/`EngineTables`/`GearDefinition`/`FcsLimits` fields are read directly (no getter chains, no `Object.keys` iteration over table data in the hot path) — `Table1D`/`Table2D` lookups are a single binary or linear scan over a small (≤ ~15-point) breakpoint array, not a generic interpolation library call with allocation.
- **`sampleWind`**: called once per aircraft per TICK (not per substep — `env.windWorldMps` is computed once in the tick-order in section 3 and reused for both substeps), O(1), no table lookups.

## 7. Unit tests to write

All in `tests/physics/*.test.ts`, mirroring `src/physics/*.ts`. Each test builds its own minimal synthetic `AircraftDefinition`-shaped fixture (round numbers, hand-verifiable) — none of these tests depend on the real Tejas data from module 03.

**`tests/physics/atmosphere.test.ts`**
1. `sampleAtmosphere(0, out)` → `densityKgM3` within `1e-3` of `1.2250`, `temperatureK` within `1e-3` of `288.15`, `soundSpeedMps` within `1e-2` of `340.294`.
2. `sampleAtmosphere(11000, out)` → `densityKgM3` within `1e-3` of `0.36392`, `pressurePa` within `1` of `22632.1`.
3. `sampleAtmosphere(20000, out)` → `densityKgM3` within `1e-4` of `0.088035`.
4. `sampleAtmosphere(5500, out).densityKgM3` strictly between the h=0 and h=11000 values (monotonic decrease check).

**`tests/physics/rigidBody.test.ts`**
5. Free fall: fixture with `wingAreaM2=0` (zero aero), `engine` thrust tables all-zero, `gear=[]`, spawn at 5000 m with `vel=(0,0,0)`. After exactly 120 `stepAircraft` calls at `dtSec=1/120`: `out.vel.y` within `1e-9` of `-9.80665` (semi-implicit Euler is EXACT for constant acceleration).
6. Quaternion stays unit length: fixture with constant `omega=(0.5,0.3,-0.2)`, zero forces; after 1000 steps, `|out.rot| - 1` within `1e-9`.
7. Yaw sign mapping (the 4.5 worked example verbatim): fixture with `Cn_beta` chosen so a fixed `beta=0.1 rad` gives `Cn_std=0.1`, `qBar` and `S,b` chosen for `N_mom=100 N·m`, `Iyy=100`, all other derivatives zero, `omega` initially zero, gear/thrust zero. After ONE `dtSec=1/120` step: `bodyRateR(out.omega) > 0` (assert sign, and assert magnitude within `5%` of the hand-computed `0.008333 rad/s`).
8. Roll sign mapping: analogous fixture using `Cl_elevon` with `elevonDiff` set via `state.elevonL=0.1, elevonR=-0.1`; assert `out.omega.x > 0` after one step (roll right for `elevonDiff>0`).

**`tests/physics/aeroForces.test.ts`**
9. `alpha=0,beta=0` sanity check (4.4): fixture with known `CD(0,mach)=0.05`, `CL(0,mach)=0.3`, `qBar=1000`, `S=20` ⇒ `D=1000, L=6000`; assert resulting body force `Fx` within `1e-6` of `-1000`, `Fy` within `1e-6` of `6000`, `Fz` within `1e-6` of `0`.
10. Ground effect: same fixture at `altAglM = 0` vs `altAglM = def.wingSpanM * 2`; assert `CL`-derived lift force at `altAglM=0` is strictly greater (by the `groundEffectMaxDeltaCL` fraction, within `1%`) than at `altAglM ≥ wingSpanM`.

**`tests/physics/engine.test.ts`**
11. Spool lag: fixture with `spoolTimeConstantSec=2.0`, `out.throttle` starts at 0, `inputs.throttle=1` held constant. After `t=2.0 s` of stepping: `out.throttle` within `1%` of `1 - 1/e ≈ 0.6321` (first-order lag reaches 63.2% of the way to command in one time constant).
12. Flameout: `damage.engineHealthPct=0` ⇒ resulting thrust-derived acceleration contribution is exactly 0 regardless of `throttle`/`afterburner` inputs.

**`tests/physics/landingGear.test.ts`**
13. Static equilibrium: aircraft resting exactly at `pos.y = env.groundElevationM + (restCompression)` where `restCompression = def.massKg*g / legDef.springNPerM` summed appropriately across 3 legs (evenly loaded fixture), `vel=(0,0,0)`, `omega=0`, gear down. Assert after one step `|out.vel.y|` stays under `0.01 m/s` (net vertical force near zero at equilibrium compression — a settling/equilibrium check, not an exact-zero one, since the fixture's initial compression is only approximately the analytic equilibrium point unless computed exactly for the specific test fixture, in which case tighten to `1e-6`).
14. Hard stop: `penetrationM` fixture set to `2 × maxCompressionM`; assert `normalForceMag` is at least `GEAR_HARD_STOP_STIFFNESS_MULTIPLIER` times larger than a fixture with `penetrationM = maxCompressionM` exactly (confirms the hard-stop term engages).
15. Braking: `inputs.brakes=1`, fixture with nonzero `vRoll`; assert longitudinal friction force magnitude equals `kineticFrictionCoefficient * normalForceMag` within `1e-6` (full braking reaches the kinetic-friction limit, not just rolling resistance).

**`tests/physics/fcs.test.ts`**
16. Auto-trim: `inputs.pitch=0` ⇒ `gCmd` computed internally equals `1.0` exactly (test via a fixture where `gLoadGain` is large enough that after settling, measured `gLoad` converges to within `1%` of `1.0` over a multi-second stepped simulation in level unaccelerated-ish flight, OR — simpler and preferred — directly unit-test the exported-for-testing `computeGCommand(pitchStick, fcsLimits)` helper if `src/physics/fcs.ts` exposes it internally to its own test file via a non-contract internal export).
16b. Trim-integral convergence: fixture with a DELIBERATELY LOW `gLoadGain` (e.g. `0.3`, chosen so the proportional term ALONE would leave a >5% steady-state g error per 4.9's worked linearization) and `inputs.pitch=0` held constant in level unaccelerated-ish flight; assert measured `gLoad` is within `5%` of `1.0` after 2 s of stepping (proportional-only would still show >5% error at this point) AND within `1%` of `1.0` after 10 s of stepping — demonstrates the integral term, not the proportional term alone, is closing the error.
16c. Trim-integral reset: step a fixture to a nonzero settled `trimIntegralRad[i]` (as in 16b), then set `damage.hydraulicsOk=false` for one `stepAircraft` call; assert (via `fcs.ts`'s non-contract internal export of `trimIntegralRad`, as in test 16) the value is exactly `0` immediately after that call. Repeat for an `OnGround` clear→set transition (a touchdown fixture) in place of the hydraulics fault.
17. Full aft stick: `inputs.pitch=1` ⇒ `gCmd === fcsLimits.maxGLoadPos` exactly.
18. Alpha limiter engages: fixture forcing `alpha = fcsLimits.maxAlphaRad + 0.1`, `inputs.pitch=1`; assert the resulting `elevonSymCmd` is strictly less than the same computation with alpha-limiting disabled (i.e., less nose-up command than an unlimited g-command would give).

**`tests/physics/determinism.test.ts`**
19. Bit-identical replay: two independent fixture `EntityState`/`DamageState` objects with identical initial values, stepped 3600 times (30 s at 120 Hz) with an identical scripted `PilotInputs` stream and identical `Environment` sequence (same seeded gust stream via two `GustState`s fed the same `rngNext` sequence from two independently-constructed but identically-seeded PRNGs). Assert every field of the two final `EntityState`s is `Object.is`-equal (exact float equality, not "close to").

**`tests/physics/telemetry.test.ts`**
20. `computeTelemetry` alpha/beta agree exactly (same formula, same inputs) with the values `stepAircraft`'s internal 4.3 computation would produce for the same `state`/`env` — cross-check by comparing against a hand-computed value from a fixture with a known `v_air_body`.
21. `computeTelemetry` gLoad cache read-back: call `stepAircraft` once on a fixture with known aero/thrust/gear terms (e.g. reuse test 9's fixture), capturing its internally-computed `gLoad`; then call `computeTelemetry` on the resulting `out` state and assert `telemetry.gLoad` is bit-identical (`Object.is`) to the value `stepAircraft` computed — proves `computeTelemetry` reads `lastGLoadRad[i]` back rather than recomputing aero/engine/gear (a spy/counter on the fixture's `AeroTables`/`EngineTables` `Table2D` lookup — a wrapped `interpolate2D` call-counter — asserts zero additional table-lookup calls happen inside `computeTelemetry`).

**No-allocation check** (`tests/physics/allocation.test.ts`): call `stepAircraft` 100000 times with a fixed fixture in a loop; assert `process.memoryUsage().heapUsed` growth over the loop is under 1 MB (loose bound — this is a smoke test; module 12's `tools/sim-check.ts` owns the authoritative allocation regression check across the whole sim).

**`tests/physics/relaxedStability.test.ts`** (section 8 criterion 9):
22. Open-loop divergence: fixture aircraft trimmed and stepped with surfaces frozen at trim; `+1°` alpha perturbation grows strictly over 120 ticks (1 s).
23. Closed-loop damping: identical fixture and perturbation, FCS enabled; `|alpha - alphaTrim|` is within `0.1°` of zero by `t=5s`.

## 8. Acceptance criteria

1. `src/physics/*.ts` (and `contracts/flight.ts`) compile with `tsc --noEmit --strict` with zero errors, as part of the whole-`src/` strict compile (`00-architecture.md` section 12 step 4).
2. All 11 files under `tests/physics/` exist and pass (`ls tests/physics/*.test.ts | wc -l` equals 11 — `atmosphere.test.ts`, `rigidBody.test.ts`, `aeroForces.test.ts`, `engine.test.ts`, `landingGear.test.ts`, `fcs.test.ts`, `integrator.test.ts`, `allocation.test.ts`, `determinism.test.ts`, `telemetry.test.ts`, `relaxedStability.test.ts`, all listed in `12-verification.md` section 2 — AND `vitest run tests/physics` exits 0). File-count-checkable rather than relying on `vitest run`'s exit code alone, which would pass even if some of these 11 files were silently never created.
3. `stepAircraft`, `computeTelemetry`, `sampleAtmosphere`, `sampleWind` perform zero heap allocation in steady-state repeated calls (section 7's allocation test, and module 12's `tools/sim-check.ts` integration check).
4. Determinism test (section 7, item 19) passes: identical seed + identical input stream ⇒ bit-identical final `EntityState` after 3600 ticks.
5. The 4.5 worked sign-mapping example (section 7, items 7–8) passes for BOTH roll and yaw — this is the mechanical check that the `(L,M,N)→(Mx,My,Mz)` mapping in `aeroForces.ts` was implemented, not just documented.
6. Given a synthetic aircraft in straight-and-level trim (constructed by `tools/sim-check.ts`, module 12, using only this module's public API and a fixture `AircraftDefinition`), repeated `stepAircraft` calls with a fixed `PilotInputs` (found by a simple numerical search over `inputs.pitch` and `inputs.throttle`, no changes needed to this module) converge to and hold `|vspeedMps| < 0.5 m/s` and `|gLoad - 1.0| < 0.05` for at least 60 continuous seconds of simulated time — this exercises the auto-trim/g-command law end-to-end.
7. No file exists under `src/physics/` other than those listed in section 2.
8. No `Math.random()` call anywhere under `src/physics/` (grep-checkable).
9. **Relaxed-static-stability round trip is mechanically verified, not just asserted in prose.** Using a fixture `AircraftDefinition` trimmed to straight-and-level per criterion 6: (a) OPEN-LOOP check — freeze `out.elevonL`/`out.elevonR`/`out.rudder` at their trimmed values (bypass 4.9's FCS entirely, e.g. by stepping only 4.3–4.8/4.10 directly, or by an FCS-disable test hook `src/physics` exposes non-contractually for this one test), perturb `alpha` by `+1°` (nudge `out.vel`'s body-frame pitch component), and step 120 ticks (1 s): the resulting `|alpha - alphaTrim|` must be STRICTLY GREATER than the initial `1°` perturbation (confirms `dCm/dalpha > 0` at trim — an open-loop divergence, the literal definition of relaxed static stability). (b) CLOSED-LOOP check — the identical perturbation, FCS enabled (normal `stepAircraft` calls): `|alpha - alphaTrim|` must decay to within `0.1°` within `5` continuous seconds of simulated time (confirms the g-command law's proportional+integral action, section 4.9, actually closes the loop the product brief requires). `03-tejas-data.md` (module 03) documents its own `Cm(alpha)` slope at the trimmed alpha and the resulting open-loop time-to-double, per that document's own acceptance criteria — this criterion is what makes that documented number mechanically checkable rather than an unverified claim.

## 9. Open assumptions

- **`AeroTables`/`EngineTables`/`GearDefinition`/`FcsLimits` internal shape (section 5.1–5.2, 5.4–5.5) is now PINNED by `00-architecture.md` section 9.1, not this module's own assumption — RESOLVED from an earlier drafting-time risk.** An earlier pass of architecture section 9.1 fixed only `AircraftDefinition`'s TOP-LEVEL field names and delegated these four sub-shapes' internals to "module 03's own design," which would have left module 02 (this module, drafted blind to module 03) and module 03 (drafted blind to module 02) each guessing the same shape independently with no guarantee of agreement — exactly the failure mode `00-architecture.md` section 8 warns against. Architecture section 9.1 has since been expanded to pin all four sub-shapes field-for-field, using precisely the shape this module's sections 4–5 already assumed (so nothing in this module's own algorithm text needed to change) — `03-tejas-data.md`/`contracts/aircraft.ts` (module 03) are drafted against that same pinned shape, so the two modules now agree by construction, not by chance.
- **`contracts/math.ts`'s exact exported shapes — RESOLVED, no longer an assumption.** An earlier drafting pass of this document guessed at `Table1D`/`Table2D`'s fields and a function it called `sampleTable2D`, since `contracts/math.ts` was not available to read at the time. `contracts/math.ts` now exists; its real exports are `Table1D { xs, ys }`/`Table2D { xs, ys, zs }` (structurally identical to what this module already assumed — no change needed) and `Interpolate1D`/`Interpolate2D` (function VALUES `interpolate1D`/`interpolate2D`, not `sampleTable1D`/`sampleTable2D` — every call site in section 4 has been corrected to the real name), plus `PrngState`/`PrngNextFloat01`/`LowPassStep`. `Vec3`/`Quat`/`Mat3`'s method names used above (`Quat.rotate`, `Quat.rotateInverse`, `Quat.multiply`, `bodyRateP/Q/R`, `Quat.toYawPitchRoll`) were always taken directly from `00-architecture.md` section 3, which gives their exact signatures normatively, and match `contracts/math.ts`'s real `QuatStatic` exactly.
- **`Environment`'s `groundElevationM`/`groundNormalWorld` fields are now pinned directly by `00-architecture.md` section 9.1 itself** (an earlier drafting pass here had added them as this module's own extension beyond architecture's then-4-field sketch; architecture has since been corrected to give the full, authoritative 6-field shape, since `contracts/sim.ts`'s `SimEnvironment` — module 10, drafted blind to this document — independently needed the identical two fields to actually wire the landing-gear/AGL ground reference through `FlightModelPort.step`). `StepAircraft`'s mandated 7-parameter signature still has no separate `HeightSampler` parameter; the ground reference each tick's landing-gear model (4.8) and AGL telemetry (4.11) need arrives pre-sampled through these two `Environment` fields instead, exactly as `10-core-worker.md` section 4.1 step 3 now documents on the `World` side.
- **Pitch trim-integral state (`trimIntegralRad`) and the telemetry gLoad cache (`lastGLoadRad`), both introduced in 4.9/4.11, are held as `fcs.ts`/`physics`-module-private `Float64Array(MAX_ENTITIES)` tables indexed by `UnpackEntityId(state.id).index`, NOT as `EntityState`/`DamageState` fields.** This is a deliberate choice, not an oversight: both `contracts/core.ts` and `contracts/flight.ts` are fixed inputs this module cannot edit (per the single-pass isolation rule), `StepAircraft`'s mandated signature has no channel for physics to hand PERSISTENT per-entity scalars back to `src/core` other than through `out: EntityState` itself, and adding fields to `EntityState` would ripple into the `Snapshot` binary layout (`contracts/core.ts` section on stride/offsets) that every other module also reads — entirely out of this module's authority to change. Keeping this state module-private instead means: (a) it survives exactly as long as `src/physics`'s module instance does, which for a single long-lived Worker (this project's actual runtime — see `00-architecture.md`) is the whole session, so no persistence is actually lost in practice; (b) it is NOT part of any save/replay/network state, which is fine because it is fully re-derived from a few seconds of `(gCmd, gLoad)` history — a replay that re-runs `stepAircraft` with the same recorded `PilotInputs` stream re-accumulates the identical `trimIntegralRad` deterministically (same argument as the determinism test, section 7 item 19); (c) it is NEVER read outside `src/physics` except through the read-back path `computeTelemetry` already has for `lastGLoadRad`, so no other module needs to know it exists. The one risk this carries: if `src/core` ever pools/reuses an `EntityId` index for a DIFFERENT aircraft without this module observing a `damage.hydraulicsOk` or `OnGround` transition in between (e.g. instant despawn+respawn at the same pool index within one call), the new aircraft could inherit a stale `trimIntegralRad`/`lastGLoadRad` value for one tick; `src/core`'s entity-pool reuse contract (module 10) should zero these via a `resetFcsTrimState(entityIndex)` export this module additionally provides from `fcs.ts` (non-contract, `src/core`-only convenience) whenever it recycles a pool slot for a new aircraft — flagged here as the one cross-module coordination point this design introduces.
- **`stepAircraft` treats `damage: DamageState` as strictly read-only** and never mutates it, per `core.ts`'s own field comment ("written by src/combat... read by src/physics"). Consequently this module does NOT implement hard-landing / overstress structural damage, gear-collapse damage, or any other physics-triggered `DamageState` mutation — a hard landing simply bounces/settles per the spring-damper model (4.8) with no lasting damage unless `src/combat` or `src/core` separately observes the touchdown `vspeedMps`/`gLoad` (available via telemetry/events) and chooses to reduce `structurePct` itself. This is a scoped limitation, not an oversight.
- **`stepAircraft` never emits `SimEvent`s** (no output parameter for them in the mandated signature) — `TouchdownEvent`/`CrashEvent` detection (comparing `EntityFlag.OnGround` transitions, `structurePct` reaching 0, etc.) is `src/core`'s responsibility, built from the `EntityState`/`DamageState` this module produces, not this module's.
- **Aircraft mass is treated as a fixed constant (`def.massKg`), not reduced as fuel burns** (`massKg` vs. `emptyMassKg + fuelKg`). Architecture section 9.1 gives `AircraftDefinition` both `massKg` and `emptyMassKg` fields without specifying which one `stepAircraft` should use for inertial calculations — this module uses `massKg` (interpreted as "current reference mass for the integrator," effectively a fixed nominal combat-weight simplification) for both translational (`F=ma`) and gLoad purposes, and does not recompute the inertia tensor as fuel depletes. This is a deliberate scope-limiting simplification (a mass-varying inertia model would need `AircraftDefinition` to expose an empty-vs-full inertia tensor pair or a fuel-position-dependent formula, which architecture does not provide) — flagged as a known physical inaccuracy (a Tejas at low fuel will fly slightly "heavier" than reality in this simulation).
- **Thrust line assumed through the CG** (no thrust-offset pitching moment) — `AircraftDefinition` gives hardpoint positions but no explicit engine-nozzle position separate from `cgOffsetBodyM`; a single-engine centerline fighter's thrust offset from CG is small in practice, and modeling it would need a field architecture doesn't provide.
- **Gear ground-contact normal force direction is approximated as world +Y** (flat-locally), not `env.groundNormalWorld` (which IS carried in `Environment` for a future revision, section 1 of `contracts/flight.ts`). Justified because airport surfaces are explicitly flattened (`AirportFlattenZone`, architecture section 9.2) and general terrain slope under a landing gear leg is typically shallow; a fully slope-aware contact model is deferred as a documented simplification, not a missing requirement.
- **Ground effect (4.4) is a custom, generically-shaped smoothstep model** (`1 + groundEffectMaxDeltaCL*(1-smoothstep01(h/b))`), not a specific published empirical formula for the Tejas or any analogue aircraft — no public Tejas ground-effect data exists; the functional FORM (monotonic CL increase approaching the ground, negligible beyond ~1 span height) is standard delta-wing behavior, but the exact curve shape and the `groundEffectMaxDeltaCL` VALUE are module 03's data to choose, this module only fixes the formula shape.
- **IAS formula (4.11) uses the incompressible `IAS ≈ TAS·sqrt(ρ/ρ0)` approximation**, with no pitot compressibility correction and no instrument/position error — adequate for a HUD display and for this project's scope; a full compressible-flow IAS (calibrated-airspeed) model was judged not worth the added complexity for a placeholder-visual, single-aircraft-type simulator.
- **24 simultaneously-active aircraft** (section 6's performance budget) is this module's own assumption for sizing the per-tick performance target, since no other module spec gives an exact concurrent-aircraft count; `core.ts`'s `MAX_ENTITIES=400` includes bullets/missiles/effects, not just aircraft, so 24 is a reasonable upper bound for a "large furball" scenario, chosen conservatively for budgeting purposes only (it does not gate or limit anything at runtime).
