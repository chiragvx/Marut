# Build & Acceptance Report

Run date: 2026-09-23
Source: `docs/spec/12-verification.md` section 8 ("Acceptance criteria — the final checklist"), executed verbatim from the repo root, in order. Nothing was fixed; this is a read of current state only.

## Checklist results

| # | Checklist item (id) | Command | Pass/Fail | Evidence |
|---|---|---|---|---|
| 1 | install (`install`) | `npm install` | PASS | exit 0, "added 47 packages, and audited 192 packages" |
| 2 | contracts compile (`contracts_compile`) | `node scripts/checkContracts.mjs` | PASS | exit 0, no output |
| 3 | src compile (`src_compile`) | `npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.worker.json` | PASS | both invocations exit 0, no diagnostics |
| 4 | unit + integration tests (`unit_tests` + `integration_tests`) | `npx vitest run` | PASS | `Test Files 105 passed (105)`, `Tests 466 passed (466)`, Duration 14.76s |
| 5 | trim/performance (`trim_performance`) | `npx vite build --config scripts/vite.tools.config.ts && node dist-tools/sim-check.mjs --mode trim --mission src/core/missions/freeFlight.json --seed 12345` | **FAIL** | exit 1. All 8 named targets PASS, but the trim envelope grid shows 8 cells (of the sampled grid) with `max_iterations_exceeded`, which the spec's own pass condition (section 8 row 5) treats as a hard fail even though the 8 named targets pass |
| 6 | determinism (`determinism`) | `node dist-tools/sim-check.mjs --mode determinism --mission src/core/missions/dogfight1v1.json --seed 424242` | PASS | exit 0, `Determinism: MATCHED` |
| 7 | AI dogfight, veteran (`ai_dogfight_veteran`) | `node dist-tools/sim-check.mjs --mode dogfight --mission src/core/missions/dogfight1v1.json --seed 1 --difficulty veteran` | PASS | exit 0, `cheatSuspected=false groundCollision=false ticksRun=21600` |
| 8 | AI dogfight, ace (`ai_dogfight_ace`) | `node dist-tools/sim-check.mjs --mode dogfight --mission src/core/missions/dogfight1v1.json --seed 1 --difficulty ace` | PASS | exit 0, `cheatSuspected=false groundCollision=false ticksRun=21600` |
| 9 | no-allocation hot path (`no_allocation_hot_path`) | `NODE_OPTIONS=--expose-gc npx vitest run tests/integration/noAllocation.test.ts` | PASS | exit 0, `Tests 1 passed (1)`, ran under `--expose-gc` (strict check, not the warn-and-pass fallback) |
| 10 | build (`build`) | `npx vite build` | PASS | exit 0, `dist/index.html` exists (1.08 kB) |
| 11 | e2e smoke (`e2e_smoke`) | `npm install --no-save playwright && npx playwright install --with-deps chromium && npx vitest run tests/e2e --testTimeout=60000` | **FAIL** | playwright + chromium install both succeeded, but the literal command as spelled in the spec reports `No test files found, exiting with code 1` because `vitest.config.ts` hard-excludes `tests/e2e/**` (a spec-inconsistency `vitest.e2e.config.ts` itself documents). Re-run with the project's actual working invocation (`npx vitest run --config vitest.e2e.config.ts tests/e2e --testTimeout=60000`) also fails: `appSmoke.test.ts` — 1 of 2 sub-tests times out after 60000ms |
| 12 | mobile smoke (`mobile_smoke`) | `npm install --no-save playwright && npx playwright install --with-deps chromium && npx vitest run tests/e2e/mobile.test.ts --testTimeout=60000` | **FAIL** | same exclude problem as row 11 with the literal command; with `--config vitest.e2e.config.ts`, both `mobile.test.ts` sub-tests (Pixel 5, iPhone 13) fail: `page.reload: Timeout 30000ms exceeded` while waiting for navigation "load" after forcing the low quality tier — this is the mandatory gate per the spec (never allowed to be silently skipped when playwright is available), and playwright was available here |
| — | Manual/code-review only: snapshot buffer pool never allocates a 4th `ArrayBuffer` | (manual/code review, not run by this tool) | Not evaluated | Out of scope for a mechanical run; requires a manual play session or heap-snapshot diff |

Additionally run per this task's own instructions (not itself a checklist row):

| Command | Pass/Fail | Evidence |
|---|---|---|
| `npm run build` | PASS | exit 0 (`typecheck` then `vite build`), same `dist/` output as row 10 |

**Overall PASS status per spec's own rule** ("rows 1–10 all `pass`, rows 11–12 each `pass` or `skip`, never `fail`"): **FAIL** — row 5 is a genuine fail (not merely a named-target tolerance miss), and rows 11–12 are `fail`, not the allowed `skip`, since playwright/chromium were successfully installed and the tests ran but did not pass.

## Playwright availability

Playwright was **not preinstalled** in `node_modules` (`node -e "require.resolve('playwright')"` failed with `MODULE_NOT_FOUND`). Following the checklist's own row 11/12 commands, `npm install --no-save playwright` and `npx playwright install --with-deps chromium` were run and both succeeded (Chromium 153.0.8010.12 downloaded to the local Playwright cache). The e2e smoke test therefore *was* run (not skipped) — see rows 11 and 12 above for its result.

## Sim-check table (verbatim, row 5)

```
Category               | Condition                          | Target         | Measured       | Tolerance   | Result
-----------------------+------------------------------------+----------------+----------------+-------------+-------
vmax_sl (vmax)         | military+AB, clean                 | 310.00 m/s     | 291.36 m/s     | +-10%       | PASS  
vmax_11000 (vmax)      | military+AB, clean                 | 472.00 m/s     | 466.36 m/s     | +-10%       | PASS  
turn_5000_m06 (sustain | Mach 0.6, military+AB, clean, 9500 | 11.00 deg/s    | 9.13 deg/s     | +-20%       | PASS  
climb_sl (climb_rate_m | military+AB, clean, Vy=180 m/s, 95 | 66.00 m/s      | 70.21 m/s      | +-15%       | PASS  
stall_clean (stall_spe | clean, gear/flaps up, 9500 kg      | 60.00 m/s      | 60.01 m/s      | +-15%       | PASS  
stall_landing (stall_s | gear+flaps down, 9500 kg           | 50.00 m/s      | 51.23 m/s      | +-15%       | PASS  
takeoff_roll (takeoff_ | military+AB, flaps takeoff, 9500 k | 450.00 m       | 487.24 m       | +-30%       | PASS  
landing_roll (landing_ | flaps landing, brakes, 8500 kg     | 600.00 m       | 579.17 m       | +-30%       | PASS  

8/8 targets passed.

Trim envelope grid (altitude m x speed m/s):
  alt=    0 m  speed= 300 m/s  -> max_iterations_exceeded
  alt=    0 m  speed= 350 m/s  -> max_iterations_exceeded
  alt= 3000 m  speed= 350 m/s  -> max_iterations_exceeded
  alt= 6000 m  speed= 350 m/s  -> max_iterations_exceeded
  alt= 9000 m  speed= 150 m/s  -> max_iterations_exceeded
  alt=11000 m  speed= 150 m/s  -> max_iterations_exceeded
  alt=14000 m  speed= 150 m/s  -> max_iterations_exceeded
  alt=14000 m  speed= 200 m/s  -> max_iterations_exceeded
```

## Test counts

- `npx vitest run` (row 4, default suite, excludes `tests/e2e/**`): **105 test files passed / 105**, **466 tests passed / 466**. Duration 14.76s.
- `tests/integration/noAllocation.test.ts` (row 9, `--expose-gc`): **1 test file passed / 1**, **1 test passed / 1**.
- e2e suite (`vitest.e2e.config.ts`, rows 11–12 combined): **4 tests total, 1 passed, 3 failed** (2 test files, both with failures).

## Bundle size (from `npx vite build` / `npm run build` output, row 10)

| File | Raw size | Gzip |
|---|---|---|
| `dist/index.html` | 1.08 kB | 0.52 kB |
| `dist/assets/terrain.worker-Cc9edjet.js` | 5.03 kB | — |
| `dist/assets/sim.worker-GmOwnR5j.js` | 96.14 kB | — |
| `dist/assets/index-Bfe_hjPI.js` | 26.06 kB | 7.76 kB |
| `dist/assets/index-D56mBzXw.js` | 602.19 kB | 165.98 kB |

Vite additionally warns that `index-D56mBzXw.js` (602.19 kB) exceeds its 500 kB chunk-size warning threshold and suggests code-splitting (`dynamic import()` or `manualChunks`).

## Failures summary

1. **Row 5 — `trim_performance` (FAIL, exit 1).** All 8 named performance targets pass their tolerance bands, but the trim-envelope grid scan reports `max_iterations_exceeded` at 8 sampled altitude/speed cells (e.g. sea level at 300–350 m/s, mid/high altitude at various speeds), which section 8's pass condition requires to be absent for a PASS.
2. **Row 11 — `e2e_smoke` (FAIL).**
   - The checklist's literal command (`npx vitest run tests/e2e --testTimeout=60000`) fails immediately with "No test files found, exiting with code 1" because `vitest.config.ts` excludes `tests/e2e/**` by design (documented as a known spec/tooling inconsistency in `vitest.e2e.config.ts`'s own header comment).
   - Re-run with the project's actual intended invocation (`--config vitest.e2e.config.ts`), `tests/e2e/appSmoke.test.ts` still fails: one of its two sub-tests times out at 60000ms.
3. **Row 12 — `mobile_smoke` (FAIL).** Same config-exclude issue as row 11 with the literal command. Using `--config vitest.e2e.config.ts`, both device sub-tests (Pixel 5, iPhone 13) fail on `page.reload({ waitUntil: 'load' })` timing out at 30000ms while the test is priming the service-worker cache before the offline check — this is the checklist's mandatory (non-skippable) gate given playwright was available.
4. **Manual gate not evaluated.** The snapshot-buffer-pool allocation check (section 8, unlabeled manual/code-review row) was not performed — it requires a live play session or heap-snapshot diff, outside the scope of this mechanical run.

Nothing in the above was modified or fixed, per instructions — this report only reads and records current state.
