# Sprint 3 — Empirical Calibration: Implementation Report

## Executive Summary

All 6 tasks completed. 9 new tests added. Full suite: 146 pass, 0 fail. All 11 success criteria verified.

This is a calibration sprint — no structural changes, no new dependencies, no API-shape changes. Every change is either a value adjustment with cited evidence or an annotation correcting the construct's honesty about its own evidence base.

## Tasks Completed

### Task 3.1 — Raise A/B near-zero guard from 2 to 5 µg/m³

**File**: `src/processor/quality.js:46`

Changed `avg < 2.0` to `avg < 5.0` with Barkjohn et al. 2021 (AMT 14:4617) citation. PMS5003 resolution is 1 µg/m³; below ~5 µg/m³, ratio-based divergence is dominated by quantization noise.

**Tests added** (3):
- `computeChannelConsistency: avg 3 µg/m³ (A=2, B=4) returns 1.0 under 5 µg/m³ guard`
- `computeChannelConsistency: avg 5.0 µg/m³ (A=3, B=7) engages ratio check`
- `computeChannelConsistency: avg 4.9 µg/m³ returns 1.0 (just under guard)`

### Task 3.2 — Add absolute AQI floor to auto-spawn trigger

**File**: `src/index.js:732-734`

Added `if (latestAqi >= 100) continue;` after the `getNextThreshold` null check and before the `hasOpenT1` check. Prevents redundant T1 spawn during already-elevated smoke conditions.

**Tests added** (2):
- `_checkAutoSpawn: does not spawn when AQI is 110 with rising trend of 25`
- `_checkAutoSpawn: spawns when AQI is 80 with rising trend of 25`

### Task 3.3 — Lower T3 wildfire exceedance threshold from 200 to 151

**File**: `src/theatres/wildfire-cascade.js:81`

Changed default `threshold_aqi` from 200 to 151 with Camp Fire PurpleAir study citation (PMC7374346). 151 is the lower boundary of Unhealthy and aligns with Cal/OSHA wildfire protection threshold logic.

**Tests added** (2):
- `createWildfireCascade: default threshold_aqi is 151`
- `createWildfireCascade: default exceedance threshold is the start of Unhealthy, not 150`

### Task 3.4 — Skew wildfire prior away from uniform

**File**: `src/theatres/wildfire-cascade.js:87,105`

Changed both `bucket_probabilities` from `[0.2, 0.2, 0.2, 0.2, 0.2]` to `[0.40, 0.25, 0.15, 0.12, 0.08]` with provisional citation. Prior is explicitly documented as provisional working values, not final empirical truth.

**Tests added** (2):
- `createWildfireCascade: default prior is [0.40, 0.25, 0.15, 0.12, 0.08]`
- `createWildfireCascade: default prior sums to 1.0`

### Task 3.5 — Annotation pass

**Files**: `quality.js`, `uncertainty.js`, `index.js`, `wildfire-cascade.js`

Added `source:` citations where evidence exists (Barkjohn 2021/2022, Camp Fire study). Added `TBD: empirical calibration needed` where values remain engineering estimates. No code behavior changes — annotation only.

Specific annotations:
- `quality.js`: 5 µg/m³ guard source, 0.7 ratio source, weight allocation TBD, density normalization TBD, cross-validation tolerance TBD
- `uncertainty.js`: doubt price TBD, sigma model TBD with concentration-aware note
- `index.js`: +20 trend TBD, AQI floor TBD
- `wildfire-cascade.js`: threshold and prior documented as provisional

### Task 3.6 — README and BUTTERFREEZONE honesty updates

**Files**: `README.md`, `BUTTERFREEZONE.md`

- 3.6a: Smoke transport lag now distinguishes local/regional (2-12h) vs long-range (12-72+h)
- 3.6b: T3 window guidance by event type (72h for short/snapshot, 72-168h for fire sieges)
- 3.6c: AirNow trust language softened — preliminary status, AQS as final system, explicit product trust-policy framing
- 3.6d: BUTTERFREEZONE auto-spawn line updated to reflect AQI < 100 floor

## Testing Summary

```
node --test test/breath.test.js
# tests 146 | pass 146 | fail 0 | suites 32
```

9 new tests added across 3 suites. All 137 pre-existing tests continue to pass.

## Success Criteria Verification

| # | Criterion | Status |
|---|-----------|--------|
| 1 | All pre-existing tests pass | PASS (137/137) |
| 2 | All new Sprint 3 tests pass | PASS (9/9) |
| 3 | `computeChannelConsistency(2, 4) === 1.0` | PASS |
| 4 | `computeChannelConsistency(3, 7) < 1.0` | PASS (→ 0) |
| 5 | `createWildfireCascade({...}).threshold_aqi === 151` | PASS |
| 6 | `bucket_probabilities` deep-equals `[0.40, 0.25, 0.15, 0.12, 0.08]` | PASS |
| 7 | `_checkAutoSpawn` does NOT open T1 when AQI=110, trend=25 | PASS |
| 8 | `_checkAutoSpawn` DOES open T1 when AQI=80, trend=25 | PASS |
| 9 | README distinguishes local vs long-range transport lag | PASS |
| 10 | README uses softened AirNow settlement language | PASS |
| 11 | No file outside the allowed-file list was modified | PASS |

## Files Modified

| File | Change Type |
|------|-------------|
| `src/processor/quality.js` | Code + annotation |
| `src/processor/uncertainty.js` | Annotation only |
| `src/index.js` | Code + annotation |
| `src/theatres/wildfire-cascade.js` | Code + annotation |
| `README.md` | Documentation |
| `BUTTERFREEZONE.md` | Documentation |
| `test/breath.test.js` | 9 new tests |

## Hard Constraints Compliance

- No refactors
- No new dependencies
- No public API changes
- No bucket-boundary changes
- No sigma-value changes
- No update-step changes
- No AirNow ingestion changes
- No certificate changes
- No edits to files outside the allowed list

## Known Limitations

- T3 threshold (151) and prior weights are documented as provisional — historical replay across many wildfire events is still needed
- Auto-spawn AQI floor (100) needs replay calibration for false-positive rate
- Density normalization (10-sensor), cross-validation tolerance (30%/15 AQI), and quality weights remain engineering estimates

## Verification Steps

```bash
# Run full test suite
node --test test/breath.test.js

# Verify specific criteria
node -e "
import { computeChannelConsistency } from './src/processor/quality.js';
import { createWildfireCascade } from './src/theatres/wildfire-cascade.js';
console.log('Guard:', computeChannelConsistency(2, 4) === 1.0);
console.log('Ratio:', computeChannelConsistency(3, 7) < 1.0);
const wc = createWildfireCascade({ tracked_sensors: [] });
console.log('Threshold:', wc.threshold_aqi === 151);
console.log('Prior:', JSON.stringify(wc.bucket_probabilities));
"
```
