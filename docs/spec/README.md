# Tejas Sim — Spec Index

This directory is the complete design specification for the HAL Tejas Mk1 web flight simulator. It is written to support a **single-pass parallel build**: once every file below exists, up to twelve implementer agents build the whole project at the same time, each reading only three things — `00-architecture.md`, `contracts/core.ts`, and their own module's spec + contract file — before writing code into their own owned directories (see `00-architecture.md` section 11 for the exact file-ownership manifest).

## Reading order

**Every agent, regardless of role, reads these two first, in this order, before anything else:**

1. **`00-architecture.md`** — global architecture: fixed technology decisions, coordinate frames and sign conventions (with a worked, numerically-verified example), the fixed-step loop, worker topology and message protocol, the snapshot binary layout, floating-origin design, cross-module data contracts, the dependency/import graph, the complete file-ownership manifest, the build order, coding rules, the quality-tier table, and a glossary. This document is normative; if anything below appears to disagree with it, this document wins.
2. **`contracts/core.ts`** — the root shared contract: `PilotInputs`, `EntityState`, `AircraftTelemetry`, `PilotContext`/`Pilot`, the `Snapshot*` binary-layout constants, the `WorkerMessage` unions, `SimEvent`, `HeightSampler`, `AirportNavDb`, `WorldConfig`/`Mission`, `AiDifficulty`, `QualityTier`, `DamageState`, `Contact`, `LockState`, `WeaponKind`, `WarningBit`. Valid standalone strict TypeScript; imports nothing.

**Then, only your own module's two files:**

| # | spec | contract | owned directories |
|---|---|---|---|
| 00 | `00-architecture.md` | `contracts/core.ts` | `src/contracts/` (copied verbatim by the scaffold step) |
| 01 | `01-math.md` | `contracts/math.ts` | `src/math/` |
| 02 | `02-flight-model.md` | `contracts/flight.ts` | `src/physics/` |
| 03 | `03-tejas-data.md` | `contracts/aircraft.ts` | `src/aircraft/` |
| 04 | `04-terrain.md` | `contracts/terrain.ts` | `src/terrain/` |
| 05 | `05-airport.md` | `contracts/airport.ts` | `src/airport/` |
| 06 | `06-ai.md` | `contracts/ai.ts` | `src/ai/` |
| 07 | `07-combat.md` | `contracts/combat.ts` | `src/combat/` |
| 08 | `08-render.md` | `contracts/render.ts` | `src/render/`, `src/hud/` |
| 09 | `09-input.md` | `contracts/input.ts` | `src/input/` |
| 10 | `10-core-worker.md` | `contracts/sim.ts` | `src/core/`, plus `src/main.ts`, `index.html`, `vite.config.ts`, `tsconfig.json`, `package.json` |
| 11 | `11-ui.md` | `contracts/ui.ts` | `src/ui/`, `public/` |
| 12 | `12-verification.md` | `contracts/verify.ts` | `tests/`, `tools/`, `scripts/`, CI config, `vitest.config.ts` |

No module reads any other module's `NN-name.md` or `contracts/<name>.ts`. Any information one module needs from another either lives in `contracts/core.ts` (compile-time types) or is pinned down explicitly in `00-architecture.md` section 9 ("Cross-module data contracts") — currently: the `AircraftDefinition`/`StepAircraft` boundary between modules 02 and 03, the airport-flattening-zone boundary between modules 04 and 05, and the two built-in airport layout file paths for module 05. If you are drafting or implementing a module and find you need something from a sibling module that is genuinely missing from both `core.ts` and section 9, do not invent a shape and hope it matches — use the narrowest possible local structural type and record the assumption in your own spec's "Open assumptions" section (section 9 of the per-module writing standard below).

## Writing standard for modules 01–12

Each `NN-name.md` follows this section order:

1. Purpose & scope
2. Owned files (exact paths, one-line purpose each)
3. Public API (must match the contract file; restate signatures)
4. Design & algorithms (formulas, constants, step-by-step, edge cases)
5. Data (tables, JSON shapes, magic numbers with justification)
6. Performance budget (allocations, per-tick cost, mobile)
7. Unit tests to write (file path + concrete assertions with numbers/tolerances)
8. Acceptance criteria (mechanically checkable)
9. Open assumptions (public performance data for the Tejas is sparse; state what was approximated and from what analogue aircraft/engine)

Target 300–900 lines. Markdown prose, TypeScript code blocks. No "TBD" / "implementer decides" placeholders — every number, sign, and file path is decided in the spec itself.

## Build order

Scaffold (copy contracts into `src/contracts/`) → modules 01–12 in parallel → integration (`tsc --noEmit --strict` across `src/`, wiring concrete implementations behind `core.ts`'s interfaces in `src/core`) → verification (`vitest run`, `tools/sim-check.ts`, the acceptance checklist in `12-verification.md`). Full detail in `00-architecture.md` section 12.
