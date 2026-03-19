# Sprint 2 Security Audit — BREATH Oracle Layer (Re-Audit)

**Auditor**: Paranoid Cypherpunk
**Date**: 2026-03-19
**Verdict**: APPROVED — LETS FUCKING GO

---

## Re-Audit Summary

H1 has been resolved. The Category null dereference crash path is closed. Regression test is in place. 80/80 tests pass. Sprint 2 is cleared for COMPLETED.

---

## H1 Resolution Verified

**Finding**: `obs.Category.Name` / `obs.Category.Number` in `buildAirNowBundle` — uncaught crash from null Category during AirNow outages.

**Fix applied** (`src/processor/bundles.js:189-190`):
```js
// Before (vulnerable):
category: obs.Category.Name,
category_number: obs.Category.Number,

// After (fixed):
category: obs.Category?.Name ?? 'Unknown',
category_number: obs.Category?.Number ?? 0,
```

**Regression test added** (Suite 15 — EPA AirNow oracle — bundle construction):
```
✔ AirNow observation with null Category does not throw
```

Test correctly:
- Passes `Category: null` through `makeAirNowApiObs({ Category: null })`
- Awaits `pollAirNow()` — would reject if H1 not fixed
- Asserts `bundles.length > 0` — bundle still produced despite null Category
- Asserts `payload.aqi.category === 'Unknown'` — fallback applied
- Asserts `payload.aqi.category_number === 0` — fallback applied

**Test run**:
```
ℹ tests 80
ℹ pass 80
ℹ fail 0
ℹ duration_ms 129.5ms
```

---

## Carry-Forward Items (Not Blocking)

The following LOW/INFORMATIONAL findings from the first audit remain unresolved. They are not blocking COMPLETED. They are documented here for Sprint 3/4 pickup.

| ID | File | Finding | Deferred To |
|----|------|---------|-------------|
| L1 | `purpleair.js:100` | No upper bound on `data.map()` response rows | Sprint 4 |
| L2 | `index.js:80` | `sensor.name` null propagates to RLMF `region_label` | Sprint 3 |
| L3 | `purpleair.js:63-66` | Module-level `backoffState`/`responseCache` shared across instances | Sprint 4 |
| L4 | `index.js:41` | `SensorRegistry.sensors` Map is unbounded (no eviction policy) | Sprint 4 |
| L5 | `bundles.js:188,191,197` | `obs.AQI` type guard missing; `obs.ParameterName ?? null` not applied | Sprint 3 |
| L6 | `purpleair.js:186`, `epa-airnow.js:149` | Error messages disclose env var names (operational, not code fix) | Ops runbook |
| M1 | `epa-airnow.js:142` | AirNow key in URL query param (API constraint — no code fix possible) | Ops runbook |

L5 was recommended for the same-pass H1 fix. It was not addressed. Since L5 is non-crashing (corrupts certificate AQI value but does not halt the pipeline), it does not block COMPLETED. It should be patched in Sprint 3 alongside the Theatre Layer's bundle consumption code, when the downstream impact is visible.

---

## Full Security Checklist (Sprint 2 Re-Audit)

| Check | Result | Notes |
|-------|--------|-------|
| H1 `obs.Category` null guard | PASS | `obs.Category?.Name ?? 'Unknown'` applied |
| H1 regression test present | PASS | 'AirNow observation with null Category does not throw' |
| No hardcoded API keys | PASS | Config/env only |
| URL construction not SSRF-injectable | PASS | Hardcoded base + `searchParams.set()` only |
| PurpleAir key in header not URL | PASS | `X-API-Key` header |
| AirNow key never logged | PASS | Confirmed |
| `.env.example` placeholders only | PASS | Confirmed |
| `pm25_history` capped at 12 | PASS | M1 fix in `index.js` |
| `_consistencyHistory` capped at 10 | PASS | `slice(-10)` |
| `aqi_history` capped at 12 | PASS | `slice(0, 12)` |
| `obs.ReportingArea` null guard | PASS | M3 fix confirmed |
| `matchTheatres` bbox null guard | PASS | M2 fix confirmed |
| Indoor sensor excluded from registry | PASS | `location_type === 0` filter before `registry.update()` |
| Dedup check pre-update | PASS | `isNewReadingMap` populated before `registry.update()` call |
| Dropout `seenThisCycle` exclusion | PASS | Active sensors excluded from dropout candidates |
| HTTP 429 backoff + cache | PASS | Exponential backoff, cache fallback, `continue` if no cache |
| Network errors caught (no throw) | PASS | Both oracles catch and log |
| HTTP 401 logged CRITICAL | PASS | Both oracles |
| Test mocks restored after each test | PASS | All callers invoke `restore()` |
| No test API keys in test fixtures | PASS | `'test'` literal only |
| M1–M5 Sprint 1 patches confirmed | PASS | All five present and verified |
| 80 tests / 0 fail | PASS | Full suite green |

---

## Disposition

**APPROVED — LETS FUCKING GO.**

Sprint 2 delivers a complete, security-reviewed Oracle Layer. PurpleAir and EPA AirNow oracles are ready. SensorRegistry is hardened. The processor pipeline is end-to-end verified. The settlement authority chain from AirNow to Theatre resolution is architecturally confirmed.

Sprint 3 (Theatre Layer + RLMF) may proceed.
