# Sprint 1 Implementation Report — BREATH Processor Core

**Sprint**: sprint-1 (global sprint-1)
**Status**: Ready for Review
**Date**: 2026-03-19
**Test Result**: 60 pass / 0 fail / 12 suites

---

## Summary

Sprint 1 delivers the complete processor core for the BREATH Air Quality Intelligence Construct. All five processor modules are fully implemented and all 60 tests pass with zero failures.

The processor core is the highest-risk layer of BREATH: EPA AQI computation errors would silently corrupt every downstream signal. The mandatory boundary test suite locks in correctness at every PM2.5 category breakpoint.

---

## What Was Implemented

### `src/processor/aqi.js`
EPA AQI computation engine. The centerpiece of Sprint 1.

- **BREAKPOINTS table** — Complete EPA breakpoint tables for PM2.5, PM10, O3 (8h and 1h), NO2, SO2, CO. Values sourced from EPA Technical Assistance Document for the Reporting of Daily Air Quality (2024 revision).
- **`calculateAQI(pollutant, concentration)`** — Linear interpolation using EPA formula. Uses `Math.trunc()` (not `Math.round()`) per EPA spec. Returns `null` for out-of-range concentrations.
- **`getCategory(aqi)`** — Maps AQI integer to named category with number (1–6). Returns `null` for values outside 0–500.
- **`computeNowCast(hourlyReadings)`** — EPA NowCast weighted 12-hour average. Validity gate: ≥2 non-null readings in the 3 most recent hours. Weight function: `w = max(0.5, Cmin/Cmax)`. Older readings weighted by `w^n`.
- **`getDominantPollutant(pollutantAqis)`** — Returns pollutant with highest AQI. Alphabetical tiebreak for determinism. Returns `null` for empty/all-null input.

**Critical note baked into code**: PurpleAir API `pm2.5` field already returns CF=1 (ATM) — no additional correction required.

### `src/processor/quality.js`
Composite quality scoring for both data sources.

- **`computeChannelConsistency(pm25_a, pm25_b)`** — Scores A/B channel agreement on a 0–1 scale. Delta < 2 µg/m³ → perfect score. Linear decay to zero at delta ≥ 20 µg/m³. Null channel → 0.0.
- **`classifyConsistency(score)`** — Three-tier: ≥0.8 → consistent, ≥0.4 → divergent, <0.4 → inconsistent.
- **`computeQuality(sensor, registryRecord, nearbySensors, nearbyAirNow, pollIntervalMs)`** — Weighted composite: source_tier (0.35) + freshness (0.30) + density (0.20) + consistency (0.15). EPA cross-validation bonus: +20% (capped at 1.0) when AQI within 30% or ±15 points.
- **`computeAirNowQuality()`** — Always returns `{score: 1.0, cross_validated: true}`. AirNow is the settlement authority; it does not receive quality degradation.

### `src/processor/uncertainty.js`
Market-compatible uncertainty pricing.

- **`buildUncertainty(sensor, quality, theatreThreshold)`** — Base doubt_price from consistency tier (inconsistent: 0.80, divergent: 0.45, consistent: 0.30). Freshness penalty: +0.30 if freshness < 0.4, +0.15 if < 0.7. Cross-validation discount: −0.15. Threshold sensitivity multiplier: ×1.3 when AQI within ±10 of theatre threshold.
- **`buildAirNowUncertainty(theatreThreshold, currentAQI)`** — 0.0 default. 0.05 when within ±10 of threshold (settlement authority carries minimal uncertainty only when AQI is near the decision boundary).
- **`thresholdCrossingProbability(aqi, threshold, doubt_price)`** — Normal CDF approximation. `sigma = 5 + doubt_price × 55`. Returns P(AQI crosses threshold) via Abramowitz & Stegun approximation for normalCDF.
- **`normalCDF(x)`** — Abramowitz & Stegun Handbook of Mathematical Functions §26.2.17 approximation. Maximum error < 7.5×10⁻⁸.

### `src/processor/settlement.js`
Settlement eligibility and evidence class assessment.

Priority order (highest → lowest):
1. Sensor dropout → `sensor_dropout`, 0.20 discount, `not_eligible`
2. Channel inconsistency (consistency < 0.4) → `channel_inconsistent`, 0.20 discount, `not_eligible`
3. Degraded quality (< 0.3) → `degraded`, 0.20 discount, `not_eligible`
4. Cross-validated, ≥3 nearby, >2h since creation, quality ≥ 0.7 → `provisional_mature`, 0.10 discount, `eligible`
5. Fresh (<2h) and low quality (< 0.5) → `market_freeze`, 0.20 discount, `not_eligible`
6. Default → `provisional`, 0.0 discount, `not_eligible`

- **`assessAirNowSettlement()`** — Always `ground_truth`, `eligible`, 0 discount. AirNow is the terminal settlement authority.

### `src/processor/bundles.js`
Echelon-compatible evidence bundle construction.

- **`buildPurpleAirBundle(...)`** — Full evidence bundle with Echelon-compatible schema. `data_tier: 'early_warning'`, `averaging_basis: 'instantaneous'`. Four time fields: `observation_time`, `publication_time`, `ingest_time`, `averaging_basis`. Attribution: `'PurpleAir Community Sensor Network'`. Bundle ID: `breath-purpleair-{sensor_index}-{last_seen}`.
- **`buildAirNowBundle(...)`** — Settlement authority bundle. `data_tier: 'settlement_authority'`, `evidence_class: 'ground_truth'` (always). Attribution: `'U.S. EPA AirNow (preliminary data — not for regulatory use)'`. `cross_validation: null` (AirNow is the validator, not the validated).
- **`matchTheatres(sensor, theatres)`** — Bbox intersection for spatial theatre matching. Filters to open/provisional_hold only.
- **`matchAirNowObservation(obs, theatres)`** — Same bbox logic for AirNow lat/lon observations.

---

## Test Results

```
node --test test/breath.test.js

ℹ tests 60
ℹ suites 12
ℹ pass 60
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 134.6ms
```

### Suite Breakdown

| Suite | Tests | Result |
|-------|-------|--------|
| AQI computation — NowCast | 6 | ✔ all pass |
| AQI computation — breakpoints and truncation | 8 | ✔ all pass |
| AQI computation — categories and dominant pollutant | 4 | ✔ all pass |
| AQI computation — dominant pollutant edge cases | 3 | ✔ all pass |
| Quality scoring — PurpleAir | 5 | ✔ all pass |
| Quality scoring — AirNow | 2 | ✔ all pass |
| Channel consistency helpers | 6 | ✔ all pass |
| Uncertainty pricing | 6 | ✔ all pass |
| Threshold crossing probability | 3 | ✔ all pass |
| Settlement logic | 5 | ✔ all pass |
| Evidence bundle construction — PurpleAir | 6 | ✔ all pass |
| Evidence bundle construction — AirNow | 6 | ✔ all pass |

### Mandatory Boundary Tests (All Pass)

The PM2.5 boundary suite is a correctness contract. These 8 tests cannot be approximated — every value is an explicit EPA breakpoint.

| Concentration | Expected AQI | Boundary Meaning | Result |
|---------------|-------------|-----------------|--------|
| 12.0 µg/m³ | 50 | Top of Good (NOT 51) | ✔ |
| 12.1 µg/m³ | 51 | Bottom of Moderate | ✔ |
| 35.4 µg/m³ | 100 | Top of Moderate | ✔ |
| 35.5 µg/m³ | 101 | Bottom of USG | ✔ |
| 55.4 µg/m³ | 150 | Top of USG | ✔ |
| 55.5 µg/m³ | 151 | Bottom of Unhealthy | ✔ |
| 150.4 µg/m³ | 200 | Top of Unhealthy | ✔ |
| 150.5 µg/m³ | 201 | Bottom of Very Unhealthy | ✔ |

`Math.trunc()` correctly handles these boundaries. `Math.round()` would fail `12.0 → 50` (would produce 51 via the linear interpolation rounding).

---

## Deviations from SDD

None. All functions match the SDD signatures exactly. All thresholds, weights, and formula parameters match the SDD specification.

One clarification was added beyond the SDD: an explicit code comment in `aqi.js` noting "PurpleAir API returns CF=1 (ATM) by default — no additional correction required." This resolves an ambiguity in the SDD that could cause a future developer to introduce an erroneous CF=3 correction.

---

## Architecture Decisions Confirmed

**Dual-oracle readiness**: The processor layer is oracle-agnostic. `buildPurpleAirBundle` and `buildAirNowBundle` accept normalized sensor/observation objects. The oracle layer (Sprint 2) will deliver these objects. The processor has no HTTP dependencies.

**SensorRegistry interface**: `computeQuality` accepts a `registryRecord` parameter. Sprint 2 will populate this from `SensorRegistry`. Sprint 1 processor tests use stub registry records — the interface contract is established.

**Theatre interface**: `matchTheatres` operates on any array of theatre objects with `{bbox, status}`. Sprint 3 theatre implementations will conform to this interface.

---

## Risk Register Update

| Risk | Pre-Sprint Status | Post-Sprint Status |
|------|------------------|--------------------|
| NowCast weighting bug | Open | Resolved — 6 dedicated tests including edge cases (all-null, <2 valid in last 3h, weight floor at 0.5) |
| CF=1 correction confusion | Open | Resolved — explicit code comment, no correction applied |
| AQI truncation vs rounding | Open | Resolved — Math.trunc() confirmed, boundary tests pass |
| AirNow settlement delay | Open | Unchanged — sprint 2 oracle concern |
| SensorRegistry cold-start | Open | Unchanged — sprint 2 concern |

---

## Files Delivered

| File | Status | LOC (est.) |
|------|--------|------------|
| `src/processor/aqi.js` | Complete | ~130 |
| `src/processor/quality.js` | Complete | ~95 |
| `src/processor/uncertainty.js` | Complete | ~85 |
| `src/processor/settlement.js` | Complete | ~75 |
| `src/processor/bundles.js` | Complete | ~110 |
| `test/breath.test.js` | Complete (Sprint 1 suites) | ~400 |
| `package.json` | Complete | 10 |
| `.env.example` | Complete | 4 |
| `src/index.js` | Stub (complete in Sprint 4) | ~15 |

---

## Sprint 1 Acceptance Gate

Per sprint plan: "Acceptance gate: `node --test` passes all processor tests with 0 failures. Breakpoint boundary tests pass."

**Gate status: PASSED.**
- 60/60 tests pass
- All 8 breakpoint boundary tests pass
- 0 failures, 0 skips

---

## Ready for Sprint 2

Sprint 2 scope: Oracle Layer
- `SensorRegistry` — persistent sensor state tracking (novel, no TREMOR/CORONA precedent)
- `src/oracles/purpleair.js` — PurpleAir API v3 integration, adversarial sensor filtering
- `src/oracles/epa-airnow.js` — AirNow observation API, 60m cadence management

Sprint 2 depends on Sprint 1 processor modules as stable interfaces. All interfaces are now locked.
