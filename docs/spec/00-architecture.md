# 00 — Architecture (HAL Tejas Mk1 Web Flight Simulator)

**Read this document first, then `docs/spec/contracts/core.ts`, then your own module spec + contract file. Nothing else.**
This document is normative. Where a later module spec appears to disagree with this document or with `contracts/core.ts`, this document and `core.ts` win. If you are drafting or implementing a module and something here seems to conflict with your module's brief, follow this document and flag the conflict in your spec's "Open assumptions" section rather than silently deviating.

## 1. Purpose & scope

We are building a browser-based, real-physics flight simulator of the HAL Tejas Mk1 (tailless cranked-delta, relaxed-static-stability, digital fly-by-wire fighter), with procedural terrain, custom airport layouts, a placeholder wireframe aircraft model, and aerial-combat AI that plays under the same physics as the human. The project is built in a **single parallel pass**: after this document and `contracts/core.ts` are finalized, up to twelve implementer agents each build exactly one module, at the same time, each reading only (a) this document, (b) `contracts/core.ts`, and (c) their own module's spec + contract file. They cannot see each other's code. The only things that make their independent work fit together at integration time are:

1. This document (topology, conventions, file ownership, build order, coding rules).
2. `contracts/core.ts` (shared data shapes every module can `import type` from).
3. Each module's own contract file (`contracts/<name>.ts`), which is the literal, compilable TypeScript surface that module must implement exactly.

There is no fourth mechanism. Anything one module needs from another that is not nailed down in one of the three items above **will** cause an integration failure. Section 9 ("Cross-module data contracts") exists specifically to close the small number of gaps where two non-adjacent modules must agree on a shape that isn't naturally "core".

## 2. Fixed technology decisions (restated precisely, non-negotiable)

- **Language**: TypeScript, `strict: true`, compiled by Vite 5. See section 13 for the exact `tsconfig.json`.
- **Renderer**: Three.js (r16x line), used **only** as a renderer on the main thread (scene graph, camera, materials, line/triangle geometry upload). It never touches simulation state directly and never runs off-main-thread.
- **No physics engine, no game framework.** All rigid-body dynamics, collision/contact (gear, terrain, hit detection) and integration are hand-written in `src/physics`, `src/terrain`, `src/combat`.
- **No UI framework.** Menus, HUD chrome, the airport editor: plain DOM (`src/ui`) and Canvas 2D (`src/hud`).
- **Testing**: vitest for unit/integration tests. No other test runner.
- **No other runtime dependencies.** The `dependencies` section of `package.json` contains exactly `three`. Everything else (noise functions, quaternion math, JSON schema validation, etc.) is hand-written. `devDependencies` may contain `typescript`, `vite`, `vitest`, `@types/three`, and `jsdom` (needed only so `vitest.config.ts` can run the small, explicitly-named subset of module 09/11's DOM-touching unit tests — `tests/input/playerPilot.test.ts`, `tests/ui/screens.test.ts`, `tests/ui/orientationPrompt.test.ts` — under a DOM environment per-file, via `environmentMatchGlobs`; every other test file in the project stays on vitest's default `node` environment, including every other `tests/input/**`/`tests/ui/**`/`tests/render/**`/`tests/hud/**` file, which are DOM-free by construction — see `12-verification.md` sections 2 and 4.10). Nothing else without a change to this document.
- **Concurrency model**: three JS execution contexts.
  1. **Main thread** — Three.js rendering, DOM UI, input capture, worker orchestration.
  2. **Sim worker** (`src/core/sim.worker.ts`) — physics, AI, combat, world/entity state, fixed 120 Hz step with an accumulator (section 5). Owns the single source of truth for simulation state.
  3. **Terrain worker** (`src/terrain/terrain.worker.ts`) — builds chunk geometry (positions/normals/indices) off the main thread. Height **sampling** (the pure `HeightSampler` in `core.ts`) is plain deterministic code with no worker/thread affinity: the exact same module runs identically inside the terrain worker, inside the sim worker (gear/AI terrain checks), on the main thread (camera collision, editor preview), and under Node in vitest.
- **Transport**: `postMessage` with **transferable `ArrayBuffer`s**. The sim worker emits one double/triple-buffered binary snapshot at 60 Hz (section 7); it does not emit per-entity JS objects every tick. `SharedArrayBuffer` is explicitly **not used** anywhere in this project (no cross-origin-isolation requirement).
- **DOM-free simulation code**: everything under `src/math`, `src/physics`, `src/aircraft`, `src/terrain` (except that module's worker bootstrap file itself, which still touches no DOM — workers have no DOM), `src/airport`, `src/ai`, `src/combat`, and `src/core` (except `src/main.ts`) must run under plain Node. This is mechanically enforced: `tools/sim-check.ts` (module 12) imports these modules under Node and vitest's default environment for these directories is `node` (not `jsdom`) — any accidental `window`/`document`/`localStorage` reference throws `ReferenceError` immediately. `src/render`, `src/hud`, `src/input`, `src/ui` are exempt (they are inherently browser-facing) but still must not be imported by anything in the DOM-free list (see section 10).
- **No allocation in hot paths.** A "hot path" is anything invoked once per sim tick (120 Hz) inside `src/physics`, `src/ai`, `src/combat`, `src/core`'s step loop, or once per rendered frame inside `src/render`/`src/hud`. Math types (`Vec3`, `Quat`, `Mat3`, from `contracts/math.ts`) are **mutable classes with `out` parameters**, never immutable value types returned by `+`/`*` operators. Entities, missiles, bullets, effects live in **pre-sized pools** (`MAX_ENTITIES` and friends, `core.ts` section 11) allocated once at init. No `.map`/`.filter`/`.slice`/`.concat`/spread/`new`/closures-that-capture inside a hot path; use indexed `for` loops and scratch objects reused across calls.
- **Units**: SI everywhere in runtime code — metres, kilograms, seconds, Newtons, radians. Degrees appear **only** in data tables and UI display code, and any field holding degrees is suffixed `Deg` (e.g. `stallAoaDeg` in a data table) so it can never be silently used as radians. `core.ts`'s `GRAVITY_MPS2 = 9.80665` applied along world **-Y**.
- **Determinism**: given the same seed (`WorldConfig.seed`/`Mission.world.seed`) and the same recorded input stream, the sim produces bit-for-bit-reproducible state. This is required for replay and for `tools/sim-check.ts`'s trim/regression tests. The one and only PRNG is `mulberry32` in `src/math` (contract: `contracts/math.ts`, module 01). **`Math.random()` is forbidden** anywhere under `src/math`, `src/physics`, `src/aircraft`, `src/terrain`, `src/airport`, `src/ai`, `src/combat`, `src/core`. It is permitted only in `src/render`, `src/hud`, `src/ui`, `src/input` for purely cosmetic effects that never feed back into simulation state (e.g. a particle's visual jitter) — and even there, prefer the seeded PRNG if the effect should be replay-stable.

## 3. Coordinate frames and sign conventions

This section is the single source of truth. `contracts/core.ts`'s file-header comment is a terse restatement of exactly this; if you find a discrepancy, this document wins and it is a bug in `core.ts` to be raised, not a license to pick either one.

### 3.1 World frame

Right-handed, **+Y up**, **+X east**, **-Z north** (so **+Z is south**). Check: X × Y = Z (east × up = south), which is the standard right-hand rule — confirms the frame is right-handed as required.

**Heading** (compass heading, used for spawn orientation, AI navigation, HUD): 0 rad = north, +π/2 rad = east, increasing **clockwise** viewed from above (from +Y looking down the -Y axis) — i.e. ordinary compass behaviour: north → east → south → west.

```
forwardWorld(heading) = ( sin(heading), 0, -cos(heading) )
```
Check: `heading=0` → `(0,0,-1)` = north ✓. `heading=π/2` → `(1,0,0)` = east ✓. `heading=π` → `(0,0,1)` = south ✓.

World Y = 0 is defined as **mean sea level (MSL)** for the active `WorldConfig`; `AircraftTelemetry.altMslM` is simply the entity's world-space `pos.y` (terrain height and airport elevations are also expressed in this same absolute MSL frame — see `HeightSampler.heightAt` and `AirportInfo.elevationM` in `core.ts`).

### 3.2 Body frame

**+X forward** (nose), **+Y up** (canopy), **+Z right** (starboard wing). Right-handed (X × Y = Z). This is a **Y-up body frame**, not the classical Z-down aerospace body frame — every module must use accessors (section 3.4), never assume textbook NED body-axis formulas transfer unchanged.

Body → world rotation is the entity's quaternion `rot` (also called `q` in formulas): for any body-frame vector `v_b`, its world-frame representation is

```
v_w = q * v_b * conj(q)
```

`Quat.rotate(q, v_b, out)` in `contracts/math.ts` performs this; `Quat.rotateInverse(q, v_w, out)` (= `conj(q) * v_w * q`) performs world→body and is used for airspeed/alpha/beta below.

### 3.3 Euler angles ↔ quaternion (display, spawn orientation)

Composition order and per-axis definitions (this is the **only** legal way to build or decompose a yaw/pitch/roll orientation anywhere in this project):

```
qYaw   = axisAngle( worldY = (0,1,0),  angle = PI/2 - headingRad )
qPitch = axisAngle( bodyZ  = (0,0,1),  angle = pitchRad  )   // +pitch = nose UP
qRoll  = axisAngle( bodyX  = (1,0,0),  angle = rollRad   )   // +roll  = right wing DOWN
q = qYaw ⊗ qPitch ⊗ qRoll        // Hamilton product, qYaw applied outermost
```
where `axisAngle(axis, angle) = (axis.x*sin(angle/2), axis.y*sin(angle/2), axis.z*sin(angle/2), cos(angle/2))` and `⊗` is Hamilton quaternion multiplication (`a⊗b`: `w=aw*bw-ax*bx-ay*by-az*bz`, `x=aw*bx+ax*bw+ay*bz-az*by`, `y=aw*by-ax*bz+ay*bw+az*bx`, `z=aw*bz+ax*by-ay*bx+az*bw`).

`pitchRad` is measured about the **body** Z axis and `rollRad` about the **body** X axis (i.e. these are applied as *intrinsic* rotations, in the aircraft's own rotating frame, which is exactly what the right-multiplication by `qPitch` then `qRoll` achieves — do not re-derive `qPitch`/`qRoll` in world coordinates first).

**Why `PI/2 - headingRad` and not `headingRad`?** Body-forward is world **+X** when unrotated, but heading-zero means world **-Z** (north). The 90° reference offset between "east" (the body's own rest axis) and "north" (the heading reference) is unavoidable given both conventions are fixed by this document, and it is baked into `qYaw`'s formula so nobody has to re-derive it. `contracts/math.ts` (module 01) must implement this exact formula as `Quat.fromYawPitchRoll(headingRad, pitchRad, rollRad, out)`, and its inverse as `Quat.toYawPitchRoll(q, out: {headingRad,pitchRad,rollRad})`.

#### Worked example A — sanity check (identity quaternion)

`heading = PI/2` (due east), `pitch = 0`, `roll = 0`:
`qYaw`: angle `= PI/2 - PI/2 = 0` → `qYaw = (0,0,0,1)` (identity). `qPitch = qRoll = (0,0,0,1)`. So **`q = (0,0,0,1)`** — flying due east with wings level and no pitch is the identity orientation (body axes exactly aligned with world axes: nose→+X/east, canopy→+Y/up, right wing→+Z/south). Use this as a unit-test fixture in `tests/math/quat.test.ts` (module 12): `fromYawPitchRoll(Math.PI/2, 0, 0)` must equal `(0,0,0,1)` within `1e-9`.

#### Worked example B — composed rotation

`heading = 0` (due north), `pitch = 15° = 0.2617994 rad`, `roll = 0`:

```
qYaw   = axisAngle(Y, PI/2 - 0)        = (0, 0.7071068, 0, 0.7071068)
qPitch = axisAngle(Z, 0.2617994)       = (0, 0, 0.1305262, 0.9914448)
qRoll  = identity
q = qYaw ⊗ qPitch = (x:0.092296, y:0.701057, z:0.092296, w:0.701057)   (‖q‖ = 1)
```

Rotating body-forward `(1,0,0)` by this `q` gives `forwardWorld = (0, 0.258819, -0.965926)`, which equals `(0, sin(15°), -cos(15°))` exactly — nose pointing due north, tilted 15° above the horizon, as expected for zero heading + 15° nose-up + wings level. (Both `q` and `forwardWorld` above were verified numerically, not just derived by hand — see `tools/sim-check.ts`'s math fixtures.) Use this (tolerance `1e-6`) as a second fixture in `tests/math/quat.test.ts`.

### 3.4 Angular velocity — body rates and the aerodynamic p/q/r mapping

`EntityState.omega = (wx, wy, wz)` is **always body-frame**, rad/s, about body X, Y, Z respectively — this is what `src/physics` integrates and what `src/math`'s quaternion-derivative function consumes directly. It is **not** the same thing as the classical aerodynamic roll/pitch/yaw rate triple `(p, q, r)`, because this project's body frame is Y-up (canopy), not the textbook Z-down body frame. The mapping (derived from the right-hand rule on each axis; see rationale below) is:

| textbook symbol | meaning | formula | sign |
|---|---|---|---|
| `p` roll rate | + = right roll | `p = wx` | rotation about +X takes +Y(up) toward +Z(right wing) |
| `q` pitch rate | + = nose up | `q = wz` | rotation about +Z takes +X(nose) toward +Y(up) |
| `r` yaw rate | + = nose right | `r = -wy` | rotation about +Y takes +Z(right wing) toward +X(nose), i.e. nose LEFT, so `r = -wy` flips it to the textbook nose-right-positive sign |

`contracts/math.ts` (module 01) must export exactly these three named accessors and every module that needs a body rate calls them — nobody reads `omega.y` inline and calls it "yaw rate":

```ts
export type BodyRateP = (omega: Vec3Like) => number; // = omega.x
export type BodyRateQ = (omega: Vec3Like) => number; // = omega.z
export type BodyRateR = (omega: Vec3Like) => number; // = -omega.y
```

### 3.5 Angle of attack and sideslip

Computed from the **airspeed** vector in body frame — aircraft velocity minus wind, then rotated world→body — never from raw ground velocity:

```
v_air_world = entity.vel - windWorldMps
v_air_body  = Quat.rotateInverse(entity.rot, v_air_world, scratch)
alpha = atan2( -v_air_body.y, v_air_body.x )   // + = air arriving from below (nose above velocity vector)
beta  = asin( v_air_body.z / |v_air_body| )    // + = air arriving from the right
```
`AircraftTelemetry.alphaRad`/`betaRad` in `core.ts` hold these; `src/physics` (module 02) computes them every tick and both `src/ai` (module 06, via `PilotContext.telemetry`) and `src/hud` (via the snapshot HUD block) read the same values — nobody recomputes alpha/beta independently.

### 3.6 Control inputs

`PilotInputs` (full shape in `core.ts`): `pitch`/`roll`/`yaw` ∈ `[-1,1]` with `+1 pitch` = stick full aft = nose-up command, `+1 roll` = roll right, `+1 yaw` = nose right; `throttle` ∈ `[0,1]` (0 = idle, 1 = full military, afterburner is a separate boolean only effective at `throttle === 1`).

## 4. Fixed-step loop & interpolation

`src/core`'s `sim.worker.ts` runs an **accumulator** loop:

```
const SIM_DT_SEC = 1 / SIM_HZ;       // 1/120, from core.ts
const SNAPSHOT_EVERY_N_TICKS = SIM_HZ / SNAPSHOT_HZ; // = 2, from core.ts
let accumulator = 0;
let tick = 0;
function onAnimationTick(realDtSec: number) {
  accumulator += Math.min(realDtSec, 0.25); // clamp to avoid a spiral of death after a tab is backgrounded
  while (accumulator >= SIM_DT_SEC) {
    stepWorld(SIM_DT_SEC);   // physics, AI, combat, all deterministic given (seed, input stream)
    accumulator -= SIM_DT_SEC;
    tick += 1;
  }
  if (tick % SNAPSHOT_EVERY_N_TICKS === 0) emitSnapshot(); // SIM_HZ/SNAPSHOT_HZ = 120/60 = 2
}
```

Workers have no `requestAnimationFrame`; `sim.worker.ts` drives its own clock with `setTimeout`/`performance.now()` at roughly `SIM_DT_SEC` granularity, always processing the **while** loop above so it catches up exactly rather than drifting — this is what makes the sim's tick rate independent of the host's actual callback jitter. Full detail (timer choice, catch-up cap) is module 10's to specify precisely in `10-core-worker.md`; the accumulator algorithm itself, and the 120/60 Hz relationship, are fixed here and must not change.

**Rendering interpolates.** The main thread receives snapshots at 60 Hz (`SNAPSHOT_HZ`) but the display may run at 120/144/240 Hz or be throttled to 30 Hz on low-end mobile. `src/render`'s `snapshotInterpolation.ts` (module 08) keeps the two most recent snapshots and linearly interpolates entity `pos` (lerp) and `rot` (nlerp/slerp) between them by the fraction of a snapshot-period elapsed since the newer one arrived, rendering slightly (≤ 1 snapshot period, ≤ ~17 ms) in the past. This is standard client-side interpolation; module 08's own spec finalizes extrapolation-vs-hold behavior for the first frame after a stall in snapshot delivery.

Quality tier **never** changes the sim's tick rate or determinism — only rendering-side cost (section 14).

## 5. Worker topology & message protocol

```
┌──────────────┐   MainToSimMessage      ┌───────────────┐
│              │ ───────────────────────▶│                │
│ Main thread  │                         │  sim.worker.ts │  (src/core, 120 Hz fixed step:
│ (src/main.ts,│   SimToMainMessage      │  physics+AI+   │   physics, AI, combat, entity pools)
│  src/render, │ ◀───────────────────────│  combat+core   │
│  src/hud,    │                         └───────────────┘
│  src/ui,     │   MainToTerrainMessage  ┌────────────────┐
│  src/input)  │ ───────────────────────▶│ terrain.worker │  (src/terrain: chunk geometry build)
│              │   TerrainToMainMessage  │      .ts       │
│              │ ◀───────────────────────│                │
└──────────────┘                         └────────────────┘
```

All four message flows are discriminated unions on a `type` string field, defined in `contracts/core.ts` section 13, reproduced here for reference (see `core.ts` for the authoritative, fully-commented version):

- **`MainToSimMessage`** = `SimInitMessage('init')` | `SimInputMessage('input')` | `SimCommandMessage('command')` | `SimReleaseBufferMessage('releaseBuffer')`.
  - `command` carries a `SimCommand` union: `spawn`, `reset`, `loadMission`, `setDifficulty`, `pause`.
- **`SimToMainMessage`** = `SimReadyMessage('ready')` | `SimSnapshotMessage('snapshot')` | `SimEventsMessage('events')`.
  - `snapshot.buffer` is **transferred** (not copied); layout is section 7 below.
- **`MainToTerrainMessage`** = `TerrainRequestChunkMessage('requestChunk')` | `TerrainCancelMessage('cancel')`.
- **`TerrainToMainMessage`** = `TerrainChunkReadyMessage('chunkReady')`, carrying three **transferred** `ArrayBuffer`s: `positions` (Float32Array xyz), `normals` (Float32Array xyz), `indices` (Uint32Array).

**Terrain-worker initialization handshake.** Unlike the sim worker (which has a pinned `SimInitMessage`/`SimReadyMessage` pair, above), core.ts's `MainToTerrainMessage`/`TerrainToMainMessage` unions carry no initialization message — the terrain worker still needs a `TerrainParams` + `AirportFlattenZone[]` before it can build the internal `HeightSampler` any `requestChunk` needs. `contracts/terrain.ts` (module 04) therefore extends both unions with its own `TerrainInitMessage('terrainInit')` / `TerrainReadyMessage('terrainReady')` pair (`MainToTerrainMessageExt`/`TerrainToMainMessageExt`). This is pinned here, centrally, exactly like the AircraftDefinition boundary in section 9, because module 10 (`src/core`'s main-thread terrain-worker wiring) is drafted blind to `contracts/terrain.ts` and would otherwise never learn this handshake exists: **`src/core`'s terrain-worker wiring code sends `TerrainInitMessage` as the terrain worker's FIRST message, before any `MainToTerrainMessage`, and must not send a `requestChunk` before receiving `TerrainReadyMessage` back** (a `requestChunk` received first is simply ignored by the terrain worker — no crash, no chunk). A quality-tier change that alters `chunkGridQuads` (contracts/terrain.ts's `QualityTerrainProfile`) re-sends a fresh `TerrainInitMessage` with the new value; module 10's spec gives the exact wiring code (10-core-worker.md section 4.9).

**Buffer lifecycle (no allocation in the sim worker's hot path):** the sim worker pre-allocates `SNAPSHOT_BUFFER_POOL_SIZE` (= 3) same-size `ArrayBuffer`s once at `init`. Each time it has a buffer available, it writes a snapshot into it and transfers it to main via `SimSnapshotMessage`. The main thread, once it has copied whatever it needs out of that buffer (typically immediately, into the interpolation double-buffer), transfers the **same `ArrayBuffer`** back via `SimReleaseBufferMessage`. If the pool is ever empty when a snapshot is due, the sim worker simply skips emitting that frame's snapshot (physics still steps on schedule) rather than allocating a new buffer — module 10's spec must implement this skip explicitly and module 12's acceptance tests must assert no allocation occurs in steady state (e.g. via a Node heap-snapshot-free timing test, or by asserting the pool never grows).

## 6. Snapshot binary layout

One `Float64Array`-backed `ArrayBuffer`, length `SNAPSHOT_FLOATS` floats (`SNAPSHOT_BYTES` bytes), transferred whole. All offsets below are **float indices** (`buffer[OFFSET]`), not byte offsets, and are exported as named constants from `core.ts` — no module may hardcode a numeric offset.

**Deliberate simplification vs. the literal "float64 player position / float32 relative others" idea floated in the project brief:** the sim worker's internal `EntityState.pos` is always a plain JS number (effectively float64) for every entity, at all times, in absolute world coordinates — this is what gives it unlimited precision regardless of how far the aircraft has flown from the origin. The snapshot buffer stores **all** entity positions the same way, as float64, uniformly. There is no mixed-precision wire format. The float32-precision concern from the brief is real, but it only matters for **Three.js's WebGL buffers**, which are always float32 internally regardless of what we hand them — so the conversion to a small, float32-safe, camera-relative number is `src/render`'s job at *consumption* time (see section 8, Floating origin), not something the wire protocol needs to encode. This keeps the protocol simple and uniform, per this document's mandate to "keep it simple and consistent."

```
Float64Array layout (index 0 .. SNAPSHOT_FLOATS-1):

[0 .. HEADER_FLOATS)                                              Header       (4 floats)
[HEADER_FLOATS .. HEADER_FLOATS + MAX_ENTITIES*ENTITY_STRIDE)      Entity blocks (400 × 26 = 10400 floats, fixed-size region)
[HUD_BLOCK_START .. SNAPSHOT_FLOATS)                                HUD block    (27 floats, for the player only)
```

### 6.1 Header (`SnapshotHeader`, `HEADER_FLOATS = 4`)

| offset constant | index | meaning |
|---|---|---|
| `TICK_OFFSET` | 0 | integer sim tick counter, increments by 1 every `SIM_DT_SEC` |
| `SIM_TIME_SEC_OFFSET` | 1 | seconds since sim start |
| `ENTITY_COUNT_OFFSET` | 2 | number of valid entity blocks that follow, `0..MAX_ENTITIES` |
| `PLAYER_INDEX_OFFSET` | 3 | index (`0..entityCount-1`) of the player's entity block, or `-1` |

The entity block region holds a **dense list** rebuilt every emitted snapshot (only alive/relevant entities, packed from index 0; this is a cheap copy loop over the live pool, not a reshuffle of the pool itself), **not** indexed by raw pool slot — `entityCount` tells the reader how many of the fixed `MAX_ENTITIES` blocks are meaningful this frame.

### 6.2 Entity block (`SnapshotEntity`, `ENTITY_STRIDE = 26` floats, repeated `MAX_ENTITIES = 400` times starting at `HEADER_FLOATS`)

Absolute float index of entity `i`'s field `F` = `entityFieldOffset(i, SnapshotEntity.F)` = `HEADER_FLOATS + i*ENTITY_STRIDE + F` (exported helper in `core.ts`; use it, don't recompute the arithmetic by hand).

| field | offset | unit / meaning |
|---|---|---|
| `ID` | 0 | `EntityId` (see `core.ts` §3 for pack/unpack) |
| `KIND` | 1 | `EntityKindCode`: 0=aircraft, 1=missile, 2=bullet, 3=effect |
| `TEAM` | 2 | 0 or 1 |
| `POS_X/Y/Z` | 3,4,5 | world position, m (absolute, float64) |
| `ROT_X/Y/Z/W` | 6,7,8,9 | body→world quaternion, unit length |
| `VEL_X/Y/Z` | 10,11,12 | world velocity, m/s |
| `OMEGA_X/Y/Z` | 13,14,15 | body angular velocity, rad/s (see §3.4 for p/q/r mapping) |
| `ALIVE` | 16 | 0 or 1 |
| `HP` | 17 | 0..100 |
| `FUEL_KG` | 18 | kg, aircraft only; 0 for missile/bullet/effect. The one authoritative fuel value — `src/physics`'s `stepAircraft` (module 02) reads/writes it directly every substep; no other module keeps an independent fuel estimate. |
| `ELEVON_L` | 19 | rad, + = trailing edge down (NOSE-DOWN pitching moment — see section 3's sign-convention note below) |
| `ELEVON_R` | 20 | rad, + = trailing edge down |
| `RUDDER` | 21 | rad, + = trailing edge left |
| `GEAR_POS` | 22 | 0 (up) .. 1 (down) |
| `THROTTLE` | 23 | 0..1, as actually applied (post engine-spool lag) |
| `AFTERBURNER_ON` | 24 | 0 or 1 |
| `FLAGS` | 25 | `EntityFlags` bitmask (`EntityFlag.*` in `core.ts`) |

**Elevon sign convention.** `+ELEVON_L`/`+ELEVON_R` = trailing edge DOWN, which produces a NOSE-DOWN pitching moment about the CG — the conventional elevator/elevon sign (stick back commands trailing-edge UP, nose-up). This matches every other aileron/elevator convention in aviation (e.g. "flaps down" is nose-down for the identical moment-arm reason: the surface is aft of the CG). `02-flight-model.md` section 5.1 pins the resulting required sign of `AeroTables.Cm_elevon` (negative) so module 03's data cannot independently rediscover the opposite (and physically wrong) sign.

### 6.3 HUD block (`SnapshotHud`, `HUD_BLOCK_FLOATS = 27` floats, starting at `HUD_BLOCK_START = HEADER_FLOATS + MAX_ENTITIES*ENTITY_STRIDE`)

One block, always describing the **player**, written by `src/core` from that tick's `AircraftTelemetry` + `CombatStatus` + ILS deviation calc so `src/hud` never has to recompute derived values.

| field | offset | unit / meaning |
|---|---|---|
| `IAS_MPS` | 0 | indicated airspeed, m/s |
| `TAS_MPS` | 1 | true airspeed, m/s |
| `MACH` | 2 | Mach number |
| `ALT_MSL_M` | 3 | m |
| `ALT_AGL_M` | 4 | m |
| `AOA_RAD` | 5 | rad |
| `BETA_RAD` | 6 | rad |
| `G_LOAD` | 7 | g |
| `HEADING_RAD` | 8 | rad, `[0, 2π)` |
| `PITCH_RAD` | 9 | rad, + = nose up |
| `ROLL_RAD` | 10 | rad, + = right wing down |
| `VSPEED_MPS` | 11 | m/s, + = climbing |
| `FUEL_KG` | 12 | kg |
| `THRUST_FRAC` | 13 | 0..1 |
| `GEAR_POS` | 14 | 0..1 (duplicated from the entity block for HUD convenience) |
| `WEAPON_IDX` | 15 | `WeaponKindCode` of selected weapon |
| `TARGET_ID` | 16 | `EntityId` of current target, or `NO_ENTITY_ID` (-1) |
| `TARGET_RANGE_M` | 17 | m |
| `CLOSURE_MPS` | 18 | m/s, + = closing |
| `LOCK_STATE` | 19 | `LockStateCode` |
| `WARNING_BITS` | 20 | `WarningBits` bitmask |
| `ILS_LOC` | 21 | normalised localiser deviation, `[-1,1]` (0 if no ILS tuned); see `ILS_LOC_FULL_SCALE_DEG` |
| `ILS_GS` | 22 | normalised glideslope deviation, `[-1,1]`; see `ILS_GS_FULL_SCALE_DEG` |
| `PIPPER_X` | 23 | world-space gun lead-computing-sight aim point, m (absolute, float64). Copied by `src/core` from the player's `CombatStatus.aimPointWorld` — module 07's real, gravity-drop-compensated `computeLeadSolution` output. 0 when `PIPPER_VALID` is 0. |
| `PIPPER_Y` | 24 | as `PIPPER_X` |
| `PIPPER_Z` | 25 | as `PIPPER_X` |
| `PIPPER_VALID` | 26 | 0 or 1; mirrors `CombatStatus.aimPointValid`. `src/hud`'s lead-sight pipper (module 08) reads these four fields directly and performs no ballistics computation of its own — see `08-render.md` section 4.8. |

Ammo counts (gun rounds remaining, missiles remaining per type) are **not** in this fixed-rate block; `src/hud`'s weapon-status widget tracks them locally by decrementing on `gunFire`/`missileLaunch` `SimEvent`s (module 08/11's spec should say so explicitly), keeping the 60 Hz block lean and matching this document's field list exactly.

## 7. Floating origin

`src/core`'s entity pool always holds **absolute, float64** world coordinates — this never changes and never gets rebased; it is the simulation's single source of truth and is what makes replay/determinism exact regardless of how far the mission has flown from `(0,0,0)`.

`src/render` (module 08) maintains its own `renderOriginWorld: Vec3` (float64, main-thread-only state, not part of the sim). Every frame:

1. If `|cameraWorldPos - renderOriginWorld| > FLOATING_ORIGIN_REBASE_DISTANCE_M` (4000 m, `core.ts`), set `renderOriginWorld = cameraWorldPos` (a rebase — this also requires re-basing any currently-streamed terrain chunk positions the same way, since Three.js objects are parented under a root whose local coordinates are `worldPos - renderOriginWorld`).
2. For every entity to draw, compute `renderPos = entityWorldPos - renderOriginWorld` (a float64 subtraction of two numbers close in magnitude, hence safe), then assign it to the Three.js object's position, which internally stores float32 — safe precisely because `renderPos` is always small (≤ ~4000 m magnitude by construction).

This achieves the precision goal (no float32 jitter far from the origin) without any float32 fields anywhere in the wire protocol. Terrain chunks (module 04/08) are generated in absolute world coordinates by `terrain.worker.ts` and shifted by the same `renderOriginWorld` when uploaded, exactly like entities.

## 8. Contract-file rules (how the 13 files in `docs/spec/contracts/` relate)

- `contracts/core.ts` is the **root**. It imports nothing — not even `./math`. Everything else may depend on it.
- `contracts/math.ts` (module 01) is the **one shared runtime library**. Any other contract may `import type { ... } from './math'` in addition to `'./core'`.
- Any contract file **may** import from **any other contract file** via a relative import (`import type { X } from './aircraft'`), as long as the whole graph stays acyclic and every file still compiles standalone with `tsc --noEmit --strict` run over `docs/spec/contracts/*.ts` with no external imports (module 12's Audit phase checks this mechanically). In practice, keep this rare: most contracts only need `./core` and `./math`. The one place this document mandates it is `contracts/flight.ts` importing `AircraftDefinition` from `contracts/aircraft.ts` (section 9.1).
- **Contract files contain no implementation.** Interfaces, `type` aliases, `as const` objects + derived unions, and bare function-signature aliases (`export type CreateX = (...) => X`) only. No class bodies, no function bodies (an interface **method signature**, e.g. `Pilot.update(...): void` with no body, is fine — that's just a shape, not an implementation).
- Because module-drafting and (later) module-*implementing* agents for, say, `02-flight-model.md` never see `03-tejas-data.md` or `contracts/aircraft.ts`'s full content while writing their own spec, **any shape that spans two non-core modules must be pinned down authoritatively in this document** (not left for both sides to "figure out the same way independently"). Section 9 does this for the handful of cases that exist in this project. If you are drafting a module spec and discover you need something from a sibling leaf module that isn't in `core.ts` or section 9, do not invent a shape and hope the other side matches it — use the most conservative structural subset you can (a minimal local interface with only the fields you truly need, matching this document's naming) and note the assumption in your spec's "Open assumptions" section.

## 9. Cross-module data contracts

These are the shapes that more than one leaf module (02–11) must agree on byte-for-byte, pinned here because the modules that need them are drafted/built in isolation from each other.

### 9.1 `AircraftDefinition` and `stepAircraft` (module 02 ↔ module 03, consumed by 06/07/08)

`contracts/aircraft.ts` (module 03) defines the full `AircraftDefinition` interface for the Tejas. `contracts/flight.ts` (module 02) imports it. Both files **must** use exactly this skeleton, including the full field-level shape of `AeroTables`/`EngineTables`/`GearDefinition`/`FcsLimits` given below — these four sub-shapes are pinned HERE, authoritatively, rather than left for module 02 and module 03 to (blindly) reconstruct the same way independently, per section 8's rule that any shape spanning two non-core modules belongs in this document. `WireframeModel` is likewise pinned below, verbatim, and matches `contracts/render.ts`'s own copy of the same shape field-for-field (module 08 is a third, independent consumer):

```ts
// contracts/aircraft.ts (module 03)
import type { Vec3Like } from './core';

export interface Hardpoint {
  id: string;
  posBodyM: Vec3Like; // body-frame mounting position
  type: 'gun' | 'ir_missile' | 'radar_missile' | 'fuel_tank';
}

export interface WireframeGroup {
  name: string;              // e.g. "elevonL","elevonR","rudder","noseGear","mainGearL","mainGearR"
  vertexIndices: readonly number[]; // indices into WireframeModel.vertices this group rotates
  pivotBodyM: Vec3Like;       // body-frame pivot point
  axisBody: Vec3Like;         // body-frame unit rotation axis
}
export interface WireframeModel {
  vertices: readonly (readonly [number, number, number])[]; // body-frame, m, rest pose
  edges: readonly (readonly [number, number])[];             // index pairs into vertices
  groups: readonly WireframeGroup[]; // moving parts; render.ts rotates listed vertices about pivot/axis by the live deflection (elevonL/elevonR/rudder in rad, or gearPos in [0,1] mapped to a group-defined travel angle) each frame
}

export interface AircraftDefinition {
  id: string;
  massKg: number;
  emptyMassKg: number;
  maxFuelKg: number;
  inertiaBodyKgM2: { xx: number; yy: number; zz: number; xy: number; xz: number; yz: number }; // body-frame inertia tensor about CG
  cgOffsetBodyM: Vec3Like;
  wingAreaM2: number;
  wingSpanM: number;
  meanChordM: number;
  hardpoints: readonly Hardpoint[];
  wireframe: WireframeModel;
  aero: AeroTables;
  engine: EngineTables;
  gear: readonly GearDefinition[];
  fcsLimits: FcsLimits;
}

// -- Table1D/Table2D: contracts/math.ts's real interfaces, restated structurally
// here (module 03 does not import contracts/math.ts — see 01-math.md section
// 9's companion note) so this shape is self-contained. `interpolate1D`/
// `interpolate2D` (contracts/math.ts) are the ONLY sanctioned way to sample
// these — never `sampleTable1D`/`sampleTable2D`, a name no math export uses.
export interface Table1D { xs: readonly number[]; ys: readonly number[]; }
export interface Table2D { xs: readonly number[]; ys: readonly number[]; zs: readonly (readonly number[])[]; }

// Pinned field-for-field to match 02-flight-model.md section 5.1's assumed
// shape exactly (that document's implementer never sees this file's module-03
// section, so this pin is what makes the two agree). CL/CD/Cm are Table2D
// vs (alphaRad, mach). IMPORTANT SIGN RULE: Cm_elevon MUST be negative — a
// positive (trailing-edge-down) elevonSym produces a NOSE-DOWN pitching
// moment per this document's elevon sign convention (section 6.2); a module-03
// implementer who instead makes Cm_elevon positive has the sign backwards and
// the aircraft's relaxed-stability FCS pitch loop will diverge, not converge.
export interface AeroTables {
  CL: Table2D;
  CD: Table2D;
  Cm: Table2D;
  CY_beta: number;
  Cl_beta: number;
  Cn_beta: number;
  CL_elevon: number;
  CD_elevon: number;
  /** MUST be negative — see the sign-rule note above. */
  Cm_elevon: number;
  Cl_elevon: number;
  Cn_elevon: number;
  CY_rudder: number;
  Cl_rudder: number;
  Cn_rudder: number;
  Cl_p: number;
  Cl_r: number;
  Cm_q: number;
  Cn_p: number;
  Cn_r: number;
  groundEffectMaxDeltaCL: number;
  stallAlphaRad: number;
}

// Pinned field-for-field to match 02-flight-model.md section 5.2.
export interface EngineTables {
  militaryThrustN: Table2D;        // vs (mach, altitudeM), throttle=1, no afterburner
  afterburnerThrustN: Table2D;     // vs (mach, altitudeM), full afterburner
  militaryFuelFlowKgS: Table2D;    // vs (mach, altitudeM), at throttle=1 military
  afterburnerFuelFlowKgS: Table2D; // vs (mach, altitudeM), full afterburner
  idleFuelFlowKgS: number;
  spoolTimeConstantSec: number;
}

// Pinned field-for-field to match 02-flight-model.md section 5.4. Exactly
// three entries in AircraftDefinition.gear: ids 'nose', 'mainLeft', 'mainRight'.
export interface GearDefinition {
  id: string; // 'nose' | 'mainLeft' | 'mainRight'
  posBodyM: Vec3Like;
  maxCompressionM: number;
  springNPerM: number;
  damperNPerMPerS: number;
  kineticFrictionCoefficient: number;
  steerable: boolean;      // true only for 'nose'
  maxSteerAngleRad: number; // 0 for main gear
  brakeCapable: boolean;    // true only for main gear
}

// Pinned field-for-field to match 02-flight-model.md section 5.5.
export interface FcsLimits {
  maxAlphaRad: number;
  minAlphaRad: number;
  maxGLoadPos: number;
  maxGLoadNeg: number; // negative
  maxRollRateRadS: number;
  maxElevonRad: number;
  maxRudderRad: number;
  maxElevonRateRadS: number;
  maxRudderRateRadS: number;
  pitchRateGain: number;  // Kq
  rollRateGain: number;   // Kp
  yawRateGain: number;    // Kr
  alphaLimitGain: number; // Ka
  gLoadGain: number;      // Kg
}
```

```ts
// contracts/flight.ts (module 02)
import type { Vec3Like, EntityState, PilotInputs, DamageState } from './core';
import type { AircraftDefinition } from './aircraft';

export interface Environment {
  airDensityKgM3: number;
  soundSpeedMps: number;
  windWorldMps: Vec3Like;
  gravityMps2: number; // pass core.ts's GRAVITY_MPS2 through explicitly rather than importing the constant into a hot-path function, so stepAircraft stays a pure function of its arguments
  /** Terrain surface elevation (world Y, m MSL) at (state.pos.x, state.pos.z), i.e. HeightSampler.heightAt(...) — needed every tick by the landing-gear model and by AGL telemetry. A single sample at the aircraft's own horizontal position is used for all three gear legs (deliberate simplification, 02-flight-model.md section 9). */
  groundElevationM: number;
  /** Terrain unit surface normal (world frame) at the same point, i.e. HeightSampler.normalAt(...). Carried for a future slope-aware gear-contact revision; the current gear model approximates the contact-force direction as world +Y regardless (02-flight-model.md section 9). */
  groundNormalWorld: Vec3Like;
}

// Pure, allocation-free: mutates `out` in place. `state` is the entity's CURRENT
// EntityState (read-only in, `out` may safely alias `state` for in-place integration).
export type StepAircraft = (
  state: EntityState,
  damage: DamageState,
  inputs: PilotInputs,
  env: Environment,
  def: AircraftDefinition,
  dtSec: number,
  out: EntityState
) => void;
```

### 9.2 Airport flattening (module 04 ↔ module 05)

`contracts/airport.ts` (module 05)'s `AirportLayout` must include a `flattenZones` array of exactly this shape (typically one per runway + apron footprint), and `contracts/terrain.ts` (module 04)'s height-sampler factory must accept exactly this shape as one of its inputs:

```ts
export interface AirportFlattenZone {
  centerWorldX: number;
  centerWorldZ: number;
  elevationM: number;   // flattened surface elevation, MSL
  flatRadiusM: number;  // radius within which terrain height is forced to elevationM
  blendRadiusM: number; // additional radius, beyond flatRadiusM, over which height smoothstep-blends back to natural noise
}
```

`HeightSampler.heightAt(x,z)` (module 04) blends: inside `flatRadiusM` of any zone center → exactly `elevationM`; between `flatRadiusM` and `flatRadiusM+blendRadiusM` → smoothstep interpolation between `elevationM` and the raw noise height; otherwise → raw noise height. Module 04's own spec fixes the exact smoothstep formula and the multi-zone blending rule (nearest zone wins, or a distance-weighted blend) — that detail is module 04's to design; the zone **shape** above and the three named radii are fixed here.

### 9.3 File paths for the two built-in airports (module 05)

`src/airport/layouts/rangpur-afb.json` (inland/plateau airbase, single long runway, mountainous surroundings — exercises terrain-hugging BFM and a non-trivial approach) and `src/airport/layouts/konarak-coastal.json` (coastal airbase at sea level, parallel runways, ILS approach over water). Both are fictional. Module 05's spec designs their exact runway counts/headings/lengths; only the file paths and general character are fixed here so module 11 (mission select UI) and module 12 (integration tests referencing them by path) can rely on the names without seeing module 05's content.

## 10. Dependency rules (import graph)

```
src/contracts/*        ← copied verbatim from docs/spec/contracts/*.ts by the scaffold step. Nobody edits these files directly; if a contract needs to change, the change is made in docs/spec/contracts and re-copied.

src/math/*              no src/* imports (leaf; may use src/contracts/math.ts's own types internally, i.e. it implements its own contract)
src/physics/*           imports src/contracts/*, src/math/* only
src/aircraft/*           imports src/contracts/* only
src/terrain/*             imports src/contracts/*, src/math/* only
src/airport/*             imports src/contracts/*, src/math/* only
src/ai/*                   imports src/contracts/*, src/math/* only
src/combat/*                imports src/contracts/*, src/math/* only
src/render/*                  imports src/contracts/* only
src/hud/*                      imports src/contracts/* only
src/input/*                     imports src/contracts/* only
src/ui/*                         imports src/contracts/* only
src/core/*                        imports EVERYTHING (src/contracts/*, src/math/*, src/physics/*, src/aircraft/*, src/terrain/*, src/airport/*, src/ai/*, src/combat/*, src/render/*, src/hud/*, src/input/*, src/ui/*) — it is the integrator that wires concrete implementations (e.g. a `Pilot` from src/input or src/ai) behind the interfaces core.ts defines.
```

No module outside `src/core` imports another leaf module's `src/*` directly (e.g. `src/ai` never imports from `src/combat` — if AI needs combat state, it gets it through `PilotContext.combat: CombatStatus`, which `src/core` populates). This is what makes the twelve modules buildable without seeing each other: every cross-module data need either flows through `src/contracts/*` (compile-time types) or through a runtime value `src/core` constructs and injects (e.g. the `Pilot` implementations, the `AirportNavDb` instance, the `HeightSampler` instance).

`src/main.ts`, `index.html`, `vite.config.ts`, `tsconfig.json`, `package.json` are owned by module 10 (they are the application's entry point and build config, and module 10 is the only module that needs the full picture to wire the worker bootstraps). `vitest.config.ts` is owned by module 12.

## 11. Complete file-ownership manifest

Every path the finished project contains, grouped by owning module. An implementer agent may create files **only** inside its own group. Paths not listed here should not exist; if your module's own spec needs one more small file than listed (e.g. an extra internal helper), that is fine as long as it is inside your owned directory — this list fixes the *directories and the load-bearing entry-point files*, not literally every helper file a module might split its work into.

### Module 00 — architecture (this module)
- `docs/spec/00-architecture.md` — this document.
- `docs/spec/contracts/core.ts` — root contract.
- `docs/spec/README.md` — spec index and reading order.

### Module 01 — math (`01-math.md`, `contracts/math.ts`)
- `src/math/vec3.ts` — mutable `Vec3` (add/sub/scale/dot/cross/normalize/lerp, all with `out` params).
- `src/math/quat.ts` — mutable `Quat` (multiply, `rotate`/`rotateInverse`, `fromYawPitchRoll`/`toYawPitchRoll`, slerp/nlerp, `bodyRateP/Q/R`).
- `src/math/mat3.ts` — 3×3 matrix (inertia tensor ops: multiply, inverse, transform).
- `src/math/scalar.ts` — `clamp`, `lerp`, `smoothstep`, `wrapAngle`, etc.
- `src/math/table1d.ts` — 1D lookup-table interpolation (alpha → coefficient).
- `src/math/table2d.ts` — 2D lookup-table interpolation (alpha, Mach → coefficient).
- `src/math/prng.ts` — `mulberry32` seeded PRNG + sub-seed derivation helper.
- `src/math/filters.ts` — low-pass filter(s) for actuator/engine-spool dynamics.
- `src/math/index.ts` — barrel re-export.

### Module 02 — flight model (`02-flight-model.md`, `contracts/flight.ts`)
- `src/physics/rigidBody.ts` — 6-DOF integration (semi-implicit Euler or RK4 per module 02's choice).
- `src/physics/atmosphere.ts` — ISA atmosphere model (density/speed-of-sound vs altitude).
- `src/physics/aeroForces.ts` — aero force/moment builder from `AeroTables`.
- `src/physics/engine.ts` — thrust/fuel-burn model.
- `src/physics/landingGear.ts` — gear contact/suspension/friction/steering.
- `src/physics/fcs.ts` — fly-by-wire control laws (relaxed-stability stabilization).
- `src/physics/integrator.ts` — top-level `stepAircraft` entry point (implements `StepAircraft` from `contracts/flight.ts`).
- `src/physics/index.ts` — barrel re-export.

### Module 03 — Tejas aircraft data (`03-tejas-data.md`, `contracts/aircraft.ts`)
- `src/aircraft/tejasDefinition.ts` — the `AircraftDefinition` object for the Tejas Mk1.
- `src/aircraft/tejasAeroTables.ts` — `AeroTables` data (Cl/Cd/Cm vs alpha/Mach, control & damping derivatives).
- `src/aircraft/tejasEngineTables.ts` — F404-IN20 thrust/fuel-flow tables.
- `src/aircraft/tejasGeometry.ts` — mass/inertia/gear geometry, hardpoints, `FcsLimits`.
- `src/aircraft/tejasWireframe.json` — the `WireframeModel` data (vertices/edges/groups).
- `src/aircraft/wireframeTypes.ts` — local helper types for building the wireframe JSON (re-exports `WireframeModel` from `contracts/aircraft.ts`).
- `src/aircraft/index.ts` — barrel re-export.

### Module 04 — terrain (`04-terrain.md`, `contracts/terrain.ts`)
- `src/terrain/noise.ts` — simplex noise implementation.
- `src/terrain/domainWarp.ts` — domain-warping for more natural ridgelines.
- `src/terrain/ridge.ts` — ridge-noise function.
- `src/terrain/heightSampler.ts` — implements `HeightSampler` (`core.ts`) combining noise + `AirportFlattenZone`s (section 9.2).
- `src/terrain/quadtree.ts` — chunk quadtree / LOD selection.
- `src/terrain/chunkManager.ts` — request/cache/evict chunk geometry, talks to `terrain.worker.ts`.
- `src/terrain/chunkGeometryBuilder.ts` — builds positions/normals/indices for one chunk.
- `src/terrain/terrain.worker.ts` — worker bootstrap implementing `MainToTerrainMessage`/`TerrainToMainMessage`.
- `src/terrain/index.ts` — barrel re-export.

### Module 05 — airport (`05-airport.md`, `contracts/airport.ts`)
- `src/airport/schema.ts` — JSON schema + TS types for `AirportLayout`.
- `src/airport/parser.ts` — JSON → `AirportLayout` parsing.
- `src/airport/validator.ts` — validation, returns `Result<AirportLayout>`.
- `src/airport/runwayGeometry.ts`, `src/airport/taxiwayGeometry.ts`, `src/airport/apronGeometry.ts` — geometry generation for render/HUD consumption.
- `src/airport/ils.ts` — localiser/glideslope math (`ilsDeviation(pos, ils)`), using `ILS_LOC_FULL_SCALE_DEG`/`ILS_GS_FULL_SCALE_DEG` from `core.ts`.
- `src/airport/navDb.ts` — implements `AirportNavDb` (`core.ts`).
- `src/airport/layouts/rangpur-afb.json`, `src/airport/layouts/konarak-coastal.json` — the two built-in layouts (section 9.3).
- `src/airport/index.ts` — barrel re-export.

### Module 06 — AI (`06-ai.md`, `contracts/ai.ts`)
- `src/ai/pilotAi.ts` — implements `Pilot` (`core.ts`).
- `src/ai/terrainAvoidance.ts` — ground-proximity avoidance using `HeightSampler`.
- `src/ai/tacticalFsm.ts` — engage/evade/RTB state machine.
- `src/ai/bfmManoeuvres.ts` — basic fighter manoeuvre library.
- `src/ai/threatEvaluation.ts` — contact scoring/prioritization.
- `src/ai/difficultyProfiles.ts` — parameter sets per `AiDifficulty`.
- `src/ai/index.ts` — barrel re-export.

### Module 07 — combat (`07-combat.md`, `contracts/combat.ts`)
- `src/combat/weaponStation.ts` — per-`Hardpoint` loadout/state.
- `src/combat/gunBallistics.ts` — bullet spawn/flight/hit.
- `src/combat/leadComputingSight.ts` — gunsight pipper solution.
- `src/combat/irMissileSeeker.ts`, `src/combat/proportionalNavigation.ts` — IR missile guidance.
- `src/combat/radarModel.ts`, `src/combat/radarMissile.ts` — radar detection/lock + radar-guided missile.
- `src/combat/hitDetection.ts` — bullet/missile vs entity collision.
- `src/combat/subsystemDamage.ts` — writes `DamageState` (`core.ts`).
- `src/combat/effectsEvents.ts` — builds `SimEvent`s (explosion/hit/kill/lock...).
- `src/combat/index.ts` — barrel re-export.

### Module 08 — render + HUD (`08-render.md`, `contracts/render.ts`)
- `src/render/scene.ts` — Three.js scene/renderer setup.
- `src/render/cameraModes.ts` — chase/cockpit/external/free camera.
- `src/render/wireframeAircraftRenderer.ts` — consumes `WireframeModel` + live deflections.
- `src/render/terrainChunkConsumer.ts` — uploads chunk buffers from `terrain.worker.ts`.
- `src/render/skyFog.ts`, `src/render/effects.ts` — sky/fog/explosion/tracer visuals.
- `src/render/snapshotInterpolation.ts` — snapshot double-buffer + lerp/nlerp (section 4).
- `src/render/floatingOrigin.ts` — `renderOriginWorld` rebase logic (section 7).
- `src/render/index.ts` — barrel re-export.
- `src/hud/hudCanvas.ts` — Canvas-2D HUD root, reads the snapshot HUD block directly.
- `src/hud/ladder.ts` — attitude ladder.
- `src/hud/tapes.ts` — speed/altitude tapes.
- `src/hud/ilsNeedles.ts` — localiser/glideslope needles from `ILS_LOC`/`ILS_GS`.
- `src/hud/radarScope.ts` — radar/contacts scope.
- `src/hud/weaponStatus.ts` — selected weapon + ammo (tracked via `SimEvent`s, section 6.3).
- `src/hud/warnings.ts` — `WarningBits` → on-screen warning text/flashers.
- `src/hud/index.ts` — barrel re-export.

### Module 09 — input (`09-input.md`, `contracts/input.ts`)
- `src/input/keyboard.ts`, `src/input/mouse.ts`, `src/input/gamepad.ts`, `src/input/touch.ts`, `src/input/deviceOrientation.ts` — raw device readers.
- `src/input/inputMap.ts` — binding configuration.
- `src/input/deadzones.ts` — deadzone/curve shaping.
- `src/input/playerPilot.ts` — implements `Pilot` (`core.ts`) for the human player, combining the above into `PilotInputs` each call.
- `src/input/index.ts` — barrel re-export.

### Module 10 — core worker & app shell (`10-core-worker.md`, `contracts/sim.ts`)
- `src/core/fixedStepLoop.ts` — the accumulator loop (section 4).
- `src/core/entityPool.ts` — pooled entity storage, `packEntityId`/`unpackEntityId`.
- `src/core/world.ts` — owns all pools, wires `Pilot`/`HeightSampler`/`AirportNavDb` implementations into `PilotContext`.
- `src/core/snapshotWriter.ts` — writes `EntityState`s + HUD block into a pooled `ArrayBuffer` (section 6).
- `src/core/snapshotReader.ts` — main-thread-side reader (used by render/hud), and by `tools/sim-check.ts`.
- `src/core/eventQueue.ts` — per-tick `SimEvent` collection.
- `src/core/missions/freeFlight.json`, `src/core/missions/dogfight1v1.json` — concrete `Mission` data.
- `src/core/sim.worker.ts` — worker bootstrap implementing `MainToSimMessage`/`SimToMainMessage`.
- `src/main.ts` — app entry point: creates both workers, wires `src/render`/`src/hud`/`src/input`/`src/ui`.
- `index.html` — single page shell.
- `vite.config.ts`, `tsconfig.json`, `package.json` — build config (section 13 gives the exact required contents).
- `src/core/index.ts` — barrel re-export.

### Module 11 — UI (`11-ui.md`, `contracts/ui.ts`)
- `src/ui/mainMenu.ts`, `src/ui/missionSelect.ts`, `src/ui/settings.ts`, `src/ui/pauseMenu.ts`, `src/ui/debrief.ts` — DOM screens.
- `src/ui/qualityTierDetect.ts`, `src/ui/benchmark.ts` — auto quality-tier selection (section 14).
- `src/ui/airportEditor.ts`, `src/ui/airportEditorExport.ts` — 2D top-down airport editor + JSON export/import matching `contracts/airport.ts`'s schema.
- `src/ui/pwa.ts` — service-worker registration glue.
- `src/ui/index.ts` — barrel re-export.
- `public/manifest.webmanifest` — PWA manifest.
- `public/service-worker.js` — PWA service worker.
- `public/icons/` — PWA icon set.

### Module 12 — verification (`12-verification.md`, `contracts/verify.ts`)
- `tests/math/*.test.ts`, `tests/physics/*.test.ts`, `tests/aircraft/*.test.ts`, `tests/terrain/*.test.ts`, `tests/airport/*.test.ts`, `tests/ai/*.test.ts`, `tests/combat/*.test.ts`, `tests/core/*.test.ts` — per-module unit tests (mirroring `src/<module>/<file>.ts` as `tests/<module>/<file>.test.ts`).
- `tests/integration/*.test.ts` — cross-module integration tests (spawn → fly → land; spawn → fight → kill; etc.).
- `tools/sim-check.ts` — headless CLI: loads a `Mission`, runs the sim under Node for N ticks with a scripted/trim input stream, asserts trim state and determinism (same seed+inputs ⇒ same final state).
- `scripts/ci.ts` (or `.sh`) — CI helper invoked by the workflow below.
- `.github/workflows/ci.yml` — CI config: install, `tsc --noEmit`, `vitest run`, `tools/sim-check.ts`.
- `vitest.config.ts` — test runner config (Node environment by default; see section 2).
- The acceptance checklist the final review agents run (defined inside `12-verification.md` itself, not a separate file).

## 12. Build order for the single pass

1. **Scaffold** (automated, not an LLM agent): create every directory in section 11's manifest; copy `docs/spec/contracts/*.ts` verbatim into `src/contracts/*.ts`.
2. **Modules 01–11, in parallel**: each implementer agent reads this document + `src/contracts/core.ts` + its own `docs/spec/<NN>-<name>.md` + `docs/spec/contracts/<name>.ts`, and writes only the files listed under its module in section 11. No agent reads another agent's output during this phase.
3. **Module 12, in parallel with 01–11** (it does not need their output to write its *own* test files, since it codes tests against the contracts, not the implementations — though a given test obviously cannot *pass* until the corresponding implementation exists): writes `tests/**`, `tools/sim-check.ts`, `scripts/**`, CI config, `vitest.config.ts`.
4. **Integration** (automated + a dedicated integration pass if needed): `npm install`; `tsc --noEmit` against BOTH `tsconfig.json` and `tsconfig.worker.json` (section 13) across the whole `src/` tree; resolve any compile errors. Most compile errors, given strict directory ownership and the contract-first design, arise only if a module violated its own contract file. The one KNOWN exception this document flags in advance: `src/main.ts` (module 10) has no contract of its own to violate — it is the one file whose entire job is calling into `src/render`/`src/hud`/`src/input`/`src/ui`'s real exports, which module 10 drafted blind to (see `10-core-worker.md` section 4.10's own explicit non-normative marking) — so a short, expected reconciliation pass against those four modules' real, now-implemented signatures is a normal part of this step, not a sign of a cross-module contract violation. `src/core`'s `world.ts` wires concrete `Pilot` (from `src/input`/`src/ai`), `HeightSampler` (from `src/terrain`), `AirportNavDb` (from `src/airport`), `AircraftDefinition` (from `src/aircraft`), `StepAircraft` (from `src/physics`) implementations behind the interfaces `core.ts` defines.
5. **Verification**: `vitest run` (module 12's unit + integration tests), `tools/sim-check.ts` against both built-in missions, then the acceptance checklist in `12-verification.md` is run manually/mechanically against the built app.

## 13. Coding rules

- **No allocation in hot paths.** See section 2. Concretely: `Vec3`/`Quat`/`Mat3` methods take an `out` parameter and return it; they never construct `new Vec3(...)` internally to return a fresh result. Pools (`src/core/entityPool.ts`) are sized once from `MAX_ENTITIES` and friends at init; `spawn`/`despawn` reuse slots, never `push`/`splice` a growing array in the hot path.
- **No `Math.random()` in sim code.** See section 2's exact directory list. All randomness derives from `mulberry32(seed)` (`src/math/prng.ts`), and `WorldConfig.seed` is the single root seed every subsystem derives its own sub-stream from (e.g. `subSeed = hash(seed, 'terrain')`, `hash(seed, 'ai:' + aircraftId)`) so that changing one subsystem's usage of randomness doesn't perturb another's stream.
- **No DOM in sim code.** See section 2's exact directory list; mechanically enforced by `tools/sim-check.ts` + vitest running under Node.
- **Strict TypeScript.** `"DOM"` and `"WebWorker"` MUST NOT be combined in the same `lib` array: TypeScript 5.x's `lib.dom.d.ts` and `lib.webworker.d.ts` declare several globals (`self`, `FormData`, `URL`, `Notification`, ...) incompatibly when both are included together, producing ~30 TS6200/TS2374/TS2403 duplicate-global-declaration errors regardless of any module's own code being correct — a known TypeScript limitation, not a project bug. This project therefore uses **two** tsconfigs (both owned by module 10; contents fixed here):

  `tsconfig.json` (the main one — everything except the two worker bootstrap files):
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "ESNext",
      "moduleResolution": "Bundler",
      "lib": ["ES2022", "DOM"],
      "strict": true,
      "noUncheckedIndexedAccess": true,
      "noImplicitOverride": true,
      "noFallthroughCasesInSwitch": true,
      "forceConsistentCasingInFileNames": true,
      "skipLibCheck": true,
      "esModuleInterop": true,
      "isolatedModules": true,
      "resolveJsonModule": true,
      "outDir": "dist-ts-check"
    },
    "include": ["src", "tests", "tools"],
    "exclude": ["src/core/sim.worker.ts", "src/terrain/terrain.worker.ts"]
  }
  ```

  `tsconfig.worker.json` (the two worker bootstrap files only — everything else in `src/core`/`src/terrain` still compiles under the main config above, since only the worker entry file itself references `self`/`WorkerGlobalScope`-style globals; everything it imports is DOM-free per section 2 and compiles fine under either lib set):
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "ESNext",
      "moduleResolution": "Bundler",
      "lib": ["ES2022", "WebWorker"],
      "strict": true,
      "noUncheckedIndexedAccess": true,
      "noImplicitOverride": true,
      "noFallthroughCasesInSwitch": true,
      "forceConsistentCasingInFileNames": true,
      "skipLibCheck": true,
      "esModuleInterop": true,
      "isolatedModules": true,
      "resolveJsonModule": true,
      "outDir": "dist-ts-check-worker"
    },
    "include": ["src/core/sim.worker.ts", "src/terrain/terrain.worker.ts"]
  }
  ```

  The project-wide strict compile (section 12 step 4, and `12-verification.md`'s `src_compile` acceptance check) runs `tsc --noEmit` against **both** configs; either failing fails the check. `package.json`'s `typecheck`/`build` scripts (section 5.7 of `10-core-worker.md`) invoke both.
- **Naming conventions.** Files: `camelCase.ts`, named after their primary export where there is one (`vec3.ts` exports `Vec3`). Types/interfaces/classes: `PascalCase`. Variables/functions: `camelCase`. Constants that are truly fixed (not just `const`-declared locals): `UPPER_SNAKE_CASE` (e.g. `MAX_ENTITIES`, `SIM_HZ`). `as const` object maps use `PascalCase` names with `camelCase`/`snake_case` **string values** matching their TS union type (e.g. `EntityKind.Aircraft === 'aircraft'`). Test files mirror their source path under `tests/`, e.g. `src/math/vec3.ts` → `tests/math/vec3.test.ts`.
- **Error handling.** Pure math/physics functions never throw for ordinary numeric edge cases — clamp, don't throw (e.g. `Math.acos` inputs are clamped to `[-1,1]` before calling). Functions that validate external/untrusted data (airport JSON parsing, mission loading) return `Result<T,E>` (`core.ts`) rather than throwing, so worker message handlers never need a `try/catch` around ordinary bad-data conditions — they check `.ok` and emit a `warning` `SimEvent` or reject the command. Throwing (`throw new Error(...)`) is reserved for programmer-error assertions (contract violations) that should only ever fire during development and are caught by tests, e.g. an `EntityId` referring to a pool slot with a stale generation.

## 14. Quality tiers

Quality tier affects **rendering and UI cost only** — never the sim worker's behaviour, tick rate, or determinism (a replay recorded on Ultra must play back identically on Low). `src/ui/qualityTierDetect.ts` auto-selects a tier via a short benchmark on first run; `src/ui/settings.ts` lets the player override it.

| control | Low | Medium | High | Ultra |
|---|---|---|---|---|
| terrain draw distance (chunks) | 6 | 10 | 16 | 24 |
| terrain max LOD depth | 3 | 4 | 5 | 6 |
| shadows | off | off | on (1 cascade) | on (2 cascades) |
| effect/particle budget (concurrent) | 16 | 32 | 64 | 128 |
| antialiasing | off | FXAA | FXAA | MSAA 4x |
| HUD radar scope contact cap (rendered detail) | 8 | 16 | 32 | 32 |
| target render FPS assumption | 30 | 45 | 60 | 60+ |
| snapshot interpolation | on | on | on | on |
| physics tick rate | 120 Hz (fixed, all tiers) | | | |

## 15. Glossary

- **AoA / alpha** — angle of attack.
- **AGL / MSL** — above ground level / mean sea level.
- **BFM** — basic fighter manoeuvres.
- **FCS** — flight control system (the fly-by-wire control laws).
- **FSM** — finite state machine.
- **ILS** — instrument landing system (localiser + glideslope).
- **IR** — infrared (missile seeker type).
- **ISA** — International Standard Atmosphere.
- **LOD** — level of detail.
- **PRNG** — pseudo-random number generator (`mulberry32` here).
- **Proportional navigation** — missile guidance law steering toward a constant bearing to intercept.
- **Quadtree** — spatial subdivision structure used for terrain chunk LOD selection.
- **RWR** — radar warning receiver.
- **Snapshot** — the 60 Hz binary state dump the sim worker sends to the main thread (section 6).
- **Trim** — a steady-state flight condition (constant altitude/speed/heading) used as a physics validation target.
- **Wireframe model** — the placeholder aircraft visual: line segments between vertices, no textures/surfaces.
