# 07 — Combat (weapons, radar, damage)

**Read `docs/spec/00-architecture.md` and `docs/spec/contracts/core.ts` in full before this document.** Where anything here appears to disagree with those two, they win — see architecture §8. This document and `contracts/combat.ts` are the complete, self-contained spec for `src/combat/*`. `contracts/combat.ts` imports **only** from `./core` (no `./math` import is needed — every function below that would otherwise need a mutable vector instead takes a `Vec3Like`/`QuatLike`-shaped `out` parameter, exactly as core.ts's own §1 rationale recommends).

## 1. Purpose & scope

This module is the entire weapons/sensors/damage layer: weapon stations and loadouts; the 23 mm GSh-23 gun with ballistic (drag+gravity) bullets and a lead-computing gunsight solution; an R-73-like IR missile (seeker FOV/gimbal, heat-aspect lock, proportional navigation); a Derby-like radar missile (STT-lock-to-launch, datalink midcourse, autonomous terminal homing); a radar model (r⁴ detection range, scan/track cones, STT lock state machine, ground-clutter notch approximation); an RWR (missile-inbound + radar-lock warnings); subsystem damage (writes `core.ts`'s `DamageState`, which `src/physics` reads to degrade the flight model); and every `SimEvent` all of the above produce (`gunFire`, `missileLaunch`, `hit`, `kill`, `explosion`, `lockAcquired`, `lockLost`, `warning`).

It runs identically in the sim worker and under Node (vitest, `tools/sim-check.ts`) — no DOM, no `Math.random()` (all randomness is via a caller-supplied, mulberry32-backed `CombatRngState`), no allocation in any function called once per SIM_DT_SEC or once per projectile per tick (every hot function mutates an `out` parameter or pushes into a pre-sized/reused array; see the "OUT-ARRAY CONVENTION" note at the top of `contracts/combat.ts`).

Because the twelve modules are built in one parallel pass and never see each other's specs (only `00-architecture.md` + `core.ts` + their own spec+contract — build order, architecture §12), **`contracts/combat.ts`'s exported function JSDoc comments are written to be sufficient on their own** for `src/core` (module 10) to wire this module correctly, since module 10's drafting agent reads this module's *contract* (it imports `src/combat/*` — architecture §10) but never this prose document. This document is the full rationale, the exact algorithms, and the test/acceptance surface for module 12 and for whoever later implements `src/combat/*` itself.

## 2. Owned files

| file | purpose |
|---|---|
| `src/combat/weaponStation.ts` | `WeaponsState`/`WeaponStationRuntime` factory (`createWeaponsState`), `writeCombatStatus`; hosts the top-level `fireWeapons` (dispatches to gun/IR/radar-missile spawn logic below). |
| `src/combat/gunBallistics.ts` | Gun constants' consumers: bullet drag/gravity integration; also hosts the top-level `stepProjectile` (dispatches to `proportionalNavigation.ts`/`irMissileSeeker.ts`/`radarMissile.ts` for guided kinds) and the projectile pool factories (`createProjectilePool`, `resetProjectile`, `initProjectile`). |
| `src/combat/leadComputingSight.ts` | `computeLeadSolution` (iterative ballistic lead solve for the gunsight pipper). |
| `src/combat/irMissileSeeker.ts` | IR seeker acquire/track cone checks, `irDetectionRangeM`, IR-specific lock-progress logic used inside `updateSensors`, IR guidance-mode transitions used inside `stepProjectile`. |
| `src/combat/proportionalNavigation.ts` | Shared true-PN lateral-acceleration formula used by both missile kinds inside `stepProjectile`. |
| `src/combat/radarModel.ts` | Hosts the top-level `updateSensors` (contacts, scan/track cones, `radarDetectionRangeM`, notch, terrain-LOS masking, threat scoring, RWR); radar-specific lock-progress logic. |
| `src/combat/radarMissile.ts` | Radar-missile-specific guidance-mode transitions (datalink → active) used inside `stepProjectile`. |
| `src/combat/hitDetection.ts` | `segmentHitsEllipsoid`, `closestApproachOnSegment`. |
| `src/combat/subsystemDamage.ts` | `applyHit`, `rollSubsystemHit`, `subsystemHitFromU01`, `createDamageState`. |
| `src/combat/effectsEvents.ts` | `pushExplosionEvent`, `resolveProjectileHit`. |
| `src/combat/index.ts` | Barrel re-export of every function/constant above. |

## 3. Public API

This restates `contracts/combat.ts` verbatim in signature form, grouped to match §2's files, with the per-tick call order `src/core` must follow. **Full JSDoc for every item lives only in the contract file** — this section is a map, not a duplicate.

### 3.1 Per-tick call order (authoritative — also stated in the contract's own doc comments)

For every SIM_DT_SEC tick, for every aircraft entity that carries a `Pilot` and a `WeaponsState`:

1. **`updateSensors(...)`** — before `Pilot.update`. Builds this tick's `Contact[]`, advances lock state, refreshes RWR. Uses **last tick's** `PilotInputs` for `cycleTarget`/`cycleWeapon` (this tick's inputs do not exist yet — see §4.1).
2. `Pilot.update(ctx, dt, out)` runs (module 06/09; not this module).
3. `stepAircraft(...)` runs (module 02; not this module).
4. **`fireWeapons(...)`** — after `stepAircraft`, using **this tick's** fresh `PilotInputs` (`trigger`, `launch`) and fresh `EntityState` (muzzle position/velocity). Pushes `ProjectileSpawnRequest`s + `gunFire`/`missileLaunch` events.
5. `src/core` allocates an `EntityId`/`EntityState` for each spawn request, then calls **`initProjectile(...)`**.
6. For every alive bullet/missile entity: **`stepProjectile(...)`**.
7. For every `ProjectileStepResult` with `outcome ∈ {'direct_hit','proximity_detonation'}`: **`resolveProjectileHit(...)`**, then `src/core` pushes a `kill` `SimEvent` iff the result's `targetLethal === true`. For `'terrain_impact'`/`'expired'`, `src/core` despawns the projectile directly — no combat call needed.

### 3.2 Weapon stations & loadout (`weaponStation.ts`)

```ts
createWeaponsState: CreateWeaponsState;               // (loadout, rngSubSeed) => WeaponsState
writeCombatStatus: WriteCombatStatus;                 // (state, out: CombatStatus) => void
createCombatRngState: CreateCombatRngState;           // (subSeed) => CombatRngState
fireWeapons: FireWeapons;
```

### 3.3 Damage (`subsystemDamage.ts`)

```ts
createDamageState: CreateDamageState;                 // () => DamageState (canonical "full health")
applyHit: ApplyHit;
rollSubsystemHit: RollSubsystemHit;
subsystemHitFromU01: SubsystemHitFromU01;
```

### 3.4 Sensors / radar / RWR (`radarModel.ts`, `irMissileSeeker.ts`)

```ts
updateSensors: UpdateSensors;
radarDetectionRangeM: RadarDetectionRangeM;
irDetectionRangeM: IrDetectionRangeM;
```

### 3.5 Projectile flight (`gunBallistics.ts`, `proportionalNavigation.ts`, `irMissileSeeker.ts`, `radarMissile.ts`)

```ts
createProjectilePool: CreateProjectilePool;
resetProjectile: ResetProjectile;
initProjectile: InitProjectile;
stepProjectile: StepProjectile;
computePnAccel: ComputePnAccel;
```

### 3.6 Hit detection (`hitDetection.ts`)

```ts
segmentHitsEllipsoid: SegmentHitsEllipsoid;
closestApproachOnSegment: ClosestApproachOnSegment;
```

### 3.7 Gunsight (`leadComputingSight.ts`)

```ts
computeLeadSolution: ComputeLeadSolution;
```

### 3.8 Events (`effectsEvents.ts`)

```ts
pushExplosionEvent: PushExplosionEvent;
resolveProjectileHit: ResolveProjectileHit;
```

## 4. Design & algorithms

### 4.1 Why `updateSensors` reads *last* tick's inputs

`Pilot.update` (human or AI) is what *produces* `PilotInputs.cycleTarget`/`cycleWeapon` for this tick, but `PilotContext.combat` (built from this module's `WeaponsState`) must already be valid *before* `Pilot.update` runs, since the AI reads lock state to decide behaviour. The only way to avoid a circular dependency is for target/weapon cycling to run one tick behind: `updateSensors` edge-detects `inputs.cycleTarget` against `state.prevCycleTarget` using the **previous** tick's `PilotInputs` (the same object `fireWeapons` consumed last tick — `src/core` must keep it around). `fireWeapons`, which runs *after* `stepAircraft` in the *same* tick, always uses the fresh, current-tick inputs for `trigger`/`launch` — there is no such cycle there since firing doesn't feed back into `updateSensors`'s own inputs.

### 4.2 Gun ballistics (bullets) — drag + gravity integration

Cross-section area is precomputed as a contract constant: `GUN_ROUND_CROSS_SECTION_M2 = π·(GUN_ROUND_DIAMETER_M/2)² = π·0.0115² = 4.1548×10⁻⁴ m²` (same formula for the two missile kinds' `*_CROSS_SECTION_M2`).

Per tick, for a bullet (`ProjectileGuidanceMode.Ballistic`, no thrust):

```
speed      = |vel|
dragAccel  = 0.5 · env.airDensityKgM3 · speed² · GUN_ROUND_DRAG_COEFF · GUN_ROUND_CROSS_SECTION_M2 / GUN_ROUND_MASS_KG   // m/s², opposes vel
accel      = -normalize(vel) · dragAccel + (0, -env.gravityMps2, 0)
vel_new    = vel + accel · dtSec            // semi-implicit Euler
pos_new    = pos + vel_new · dtSec
```

`out.rot` is re-derived every tick from `vel_new` via **velocity alignment** (used identically for missiles, §4.7): build an orthonormal basis with `forward = normalize(vel_new)`, `right = normalize(cross(forward, worldUp=(0,1,0)))` (fallback `right = (1,0,0)` if `forward` is within 1e-4 rad of `worldUp`), `up = cross(right, forward)`, then construct the quaternion whose body axes map to `(forward, up, right)` = world `(+X, +Y, +Z)` (standard basis→quaternion construction). This is the only place this module builds a quaternion from axes rather than from `core.ts`'s yaw/pitch/roll formula, because a projectile has no meaningful independent roll — it always points exactly along its velocity.

`distanceTravelledM += |pos_new − pos|` each tick; bullets become fuse/hit-eligible once this exceeds `GUN_ARM_DISTANCE_M` (5 m — prevents an impossible self-hit at the muzzle). A bullet's `ProjectileState.targetId` is always `NO_ENTITY_ID` and its `guidance` is always `'ballistic'` — it never looks up `candidates` for anything except the hit test in §4.9, which is run against **every** candidate, nearest first, not a single assigned target.

Lifetime: `ageSec > GUN_BULLET_MAX_LIFETIME_SEC` (3.0 s ⇒ ~2145 m at muzzle velocity before drag) ⇒ `outcome = 'expired'`, no explosion.

### 4.3 Lead-computing sight — iterative ballistic solve

`computeLeadSolution` fixed-point-iterates the intercept time, assuming **constant target velocity** (no target-maneuver prediction — a standard simplification for a lead-computing, non-radar-ranging gunsight):

```
T₀ = |targetPos − shooterPos| / muzzleVelocityMps
repeat k = 1..LEAD_SOLVE_MAX_ITERATIONS (5):
  predictedPos = targetPos + targetVel · T_{k−1}
  T_k = |predictedPos − shooterPos| / muzzleVelocityMps
dropCompensationM = 0.5 · gravityMps2 · T_final²
outAimPointWorld  = predictedPos + (0, dropCompensationM, 0)
valid = isFinite(T_final) && T_final >= 0 && T_final < 10 && |predictedPos − shooterPos| <= LEAD_SOLVE_MAX_RANGE_M
```

If `!valid`, `outAimPointWorld` is left equal to `targetPosWorld` (a safe fallback — see the contract's own doc comment) and `timeOfFlightSec`/`rangeM` still hold the last-iteration values for diagnostic use.

**Worked example** (used verbatim by the unit test in §7): `shooterPos = (0,0,0)`, `shooterVel = (0,0,0)`, `targetPos = (1000,0,0)`, `targetVel = (0,0,50)`, `muzzleVelocityMps = 715`, `gravityMps2 = 9.80665`.

| iter | predictedPos | range | T |
|---|---|---|---|
| 0 (seed) | — | 1000 | 1.39860 |
| 1 | (1000, 0, 69.93) | 1002.44 | 1.40201 |
| 2 | (1000, 0, 70.10) | 1002.454 | 1.402034 |
| 3 | (1000, 0, 70.102) | 1002.4547 | 1.402035 (converged) |

`dropCompensationM = 0.5·9.80665·1.402035² = 9.638`. **`outAimPointWorld ≈ (1000.0, 9.638, 70.10)`, `timeOfFlightSec ≈ 1.40203`, `valid = true`.**

`computeLeadSolution` deliberately takes only `Vec3Like` kinematics + two scalar constants (`GUN_MUZZLE_VELOCITY_MPS`, `core.ts`'s `GRAVITY_MPS2`).

**Publishing the solution to the HUD (`WeaponsState.aimPointWorld`/`aimPointValid`).** `updateSensors` (§4.1), as the last step of its per-tick work and regardless of `state.selectedWeapon`, resolves the aim-reference contact as `state.lockedTargetId` if defined and still alive in `allEntities`, else the contact at `state.selectedContactIndex` in the `outContacts` just built, else `undefined`; when a contact is resolved it calls `computeLeadSolution(observer.pos, observer.vel, contactPos, contactVel, GUN_MUZZLE_VELOCITY_MPS, env-supplied `gravityMps2`, scratchAimPoint)` and copies the result into `state.aimPointWorld`/`state.aimPointValid = result.valid`; when no contact is resolved, `state.aimPointValid = false` (`aimPointWorld` left at its previous value — never read while invalid). `writeCombatStatus` copies both fields straight into `CombatStatus.aimPointWorld`/`aimPointValid` (core.ts, module 00), and `src/core`'s HUD-block assembly (10-core-worker.md §4.8) copies `CombatStatus.aimPointWorld`/`aimPointValid` into the Snapshot HUD block's `PIPPER_X/Y/Z/VALID` floats (core.ts §6.3) every emitted snapshot. `src/hud`'s target-box/lead-sight widget (module 08) therefore never runs its own ballistics: it reads `PIPPER_*` straight off the snapshot and projects that single world point through the frame's `CameraState`, so the on-screen pipper always agrees exactly with this module's real, gravity-drop-compensated solution — see §9 for the resolved history of this gap.

### 4.4 Radar model — detection, scan cone, notch, terrain masking

**Detection range** (r⁴ radar range equation): `radarDetectionRangeM(rcsM2) = clamp(RADAR_REFERENCE_RANGE_M · (rcsM2 / RADAR_REFERENCE_RCS_M2)^0.25, 0, RADAR_MAX_RANGE_M)`.

| `rcsM2` | range |
|---|---|
| `DEFAULT_AIRCRAFT_RCS_NOSE_ON_M2` = 2.0 | 80000·(0.4)^0.25 ≈ **63 624 m** |
| `DEFAULT_AIRCRAFT_RCS_BROADSIDE_M2` = 6.0 | 80000·(1.2)^0.25 ≈ **83 730 m** |
| `RADAR_REFERENCE_RCS_M2` = 5.0 | exactly 80 000 m |

Effective RCS for a `DetectableEntity` is aspect-interpolated the same way as IR (§4.6): `rcsM2 = lerp(sig.noseOnRcsM2, sig.broadsideRcsM2, sin(aspectFromNoseRad))` where `aspectFromNoseRad` is the angle between the target's own forward axis and the line back to the observer, `sin(0) = 0` (nose-on, minimum) and `sin(π/2) = 1` (beam-on, maximum).

**Scan/track cone** (azimuth/elevation decomposition against the observer's own body axes):

```
forwardW = rotate(observer.rot, (1,0,0));  rightW = rotate(observer.rot, (0,0,1));  upW = rotate(observer.rot, (0,1,0))
bearing  = normalize(targetPos − observerPos)
azRad    = atan2(dot(bearing, rightW), dot(bearing, forwardW))
elRad    = atan2(dot(bearing, upW), sqrt(dot(bearing,forwardW)² + dot(bearing,rightW)²))
inScanCone  = |azRad| <= RADAR_SCAN_AZ_HALF_ANGLE_RAD  && |elRad| <= RADAR_SCAN_EL_HALF_ANGLE_RAD
inTrackCone = |azRad| <= RADAR_TRACK_HALF_ANGLE_RAD    && |elRad| <= RADAR_TRACK_HALF_ANGLE_RAD
```

**Worked example**: observer heading = π/2 (due east ⇒ `rot` = identity, per architecture §3.3 worked example A) so `forwardW=(1,0,0)`, `rightW=(0,0,1)`, `upW=(0,1,0)`. Target at `observerPos + (500,0,100)`: `bearing = (0.9806, 0, 0.1961)`, `azRad = atan2(0.1961, 0.9806) = 0.1974 rad` (≈11.3°), `elRad = atan2(0, 1) = 0`. `0.1974 ≤ RADAR_SCAN_AZ_HALF_ANGLE_RAD(1.047)` ⇒ **in scan cone**; `0.1974 > RADAR_TRACK_HALF_ANGLE_RAD(0.175)` ⇒ **not in track cone** (detected, not lockable at this bearing).

**Ground-clutter notch**: `isNotched = bearing.y < 0 && |dot(target.vel, bearing)| < RADAR_NOTCH_CLOSURE_MPS(15) && contact.rangeM <= RADAR_NOTCH_MAX_RANGE_M(20000)` — the target's own ground-relative radial velocity (not the observer-relative closure, which wrongly notched every co-speed tail chase), and only while looking down into ground clutter. A notched contact is still returned as a `Contact` (radar "sees a return") but can never satisfy the track-cone lock criteria in §4.6.1 while notched — flying a beam aspect defeats an STT lock attempt, matching real pulse-Doppler notching, without modeling actual Doppler processing.

**Terrain LOS masking** (`RADAR_LOS_SAMPLE_COUNT = 3` samples at `f ∈ {0.25, 0.5, 0.75}`):

```
for f in [0.25, 0.5, 0.75]:
  midX, midZ = lerp(observerPos.x, targetPos.x, f), lerp(observerPos.z, targetPos.z, f)
  terrainH = sampler.heightAt(midX, midZ)
  losH     = lerp(observerPos.y, targetPos.y, f)
  if terrainH + TERRAIN_LOS_MASK_MARGIN_M > losH: masked = true; break
```

A masked target is dropped from `outContacts` entirely for that tick (both radar and visual — a ridgeline blocks the eyeball too) regardless of range/RCS.

### 4.5 Visual detection

`isVisible = rangeM <= VISUAL_DETECT_RANGE_M(8000) && angleFromForward(bearing, forwardW) <= VISUAL_FOV_HALF_ANGLE_RAD(π/2) && !terrainMasked`, where `angleFromForward = acos(clamp(dot(bearing, forwardW), −1, 1))`. A contact detected only visually (not radar) gets `detectedBy = 'visual'`; `identified = true` iff `rangeM <= VISUAL_IFF_CONFIRM_RANGE_M(3000)`. A contact detected by radar always has `identified = (radarHealthPct > 0 && inTrackCone && !isNotched)` — i.e. radar alone gives a firm ID only once it could also track it; a bare search-mode radar return is `identified = false` (matches `core.ts`'s own doc comment on `Contact.identified`: "never used to infer team beyond what the sensor model allows").

### 4.6 Lock state machine (shared shape, per-weapon criteria)

`state.lockState`/`lockProgressSec`/`lockBreakGraceRemainingSec` track progress toward locking `state.lockedTargetId`, using **different acquisition criteria depending on `state.selectedWeapon`** — this is why changing weapon resets progress (§4.1's call order: this all happens inside `updateSensors`, before `fireWeapons`):

- **`'gun'`**: `lockState` stays `'none'` always (guns don't lock; §4.3's sight works off `lockedTargetId` alone, no lock progress needed).
- **`'radar_missile'`** (§4.6.1): criteria = `inTrackCone && !isNotched && !terrainMasked && rangeM <= radarDetectionRangeM(rcsM2)`, time-to-lock `RADAR_LOCK_TIME_SEC(3.0)`, grace `RADAR_LOCK_BREAK_GRACE_SEC(1.5)`.
- **`'ir_missile'`** (§4.6.2): criteria = `angleFromForward(bearing, forwardW) <= (locked ? IR_SEEKER_TRACK_HALF_ANGLE_RAD : IR_SEEKER_ACQUIRE_HALF_ANGLE_RAD) && rangeM <= irDetectionRangeM(aspectRad, targetAfterburnerOn)`, time-to-lock `IR_LOCK_TIME_SEC(1.0)`, grace reuses `RADAR_LOCK_BREAK_GRACE_SEC` (no separate IR grace constant — same hysteresis value for both sensor types).

Every tick, for the currently-selected weapon's criteria:

```
if criteria satisfied:
  lockProgressSec += dtSec
  lockBreakGraceRemainingSec = <weapon's grace constant>   // refill grace on every good tick
else:
  lockBreakGraceRemainingSec -= dtSec
  if lockBreakGraceRemainingSec <= 0:
    lockState = 'searching'; lockProgressSec = 0

lockTime = (selectedWeapon === 'radar_missile') ? RADAR_LOCK_TIME_SEC : IR_LOCK_TIME_SEC   // gun: n/a, lockState forced 'none'
if      lockProgressSec >= lockTime:         lockState = 'locked'
else if lockProgressSec >= lockTime * 0.3:   lockState = 'tracking'
else:                                        lockState = 'searching'
```

`lockedTargetId === undefined`, or the target entity is dead/not found this tick ⇒ immediately `lockState = 'none'`, `lockProgressSec = 0`, `lockBreakGraceRemainingSec = 0`. Push `lockAcquired` exactly on the tick `lockState` transitions **into** `'locked'`; push `lockLost` exactly on the tick it transitions **out of** `'locked'` (i.e. grace expired while previously locked).

#### 4.6.1 Radar missile launch & guidance

`fireWeapons` only spawns a `'radar_missile'` request when `state.lockState === 'locked'` (STT-lock-to-launch). In flight (`stepProjectile`, dispatched to `radarMissile.ts`):

```
rangeToTarget = |target.pos - missile.pos|
if target not found in candidates (dead):           guidance = 'lost'
else if rangeToTarget > RADAR_MISSILE_ACTIVE_SEEKER_RANGE_M(12000):
                                                      guidance = 'radar_datalink'   // perfect target state (simulated shooter datalink — see §9)
else:
  angle = angleFromForward(normalize(target.pos-missile.pos), missileForward)
  guidance = (angle <= RADAR_MISSILE_ACTIVE_SEEKER_HALF_ANGLE_RAD) ? 'radar_active' : 'lost'
```

Once `guidance === 'lost'`, it never recovers for that missile (coasts ballistic to expiry/impact). Additionally: if the PN-commanded lateral acceleration (§4.7, pre-clamp magnitude) has been `>= RADAR_MISSILE_MAX_G · gravityMps2` continuously for `RADAR_MISSILE_G_SATURATION_LOST_SEC(2.0)` seconds, `guidance = 'lost'` regardless of the cone check (the target out-maneuvered the missile's authority).

#### 4.6.2 IR missile launch & guidance

`fireWeapons` only spawns an `'ir_missile'` request when `state.lockState === 'locked'` **and** `rangeM >= IR_MIN_LAUNCH_RANGE_M(300)`. In flight (`irMissileSeeker.ts`): `seekerLosDirBody` (in `ProjectileState`) slews toward the true target bearing (in missile body frame) at up to `IR_SEEKER_GIMBAL_RATE_MAX_RAD_S(12.0 rad/s)`:

```
trueLosBody   = worldToBody(missile.rot, normalize(target.pos - missile.pos))
maxStepRad    = IR_SEEKER_GIMBAL_RATE_MAX_RAD_S · dtSec
seekerLosDirBody = rotateTowards(seekerLosDirBody, trueLosBody, maxStepRad)   // spherical step, clamped
gimbalAngle   = angleFromForward(seekerLosDirBody, (1,0,0))
guidance      = (target not found in candidates) ? 'lost'
              : (gimbalAngle > IR_SEEKER_TRACK_HALF_ANGLE_RAD) ? 'lost'
              : 'ir_homing'
```

### 4.7 Proportional navigation (both missile kinds, `proportionalNavigation.ts`)

True PN in 3D, computed only while `guidance ∈ {'ir_homing','radar_datalink','radar_active'}` (else lateral accel = 0):

```
r      = targetPos − missilePos
rDot   = targetVel − missileVel
rUnit  = normalize(r)
Vc     = −dot(rDot, rUnit)                          // + = closing
omega  = cross(r, rDot) / dot(r, r)                 // LOS rotation vector, rad/s
aCmd   = N · Vc · cross(omega, rUnit)                // m/s², N = IR_PN_GAIN or RADAR_MISSILE_PN_GAIN
aCmd   = clampMagnitude(aCmd, maxG · gravityMps2)    // maxG = IR_MAX_G or RADAR_MISSILE_MAX_G
```

**Worked example** (used verbatim by the unit test in §7): missile at origin, `vel = (200,0,0)`; target at `(2000,0,500)`, `vel = (0,0,0)`; `N = IR_PN_GAIN = 3.5`.

```
r = (2000,0,500)          rDot = (−200,0,0)          |r| = 2061.55
rUnit = (0.9701, 0, 0.2425)
Vc = −dot(rDot,rUnit) = −(−200·0.9701) = 194.02 m/s
cross(r,rDot) = (0, −100000, 0)      dot(r,r) = 4 250 000
omega = (0, −0.023529, 0) rad/s
cross(omega,rUnit) = (−0.0057058, 0, 0.0228294)
aCmd = 3.5 · 194.02 · (−0.0057058, 0, 0.0228294) = (−3.874, 0, 15.505) m/s²   |aCmd| ≈ 15.98 m/s² ≈ 1.63 g (well under IR_MAX_G=35)
```

### 4.8 Threat scoring (`THREAT_SCORE_WEIGHTS`, sum to 1.0)

The internal `DetectableEntity` candidate list (before it is narrowed into the `Contact[]` pushed to `outContacts` — see §4.4's `candidate` usage) is sorted descending by:

```
score = W.range · (1 − clamp(rangeM / RADAR_MAX_RANGE_M, 0, 1))
      + W.aspect · ((1 + cos(aspectFromNoseRad)) / 2)        // higher when contact is pointed at observer (nose-on-to-observer = high aspect threat)
      + W.targetingMe · (candidate.radarEmission?.lockedTargetId === observerId ? 1 : candidate.radarEmission?.trackedTargetId === observerId ? 0.5 : 0)
      + W.closure · clamp(closureMps / 500, 0, 1)
```
(`W = THREAT_SCORE_WEIGHTS = { range: 0.4, aspect: 0.2, targetingMe: 0.3, closure: 0.1 }`. `candidate: DetectableEntity`, matching §4.4; the resulting order is preserved when each surviving candidate is mapped to its `Contact` for `outContacts`.)

### 4.9 Hit detection, fuses, and damage magnitude

**Candidate set (owner exclusion).** For every projectile, the hit/fuse loop below iterates `candidates` EXCLUDING `c.id === projectile.ownerId` — this exclusion is unconditional and applies for the projectile's entire flight, not just its first tick. Without it, a missile spawned at a wing-mounted `WeaponStationSpec.posBodyM` (necessarily inside the shooter's own `DEFAULT_AIRCRAFT_HIT_ELLIPSOID_M = (6.6, 2.2, 4.1)`, since the wing itself is part of the airframe) would register a `direct_hit` against its own launcher on its very first swept segment. `src/core` may either filter its shared per-tick `candidates` array once before calling `stepProjectile` for each projectile, or `stepProjectile` may skip `c.id === projectile.ownerId` internally while walking it — either way, the observable contract is the same: `ownerId` is never a valid hit/fuse target for its own round. This is separate from, and in addition to, the `armDistance` gate below — a projectile that has travelled far enough to be armed but has re-approached its own (now possibly manoeuvring) shooter still must not hit it.

**Arming (applies to the direct-hit ellipsoid test too, not just the proximity fuse).** Both the direct-hit ellipsoid test AND the proximity-fuse test are gated identically by `distanceTravelledM >= armDistance` (`GUN_ARM_DISTANCE_M` / `IR_ARM_DISTANCE_M` / `RADAR_MISSILE_ARM_DISTANCE_M`, per `kind`) for EVERY projectile kind. §4.2's bullet-specific description of this gate ("bullets become fuse/hit-eligible once this exceeds `GUN_ARM_DISTANCE_M`") is the general rule, not a bullet-only special case: an IR or radar missile's very first swept segment (from the rail/hardpoint to its position one tick later) is unarmed and is skipped by the ellipsoid test exactly like an unarmed bullet would be, closing the same self-hit failure mode the owner exclusion above closes, for the case where a *different* nearby friendly aircraft happens to sit inside the missile's arm-distance envelope at launch.

**Ellipsoid test** (`segmentHitsEllipsoid`): transform both segment endpoints into the target's body frame and scale by the (inverse) semi-axes, reducing to a standard unit-sphere/segment intersection:

```
localStart = worldToBody(targetRot, segStart − targetPos);  scaledStart = localStart / semiAxes   // componentwise
localEnd   = worldToBody(targetRot, segEnd   − targetPos);  scaledEnd   = localEnd   / semiAxes
d = scaledEnd − scaledStart;  a = dot(d,d);  b = 2·dot(scaledStart,d);  c = dot(scaledStart,scaledStart) − 1
disc = b² − 4ac
hit  = disc >= 0 && a > 1e-9 && ( t1 <= 1 && t2 >= 0 )     where t1,2 = (−b ∓ √disc) / (2a)
tEntry = (c < 0) ? 0 : clamp(t1, 0, 1)                      // c<0 ⇒ segment START already inside
```

**Worked example**: target at origin, identity rotation, `semiAxes = DEFAULT_AIRCRAFT_HIT_ELLIPSOID_M = (6.6, 2.2, 4.1)`. Segment `(0,0,−50) → (0,0,50)`. `scaledStart=(0,0,−12.195)`, `scaledEnd=(0,0,12.195)`, `a=594.86`, `b=−594.87`, `c=147.72`, `disc≈2402`, `t1=0.4589`, `t2=0.5412` — both in `[0,1]` ⇒ **hit = true, tEntry ≈ 0.4589** (sanity check: entry z should be at `−4.1`, and `(−4.1−(−50))/(50−(−50)) = 0.459` ✓).

**Proximity fuse** (`closestApproachOnSegment`, standard point-to-segment minimum distance) is tested only once `distanceTravelledM >= armDistance` (`GUN_ARM_DISTANCE_M`/`IR_ARM_DISTANCE_M`/`RADAR_MISSILE_ARM_DISTANCE_M`), against **every** candidate (nearest wins), never just the assigned `targetId` — a near-miss on a bystander still detonates. Bullets (`kind === 'bullet'`) skip the proximity check entirely (no fuse; direct ellipsoid hit only).

**Damage magnitude** (`resolveProjectileHit`, used from §3.1 step 7):

```
if kind === 'bullet':               damageFrac = GUN_HIT_DAMAGE_FRAC                                  // direct hit only, bullets have no fuse
if outcome === 'direct_hit':        damageFrac = (kind==='ir_missile' ? IR_WARHEAD_DAMAGE_FRAC : RADAR_MISSILE_WARHEAD_DAMAGE_FRAC)
if outcome === 'proximity_detonation':
  fuseRadius = (kind==='ir_missile' ? IR_PROXIMITY_FUSE_RADIUS_M : RADAR_MISSILE_PROXIMITY_FUSE_RADIUS_M)
  falloff    = lerp(1.0, PROXIMITY_DAMAGE_FALLOFF_MIN_FRAC, clamp(missDistanceM / fuseRadius, 0, 1))
  damageFrac = warheadFrac(kind) · falloff
```
then `applyHit(weapon, damageFrac, targetState, targetDamage, rng)` (§4.10), then push exactly one `hit` `SimEvent`; then, iff `kind !== 'bullet'`, `pushExplosionEvent(kind, impactPos, ownerId, outEvents)` (`EXPLOSION_RADIUS_MISSILE_M = 15`).

### 4.10 Subsystem damage roll

`applyHit`: `newStructurePct = clamp(oldStructurePct − damageFrac, 0, 1)`; `targetState.hp = round(newStructurePct · 100)`; `lethal = newStructurePct <= 0` (equivalently `hp <= 0`). Then draws `u = nextFloat01(rng)` (one mulberry32 step) and calls `subsystemHitFromU01(u)`, walking `SUBSYSTEM_HIT_WEIGHT` in this **fixed cumulative order**:

| cumulative range | `SubsystemHitKind` | weight |
|---|---|---|
| `[0.00, 0.40)` | `structure_only` | 0.40 |
| `[0.40, 0.55)` | `engine` | 0.15 |
| `[0.55, 0.6167)` | `elevon_l` | 0.0667 |
| `[0.6167, 0.6834)` | `elevon_r` | 0.0667 |
| `[0.6834, 0.75)` | `rudder` | 0.0666 |
| `[0.75, 0.85)` | `fuel` | 0.10 |
| `[0.85, 0.90)` | `radar` | 0.05 |
| `[0.90, 0.95)` | `gear` | 0.05 |
| `[0.95, 1.00)` | `hydraulics` | 0.05 |

Effect of the rolled subsystem (all beyond the flat `structurePct` reduction already applied above): `engine`/`radar`/`gear` ⇒ that `DamageState` field `-= damageFrac · SUBSYSTEM_DAMAGE_EXTRA_MULT(2.0)`, clamped `[0,1]`. `elevon_l`/`elevon_r`/`rudder` ⇒ the matching `controlSurfaces.*` field, same formula. `fuel` ⇒ `fuelLeak = true` (boolean, single-point failure). `hydraulics` ⇒ `hydraulicsOk = false` (boolean, single-point failure). `structure_only` ⇒ no further field changes.

### 4.11 RWR — missile-inbound warning

For every live hostile (`team !== observer.team`) `DetectableEntity` with `kind === 'missile'`, straight-line-extrapolate its closest approach to the observer:

```
toObserver = observerPos − missilePos
t_ca = dot(toObserver, missileVel) / dot(missileVel, missileVel)      // time of closest approach, extrapolated
if t_ca < 0 || t_ca > RWR_MISSILE_THREAT_TIME_SEC(12): not a threat
missDistance = |toObserver − missileVel · t_ca|
isThreat = missDistance <= RWR_MISSILE_THREAT_RADIUS_M(200)
```

`state.missileInboundWarning = ` OR of `isThreat` over all hostile missiles. **Worked example**: `observerPos=(0,0,0)`, `missilePos=(3000,0,0)`, `missileVel=(−400,0,0)` (closing straight on): `toObserver=(−3000,0,0)`, `t_ca = 1200000/160000 = 7.5 s` (`≤ 12` ✓), `missDistance = 0` (`≤ 200` ✓) ⇒ **threat = true**, 7.5 s to impact.

`state.rwrWarning = ` true iff any hostile `DetectableEntity.radarEmission` has `trackedTargetId === observerId || lockedTargetId === observerId` (populated by `src/core` from that aircraft's own `WeaponsState` — see contract §9's `DetectableEntity.radarEmission` doc comment). Both booleans push a `warning` `SimEvent` (`bit = WarningBit.MissileLaunch` / `WarningBit.MissileLock`) on their rising **and** falling edge (`active: true`/`false`).

## 5. Data

All constants below are `export const` in `contracts/combat.ts` — this table exists for justification/units, the `.ts` file is the source of truth for values.

### 5.1 General

| constant | value | units | justification |
|---|---|---|---|
| `MAX_PROJECTILES` | 128 | count | Bullets+missiles subset of core.ts's `MAX_ENTITIES=400` shared budget. |
| `MAX_SPAWN_REQUESTS_PER_TICK` | 4 | count | Generous headroom above the gun's own <1 round/tick steady-state rate. |
| `SUBSYSTEM_DAMAGE_EXTRA_MULT` | 2.0 | — | Design choice: a "called shot" subsystem takes double the raw hit fraction. |
| `DEFAULT_AIRCRAFT_HIT_ELLIPSOID_M` | (6.6, 2.2, 4.1) | m | Half of Tejas Mk1 length (~13.2 m) / height incl. fin (~4.4 m) / span (~8.2 m). |
| `DEFAULT_AIRCRAFT_RCS_NOSE_ON_M2` / `BROADSIDE_M2` | 2.0 / 6.0 | m² | Generic small single-engine delta-fighter approximation (public RCS data for the Tejas is not published — see §9). |
| `EXPLOSION_RADIUS_MISSILE_M` | 15 | m | Render-facing FX radius, not a damage falloff radius (damage falloff uses the fuse radius, §4.9). |
| `EXPLOSION_RADIUS_AIRCRAFT_KILL_M` | 25 | m | Larger FX radius for a full aircraft kill (consumed by `src/core`/`src/render`, not this module). |
| `PROXIMITY_DAMAGE_FALLOFF_MIN_FRAC` | 0.35 | — | Floor fraction of warhead damage at the fuse radius edge. |

### 5.2 Gun (23 mm GSh-23)

| constant | value | units |
|---|---|---|
| `GUN_ROF_ROUNDS_PER_MIN` | 3400 | rounds/min |
| `GUN_ROUND_INTERVAL_SEC` | 0.017647 | s |
| `GUN_MUZZLE_VELOCITY_MPS` | 715 | m/s |
| `GUN_ROUND_MASS_KG` | 0.19 | kg |
| `GUN_ROUND_DIAMETER_M` | 0.023 | m |
| `GUN_ROUND_DRAG_COEFF` | 0.30 | — |
| `GUN_ROUND_CROSS_SECTION_M2` | 4.1548e-4 | m² |
| `GUN_MAX_AMMO_ROUNDS` | 220 | rounds |
| `GUN_DISPERSION_MRAD` | 2.0 | mrad |
| `GUN_HIT_DAMAGE_FRAC` | 0.04 | fraction of structurePct |
| `GUN_BULLET_MAX_LIFETIME_SEC` | 3.0 | s |
| `GUN_ARM_DISTANCE_M` | 5.0 | m |

### 5.3 IR missile (R-73-like)

| constant | value | units |
|---|---|---|
| `IR_MISSILE_MASS_KG` | 105 | kg |
| `IR_MISSILE_DIAMETER_M` | 0.17 | m |
| `IR_MISSILE_DRAG_COEFF` | 0.25 | — |
| `IR_MISSILE_CROSS_SECTION_M2` | 0.0227 | m² |
| `IR_MOTOR_BURN_TIME_SEC` | 2.5 | s |
| `IR_MOTOR_THRUST_N` | 20000 | N |
| `IR_PN_GAIN` | 3.5 | — |
| `IR_MAX_G` | 35 | g |
| `IR_SEEKER_ACQUIRE_HALF_ANGLE_RAD` | 0.035 (~2°) | rad |
| `IR_SEEKER_TRACK_HALF_ANGLE_RAD` | 0.698 (~40°) | rad |
| `IR_SEEKER_GIMBAL_RATE_MAX_RAD_S` | 12.0 | rad/s |
| `IR_LOCK_TIME_SEC` | 1.0 | s |
| `IR_MIN_LAUNCH_RANGE_M` | 300 | m |
| `IR_BASE_DETECT_RANGE_TAIL_ON_M` | 8000 | m |
| `IR_BASE_DETECT_RANGE_HEAD_ON_M` | 2000 | m |
| `IR_AFTERBURNER_RANGE_MULT` | 1.5 | — |
| `IR_PROXIMITY_FUSE_RADIUS_M` | 8 | m |
| `IR_ARM_DISTANCE_M` | 50 | m |
| `IR_MAX_FLIGHT_TIME_SEC` | 25 | s |
| `IR_WARHEAD_DAMAGE_FRAC` | 0.6 | fraction |
| `IR_MAX_AMMO_MISSILES` | 4 | count |
| `IR_EJECTION_SPEED_MPS` | 25 | m/s |

### 5.4 Radar model

| constant | value | units |
|---|---|---|
| `RADAR_REFERENCE_RANGE_M` | 80000 | m |
| `RADAR_REFERENCE_RCS_M2` | 5.0 | m² |
| `RADAR_MAX_RANGE_M` | 100000 | m |
| `RADAR_SCAN_AZ_HALF_ANGLE_RAD` | 1.047 (60°) | rad |
| `RADAR_SCAN_EL_HALF_ANGLE_RAD` | 0.524 (30°) | rad |
| `RADAR_TRACK_HALF_ANGLE_RAD` | 0.175 (10°) | rad |
| `RADAR_LOCK_TIME_SEC` | 3.0 | s |
| `RADAR_LOCK_BREAK_GRACE_SEC` | 1.5 | s |
| `RADAR_NOTCH_CLOSURE_MPS` | 15 | m/s |
| `RADAR_NOTCH_MAX_RANGE_M` | 20000 | m |
| `RADAR_LOS_SAMPLE_COUNT` | 3 | count |
| `TERRAIN_LOS_MASK_MARGIN_M` | 15 | m |

### 5.5 Radar missile (Derby-like)

| constant | value | units |
|---|---|---|
| `RADAR_MISSILE_MASS_KG` | 118 | kg |
| `RADAR_MISSILE_DIAMETER_M` | 0.20 | m |
| `RADAR_MISSILE_DRAG_COEFF` | 0.28 | — |
| `RADAR_MISSILE_CROSS_SECTION_M2` | 0.031416 | m² |
| `RADAR_MISSILE_MOTOR_BURN_TIME_SEC` | 4.0 | s |
| `RADAR_MISSILE_MOTOR_THRUST_N` | 25000 | N |
| `RADAR_MISSILE_PN_GAIN` | 4.0 | — |
| `RADAR_MISSILE_MAX_G` | 30 | g |
| `RADAR_MISSILE_MAX_RANGE_M` | 50000 | m |
| `RADAR_MISSILE_ACTIVE_SEEKER_RANGE_M` | 12000 | m |
| `RADAR_MISSILE_ACTIVE_SEEKER_HALF_ANGLE_RAD` | 0.349 (20°) | rad |
| `RADAR_MISSILE_MAX_FLIGHT_TIME_SEC` | 60 | s |
| `RADAR_MISSILE_PROXIMITY_FUSE_RADIUS_M` | 10 | m |
| `RADAR_MISSILE_ARM_DISTANCE_M` | 100 | m |
| `RADAR_MISSILE_WARHEAD_DAMAGE_FRAC` | 0.65 | fraction |
| `RADAR_MISSILE_G_SATURATION_LOST_SEC` | 2.0 | s |
| `RADAR_MISSILE_MAX_AMMO` | 4 | count |
| `RADAR_MISSILE_EJECTION_SPEED_MPS` | 25 | m/s |

### 5.6 RWR / visual / threat scoring

| constant | value | units |
|---|---|---|
| `RWR_MISSILE_THREAT_RADIUS_M` | 200 | m |
| `RWR_MISSILE_THREAT_TIME_SEC` | 12 | s |
| `VISUAL_DETECT_RANGE_M` | 8000 | m |
| `VISUAL_FOV_HALF_ANGLE_RAD` | 1.5708 (90°) | rad |
| `VISUAL_IFF_CONFIRM_RANGE_M` | 3000 | m |
| `THREAT_SCORE_WEIGHTS` | `{range:.4,aspect:.2,targetingMe:.3,closure:.1}` | — |
| `LEAD_SOLVE_MAX_ITERATIONS` | 5 | count |
| `LEAD_SOLVE_MAX_RANGE_M` | 3000 | m |

## 6. Performance budget

- **Allocations**: zero in `updateSensors`, `fireWeapons`, `stepProjectile`, `applyHit`, `segmentHitsEllipsoid`, `closestApproachOnSegment`, `computeLeadSolution`, `resolveProjectileHit` — every one mutates a caller-owned `out`/state object or pushes into a caller-cleared/reused array (this file's header convention). The only allocations in this module are the one-time pool factories (`createProjectilePool`, `createWeaponsState`) called at mission/aircraft init, never per-tick.
- **Per-tick cost** (120 Hz sim tick, worst case: 2 aircraft, each with up to ~12 live contacts and up to `MAX_PROJECTILES` live projectiles): `updateSensors` is O(entities) per observer with a fixed small per-contact cost (a few dot products + up to 3 `heightAt` calls only for candidates that already passed the range/cone test, not all entities) — budget **≤ 0.15 ms** per observer aircraft. `fireWeapons` is O(1) per aircraft. `stepProjectile` is O(candidates) per projectile (ellipsoid/closest-approach tests only run once armed) — budget **≤ 0.05 ms** per live projectile. On a mid-tier mobile CPU (quality tier "Medium", architecture §14) with 2 aircraft and ~20 live projectiles in a furball, total combat-module cost per 8.33 ms tick should stay **≤ 1.5 ms**, leaving headroom for physics/AI/terrain in the same sim-worker tick.
- **Mobile**: this module does no rendering and is quality-tier-agnostic by design (architecture §14: quality tier never changes sim behaviour) — its cost is identical on every device; the only mobile-relevant lever is `MAX_PROJECTILES`, which is a fixed constant here, not tier-scaled (a future tier-scaled cap, if ever needed, belongs to `src/core`'s spawn-request throttling, not this module).
- `HeightSampler.heightAt` calls are the single most expensive operation this module performs (terrain-LOS masking, terrain-impact check); both call sites cap the count per invocation (3 for LOS masking, 1 for terrain-impact) rather than ray-marching.

## 7. Unit tests to write

All paths under `tests/combat/`, mirroring `src/combat/<file>.ts` per architecture §13's naming convention.

- **`tests/combat/proportionalNavigation.test.ts`**: given the §4.7 worked example inputs (`gain = IR_PN_GAIN = 3.5`, `maxAccelMps2 = IR_MAX_G · 9.80665`), `computePnAccel(...)` returns `out` within `1e-2` of `(−3.874, 0, 15.505)`; `|out|` within `1e-2` of `15.98`. Also: a target receding faster than the missile approaches (`Vc <= 0`) returns `out = (0,0,0)` (PN is undefined/zeroed when not closing — assert this explicitly, it's the clamp edge case).
- **`tests/combat/leadComputingSight.test.ts`**: §4.3's worked example — `computeLeadSolution(...)` returns `valid === true`, `outAimPointWorld` within `0.05` m of `(1000, 9.638, 70.10)`, `timeOfFlightSec` within `1e-4` of `1.40203`. Second case: `targetVel` set to `(2000,0,0)` (target outrunning a slower simulated `muzzleVelocityMps=100`) asserts `valid === false`.
- **`tests/combat/radarModel.test.ts`**: `radarDetectionRangeM(2.0)` within `5` m of `63624`; `radarDetectionRangeM(6.0)` within `5` m of `83730`; `radarDetectionRangeM(5.0) === 80000` exactly. §4.4's scan-cone worked example: `azRad` within `1e-4` of `0.1974`, `inScanCone === true`, `inTrackCone === false`.
- **`tests/combat/irMissileSeeker.test.ts`**: `irDetectionRangeM(0, false) === 8000`; `irDetectionRangeM(Math.PI, false) === 2000`; `irDetectionRangeM(Math.PI/2, false) === 5000`; `irDetectionRangeM(Math.PI/2, true) === 7500`.
- **`tests/combat/hitDetection.test.ts`**: §4.9's worked example — `segmentHitsEllipsoid(...)` returns `hit === true`, `tEntry` within `1e-3` of `0.4589`. A parallel segment offset by `z=10` (outside the `4.1` semi-axis) returns `hit === false`. `closestApproachOnSegment((0,0,-50),(0,0,50),(3,0,0))` returns exactly `3` (perpendicular offset, midpoint of the segment is the closest point).
- **`tests/combat/subsystemDamage.test.ts`**: boundary table from §4.10 — `subsystemHitFromU01(0)` = `'structure_only'`, `subsystemHitFromU01(0.399)` = `'structure_only'`, `subsystemHitFromU01(0.40)` = `'engine'`, `subsystemHitFromU01(0.5499)` = `'engine'`, `subsystemHitFromU01(0.55)` = `'elevon_l'`, `subsystemHitFromU01(0.9999)` = `'hydraulics'`. Statistical: 100 000 calls to `rollSubsystemHit` with a real `CombatRngState`, empirical frequency of each `SubsystemHitKind` within `0.01` (absolute) of its `SUBSYSTEM_HIT_WEIGHT`. `applyHit('gun', 0.04, state, damage, rng)` on a full-health target: `damage.structurePct` within `1e-9` of `0.96`, `state.hp === 96`, `result.lethal === false`. 25 successive `applyHit` calls with `damageFrac=0.04` bring `structurePct` to `<= 0` and the 25th call's `result.lethal === true`.
- **`tests/combat/gunBallistics.test.ts`**: a bullet fired horizontally (`vel=(715,0,0)`, `env.airDensityKgM3=1.225`, `env.gravityMps2=9.80665`) for exactly `1.0` s of `stepProjectile` calls at `dtSec=1/120`: resulting `pos.y` is negative (has dropped) and within `5%` of the vacuum-drop reference `−0.5·9.80665·1² = −4.903` (drag reduces horizontal but not the gravity term, so this is a loose bound, not an exact match — assert `pos.y` is in `[−5.5, −4.5]`). `distanceTravelledM` after that same 1.0 s is `> GUN_ARM_DISTANCE_M`. A bullet run for `GUN_BULLET_MAX_LIFETIME_SEC + dtSec` returns `outcome === 'expired'` on its final call. Owner exclusion: a bullet spawned with `posWorld` inside `ownerId`'s own `DEFAULT_AIRCRAFT_HIT_ELLIPSOID_M` and `candidates` containing `ownerId` never returns `outcome === 'direct_hit'` against `ownerId` on any tick of its flight, even before `GUN_ARM_DISTANCE_M` is reached (an unarmed bullet is simply `'flying'`, never a hit on ANY candidate including the owner). The equivalent fixture in `tests/combat/irMissileSeeker.test.ts` and `tests/combat/radarMissile.test.ts` (a missile spawned with `posWorld` inside `ownerId`'s ellipsoid) likewise never returns `'direct_hit'`/`'proximity_detonation'` against `ownerId` at any tick, including the unarmed segment immediately after launch.
- **`tests/combat/radarMissile.test.ts`**: a `radar_missile` `ProjectileState` with `targetId` pointing at a candidate `12001` m away has `guidance === 'radar_datalink'` after one `stepProjectile` call; moved to `11999` m with the target within the active-seeker cone, `guidance === 'radar_active'`.
- **`tests/combat/weaponStation.test.ts`**: `createWeaponsState` with a loadout of `{gun: 220 rounds}` produces `state.stations[0].count === 220`. 120 consecutive `fireWeapons` calls (1.0 s at 120 Hz) with `inputs.trigger = true` produce close to `1.0 / GUN_ROUND_INTERVAL_SEC ≈ 56.67` ⇒ between `55` and `57` `gunFire` events pushed in total, and `state.stations[0].count` decremented by the same count.
- **`tests/combat/hitDetection_rwr.test.ts`** (RWR half of `radarModel.ts`): §4.11's worked example reproduced exactly — `t_ca` within `1e-6` of `7.5`, `missDistance === 0`, resulting `missileInboundWarning === true`.

## 8. Acceptance criteria

1. `contracts/combat.ts` compiles standalone via `tsc --noEmit --strict --noUncheckedIndexedAccess` with zero external imports besides `./core` (mechanically verified in this drafting session: `tsc --noEmit --strict --noUncheckedIndexedAccess contracts/core.ts contracts/combat.ts` exits 0).
2. Every function type exported from `contracts/combat.ts` has a full JSDoc comment stating: what it mutates, what it may allocate (always "nothing"), and — for every function `src/core` calls directly per §3.1 — exactly when in the per-tick order it is called.
3. All eleven numeric worked examples in §4 (PN accel, lead solution, radar range ×3, scan-cone az/el, ellipsoid hit, RWR closest-approach, IR detection range ×4) are reproduced as passing tests per §7, each within the stated tolerance.
4. `SUBSYSTEM_HIT_WEIGHT`'s nine values sum to exactly `1.0` (±`1e-9`) — assert this as its own tiny test, not just the statistical one.
5. No function listed in §3 contains a `for`/`while` loop over anything unbounded by a fixed constant from §5 (`MAX_PROJECTILES`, `RADAR_LOS_SAMPLE_COUNT`, `LEAD_SOLVE_MAX_ITERATIONS`) or by a caller-supplied, already-bounded array (`candidates`, `allEntities`) — grep-checkable.
6. A full engagement integration test (owned by module 12, using this module's real implementation once built): player fires a locked IR missile at a non-maneuvering target 2000 m away with closing geometry; the missile achieves `outcome === 'direct_hit'` or `'proximity_detonation'` within `IR_MAX_FLIGHT_TIME_SEC`, and the target's `DamageState.structurePct` decreases by at least `IR_WARHEAD_DAMAGE_FRAC · PROXIMITY_DAMAGE_FALLOFF_MIN_FRAC`.
7. Firing the gun for exactly 5 continuous seconds with unlimited ammo produces a round count within `±2` of `5 / GUN_ROUND_INTERVAL_SEC ≈ 283`.
8. Every `SimEvent` this module can produce (`gunFire`, `missileLaunch`, `hit`, `explosion`, `lockAcquired`, `lockLost`, `warning`) is exercised by at least one test in §7 or the integration test in item 6.

## 9. Open assumptions

Public engineering data for the Tejas Mk1's actual gun/missile/radar fit and performance is sparse/classified, and several shapes needed by this module are not pinned by `core.ts` or by 00-architecture.md §9 (which only pins `AircraftDefinition`/`stepAircraft`, `AirportFlattenZone`, and the two built-in airport file paths — nothing about weapons/radar/damage geometry). Every approximation below follows architecture §8's fallback rule ("use the most conservative structural subset you can... and note the assumption"):

1. **No `Hardpoint` import from `contracts/aircraft.ts`.** Per this workflow's explicit instruction, `contracts/combat.ts` imports only from `./core`. `WeaponStationSpec` therefore carries `hardpointId`/`posBodyM`/`weapon` as plain fields rather than importing `aircraft.ts`'s `Hardpoint` interface (which 00-architecture.md §9.1 does pin exactly, so the two shapes are structurally compatible even though not literally shared) — `src/core` passes these fields through from the real `AircraftDefinition.hardpoints` it already has.
2. **Default RCS and hit-ellipsoid values** (`DEFAULT_AIRCRAFT_RCS_*_M2`, `DEFAULT_AIRCRAFT_HIT_ELLIPSOID_M`) are this module's own estimates (§5.1), used whenever a `DetectableEntity` doesn't carry `radarSignature`/`hitEllipsoidBodyM` — i.e. this module works correctly even if `src/core` never wires real per-aircraft values from module 03's `AircraftDefinition` (which has no RCS field in the section 9.1-pinned skeleton, and no hit-geometry field beyond the wireframe mesh itself).
3. **GSh-23 fitment**: the brief specifies "23 mm GSh-23"; the real Tejas Mk1's internal gun is a different 23 mm twin-barrel type, but ballistic parameters for both are similar enough that this is a non-issue for a placeholder-wireframe sim — GSh-23 published muzzle velocity/ROF are used as given.
4. **Radar performance numbers** (`RADAR_REFERENCE_RANGE_M` etc.) are a plausible order-of-magnitude estimate for a modern fighter-mounted AESA/mechanically-scanned radar against a 5 m² target, not sourced from any specific published Tejas radar (EL/M-2032 or Uttam AESA) spec sheet.
5. **Radar missile "datalink"** (§4.6.1) is modeled as perfect target-state knowledge while beyond `RADAR_MISSILE_ACTIVE_SEEKER_RANGE_M`, gated purely on the target still being alive and findable in `candidates` — it does **not** check whether the shooter aircraft itself is still alive or still locked, because `stepProjectile` has no visibility into another aircraft's private `WeaponsState` under this project's dependency graph (leaf modules never reach across aircraft; see 00-architecture.md §10). A real implementation extension (not required by this spec) could have `src/core` pass a `datalinkActive: boolean` into `stepProjectile` by reading the shooter's own `WeaponsState`, since `src/core` — uniquely — can see both.
6. **IR seeker acquisition is boresight-only** (`IR_SEEKER_ACQUIRE_HALF_ANGLE_RAD = 2°`) rather than modeling a separate helmet-mounted-sight (HMS) cueing system for high-off-boresight acquisition (a real R-73 pairing) — no HMS module exists anywhere in this project's twelve-module scope, so acquisition is boresight-narrow and track (post-lock) is wide (`40°`), which is the closest reasonable approximation without inventing a thirteenth module.
7. **`computeLeadSolution` and the `SnapshotHud` block — RESOLVED.** An earlier drafting pass of this document flagged that `core.ts`'s `SnapshotHud` had no field for a computed aim point, forcing `src/hud` to re-derive its own (inevitably drifting) ballistics approximation. This has since been fixed at the architecture level: `core.ts`'s `CombatStatus` now carries `aimPointWorld`/`aimPointValid` (populated by this module's `WeaponsState`, §4.3), and `core.ts`'s `SnapshotHud` now carries four additional floats, `PIPPER_X/Y/Z/VALID` (`HUD_BLOCK_FLOATS` is 27, not 23), which `src/core` fills from `CombatStatus.aimPointWorld`/`aimPointValid` every emitted snapshot (10-core-worker.md §4.8). `src/hud` now reads the wire-format pipper directly and no longer needs `GUN_MUZZLE_VELOCITY_MPS` or any ballistics formula of its own — see `contracts/render.ts`'s `GUN_MUZZLE_VELOCITY_MPS`, which is kept only as a fixed, matching (715 m/s) reference value for documentation/tests, not as an independent computation. This module's own `GUN_MUZZLE_VELOCITY_MPS` (§5, `= 715`) remains the single value `computeLeadSolution` is actually evaluated with.
8. **No per-hardpoint damage.** `DamageState` (core.ts) has no per-station/per-hardpoint health field, so a hit can disable `controlSurfaces`/`engineHealthPct`/etc. but never "destroys station 3's missile before launch" — a station's `count` only ever decreases via `fireWeapons` consuming ammo, never via battle damage. Noted as a deliberate non-goal given the frozen `DamageState` shape.
9. **Friendly fire is mechanically possible** (§4.9: hit/fuse tests run against every candidate, not team-filtered) by design — this module is mechanism, not rules-of-engagement; module 06 (AI) is expected to avoid firing at friendlies through its own targeting logic, not through any restriction here.
10. **`env.airDensityKgM3` duplication vs. `contracts/flight.ts`'s `Environment`**: `CombatEnvironment` (this module) is structurally identical to `flight.ts`'s `Environment` but is declared independently rather than imported, per this file's "only `./core`" import rule (00-architecture.md §9.1 mandates the *one* cross-leaf contract import, `flight.ts → aircraft.ts`; it does not mandate `combat.ts → flight.ts`, and architecture §8 says to keep such imports rare). `src/core` is expected to compute both from the same underlying ISA formula so the two never silently diverge, but this spec cannot enforce that mechanically across module boundaries.
