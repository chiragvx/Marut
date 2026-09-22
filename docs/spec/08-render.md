# 08 — Rendering & HUD

Reads: `00-architecture.md`, `contracts/core.ts`, this document, `contracts/render.ts`. Nothing else. Where this document and `contracts/render.ts` disagree, `contracts/render.ts` wins (it is the compiled, checked surface); where this document and `00-architecture.md`/`core.ts` disagree, those win.

## 1. Purpose & scope

This module owns everything the player *sees* and the on-screen flight instruments: the Three.js 3D scene (terrain, the placeholder wireframe Tejas, sky/fog, missile/explosion/tracer effects, four camera modes, floating-origin rebasing, 60 Hz→display-rate snapshot interpolation) and the Canvas‑2D HUD overlay (pitch ladder, flight-path marker, speed/altitude/heading tapes, AoA/g readout, ILS needles, a simplified radar scope, a target box + lead-computing gunsight pipper, weapon status, and warning annunciators). It owns two directories, `src/render/` and `src/hud/`, and is the only module allowed to write to them.

It does **not** own: entity/physics/AI/combat simulation (that is the sim worker, modules 02/03/06/07 via 10); terrain chunk *generation* or LOD *selection* (module 04 — this module only *uploads geometry it is handed*); airport taxiway/apron geometry generation (module 05 — see section 9.5, this module renders only runways + ILS guide lines, computed locally from `AirportNavDb`); raw input capture (module 09); menus, settings, quality-tier auto-detection, or the airport editor (module 11); worker bootstraps or message routing (module 10, which calls every method in this module's contract).

Non-goals, explicitly: photorealistic shading (there is no textured aircraft model — wireframe only, by product brief), a sensor-realistic radar scope (this module's scope reads snapshot entities directly rather than `src/combat`'s detection model — section 4.7/9.4), and taxiway/apron rendering (section 9.5). The lead-computing gunsight IS `src/combat`'s real, physically exact ballistics solution — section 4.8 reads it straight off the Snapshot HUD block's `PIPPER_*` fields, it is not this module's own approximation.

`src/render` and `src/hud` may import **only** from `src/contracts/*` (this file, `core.ts`) — per `00-architecture.md` section 10, **neither may import `src/math/*`**, and `src/hud` may **not** import `src/render/*` even though both are owned by this same module (that dependency-rule table is per-directory, not per-module, and this spec follows it literally). Consequently:

- `src/render` may freely use **Three.js's own** `Vector3`/`Quaternion`/`Matrix4`/etc. for anything touching the Three.js scene graph (that is normal use of the one permitted renderer dependency, not "using `src/math`").
- Both directories need a handful of tiny scalar/vector helpers (lerp, quaternion nlerp, a 4×4 matrix–vector multiply) that are *not* Three.js scene-graph operations (e.g. HUD's screen projection has no Three.js object to hang a method off). Each directory implements its **own** private copy in `mathInternal.ts` (section 2). This is deliberate duplication, not an oversight — see section 9.6.

## 2. Owned files

| path | purpose |
|---|---|
| `src/render/scene.ts` | Three.js `Scene`/`WebGLRenderer`/root-group setup; implements `CreateSceneRenderer`; owns the per-frame draw call orchestration. |
| `src/render/cameraModes.ts` | Cockpit/chase/external/flyby camera pose computation (section 4.2). |
| `src/render/wireframeAircraftRenderer.ts` | Consumes a registered `WireframeModel` + per-entity live deflections; builds/updates one `THREE.LineSegments` per aircraft entity (section 4.4). |
| `src/render/terrainChunkConsumer.ts` | Turns an ingested `TerrainChunkReadyMessage` into a `THREE.BufferGeometry` + the shared terrain material; tracks chunks by `(chunkX,chunkZ,lod)` key for eviction (section 4.5). |
| `src/render/skyFog.ts` | Sky-dome gradient mesh, `THREE.Fog`/scene background wiring, sun direction → directional light (section 4.11). |
| `src/render/effects.ts` | Pooled, instanced explosion/muzzle-flash/smoke-trail visuals driven by `SimEvent`s (section 4.12). |
| `src/render/airportLines.ts` | Runway rectangle + ILS localiser/glideslope guide-line geometry built from `AirportNavDb` (section 4.13). |
| `src/render/snapshotInterpolation.ts` | Double-buffered snapshot ingest + entity id matching + lerp/nlerp (section 4.1). |
| `src/render/floatingOrigin.ts` | `renderOriginWorld` rebase logic (section 4.3). |
| `src/render/mathInternal.ts` | Private vec3/quat helpers not tied to a `THREE.Object3D` (lerp3, quatNlerp, axisAngleQuat, rotateVecByAxisAngle — Rodrigues). Not exported outside `src/render`. |
| `src/render/index.ts` | Barrel re-export of `createSceneRenderer` only (module 10's sole entry point into this directory). |
| `src/hud/hudCanvas.ts` | Canvas‑2D root; implements `CreateHudRenderer`; owns the 2D draw-call orchestration and the per-frame snapshot parse (reads the HUD block **and** scans entity blocks for the target, directly — section 4.1). |
| `src/hud/snapshotView.ts` | Internal, allocation-free Float64Array parsing helpers shared by every HUD widget file (header/entity/HUD-block field readers, player-index lookup, target-id scan). |
| `src/hud/ladder.ts` | Pitch ladder + flight-path marker (section 4.9). |
| `src/hud/tapes.ts` | Speed tape, altitude tape, heading tape, AoA/g digital readout (section 4.9). |
| `src/hud/ilsNeedles.ts` | Localiser/glideslope needle deflection from `ILS_LOC`/`ILS_GS` (section 4.10). |
| `src/hud/radarScope.ts` | Simplified top-down contact scope (section 4.7). |
| `src/hud/targetBox.ts` | World→screen projection (shared helper, section 4.6), target bounding box, and lead-computing sight pipper (section 4.8). |
| `src/hud/weaponStatus.ts` | Selected-weapon readout + locally-tracked ammo counters, event-driven decrement (section 4.9). |
| `src/hud/warnings.ts` | `WARNING_DISPLAY`-driven annunciator text + flash timing (section 4.9). |
| `src/hud/mathInternal.ts` | Private helpers: `lerp`, `clamp`, the 4×4 view-projection multiply (section 4.6), `nlerpHud` (a second, independent copy of the same formula `src/render/mathInternal.ts` has — section 9.6). |
| `src/hud/index.ts` | Barrel re-export of `createHudRenderer` only. |

## 3. Public API

Everything below is declared in `docs/spec/contracts/render.ts`; this section restates it with the call sequence module 10 (`src/core`, via `src/main.ts`) is expected to use. Full field-by-field detail is in that file's doc comments; do not re-derive types here, only follow them.

### 3.1 Construction (once, at app start, after the canvas elements exist)

```ts
const sceneRenderer: SceneRenderer = createSceneRenderer(sceneCanvas, initialTier);
const hudRenderer: HudRenderer = createHudRenderer(hudCanvas, initialTier);
sceneRenderer.registerAircraftModel(tejasWireframeModel); // from src/aircraft, injected by src/core
sceneRenderer.setNavDb(navDb);                             // from src/airport, injected by src/core
sceneRenderer.setSunDirection({ x: 0.4, y: 0.7, z: -0.4 });
hudRenderer.setWeaponLoadout(initialAmmoGun, initialMissilesIr, initialMissilesRadar);
```

### 3.2 Per-resize

```ts
sceneRenderer.resize(widthPx, heightPx, devicePixelRatio);
hudRenderer.resize(widthPx, heightPx, devicePixelRatio);
```

### 3.3 Per received `SimSnapshotMessage` (main.ts wraps `msg.buffer` in a `Float64Array` **once**, shares the *same* view with both — reading is non-mutating so this is safe)

```ts
const view = new Float64Array(msg.buffer);
sceneRenderer.ingestSnapshot(view);
hudRenderer.ingestSnapshot(view);
// Both calls above MUST have returned (synchronously) before this line —
// they do not retain `view` or `msg.buffer`.
sim.postMessage({ type: 'releaseBuffer', buffer: msg.buffer }, [msg.buffer]);
```

### 3.4 Per received `SimEventsMessage`

```ts
sceneRenderer.ingestEvents(msg.events);
hudRenderer.ingestEvents(msg.events);
```

### 3.5 Per received `TerrainChunkReadyMessage` / eviction notice from `src/terrain`'s chunk manager

```ts
sceneRenderer.ingestTerrainChunk(msg);
// ...later, when src/terrain's chunk manager evicts (chunkX, chunkZ, lod):
sceneRenderer.evictTerrainChunk(chunkX, chunkZ, lod);
```

### 3.6 Per rendered frame (driven by `requestAnimationFrame`, independent of the 120 Hz sim / 60 Hz snapshot rates)

```ts
function onAnimationFrame(nowMs: number) {
  const camera: CameraState = sceneRenderer.renderFrame(nowMs);
  hudRenderer.renderFrame(nowMs, camera);
  requestAnimationFrame(onAnimationFrame);
}
```

`camera` is a **reused, mutable** object — `hudRenderer.renderFrame` must finish reading it before `onAnimationFrame` returns; nothing may cache it across frames.

### 3.7 Quality tier / camera mode / orbit input (from `src/ui`'s settings screen and from `src/main.ts`'s own light pointer-drag listener for the external camera — see section 9.7)

```ts
sceneRenderer.setQualityTier(tier);
hudRenderer.setQualityTier(tier);
sceneRenderer.setCameraMode(CameraMode.External);
sceneRenderer.orbitCamera(deltaYawRad, deltaPitchRad, deltaZoomM);
```

### 3.8 Teardown

```ts
sceneRenderer.dispose();
hudRenderer.dispose();
```

All exported constants (`RENDER_QUALITY_TABLE`, `CameraMode`, `COCKPIT_EYE_OFFSET_BODY_M`, `CHASE_CAM_DISTANCE_M`, `CHASE_CAM_HEIGHT_M`, `CHASE_CAM_SMOOTHING_TAU_SEC`, `EXTERNAL_ORBIT_*`, `FLYBY_*`, `CAMERA_NEAR_M`/`CAMERA_FAR_M`, `WireframeModel`/`WireframeGroup`, `WIREFRAME_CONTROL_GROUP_NAMES`, `GEAR_TRAVEL_RAD`, `EffectKind`, `WARNING_DISPLAY`, `GUN_MUZZLE_VELOCITY_MPS`, `GUN_MAX_EFFECTIVE_RANGE_M`, `WEAPON_DISPLAY_LABEL`, `CameraState`) are consumed as **data**, not called — `src/ui` may also read `RENDER_QUALITY_TABLE` for its settings screen (section 9.8).

## 4. Design & algorithms

### 4.1 Snapshot ingestion & interpolation

Both `SceneRenderer.ingestSnapshot` and `HudRenderer.ingestSnapshot` receive the **same** `Float64Array view` (length `SNAPSHOT_FLOATS`, from `core.ts`). Each keeps its **own** double buffer (`prev`, `curr`), each a struct-of-arrays sized `MAX_ENTITIES` (allocated once at construction):

```ts
interface SnapshotFrame {
  tick: number;
  simTimeSec: number;
  arrivalMs: number;      // performance.now() when ingested, real wall clock
  entityCount: number;
  playerSlot: number;     // index into the arrays below, or -1
  id: Float64Array;       // length MAX_ENTITIES
  kind: Uint8Array;
  team: Uint8Array;
  alive: Uint8Array;
  posX: Float64Array; posY: Float64Array; posZ: Float64Array;
  rotX: Float32Array; rotY: Float32Array; rotZ: Float32Array; rotW: Float32Array;
  elevonL: Float32Array; elevonR: Float32Array; rudder: Float32Array;
  gearPos: Float32Array; throttle: Float32Array; afterburnerOn: Uint8Array;
  hud: Float64Array;      // length HUD_BLOCK_FLOATS, copy of the HUD block, curr only
}
```

`ingestSnapshot(view)` algorithm (allocation-free — every array above is pre-sized, this function only writes into existing slots):

1. Swap object references: `[prev, curr] = [curr, prev]` (curr now holds what was prev's storage, about to be overwritten — no allocation).
2. `curr.tick = view[SnapshotHeader.TICK_OFFSET]`, `curr.simTimeSec = view[SnapshotHeader.SIM_TIME_SEC_OFFSET]`, `curr.entityCount = view[SnapshotHeader.ENTITY_COUNT_OFFSET]`, `curr.playerSlot = view[SnapshotHeader.PLAYER_INDEX_OFFSET]`, `curr.arrivalMs = performance.now()`.
3. For `i` in `0 .. curr.entityCount-1`: read each field via `view[entityFieldOffset(i, SnapshotEntity.<FIELD>)]` into `curr.<field>[i]` (12 field reads per entity; `KIND`/`TEAM`/`ALIVE`/`AFTERBURNER_ON` cast to the narrower typed arrays, `FLAGS` is read but not stored unless a widget needs it — `SceneRenderer` stores it for `EntityFlag.OnGround`-driven gear-dust cosmetics, an optional embellishment, not load-bearing).
4. Copy the 23-float HUD block into `curr.hud` via `HUD_BLOCK_START + SnapshotHud.<FIELD>`.
5. Rebuild the id-match table (section "Entity id matching" below) from `curr`'s ids, using `prev` as the id source to match against.

**Entity id matching (why, and the exact algorithm).** Section 6.2 of `00-architecture.md` states the entity-block region is a **dense list rebuilt every snapshot**, not indexed by pool slot — so "entity at array index 5" in `curr` is not necessarily the same underlying entity as "index 5" in `prev`. Interpolating positions/rotations by raw array index would visibly teleport-blend unrelated entities whenever the live entity count changes between two snapshots (any spawn or despawn). Entities must be matched **by `EntityId` equality**. Because neither `packEntityId`/`unpackEntityId`'s concrete formula nor an importable function is available outside `src/core` (`core.ts` only fixes the *type* `UnpackEntityId`, and `ENTITY_INDEX_RADIX = 65536` is the only concrete number given), this module does **not** depend on decoding the id's index/generation components at all. Instead it uses a pre-allocated `Int32Array(ENTITY_INDEX_RADIX)` (256 KB, one-time allocation) as a direct hash keyed by `id % ENTITY_INDEX_RADIX`, with an **exact full-id re-check** to reject hash collisions (two different ids that happen to share the same low bits, e.g. after a pool slot's generation increments):

```ts
// one-time state, per SceneRenderer/HudRenderer instance:
const idHashTable = new Int32Array(ENTITY_INDEX_RADIX).fill(-1); // key -> prevArrayIndex
let touchedKeysCount = 0;
const touchedKeys = new Int32Array(MAX_ENTITIES); // to clear idHashTable cheaply next time

function rebuildMatchTable(prev: SnapshotFrame) {
  for (let k = 0; k < touchedKeysCount; k++) idHashTable[touchedKeys[k]] = -1; // O(<=400), not O(65536)
  touchedKeysCount = 0;
  for (let i = 0; i < prev.entityCount; i++) {
    const key = prev.id[i] % ENTITY_INDEX_RADIX;
    idHashTable[key] = i;
    touchedKeys[touchedKeysCount++] = key;
  }
}

function findPrevSlot(prev: SnapshotFrame, currId: number): number {
  const key = currId % ENTITY_INDEX_RADIX;
  const candidate = idHashTable[key];
  if (candidate === -1) return -1;
  return prev.id[candidate] === currId ? candidate : -1; // exact-id re-check rejects collisions
}
```

**Interpolation, per drawn entity, each `renderFrame(nowMs)`:**

```
f = clamp((nowMs - curr.arrivalMs) / (1000 / SNAPSHOT_HZ), 0, 1)   // SNAPSHOT_HZ = 60, from core.ts
```

`f` is **clamped to 1, never extrapolated** past the newest snapshot — this is this module's finalization of the "extrapolation vs hold" choice `00-architecture.md` section 4 left open. Rationale: extrapolating risks visible overshoot on a hard manoeuvre or a missile impact; a ≤ 1‑snapshot-period (≤ 16.7 ms) hold is imperceptible and strictly safer.

For each `i` in `0..curr.entityCount-1` with `curr.alive[i] === 1`:
- `prevSlot = findPrevSlot(prev, curr.id[i])`.
- If `prevSlot >= 0`: `pos = lerp3(prev.pos[prevSlot], curr.pos[i], f)`, `rot = quatNlerp(prev.rot[prevSlot], curr.rot[i], f)`, and every scalar (`elevonL`, `elevonR`, `rudder`, `gearPos`, `throttle`) similarly lerped.
- Else (no match — newly spawned this snapshot, or the very first snapshot): use `curr`'s raw values directly, no blending.
- Entities with `curr.alive[i] === 0`, or entities present in `prev` but absent from `curr` (despawned), are simply not drawn this frame — no fade-out is performed by this module; `kill`/`crash`/`explosion` `SimEvent`s (section 4.12) are the sole visual cue for destruction.

**`lerp3` and `quatNlerp` (exact formulas, `src/render/mathInternal.ts` and `src/hud/mathInternal.ts`, identical in both):**

```ts
function lerp3(a: Vec3Like, b: Vec3Like, t: number, out: Vec3Like): Vec3Like {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

function quatNlerp(a: QuatLike, b: QuatLike, t: number, out: QuatLike): QuatLike {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (a.x * bx + a.y * by + a.z * bz + a.w * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; } // shortest path
  const x = a.x + (bx - a.x) * t, y = a.y + (by - a.y) * t, z = a.z + (bz - a.z) * t, w = a.w + (bw - a.w) * t;
  const len = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  out.x = x / len; out.y = y / len; out.z = z / len; out.w = w / len;
  return out;
}
```

`src/hud` only needs `quatNlerp` for the (optional) target-entity orientation used by the radar-scope aspect indicator (section 4.7); every other HUD scalar is lerped with the same `lerp` used for `lerp3`'s components.

### 4.2 Camera modes

All four modes compute a camera **world position** `camPos` (float64) and a camera **world orientation** (as a quaternion, built from the player's interpolated `rot` plus a mode-specific offset rotation), from the interpolated player entity (`curr.playerSlot`, or `prev`-matched via section 4.1). `src/render/cameraModes.ts` exposes one pure function per mode plus a dispatcher; `SceneRenderer.renderFrame` calls the dispatcher once.

- **Cockpit** (`CameraMode.Cockpit`): `camPos = playerPos + rotate(playerRot, COCKPIT_EYE_OFFSET_BODY_M)`; camera orientation = `playerRot` directly (no offset rotation). FOV = `COCKPIT_VERTICAL_FOV_DEG` (75°). The wireframe aircraft renderer still draws the player's own model (there is no cockpit interior mesh in this placeholder project) — this is an accepted placeholder-model limitation, not a bug.
- **Chase** (`CameraMode.Chase`): target pose = `playerPos - rotate(playerRot, {x:0,y:0,z:0}) ...` more precisely: `desiredPos = playerPos - forwardWorld*CHASE_CAM_DISTANCE_M + {0, CHASE_CAM_HEIGHT_M, 0}` where `forwardWorld = rotate(playerRot, {x:1,y:0,z:0})` (body +X is nose, per `00-architecture.md` section 3.2). The camera **eases** toward `desiredPos` rather than snapping, to avoid jitter from snapshot interpolation noise, using exponential smoothing with time constant `CHASE_CAM_SMOOTHING_TAU_SEC` (0.15 s):
  ```
  alpha = 1 - exp(-frameDtSec / CHASE_CAM_SMOOTHING_TAU_SEC)
  smoothedPos += (desiredPos - smoothedPos) * alpha
  ```
  Camera looks at `playerPos + {0, 1, 0}` (a small up-offset so the horizon sits naturally rather than the camera pitching to stare at the aircraft's CG). FOV = `CHASE_VERTICAL_FOV_DEG` (60°).
- **External** (`CameraMode.External`): orbit camera around `playerPos` at spherical coordinates `(radiusM, yawRad, pitchRad)`, state owned by `SceneRenderer`, mutated only by `orbitCamera(deltaYawRad, deltaPitchRad, deltaZoomM)`: `yawRad += deltaYawRad`, `pitchRad = clamp(pitchRad + deltaPitchRad, -1.4, 1.4)` (±80°, avoids gimbal flip at the poles), `radiusM = clamp(radiusM + deltaZoomM, EXTERNAL_ORBIT_MIN_RADIUS_M, EXTERNAL_ORBIT_MAX_RADIUS_M)`. Initial state: `radiusM = EXTERNAL_ORBIT_DEFAULT_RADIUS_M` (25 m), `pitchRad = EXTERNAL_ORBIT_DEFAULT_PITCH_RAD` (0.35 rad), `yawRad = 0`. `camPos = playerPos + {x: radiusM*cos(pitchRad)*sin(yawRad), y: radiusM*sin(pitchRad), z: -radiusM*cos(pitchRad)*cos(yawRad)}`, camera looks at `playerPos`. FOV = `EXTERNAL_VERTICAL_FOV_DEG` (60°).
- **Flyby** (`CameraMode.Flyby`): the camera is placed **world-fixed** (not attached to the aircraft) ahead of the player's current velocity direction, and stays fixed while the aircraft flies past, giving a cinematic pass-by shot: on entering the mode, or whenever `|playerPos - flybyFixedPos| > FLYBY_RESET_DISTANCE_M` (400 m) **and** the aircraft is now behind the camera (`dot(playerPos - flybyFixedPos, velWorldNormalized) < 0`), recompute `flybyFixedPos = playerPos + velWorldNormalized*FLYBY_PLACEMENT_DISTANCE_M + {0, FLYBY_HEIGHT_OFFSET_M, 0}` (velocity direction normalized; if speed < 1 m/s, fall back to `forwardWorld`). Camera always looks at the live, interpolated `playerPos`. FOV = `FLYBY_VERTICAL_FOV_DEG` (45°, a longer "lens" for a cinematic feel).

All modes set `THREE.PerspectiveCamera.near = CAMERA_NEAR_M` (0.1 m), `.far = CAMERA_FAR_M` (40000 m — chosen generously larger than any tier's terrain draw distance in metres; this module has no visibility into `src/terrain`'s actual chunk-size-in-metres constant, so this is a deliberately conservative, independent choice, see section 9.9), `.fov` per mode above, `.aspect = widthPx/heightPx` (updated on `resize`).

### 4.3 Floating origin

State: `renderOriginWorld: {x,y,z}` (float64), initialized to the first ingested player position (or `{0,0,0}` if no snapshot has arrived yet — nothing is drawn before the first snapshot regardless). Once per `renderFrame`, **after** the camera position for this frame is computed (section 4.2):

```
dx = camPos.x - renderOriginWorld.x
dy = camPos.y - renderOriginWorld.y
dz = camPos.z - renderOriginWorld.z
if (sqrt(dx*dx + dy*dy + dz*dz) > FLOATING_ORIGIN_REBASE_DISTANCE_M) {  // 4000, core.ts, strict >
  renderOriginWorld = { x: camPos.x, y: camPos.y, z: camPos.z };        // copy, not the same object
}
```

For every drawable object this frame (aircraft, bullets, missiles, effects, terrain-chunk root groups, airport line geometry), the Three.js local position assigned is `absoluteWorldPos - renderOriginWorld` (a float64 subtraction of two numbers within `FLOATING_ORIGIN_REBASE_DISTANCE_M` of each other by construction, so the result is always small — safe to hand to Three.js, which stores it as float32 internally). Because every drawable is repositioned from its absolute source value **every frame** (nothing accumulates a delta), a rebase requires no special-case "shift everything" step — the very next frame's normal per-object positioning already uses the new origin.

### 4.4 Wireframe aircraft articulation

For every alive, `kind === 'aircraft'` entity in `curr` (after interpolation, section 4.1), `wireframeAircraftRenderer.ts` maintains one `THREE.LineSegments` built once from the registered `WireframeModel`'s `edges` (a fixed index buffer, built once) over a **per-entity, per-frame-rewritten** position buffer (length `vertices.length`, `vertexIndices` from `groups` may overlap — a vertex belongs to at most one group in practice but nothing prevents more).

Each frame, for that entity:
1. Start from the model's rest-pose `vertices` (body-frame, m) — always re-derive from rest pose, never rotate an already-rotated buffer (avoids drift/accumulated error).
2. For each `group` in `model.groups`, compute `theta` (rad) from the group's `name` (exact string match against `WIREFRAME_CONTROL_GROUP_NAMES`; any other name → `theta = 0`, vertices left at rest pose):

   | `group.name` | driving field (interpolated) | `theta` |
   |---|---|---|
   | `elevonL` | `elevonL` | `theta = elevonL` (rad, direct — entity field's own "+ = trailing edge down" convention) |
   | `elevonR` | `elevonR` | `theta = elevonR` |
   | `rudder` | `rudder` | `theta = rudder` |
   | `noseGear` | `gearPos` | `theta = gearPos * GEAR_TRAVEL_RAD` |
   | `mainGearL` | `gearPos` | `theta = gearPos * GEAR_TRAVEL_RAD` |
   | `mainGearR` | `gearPos` | `theta = gearPos * GEAR_TRAVEL_RAD` |
   | anything else | — | `theta = 0` |

   Gear rest pose (`gearPos = 0`) is assumed **fully retracted**; `GEAR_TRAVEL_RAD` = 1.7453293 rad (100°) is this module's own placeholder swing angle (section 9.2/9.3 document the risk that `src/aircraft`'s actual authored rest pose may not match this assumption).
3. For each vertex index `v` in `group.vertexIndices`, rotate the rest-pose point about `group.pivotBodyM` along `group.axisBody` by `theta`, via Rodrigues' rotation formula (this is the exact formula `src/render/mathInternal.ts#rotateVecByAxisAngle` must implement):
   ```
   p = vertices[v] - pivotBodyM
   p_rot = p*cos(theta) + cross(axisBody, p)*sin(theta) + axisBody*dot(axisBody, p)*(1 - cos(theta))
   vertexBody[v] = p_rot + pivotBodyM
   ```
   (`axisBody` is assumed unit-length per its doc comment; defensively normalize if `|axisBody| ` is not within `1e-6` of 1.)
4. Transform every `vertexBody[v]` (articulated or not) to render space: `vertexRender[v] = rotate(entityRot, vertexBody[v]) + (entityPos - renderOriginWorld)` — `entityRot`/`entityPos` are this entity's **interpolated** values from section 4.1. `rotate(q, v)` here may use `THREE.Quaternion.prototype` (this file is inside `src/render`, Three.js is available).
5. Write all `vertexRender` values into the `LineSegments`' `BufferGeometry.attributes.position` array and call `.needsUpdate = true` (no new `Float32Array` allocated — the attribute buffer is sized once at model-registration time to `vertices.length * 3` and reused for every entity + every frame).

If more aircraft entities are alive than currently have a `LineSegments` object, new ones are created lazily (pooled, capped — see section 6) and reused/hidden (`.visible = false`) rather than disposed when an aircraft despawns, to avoid per-despawn GC pressure.

### 4.5 Terrain chunk consumption

`ingestTerrainChunk(msg: TerrainChunkReadyMessage)`:
1. Key = `` `${msg.chunkX}:${msg.chunkZ}:${msg.lod}` `` (a string key is acceptable here — this runs at chunk-arrival rate, which is bounded by `src/terrain`'s own streaming rate, not a 60/120 Hz hot path).
2. Wrap the three transferred `ArrayBuffer`s directly as `new Float32Array(msg.positions)` / `new Float32Array(msg.normals)` / `new Uint32Array(msg.indices)` — **zero-copy**, these typed-array views become the `THREE.BufferAttribute`/`THREE.BufferGeometry.index` data directly.
3. Build one `THREE.Mesh` using the single shared terrain `ShaderMaterial` (section 4.5.1), parented under a root `Group` whose local position is set every frame from `chunkOriginWorld - renderOriginWorld` (chunk world origin = `(chunkX, 0, chunkZ) * <chunk size>`; since this module does not know `src/terrain`'s chunk-size-in-metres constant, positions are taken as **already world-absolute** inside the `positions` buffer `src/terrain` sent — i.e. this module does not need the chunk size at all, it simply treats every vertex in `msg.positions` as an absolute world-space float32 the terrain worker computed, and offsets the whole mesh's parent group by `-renderOriginWorld` like anything else in section 4.3).
4. Store the mesh in a `Map<string, THREE.Mesh>` keyed by the string from step 1.

`evictTerrainChunk(chunkX, chunkZ, lod)`: look up the same key, remove the mesh from the scene, call `.geometry.dispose()` (the buffer attributes came from transferred `ArrayBuffer`s that are otherwise unreferenced and will be GC'd — no manual `ArrayBuffer` freeing exists in JS). No-op if the key is absent (already evicted, or never ingested — both are valid caller states per the contract's doc comment).

**4.5.1 Terrain material.** One shared `THREE.ShaderMaterial` instance for **all** chunks at all LODs (not per-chunk), colouring by altitude and slope, computed per-vertex in the vertex shader and interpolated (cheap, avoids a texture fetch):

```glsl
// vertex shader (excerpt) — normal is per-vertex from msg.normals
varying float vAltitudeM;
varying float vSlope; // 0 = flat, 1 = vertical
void main() {
  vAltitudeM = position.y; // local render-space y ≈ world altitude (renderOriginWorld.y shift is small vertically in practice)
  vSlope = 1.0 - dot(normalize(normal), vec3(0.0, 1.0, 0.0));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
```
```glsl
// fragment shader (excerpt)
uniform vec3 uFogColor; uniform float uFogStart; uniform float uFogEnd;
varying float vAltitudeM; varying float vSlope;
vec3 altitudeColor(float altM) {
  if (altM < 0.0)    return vec3(0.76, 0.70, 0.50); // below-sea-level / flattened-zone sand
  if (altM < 200.0)  return mix(vec3(0.20,0.45,0.15), vec3(0.35,0.55,0.20), altM/200.0); // lowland green
  if (altM < 1200.0) return mix(vec3(0.35,0.55,0.20), vec3(0.45,0.40,0.30), (altM-200.0)/1000.0); // hill brown
  return mix(vec3(0.45,0.40,0.30), vec3(0.95,0.95,0.97), clamp((altM-1200.0)/800.0, 0.0, 1.0)); // rock -> snow cap above ~2000m
}
void main() {
  vec3 base = mix(altitudeColor(vAltitudeM), vec3(0.5, 0.47, 0.45), clamp(vSlope*1.6, 0.0, 1.0)); // steep slopes -> grey rock regardless of altitude
  float fogT = clamp((length(vViewPos) - uFogStart) / max(uFogEnd - uFogStart, 1.0), 0.0, 1.0);
  gl_FragColor = vec4(mix(base, uFogColor, fogT), 1.0);
}
```
`uFogStart`/`uFogEnd` are updated from `RENDER_QUALITY_TABLE[tier].fogStartM/fogEndM` on `setQualityTier`. Shadow receiving is enabled on this material only when `RENDER_QUALITY_TABLE[tier].shadowsEnabled`.

### 4.6 Camera state & world→screen projection (shared by target box + lead sight)

`SceneRenderer.renderFrame` returns, every call:

```ts
camera.originWorld = { ...renderOriginWorld };           // copy, float64
camera.worldPos = { ...thisFrameCamPos };                 // copy, float64
threeCamera.updateMatrixWorld();
threeCamera.matrixWorldInverse.copy(threeCamera.matrixWorld).invert();
projMatrix.multiplyMatrices(threeCamera.projectionMatrix, threeCamera.matrixWorldInverse);
camera.viewProjectionMatrix = projMatrix.elements; // THREE.Matrix4.elements: length-16, column-major
```

`src/hud/targetBox.ts#projectWorldToScreen` (the one function both the target box and the lead-sight pipper call) implements, exactly:

```ts
function projectWorldToScreen(
  camera: CameraState, worldPosAbs: Vec3Like, canvasWidthPx: number, canvasHeightPx: number,
  out: { xPx: number; yPx: number; visible: boolean }
): typeof out {
  const lx = worldPosAbs.x - camera.originWorld.x;
  const ly = worldPosAbs.y - camera.originWorld.y;
  const lz = worldPosAbs.z - camera.originWorld.z;
  const m = camera.viewProjectionMatrix;
  const clipX = m[0]! * lx + m[4]! * ly + m[8]!  * lz + m[12]!;
  const clipY = m[1]! * lx + m[5]! * ly + m[9]!  * lz + m[13]!;
  const clipW = m[3]! * lx + m[7]! * ly + m[11]! * lz + m[15]!;
  if (clipW <= 1e-6) { out.visible = false; return out; }
  const ndcX = clipX / clipW, ndcY = clipY / clipW;
  out.xPx = (ndcX * 0.5 + 0.5) * canvasWidthPx;
  out.yPx = (1 - (ndcY * 0.5 + 0.5)) * canvasHeightPx;
  out.visible = ndcX >= -1.2 && ndcX <= 1.2 && ndcY >= -1.2 && ndcY <= 1.2; // small margin past clip edge
  return out;
}
```

`m[i]!` uses `noUncheckedIndexedAccess`-safe non-null assertions because `viewProjectionMatrix` is contractually length-16.

### 4.7 Radar scope (simplified — see section 9.4 for the documented realism gap)

`src/hud/radarScope.ts` draws a top-down, 360°, player-centred scope of radius `RADAR_SCOPE_RENDER_PX` (section 5) covering ground range `RADAR_SCOPE_RANGE_M = 20000` m. Because `Contact[]` (the sensor-realistic list `src/combat` computes) has no delivery channel into the 60 Hz snapshot or the `SimEvent` stream, this widget instead scans `curr`'s own entity arrays directly:

```
for i in 0..curr.entityCount-1:
  if curr.kind[i] not in {aircraft, missile} or curr.alive[i] == 0 or i == curr.playerSlot: continue
  relWorld = { curr.pos[i] - player.pos }
  rangeM = |relWorld|
  if rangeM > RADAR_SCOPE_RANGE_M: continue
  bearingRad = atan2( dot(relWorld, rightWorld), dot(relWorld, forwardWorld) )   // rightWorld/forwardWorld from player's interpolated rot
  candidates.push({ id: curr.id[i], team: curr.team[i], rangeM, bearingRad })
sort candidates by rangeM ascending
take the first RENDER_QUALITY_TABLE[tier].radarScopeContactCap of them
```

For each kept candidate, scope-relative screen position (scope centred at `(scopeCx, scopeCy)`, scope draw radius `scopeRPx`):
```
scopeX = scopeCx + sin(bearingRad) * (rangeM / RADAR_SCOPE_RANGE_M) * scopeRPx
scopeY = scopeCy - cos(bearingRad) * (rangeM / RADAR_SCOPE_RANGE_M) * scopeRPx
```
(`bearingRad = 0` ⇒ straight ahead ⇒ top of the scope, matching heading-up convention.) Dot colour: `team === player's own team` → friendly colour, else hostile colour (both teams' identity is read straight from the snapshot's `TEAM` field — no false-contact/IFF simulation).

### 4.8 Lead-computing gunsight (reads `src/combat`'s real solution off the wire — no local ballistics)

`src/hud` computes NO ballistics of its own. `core.ts`'s Snapshot HUD block carries four additional floats written by `src/core` every tick from that tick's player `CombatStatus.aimPointWorld`/`aimPointValid` (themselves `src/combat`'s real, gravity-drop-compensated `computeLeadSolution` output — see `contracts/core.ts` section 6.3 and 07-combat.md section 4.3): `PIPPER_X`/`PIPPER_Y`/`PIPPER_Z` (world-space aim point) and `PIPPER_VALID` (0 or 1). `readSnapshotHud` (module 10) already exposes these on the `SnapshotHudView` it hands `src/hud` (`pipperX`/`pipperY`/`pipperZ`/`pipperValid`).

The pipper is drawn when **all** of: `hud.pipperValid !== 0`, `WEAPON_IDX === WeaponKindCode.gun` (0), and `TARGET_RANGE_M <= GUN_MAX_EFFECTIVE_RANGE_M` (1800 m — `src/combat` may resolve `aimPointWorld` against a contact even when the gun isn't the selected weapon, per 07-combat.md section 4.3's "regardless of `selectedWeapon`" rule, so this widget still gates on the two HUD-visible conditions itself):

```
pipperWorld = { x: hud.pipperX, y: hud.pipperY, z: hud.pipperZ }
{ screenX, screenY, visible } = projectWorldToScreen(camera, pipperWorld, screenWidthPx, screenHeightPx)   // section 4.6
```
If `!visible`, nothing is drawn this frame. `GUN_MUZZLE_VELOCITY_MPS`/`GUN_MAX_EFFECTIVE_RANGE_M` (`contracts/render.ts`) are the only gun-related constants this widget still touches, and only for the effective-range gate above and for documentation — the muzzle velocity itself is never used in a local formula, so it cannot drift from `src/combat`'s real value (both are fixed at 715 m/s, the GSh-23's actual muzzle velocity, in their respective contract files).

The **target box** (drawn whenever `TARGET_ID !== NO_ENTITY_ID` and found, regardless of selected weapon) is simply `projectWorldToScreen(camera, targetPos, ...)` (current position, not predicted) with a fixed-size square (`TARGET_BOX_SIZE_PX`, section 5) centred on the result, plus a small text readout of `TARGET_RANGE_M` and `CLOSURE_MPS` from the HUD block next to it.

### 4.9 Ladder, flight-path marker, tapes, weapon status, warnings

**Pitch ladder + FPM** (`src/hud/ladder.ts`), using only HUD-block telemetry (`PITCH_RAD`, `ROLL_RAD`, `AOA_RAD`, `BETA_RAD`) — independent of the 3D camera, drawn only when the active camera mode is `Cockpit` or `Chase` (external/flyby views hide the HUD ladder/tapes entirely, since they no longer represent "what the pilot sees"; the target box/lead-sight/warnings/weapon-status remain visible in all modes):

```
HUD_BORESIGHT_FOV_VERT_DEG = 30   // total vertical angular span the ladder maps across the canvas height
pxPerRad = (canvasHeightPx * 0.5) / (HUD_BORESIGHT_FOV_VERT_DEG * 0.5 * DEG2RAD)
screenYForPitchRung(rungDeg) = canvasHeightPx*0.5 - (rungDeg*DEG2RAD - PITCH_RAD) * pxPerRad
```
Rungs drawn every 10° from -90° to +90° (`PITCH_LADDER_RUNG_STEP_DEG = 10`); the whole ladder group is rotated about the screen centre by `-ROLL_RAD` (rotating opposite the aircraft's roll keeps the rungs horizon-referenced). FPM offset from boresight centre: `fpmXpx = centerX - BETA_RAD*pxPerRad`, `fpmYpx = centerY + AOA_RAD*pxPerRad` (small-angle approximation, adequate near boresight; not valid, and not used, beyond ±30°).

**Speed / altitude / heading tapes** (`src/hud/tapes.ts`): vertical scrolling tapes, `tickScreenY = centerY - (tickValue - currentValue) * pxPerUnit` with `pxPerUnit` and tick spacing from section 5's table; heading tape is the same formula horizontally, wrapped mod 360°.

**Weapon status** (`src/hud/weaponStatus.ts`): displays `WEAPON_DISPLAY_LABEL[WeaponKindByCode[WEAPON_IDX]]` (from `core.ts`'s `WeaponKindByCode` plus this contract's `WEAPON_DISPLAY_LABEL`) and the three ammo counters set by `setWeaponLoadout` and decremented on `ingestEvents`:
```
on gunFire event:            ammoGun = max(0, ammoGun - 1)
on missileLaunch event where weapon === 'ir_missile':     missilesIr = max(0, missilesIr - 1)
on missileLaunch event where weapon === 'radar_missile':  missilesRadar = max(0, missilesRadar - 1)
```
only events whose `shooterId`/relevant id matches the player's own `EntityId` (`curr.id[curr.playerSlot]`) are counted — AI weapon fire must not decrement the player's own ammo display.

**Warnings** (`src/hud/warnings.ts`): each frame, for each entry in `WARNING_DISPLAY` (imported from `render.ts`, sorted by `priority` ascending), test `(WARNING_BITS & entry.bit) !== 0`; draw active ones stacked top-to-bottom in priority order, each flashing at `entry.flashHz` (`flashHz === 0` ⇒ steady) via `visible = entry.flashHz === 0 || Math.floor(nowMs / (500 / entry.flashHz)) % 2 === 0`.

### 4.10 ILS needles

`src/hud/ilsNeedles.ts`: `locOffsetPx = clamp(ILS_LOC, -1, 1) * ILS_NEEDLE_MAX_OFFSET_PX` (horizontal bar), `gsOffsetPx = clamp(ILS_GS, -1, 1) * ILS_NEEDLE_MAX_OFFSET_PX` (vertical bar), both read straight from the HUD block (already normalised to `[-1,1]` by `src/core` per `00-architecture.md` section 6.3 — this widget performs **no** ILS math of its own, unlike the radar scope/lead-sight simplifications above, because the snapshot already carries the finished value).

### 4.11 Sky & fog

`src/render/skyFog.ts` sets `scene.fog = new THREE.Fog(horizonColorHex, fogStartM, fogEndM)` (from `RENDER_QUALITY_TABLE[tier]`) and draws a large inverted sphere ("sky dome") with a vertical gradient shader from `zenithColor` (top) to `horizonColor` (equator) to `groundColor` (bottom, for the below-horizon fill visible from a high external/flyby camera), plus a small emissive disc placed along `sunDirWorld` for the sun. `THREE.DirectionalLight.position` is set to `-sunDirWorld * 10000` looking at the origin (a directional light's position only matters for its direction, magnitude is arbitrary) each time `setSunDirection` is called; shadow-casting is enabled on it only when the active tier's `shadowsEnabled` is true, with `shadow.mapSize` and cascade count driven by `shadowCascades` (1 cascade = a single `PCFSoftShadowMap` sized 2048², 2 cascades = a near 2048² + far 1024² split at a fixed 500 m distance from the camera).

### 4.12 Effects

Three pooled `EffectKind`s, each a fixed-size pool of `THREE.InstancedMesh` instances sized to a per-kind share of `RENDER_QUALITY_TABLE[tier].effectBudget` (40% explosion, 20% muzzle flash, 40% smoke trail, rounded down; e.g. High tier, budget 64 → 25/12/25). Pools are allocated once per tier change (a tier change is a rare, user-initiated event, not a hot path — reallocating the pool then is acceptable). `ingestEvents` maps:

- `explosion` → acquire one pooled explosion instance (or silently drop if the pool is exhausted — never allocate beyond the pool), set its instance matrix to `event.pos - renderOriginWorld`, initial scale near 0, and register it for growth over `EXPLOSION_LIFETIME_SEC` (1.2 s) up to `event.radiusM * EXPLOSION_VISUAL_SCALE` (section 5), with opacity fading out over the same lifetime; release back to the pool on expiry.
- `gunFire` → acquire one pooled muzzle-flash instance at `event.pos`, oriented along `event.dir`, lifetime `MUZZLE_FLASH_LIFETIME_SEC` (0.05 s — a single-frame-ish flash). Actual bullet tracers are **not** a pooled effect — every `kind === 'bullet'` entity in the snapshot is drawn directly each frame as a short line segment from its interpolated position extending `BULLET_TRACER_LENGTH_M` (15 m, section 5) backward along `-velocityDirection`, by `wireframeAircraftRenderer.ts`'s sibling in `effects.ts` (kept in `effects.ts` since bullets have no `WireframeModel`).
- `missileLaunch` → begin a smoke-trail emitter attached to `event.missileId`; each frame while that id remains alive in `curr`, deposit one smoke-trail particle at its current interpolated position no more often than every `SMOKE_TRAIL_EMIT_INTERVAL_SEC` (0.05 s); each deposited particle fades over `SMOKE_TRAIL_PARTICLE_LIFETIME_SEC` (2.5 s) independently. When the missile id is no longer found alive in `curr` (hit or expired), stop emitting new particles; already-deposited ones continue fading on schedule.

All per-effect state (position, age, kind) lives in pre-sized typed arrays parallel to each `InstancedMesh`'s instance count — `ingestEvents`/`renderFrame` never call `new Vector3()`/`new Object3D()` per event; they write into the next free pool slot's existing instance-matrix storage via `InstancedMesh.setMatrixAt`.

### 4.13 Airport line rendering

`setNavDb(navDb: AirportNavDb)` is called once (at mission load). `src/render/airportLines.ts` calls `navDb.listAirports()` once and, for every `RunwayInfo` of every returned `AirportInfo`, builds a static (built once, never rebuilt per-frame) `THREE.LineSegments` runway outline:

```
halfWidth = runway.widthM / 2
p0 = thresholdPos                                              // touchdown end, world-absolute
p1 = thresholdPos + forwardWorld(runway.headingRad) * runway.lengthM   // far end
leftDir  = { x: cos(runway.headingRad), y: 0, z: sin(runway.headingRad) }   // perpendicular to forwardWorld, see note below
rect = [ p0 - leftDir*halfWidth, p0 + leftDir*halfWidth, p1 + leftDir*halfWidth, p1 - leftDir*halfWidth ]
edges: rect[0]-rect[1], rect[1]-rect[2], rect[2]-rect[3], rect[3]-rect[0], plus a centreline p0-p1
```
(`forwardWorld(h) = (sin(h), 0, -cos(h))` per `00-architecture.md` section 3.1; `leftDir` above is `forwardWorld` rotated -90° about +Y, i.e. `(cos(h), 0, sin(h))`, which is indeed perpendicular — verified: `dot(forwardWorld,leftDir) = sin(h)cos(h) - cos(h)sin(h) = 0`.) If `runway.ils` is present, two additional line segments are drawn from `ils.localiserOriginPos`/`ils.glideslopeOriginPos` extending `ILS_GUIDE_LINE_LENGTH_M` (section 5) opposite `ils.localiserHeadingRad`, as a coarse visual approach-guidance cue. Positions are re-offset by `-renderOriginWorld` every frame like any other drawable (section 4.3) — the geometry itself (relative vertex layout) is built once at `setNavDb` time and never rebuilt.

### 4.14 Renderer construction: antialiasing and WebGL context loss

**Antialiasing is ALWAYS post-process, never the native WebGL context flag — this is what makes `setQualityTier` able to switch `RenderQualitySettings.antialias` (`AntiAliasMode.Off`/`Fxaa`/`Msaa4x`) without ever recreating the `WebGLRenderer`.** `createSceneRenderer` constructs `new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })` exactly once, then wraps every frame's draw in a `THREE.EffectComposer` with a `RenderPass` followed by ONE always-present, swappable AA pass:

```
composer = new EffectComposer(renderer)
renderPass = new RenderPass(scene, camera); composer.addPass(renderPass)
fxaaPass = new ShaderPass(FXAAShader); composer.addPass(fxaaPass)   // present in the chain at every tier; its own `enabled` flag toggles
```

`setQualityTier(tier)` sets `fxaaPass.enabled = RENDER_QUALITY_TABLE[tier].antialias !== AntiAliasMode.Off` and, for `AntiAliasMode.Msaa4x` specifically (Ultra only), additionally allocates the composer's internal render target with `{ samples: 4 }` (WebGL2 multisampled renderbuffer, resolved automatically by `EffectComposer`/`WebGLRenderTarget`'s own MSAA support) instead of relying on `fxaaPass` — Ultra therefore gets true MSAA resolve quality while Low/Medium/High share the identical FXAA shader pass, toggled on/off; `fxaaPass.material.uniforms.resolution` is updated on every `resize()` call (section 3.1) to `1/(widthPx*dpr), 1/(heightPx*dpr)`, and the render-target sample count is only ever changed inside `setQualityTier`, never per-frame. No tier transition, in either direction, ever calls `renderer.dispose()`/reconstructs `WebGLRenderer` — every GPU resource (textures, the wireframe's `LineSegments` buffers, terrain chunk geometry already uploaded) survives a quality-tier change untouched.

**WebGL context loss.** `createSceneRenderer` registers, on the same `canvas` passed to it:

```
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); contextLost = true; });
canvas.addEventListener('webglcontextrestored', () => {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  rebuildComposerAndPasses();                 // section above
  reuploadWireframeMaterialAndGeometry();      // re-registers the model most recently passed to registerAircraftModel
  for (const chunk of residentChunkGeometries) uploadChunkToGpu(chunk);   // re-uploads every chunk this renderer had ingested via ingestTerrainChunk before the loss, from its own already-retained CPU-side ChunkGeometry copies — no re-request to the terrain worker needed
  contextLost = false;
});
```

`renderFrame(nowMs)` returns its normal, unchanged `CameraState` (camera math is independent of the GPU context) but skips the actual `composer.render()` call while `contextLost` is true — the canvas simply shows its last frame (browser-painted, unchanged) until `webglcontextrestored` fires, typically within one to a few frames on iOS Safari/Android Chrome after a backgrounding-induced loss (the single largest cause of context loss on the mobile targets this project lists explicitly, per the product brief). `main.ts` (module 10) needs no changes for this: it keeps calling `renderFrame`/`chunkManager.update` every animation frame exactly as before (`10-core-worker.md` section 4.10.4) — the renderer's internal `contextLost` gating and GPU-resource rebuild are entirely private to `src/render`, not exposed through `SceneRenderer`'s contract surface (no new interface method — a context loss is, by design, invisible to every caller except as a few skipped/stale-looking frames).

## 5. Data

**Table 5.1 — `RENDER_QUALITY_TABLE`** (restated from `contracts/render.ts`; the six architecture-sourced columns are normative and must not be changed by an implementer):

| tier | draw dist (chunks) | LOD depth | shadows | cascades | effect budget | AA | pixel-ratio cap | radar cap | target FPS | fog start (m) | fog end (m) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| low | 6 | 3 | off | 0 | 16 | off | 1.0 | 8 | 30 | 1500 | 5000 |
| medium | 10 | 4 | off | 0 | 32 | fxaa | 1.5 | 16 | 45 | 2500 | 8000 |
| high | 16 | 5 | on | 1 | 64 | fxaa | 2.0 | 32 | 60 | 4000 | 13000 |
| ultra | 24 | 6 | on | 2 | 128 | msaa4x | 2.0 | 32 | 60 | 6000 | 20000 |

**Table 5.2 — camera constants**

| constant | value | unit | justification |
|---|---|---|---|
| `COCKPIT_EYE_OFFSET_BODY_M` | (0.35, 1.05, 0) | m, body-frame | slightly forward/up of the aircraft origin — approximates a fighter canopy eye point; no public Tejas cockpit-station drawing was available (see section 9.1) |
| `CHASE_CAM_DISTANCE_M` | 15 | m | typical third-person "chase" framing for a ~13 m-long fighter |
| `CHASE_CAM_HEIGHT_M` | 4 | m | keeps horizon visible above the aircraft silhouette |
| `CHASE_CAM_SMOOTHING_TAU_SEC` | 0.15 | s | ~63% convergence per 150 ms — smooths snapshot-interpolation jitter without feeling laggy |
| `EXTERNAL_ORBIT_DEFAULT_RADIUS_M` | 25 | m | fits the whole aircraft in frame at `EXTERNAL_VERTICAL_FOV_DEG` |
| `EXTERNAL_ORBIT_MIN/MAX_RADIUS_M` | 8 / 150 | m | close inspection to wide formation shot |
| `EXTERNAL_ORBIT_DEFAULT_PITCH_RAD` | 0.35 (~20°) | rad | a flattering three-quarter angle |
| `FLYBY_PLACEMENT_DISTANCE_M` | 300 | m | far enough the aircraft is fully visible approaching |
| `FLYBY_HEIGHT_OFFSET_M` | 15 | m | camera slightly above flight path, avoids a flat head-on silhouette |
| `FLYBY_RESET_DISTANCE_M` | 400 | m | camera re-places once the aircraft is clearly past it |
| `CAMERA_NEAR_M` / `CAMERA_FAR_M` | 0.1 / 40000 | m | far plane exceeds any tier's practical terrain draw distance (see section 9.9) |
| `COCKPIT_VERTICAL_FOV_DEG` | 75 | deg | wide, immersive cockpit FOV |
| `CHASE_VERTICAL_FOV_DEG` / `EXTERNAL_VERTICAL_FOV_DEG` | 60 | deg | standard third-person FOV |
| `FLYBY_VERTICAL_FOV_DEG` | 45 | deg | longer lens, cinematic compression |

**Table 5.3 — wireframe articulation**

| constant | value | unit | justification |
|---|---|---|---|
| `GEAR_TRAVEL_RAD` | 1.7453293 (100°) | rad | round placeholder gear-swing arc; real Tejas gear kinematics are not modelled at the wireframe level (section 9.2) |

**Table 5.4 — target box / lead sight**

| constant | value | unit | justification |
|---|---|---|---|
| `TARGET_BOX_SIZE_PX` | 40 | px | comfortably visible at typical HUD viewing distance |
| `GUN_MUZZLE_VELOCITY_MPS` | 715 | m/s | the real GSh-23 muzzle velocity — kept here only as a fixed, matching reference/documentation constant; MUST equal `contracts/combat.ts`'s own `GUN_MUZZLE_VELOCITY_MPS` (module 07's authoritative ballistics value), since section 4.8's pipper no longer computes its own lead solution from this module's copy (see section 9.4) |
| `GUN_MAX_EFFECTIVE_RANGE_M` | 1800 | m | typical short-range cannon employment envelope |

**Table 5.5 — radar scope**

| constant | value | unit |
|---|---|---|
| `RADAR_SCOPE_RANGE_M` | 20000 | m |
| `RADAR_SCOPE_RENDER_PX` | 90 | px (on-screen scope radius, before `devicePixelRatio` scaling) |

**Table 5.6 — tapes / ladder**

| constant | value | unit |
|---|---|---|
| `HUD_BORESIGHT_FOV_VERT_DEG` | 30 | deg (total vertical span the ladder/FPM map maps across canvas height) |
| `PITCH_LADDER_RUNG_STEP_DEG` | 10 | deg |
| `SPEED_TAPE_PX_PER_MPS` | 4 | px per m/s |
| `SPEED_TAPE_MINOR_TICK_MPS` / `MAJOR_TICK_MPS` | 10 / 50 | m/s |
| `ALT_TAPE_PX_PER_M` | 0.6 | px per m |
| `ALT_TAPE_MINOR_TICK_M` / `MAJOR_TICK_M` | 20 / 100 | m |
| `HEADING_TAPE_PX_PER_DEG` | 6 | px per deg |
| `ILS_NEEDLE_MAX_OFFSET_PX` | 80 | px (at `\|ILS_LOC\|`/`\|ILS_GS\|` == 1) |
| `ILS_GUIDE_LINE_LENGTH_M` | 3000 | m |

**Table 5.7 — effects**

| constant | value | unit |
|---|---|---|
| `EXPLOSION_LIFETIME_SEC` | 1.2 | s |
| `EXPLOSION_VISUAL_SCALE` | 1.0 | dimensionless (visual radius == `event.radiusM` at peak) |
| `MUZZLE_FLASH_LIFETIME_SEC` | 0.05 | s |
| `BULLET_TRACER_LENGTH_M` | 15 | m |
| `SMOKE_TRAIL_EMIT_INTERVAL_SEC` | 0.05 | s |
| `SMOKE_TRAIL_PARTICLE_LIFETIME_SEC` | 2.5 | s |
| effect pool split | 40% / 20% / 40% | of `effectBudget`, explosion/muzzleFlash/smokeTrail, floored |

**Table 5.8 — `WIREFRAME_CONTROL_GROUP_NAMES`** (from the contract, restated): `elevonL`, `elevonR`, `rudder`, `noseGear`, `mainGearL`, `mainGearR` — the six and only six group names this module animates (section 4.4, section 9.2).

**Table 5.9 — sky colours** (hex, sRGB): zenith `#3a6ea8`, horizon `#bcd4e8`, ground `#7a6a52`, sun disc `#fff6e0`. Purely cosmetic defaults; not load-bearing for any test.

## 6. Performance budget

Per `00-architecture.md` section 2, code invoked once per rendered frame inside `src/render`/`src/hud` is a **hot path**: no `new`, no `.map`/`.filter`/`.slice`/spread, no closures allocated inside the frame loop. Concretely:

- `ingestSnapshot`: O(`entityCount`) ≤ O(400) field copies into pre-sized typed arrays, plus the O(≤400) id-hash-table rebuild (section 4.1) — target **< 0.3 ms** on a mid-range mobile device (entityCount is typically ≤ 50 in an actual mission; 400 is the hard ceiling).
- `renderFrame` (SceneRenderer): interpolation + camera + floating-origin + wireframe vertex recompute (≤ ~200 vertices × ≤ ~20 alive aircraft ≈ 4000 float ops) + terrain/effects draw-call submission. Target **< 2 ms** JS-side (excluding actual GPU/WebGL draw time, which is bounded by the quality tier's `terrainDrawDistanceChunks`/`shadowsEnabled`/`antialias` settings, not this module's JS logic) on Medium tier's 45 fps (22.2 ms) budget, leaving headroom for GPU work and other systems (input/AI/physics run in a separate worker and do not compete for main-thread time, but `src/ui`/`src/hud` share it).
- `renderFrame` (HudRenderer): O(1) widget draws on a 2D canvas (ladder ~20 line segments, two tapes, scope ≤ `radarScopeContactCap` dots, warnings ≤ 10 rows). Target **< 1 ms**.
- Terrain chunk vertex/index buffers are **not copied** (section 4.5, zero-copy from the transferred `ArrayBuffer`); GPU memory scales with `terrainDrawDistanceChunks`, bounded per tier by that same table.
- Wireframe `LineSegments` objects and effect `InstancedMesh` pools are sized once (at model registration / tier change respectively) and never resized in the frame loop; an exhausted pool silently drops the newest request rather than growing (section 4.12).
- Mobile-specific: `pixelRatioCap` (Table 5.1) bounds the actual framebuffer resolution independent of `window.devicePixelRatio`, which is the dominant GPU-fill-rate cost lever on high-DPI phones; HUD canvas is sized in CSS pixels and scaled by the same capped ratio, not the raw device ratio, for the same reason.

## 7. Unit tests to write

All tests target pure, DOM/WebGL-independent functions exported from the listed files specifically so they run under plain Node + vitest (no `jsdom`, no WebGL context). Module 12 DOES include these (`12-verification.md` section 2, resolved from an earlier over-broad exclusion — see that document's section 9 item 3), so the file paths/assertions below are the actual, final test content, not a fallback.

- **`tests/render/floatingOrigin.test.ts`**
  - `shouldRebase({x:0,y:0,z:0}, {x:4000,y:0,z:0})` → `false` (distance exactly 4000, strict `>` required).
  - `shouldRebase({x:0,y:0,z:0}, {x:4000.001,y:0,z:0})` → `true`.
  - `localPos({x:12345678.125,y:500,z:-2000000},{x:12345688.125,y:505,z:-2000003})` → `{x:10,y:5,z:-3}` exactly (`toBeCloseTo` with 9 decimal digits).
- **`tests/render/snapshotInterpolation.test.ts`**
  - `lerp(0, 10, 0.25)` === `2.5`.
  - `quatNlerp({x:0,y:0,z:0,w:1}, {x:0,y:0.7071068,z:0,w:0.7071068}, 0.5)` ≈ `{x:0,y:0.3826834,z:0,w:0.9238795}` (within `1e-6`) — this is `axisAngle(Y, 45°)`, an exact special case for co-axial nlerp from identity (worked in this doc's drafting notes; asserted numerically).
  - Id-match collision test: `prev = [{id: 5*65536+3, slot:0}, {id: 9*65536+3, slot:1}]` (both hash to key `3`), `findPrevSlot(prev, 9*65536+3)` → `1` (exact id match wins over the modulo collision), `findPrevSlot(prev, 2*65536+3)` → `-1` (no exact match despite hitting an occupied key).
  - `f = clamp((nowMs=520, arrivalMs=0)/(1000/60), 0, 1)` → exactly `1` (never `> 1`).
- **`tests/render/wireframeAircraftRenderer.test.ts`**
  - `rotateVecByAxisAngle({x:1,y:0,z:0}, {x:0,y:1,z:0}, Math.PI/2)` → `{x:0,y:0,z:-1}` within `1e-9`.
  - Elevon group: pivot `{0,0,0}`, axis `{0,0,1}`, vertex `{1,0,0}`, `theta = elevonL = 0.1745329` (10°) → rotated vertex ≈ `{0.9848078, 0.1736482, 0}` within `1e-6`.
  - Gear group at `gearPos=0` → rotation angle `0` (vertex unchanged, exact).
  - Gear group at `gearPos=1` → rotation angle exactly `GEAR_TRAVEL_RAD` (`1.7453293`, within `1e-7`).
  - Unknown group name (`"flap"`) → `theta === 0` regardless of any entity field value.
- **`tests/render/cameraModes.test.ts`**
  - Exponential smoothing: `tau=0.15`, `dt=0.15` → `alpha = 1 - exp(-1)` ≈ `0.6321206`; `smoothedPos` moves that fraction of the way from `0` to `10` → `6.321206` within `1e-4`.
  - Cockpit eye world position with `playerRot = {0,0,0,1}` (identity — the architecture worked-example-A orientation) and `playerPos = {100,200,300}` → `{100.35, 201.05, 300}` exactly.
- **`tests/hud/targetBox.test.ts`**
  - `projectWorldToScreen` with the identity-like matrix `[1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]`, `originWorld={0,0,0}`, `worldPos={0.5,0.25,0}`, canvas `800×600` → `{xPx:600, yPx:225, visible:true}` exactly (worked by hand in section 4's drafting: `ndcX=0.5→(0.5*0.5+0.5)*800=600`; `ndcY=0.25→(1-(0.25*0.5+0.5))*600=225`).
  - Same matrix, `worldPos` chosen so `clipW = -1` (e.g. a matrix row 3 test fixture with `m[15]=-1`) → `visible: false`.
- **`tests/hud/leadSight.test.ts`**
  - `pipperValid=1`, `pipperX/Y/Z = {1000, 9.638, 70.10}` (07-combat.md section 4.3's own worked example), `weaponIdx=WeaponKindCode.gun`, `targetRangeM=1000` → the pipper-visibility gate passes and `projectWorldToScreen` is called with exactly `{x:1000,y:9.638,z:70.10}` (this widget performs NO ballistics of its own — it is a pure "should I draw, and at which world point" gate over already-computed snapshot fields).
  - `pipperValid=0` → pipper not drawn, `projectWorldToScreen` not called, regardless of `weaponIdx`/`targetRangeM`.
  - `pipperValid=1`, `targetRangeM = 1800.001` (just over `GUN_MAX_EFFECTIVE_RANGE_M`) → pipper not drawn.
- **`tests/hud/snapshotView.test.ts`**
  - Hand-build a `Float64Array(SNAPSHOT_FLOATS)`, set `TICK_OFFSET=42`, `ENTITY_COUNT_OFFSET=1`, `PLAYER_INDEX_OFFSET=0`, one entity block's `ID=777`, `POS_X=10`, and `HUD_BLOCK_START + SnapshotHud.IAS_MPS = 123.4`; parse it and assert `tick===42`, `id[0]===777`, `posX[0]===10`, `hud[SnapshotHud.IAS_MPS]===123.4`.
- **`tests/hud/ladder.test.ts`**
  - `screenYForPitchRung(rungDeg=10, pitchRad=0, canvasHeightPx=600)` with `HUD_BORESIGHT_FOV_VERT_DEG=30` → exactly `100` (worked by hand: `pxPerRad=300/(15°·DEG2RAD)=1145.9156`; `deltaRad=10°·DEG2RAD=0.1745329`; `300 - 0.1745329*1145.9156 = 100.0000`, within `1e-3`).
- **`tests/hud/ilsNeedles.test.ts`**
  - `ILS_LOC=1.0` → offset exactly `ILS_NEEDLE_MAX_OFFSET_PX` (80). `ILS_LOC=-0.5` → `-40`. `ILS_LOC=0` → `0`.
- **`tests/hud/radarScope.test.ts`**
  - Player at world origin, heading `0` (identity-ish; `forwardWorld=(0,0,-1)`, `rightWorld=(1,0,0)`), contact at `{0,0,-1000}` → `bearingRad ≈ 0`, `rangeM === 1000`.
  - 20 synthetic candidates, `radarScopeContactCap=16` → selection returns exactly 16, sorted ascending by `rangeM`, and it is the 16 **nearest** (not first-20-in-input-order).

## 8. Acceptance criteria

1. `tsc --noEmit --strict --noUncheckedIndexedAccess` on `docs/spec/contracts/render.ts` + `docs/spec/contracts/core.ts` together, with `lib` = `ES2022,DOM` (see section 9.11 for why `WebWorker` is excluded from this module's own check), passes with zero errors. *(Mechanically checked; verified during drafting of this spec.)*
2. Every method on `SceneRenderer` and `HudRenderer` in `contracts/render.ts` has a corresponding implementation in `src/render/scene.ts`/`src/hud/hudCanvas.ts` — checked by `const _typeCheck: SceneRenderer = realSceneRendererInstance;` / the `HudRenderer` equivalent compiling under `--strict`.
3. `RENDER_QUALITY_TABLE`'s `terrainDrawDistanceChunks`/`terrainMaxLodDepth`/`shadowsEnabled`/`shadowCascades`/`effectBudget`/`antialias`/`radarScopeContactCap`/`targetFps` fields match `00-architecture.md` section 14's table exactly, for all four tiers (diffable by inspection against Table 5.1 above).
4. All unit tests listed in section 7 pass.
5. `grep -rn "from '.*src/math" src/render src/hud` returns no matches (dependency rule, section 1).
6. `grep -rn "from '.*src/render" src/hud` returns no matches (dependency rule, section 1).
7. `grep -rln "'three'" src/hud` returns no matches (HUD is Canvas‑2D only).
8. `grep -rn "Math.random()" src/render src/hud` — every match is on a line with an adjacent `// cosmetic` comment (or absent entirely); none appear inside `wireframeAircraftRenderer.ts`'s deflection math, `floatingOrigin.ts`, `snapshotInterpolation.ts`, or any HUD numeric-readout path.
9. No file under `src/render/` or `src/hud/` imports `'src/core'`, `'src/terrain'`, `'src/airport'`, `'src/ai'`, `'src/combat'`, `'src/physics'`, `'src/aircraft'`, `'src/input'`, or `'src/ui'` (only `'../contracts/*'` and, inside `src/render` only, `'three'`).
10. Manual/visual check (not machine-checkable): loading `tests/integration`'s free-flight mission (module 12) shows a wireframe aircraft with visibly deflecting elevons/rudder under stick input and a visibly retracting/extending gear on a `gearDown` toggle; switching all four `CameraMode`s does not throw or blank the canvas; the HUD ladder stays horizon-referenced through a full aileron roll.

## 9. Open assumptions

1. **Single aircraft type.** `registerAircraftModel(model)` takes no `aircraftDefId` — every `kind==='aircraft'` snapshot entity is drawn with the one registered model. This matches the product brief (Tejas-only) but would need a per-id model map if a second aircraft type were ever added; `EntityState` itself carries no `aircraftDefId` field to key on anyway.
2. **`WIREFRAME_CONTROL_GROUP_NAMES` is a hard naming convention this module invented — CONFIRMED matching, not just flagged.** `00-architecture.md` section 9.1 gives `"elevonL","elevonR","rudder","noseGear","mainGearL","mainGearR"` only as non-normative `e.g.` examples; `WireframeGroup` itself has no semantic-role field to key articulation on. This spec upgrades those examples into the **only** six strings this module animates. Module 03's content was invisible to this module's own drafting pass, but cross-checking `03-tejas-data.md` section 5.6's actual `tejasWireframe.json` groups table shows exactly these six literal names (`elevonL`, `elevonR`, `rudder`, `noseGear`, `mainGearL`, `mainGearR`) and no others — the graceful-degradation fallback this item describes (affected parts render static) is therefore a dead code path for the real Tejas data, not a live risk.
3. **Gear rest-pose convention — CONFIRMED matching, not just assumed.** `GEAR_TRAVEL_RAD` rotation is applied assuming the wireframe JSON's rest pose is fully retracted (`gearPos=0`). `03-tejas-data.md` section 5.6 states this explicitly ("Authored at rest pose: zero elevon/rudder deflection, `gearPos=0` (fully retracted), per `contracts/render.ts`'s documented convention") — module 03 authored to this module's assumption on purpose, so the "opposite phase" risk this item describes does not materialize for the real Tejas data.
4. **Radar scope is a self-contained approximation, not `src/combat`'s real sensor model; the lead-computing sight is NOT (this is a change from an earlier drafting pass).** `core.ts`'s `Contact[]` (bearing/range/closure/detection-source, computed by `src/combat`'s radar/RWR model) has no delivery channel into the snapshot or the `SimEvent` union, so the radar scope reads snapshot entities directly (omniscient — shows every alive aircraft/missile within `RADAR_SCOPE_RANGE_M` regardless of actual detection state); this is cosmetic-only and does not feed back into `src/combat`'s actual hit resolution. The lead-computing sight, by contrast, now reads its aim point straight off the Snapshot HUD block's `PIPPER_*` fields (section 4.8), which `src/core` fills from `src/combat`'s real `computeLeadSolution` output every tick — the two systems' earlier "invisible to this module" mismatch (differing muzzle-velocity constants, no gravity-drop compensation) no longer applies to the sight; `GUN_MUZZLE_VELOCITY_MPS` in this module's own contract is kept only as a matching reference constant, never used in a local formula.
5. **Airport visualization is runways + ILS guide lines only, not taxiways/aprons.** `contracts/airport.ts` (module 05) owns `taxiwayGeometry.ts`/`apronGeometry.ts` "for render/HUD consumption" per `00-architecture.md`'s file listing, but this module has no visibility into that contract's actual geometry shape at drafting time (importing it would be a real, unverifiable cross-contract dependency during parallel drafting — `00-architecture.md` section 8 explicitly discourages this except where mandated). This module renders only what `AirportNavDb` (fully specified in `core.ts`) exposes: runway rectangles + ILS localiser/glideslope guide lines, built locally (section 4.13). This is a reduced but functional scope, not a defect.
6. **`SceneRenderer` reading `AirportNavDb` is this module's own extension, not one `core.ts`'s doc comment listed.** `core.ts`'s comment on `AirportNavDb` names `src/hud`, `src/ai`, `src/ui`, `src/core` as consumers but not `src/render`; the dependency-rule table (`src/render imports src/contracts only`, and `AirportNavDb` lives in `core.ts`, part of `src/contracts`) structurally permits it regardless, and it is the only way this module can satisfy "airport line rendering" without a new, invented cross-contract shape.
7. **`src/hud` cannot import `src/render`, so it independently re-implements the same small set of math helpers** (`lerp`, `quatNlerp`, the entity-id hash-match, the 4×4 view-projection multiply) in its own `mathInternal.ts`/`snapshotView.ts`. This is intentional duplication forced by `00-architecture.md` section 10's per-directory dependency rules (confirmed literal, not a rule this module is choosing to over-apply), not an oversight.
8. **`CameraState` (the `originWorld`/`viewProjectionMatrix`/`worldPos` channel from `SceneRenderer` to `HudRenderer`) is entirely this module's own design.** `core.ts` defines no such shape; without it, the HUD's target box/lead-sight pipper could not stay visually aligned with the actual 3D-rendered target across camera modes. `src/core` is expected to pass `SceneRenderer.renderFrame`'s return value straight into `HudRenderer.renderFrame` the same tick (section 3.6) — if a future integration pass calls them out of step, the target box/lead sight will lag by one frame; every other HUD element (ladder, tapes, warnings, weapon status, ILS needles) is unaffected since none of them depend on `CameraState`.
9. **`CAMERA_FAR_M = 40000` m is chosen independently of `src/terrain`'s actual chunk-size-in-metres constant**, which this module has no visibility into. It is generous relative to `Ultra`'s 24-chunk draw distance under any plausible chunk size (a chunk would have to exceed ~1.6 km per side before 24 chunks could exceed this far plane), but is not derived from a shared constant because none exists in `core.ts` for it.
10. **`tests/render/**`/`tests/hud/**` — RESOLVED.** `00-architecture.md` section 11's file manifest was always illustrative, not exhaustive; `12-verification.md` section 2 now explicitly lists every file this section defines, so acceptance criterion 4 below is a real, mandatory gate, not a contingent one. This section's tests were deliberately written DOM/WebGL-independent from the start (pure functions only), which is exactly what made including them in module 12's canonical list a zero-cost fix once the earlier exclusion was recognised as overly broad.
11. **Noted, not fixed (outside this module's ownership): `00-architecture.md` section 13's fixed `tsconfig.json` lists `"lib": ["ES2022","DOM","WebWorker"]` together.** Compiling `core.ts` + `render.ts` with both libs simultaneously fails under TypeScript 5.6 with ~30 `TS6200`/`TS2374`/`TS2403` duplicate-global-declaration errors (`self`, `FormData`, `URL`, `Notification`, etc. are declared incompatibly by `lib.dom.d.ts` and `lib.webworker.d.ts` together — a known TypeScript limitation, not specific to this project's code). Compiling with `DOM` alone (no `WebWorker`) succeeds cleanly, which is what this module's contract was verified against (acceptance criterion 1). This module's own files never run inside a worker (workers are `src/core`/`src/terrain`'s `*.worker.ts` bootstraps) so it does not need `WebWorker` lib itself; the project-wide `tsconfig.json` combining both is module 10's file to resolve (e.g. a separate `tsconfig.worker.json` for the two worker bootstrap files, or per-file `/// <reference lib="..."/>` overrides) and is flagged here per this document's own instruction to note suspected `core.ts`/architecture issues rather than silently work around them.
