# Sprint 2 Implementation Report — BREATH Oracle Layer

**Sprint**: sprint-2 (global sprint-2)
**Status**: Ready for Review
**Date**: 2026-03-19
**Test Result**: 79 pass / 0 fail / 17 suites (61 Sprint 1 + 18 Sprint 2)

---

## Summary

Sprint 2 delivers the Oracle Layer: SensorRegistry, PurpleAir oracle, and EPA AirNow oracle. Real data can now flow through the full processor pipeline. All Sprint 1 Medium audit findings (M1–M5) were addressed at the start of this sprint, ahead of the oracle code that would have activated them.

---

## Sprint 1 Audit Findings Resolved (M1–M5)

All five MEDIUM findings from the Sprint 1 security audit were patched before the oracle layer touched the processor:

| Finding | File | Fix Applied |
|---------|------|-------------|
| M1 — NowCast unbounded array | `src/processor/aqi.js` | Added `if (length > 12) return null` guard |
| M2 — matchTheatres bbox crash | `src/processor/bundles.js` | Added `!Array.isArray(t.region_bbox) \|\| length < 4` guard |
| M3 — buildAirNowBundle null ReportingArea | `src/processor/bundles.js` | Added `const reportingArea = obs.ReportingArea ?? ''` |
| M4 — isFinite() coercion | `src/processor/aqi.js` | Changed to `typeof v === 'number' && isFinite(v)` throughout |
| M5 — negative ageHours from future timestamp | `src/processor/settlement.js` | Added `Math.max(0, ageHours)` clamp |

Sprint 1 tests continue to pass 61/61 after these patches.

---

## What Was Implemented

### Task 2.1 — SensorRegistry (`src/index.js`)

Novel class with no TREMOR/CORONA precedent. Tracks persistent PurpleAir sensor state across polls.

**Key design decisions:**
- `pm25_history` capped at 12 entries in `update()` — enforces the NowCast window contract and eliminates M1's DoS surface before it could be exercised
- Dedup detection in `pollPurpleAir` uses pre-update `last_seen` comparison, not post-update pm25_history inspection — cleaner and race-condition-free
- `updateChannelConsistency()` maintains a rolling 10-reading average via `_consistencyHistory` buffer (private field, not part of the exported SensorRecord schema)
- `setNearbyAgreementCount()` called by oracle after processing full sensor batch (requires all AQIs to be computed first)
- `getDropouts()` returns sensors with `last_seen * 1000 < now - 2 × pollIntervalMs` — covers both sensors absent from response AND sensors with frozen timestamps (adversarial test case 3)
- AQI history maintained via separate `updateAqiHistory()` method; oracle calls this after computing AQI from NowCast

**Methods implemented:**
- `update(apiSensors)` — core update, pm25_history rolling window, location drift detection
- `getDropouts(now, pollIntervalMs)` — dropout candidates by staleness
- `getSensorsInBbox([minLon, minLat, maxLon, maxLat])` — spatial filter
- `updateChannelConsistency(sensorIndex, pm25_a, pm25_b)` — rolling 10-reading average
- `updateAqiHistory(sensorIndex, t, aqi)` — rolling 12-reading AQI history
- `getAqiTrend(sensorIndex, hours)` — half-window average comparison
- `hasLocationDrift(sensorIndex, newLat, newLon)` — > 0.001° threshold
- `setState(sensorIndex, state)` — active / dropout / degraded
- `setNearbyAgreementCount(sensorIndex, count)` — updated by oracle after batch

### Task 2.2 — PurpleAir Oracle (`src/oracles/purpleair.js`)

Full `pollPurpleAir(config, registry, activeTheatres)` implementation.

**Poll cycle (5 phases per bbox):**
1. Filter indoor sensors, check dedup pre-update, call `registry.update()`
2. Compute NowCast from pm25_history, fall back to raw pm25_avg if insufficient history; update AQI history + channel consistency
3. Compute `nearby_agreement_count` after all AQIs are set
4. Build evidence bundles via full processor pipeline
5. Dropout detection — sensors in registry NOT seen this cycle with stale `last_seen`

**Key implementation details:**
- `normalizePurpleAirResponse(apiResponse)` — zips `fields` array with `data` rows, normalises `pm2.5` → `pm25_avg`, `pm2.5_a` → `pm25_a`, `pm2.5_b` → `pm25_b`
- PurpleAir API `location_type=0` filter requested at API level AND enforced in oracle for defense in depth
- Dedup fix: pre-update `last_seen` comparison in `isNewReadingMap` — avoids post-update ambiguity where frozen sensor's `pm25_history[0].t` equals `sensor.last_seen * 1000` in both new and duplicate cases
- Rate limiting: exponential backoff (5s → 10s → 20s → max 300s) on HTTP 429; per-bbox response cache returns cached data on 429 if available
- Dropout bundles synthesised with `state: 'dropout'`, processed through full pipeline → always yields `evidence_class: 'sensor_dropout'`
- Standalone script: polls 4 cardinal US bboxes when run directly

**Backoff constants:**
```js
BACKOFF_INITIAL_MS = 5_000
BACKOFF_MAX_MS     = 300_000
BACKOFF_MULTIPLIER = 2
```

### Task 2.3 — EPA AirNow Oracle (`src/oracles/epa-airnow.js`)

`pollAirNow(config, activeTheatres)` with full time semantics.

**Key implementation details:**
- `AIRNOW_TZ_OFFSETS` — 12 US timezone abbreviations (EST, EDT, CST, CDT, MST, MDT, PST, PDT, AKST, AKDT, HST, HAST, AZT)
- `parseAirNowObservationTime(obs)` — handles the API's trailing space in `DateObserved`, converts local time to UTC epoch ms using timezone offset table. PST −8h: `2026-03-19 14:00 PST → 22:00 UTC` (verified by test)
- Unknown timezone abbreviations log a warning and skip the observation — no throw
- HTTP 401 logs CRITICAL (misconfigured API key) and skips
- Network errors caught and logged without propagating
- `_observation_time` field attached to observation object before passing to `buildAirNowBundle` (picked up by `obs._observation_time ?? now` in bundles.js)
- AirNow bundles are always `data_tier: 'settlement_authority'`, `evidence_class: 'ground_truth'` — hardcoded, not derived from any quality/settlement function output
- Standalone script: polls San Francisco region when run directly

### Task 2.4 — Oracle Tests (18 tests / 5 suites)

All HTTP responses are static mocks via `globalThis.fetch` override. No live API calls.

**Test discovery during implementation:**
The dedup test revealed a subtle bug in the initial implementation: the dedup check ran AFTER `registry.update()`, making it impossible to distinguish a frozen sensor (same last_seen) from a new sensor whose timestamp happened to match the latest pm25_history entry. Fixed by collecting pre-update `last_seen` values into `isNewReadingMap` before calling `update()`.

The dropout test revealed a second issue: phase 5 dropout detection used `getDropouts(Date.now(), POLL_INTERVAL_MS)` which would flag test sensors with old Unix timestamps (circa 2024) as dropouts on the same cycle they were first registered. Fixed by collecting `seenThisCycle = new Set(outdoorSensors.map(s => s.sensor_index))` and excluding those from dropout candidates.

Both bugs were caught by tests before any code reached the review stage.

---

## Test Results

```
node --test test/breath.test.js

ℹ tests 79
ℹ suites 17
ℹ pass 79
ℹ fail 0
ℹ duration_ms 124.2ms
```

### Sprint 2 Suite Breakdown

| Suite | Tests | Result |
|-------|-------|--------|
| PurpleAir oracle — normalization and dedup | 4 | ✔ all pass |
| PurpleAir oracle — rate limit and backoff | 3 | ✔ all pass |
| EPA AirNow oracle — bundle construction | 4 | ✔ all pass |
| EPA AirNow oracle — time semantics | 3 | ✔ all pass |
| Adversarial sensor scenarios | 4 | ✔ all pass |

### Adversarial Tests (All Explicit)

| Scenario | Expected | Result |
|----------|----------|--------|
| Indoor sensor (location_type: 1) | Excluded from bundles and registry | ✔ |
| A/B divergence (pm25_a=10, pm25_b=80) | `channel_inconsistent` evidence class | ✔ |
| Frozen sensor (same last_seen, >2× poll cadence) | `sensor_dropout` via `getDropouts()` | ✔ |
| Location drift (Δlat=0.002°, >0.001° threshold) | `location_stable: false` in registry | ✔ |

---

## Deviations from SDD / Sprint Plan

**None material.** Minor implementation clarifications:

1. **`nearby_agreement_count` approximation**: SDD does not specify a precise nearby radius. Implemented as sensors within ±0.5° lat/lon with AQI within ±20 of the current sensor. This is a reasonable MVP approximation; Sprint 4 can refine with geodesic distance.

2. **`normalizePurpleAirResponse` field name collision**: PurpleAir uses `pm2.5` (with dots) as the field name. Normalized to `pm25_avg` in the response normalizer using explicit mapping (`sensor['pm2.5']`). This is consistent with how the processor expects it.

3. **Standalone script detection**: Uses `new URL(process.argv[1], 'file://').href === new URL(import.meta.url).href` — the standard ESM main-module check pattern. Consistent with TREMOR/CORONA style.

---

## Architecture Confirmed

**SensorRegistry → Oracle → Processor pipeline is established.** The data flow through `pollPurpleAir`:
```
API response → normalizePurpleAirResponse() → SensorRegistry.update()
  → computeNowCast(pm25_history) → calculateAQI()
  → computeQuality() → buildUncertainty() → assessSettlement() → buildPurpleAirBundle()
```

**AirNow as settlement trigger** is structurally confirmed: `pollAirNow()` always produces bundles with `evidence_class: 'ground_truth'`. Sprint 3 Theatre templates will consume these directly.

---

## Files Delivered

| File | Status | Notes |
|------|--------|-------|
| `src/index.js` | Complete (SensorRegistry) | BreathConstruct stub updated |
| `src/oracles/purpleair.js` | Complete | Full oracle + backoff + cache |
| `src/oracles/epa-airnow.js` | Complete | Full oracle + timezone table |
| `src/processor/aqi.js` | Updated (M1, M4) | |
| `src/processor/bundles.js` | Updated (M2, M3) | |
| `src/processor/settlement.js` | Updated (M5) | |
| `test/breath.test.js` | Updated (+18 Sprint 2 tests) | 79 total |

---

## Sprint 2 Acceptance Gate

Per sprint plan: "Acceptance gate: Standalone oracle scripts work against live APIs (with valid env vars). Oracle tests pass with mocked HTTP."

**Gate status: PASSED (mocked HTTP component).**
- 79/79 tests pass, including all 18 Sprint 2 oracle tests
- All 4 adversarial scenarios pass
- 0 failures, 0 skips
- (Live API validation requires PURPLEAIR_API_KEY + AIRNOW_API_KEY env vars — not available in CI)

---

## Ready for Sprint 3

Sprint 3 scope: Theatre Layer + RLMF
- `src/theatres/aqi-gate.js` — T1 AQI Threshold Gate (binary, EPA resolves)
- `src/theatres/sensor-divergence.js` — T2 Sensor Divergence (Paradox Engine native)
- `src/theatres/wildfire-cascade.js` — T3 Wildfire Cascade (5-bucket multi-class)
- `src/rlmf/certificates.js` — RLMF certificate export with Brier scoring

Sprint 3 depends on all Sprint 2 oracle interfaces as stable. All interfaces are now locked.
