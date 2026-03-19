# BREATH — Sprint Plan

> **Construct**: Air Quality Intelligence Agent for Echelon
> **Version**: 0.1.0 (PurpleAir MVP)
> **Date**: 2026-03-19
> **Cycle**: cycle-001
> **Team**: Solo (El Capitan)
> **Sprints**: 4 milestone-based sprints

---

## Overview

Four sprints, each a shippable vertical slice. The critical path from the SDD is respected strictly — later sprints depend on earlier ones. Sprint boundaries follow the natural seams of the architecture:

| Sprint | Milestone | Scope |
|--------|-----------|-------|
| Sprint 1 | Processor Core | AQI computation + full processor pipeline + all processor tests |
| Sprint 2 | Oracle Layer | PurpleAir oracle + EPA AirNow oracle + SensorRegistry + oracle tests |
| Sprint 3 | Theatre + RLMF | All 3 Theatre templates + RLMF certificates + theatre tests |
| Sprint 4 | Integration + Ship | BreathConstruct entrypoint + integration tests + construct packaging |

**Test target**: ≥50 tests / ≥18 suites total. Sprint 4 brings total to ~68 tests across 18 suites.

**Reference implementations**: `grimoires/pub/TREMOR docs/` and `grimoires/pub/Corona docs/` must be read before implementing each module. Match TREMOR's code style: concise JSDoc, flat modules, pure functions preferred.

---

## Sprint 1 — Processor Core

**Goal**: The computation foundation. Every other module depends on this. By the end of Sprint 1, all AQI math is correct, tested, and locked. No Theatre or oracle code exists yet — that's intentional.

**Acceptance gate**: `node --test` passes all processor tests with 0 failures. Breakpoint boundary tests pass.

### Task 1.1 — Project Bootstrap

**Description**: Create the project skeleton. No application logic — just the file structure, `package.json`, and config files.

**Files to create**:
- `package.json` — `{ "type": "module", "scripts": { "test": "node --test test/breath.test.js" }, "engines": { "node": ">=20" } }`
- `.env.example` — `PURPLEAIR_API_KEY=your_key_here` and `AIRNOW_API_KEY=your_key_here`
- `src/index.js` — stub export only: `export class BreathConstruct {}`
- `src/skills/air-quality.md` — stub with `# BREATH Air Quality Construct` header
- `src/oracles/purpleair.js` — stub: `export async function pollPurpleAir() { return { bundles: [] }; }`
- `src/oracles/epa-airnow.js` — stub: `export async function pollAirNow() { return { bundles: [] }; }`
- `src/processor/aqi.js` — stub
- `src/processor/quality.js` — stub
- `src/processor/uncertainty.js` — stub
- `src/processor/settlement.js` — stub
- `src/processor/bundles.js` — stub
- `src/theatres/aqi-gate.js` — stub
- `src/theatres/sensor-divergence.js` — stub
- `src/theatres/wildfire-cascade.js` — stub
- `rlmf/certificates.js` — stub
- `spec/construct.json` — stub `{}`
- `test/breath.test.js` — empty test file that passes `node --test`
- `BUTTERFREEZONE.md` — stub
- `README.md` — stub

**Acceptance criteria**:
- `node --test test/breath.test.js` runs without error (0 tests is acceptable at this stage)
- All directories exist: `src/oracles/`, `src/processor/`, `src/theatres/`, `src/skills/`, `rlmf/`, `spec/`, `test/`
- `package.json` has `"type": "module"` and correct test script
- No `node_modules/` directory, no `npm install` required
- `.env.example` contains both key names

**Dependencies**: None

---

### Task 1.2 — AQI Computation Module (`src/processor/aqi.js`)

**Description**: Implement the full AQI computation module. This is the highest-risk module. Correctness here is non-negotiable — every other module depends on it.

**What to implement** (per SDD Section 4.3):
1. `BREAKPOINTS` object — all 6 pollutant tables (PM25, PM10, O3_8H, O3_1H, NO2, SO2, CO) with exact EPA values
2. `AQI_CATEGORIES` array — 6 categories with numbers, names, ranges
3. `computeNowCast(hourlyReadings)` — PM2.5 NowCast: 12-hour weighted average, weight = max(0.5, Cmin/Cmax), requires ≥2 valid readings in last 3 hours
4. `calculateAQI(pollutant, concentration)` — linear interpolation between breakpoints, `Math.trunc()` (NOT `Math.round()`)
5. `getCategory(aqi)` — map AQI integer to `{ number, name, range }`
6. `getDominantPollutant(pollutantAqis)` — highest AQI wins, alphabetical tiebreak

**Exports**:
```js
export { BREAKPOINTS, AQI_CATEGORIES, computeNowCast, calculateAQI, getCategory, getDominantPollutant }
```

**Critical implementation notes**:
- `calculateAQI` uses `Math.trunc()`, not `Math.round()`. EPA spec specifies truncation.
- `computeNowCast` returns `null` if fewer than 2 of the last 3 hours are valid
- The weight `w` is clamped to `max(0.5, Cmin/Cmax)` — not just `Cmin/Cmax`
- PurpleAir `pm2.5` field (CF=1/ATM) goes directly into NowCast without additional correction
- Comment in code: "PurpleAir API returns CF=1 (ATM) by default — no additional correction required"

**Acceptance criteria**:
- `calculateAQI('PM25', 12.0)` returns `50` (not 51)
- `calculateAQI('PM25', 12.1)` returns `51`
- `calculateAQI('PM25', 55.4)` returns `150`
- `calculateAQI('PM25', 55.5)` returns `151`
- `calculateAQI('PM25', 150.4)` returns `200`
- `calculateAQI('PM25', 150.5)` returns `201`
- `calculateAQI('PM25', 250.4)` returns `300`
- `calculateAQI('PM25', 0.0)` returns `0`
- `calculateAQI('PM25', 500.4)` returns `500` (or highest valid bucket max)
- `computeNowCast([null, null, null, ...12 nulls])` returns `null`
- `computeNowCast([25, null, null, ...])` returns `null` (only 1 valid in last 3 hours)
- `computeNowCast([25, 20, null, ...])` returns a valid number (2 valid in last 3 hours)
- `getCategory(50)` returns `{ number: 1, name: 'Good' }`
- `getCategory(51)` returns `{ number: 2, name: 'Moderate' }`
- `getDominantPollutant({ PM25: 80, O3_8H: 100 })` returns `'O3_8H'`

**Dependencies**: Task 1.1

---

### Task 1.3 — Quality Scoring (`src/processor/quality.js`)

**Description**: Implement quality scoring for PurpleAir sensors and EPA AirNow observations.

**What to implement** (per SDD Section 4.4):
1. `computeQuality(sensor, registryRecord, nearbySensors, nearbyAirNow)` — weighted combination of source_tier (0.35), freshness (0.30), density (0.20), consistency (0.15) with 20% bonus for EPA cross-validation
2. `computeAirNowQuality()` — returns uniform high quality `{ score: 1.0, composite: 1.0, ... }`

**Channel consistency scoring helper** (used by quality and oracle modules):
```js
// consistency >= 0.8 → 'consistent'
// consistency 0.4-0.8 → 'divergent'
// consistency < 0.4 → 'inconsistent'
export function computeChannelConsistency(pm25_a, pm25_b)
export function classifyConsistency(consistencyScore)
```

**Acceptance criteria**:
- `computeAirNowQuality()` returns `{ score: 1.0, composite: 1.0, cross_validated: true }`
- `computeQuality` with fresh sensor (ageSeconds < 120), 15 nearby sensors, perfect A/B consistency, and EPA cross-validation returns score > 0.95
- `computeQuality` with stale sensor (ageSeconds > 480), 0 nearby sensors, no EPA → score < 0.5
- `computeChannelConsistency(35.2, 35.8)` returns value ≥ 0.8 (consistent — low divergence)
- `computeChannelConsistency(10.0, 40.0)` returns value < 0.4 (inconsistent — 120% divergence)
- `computeChannelConsistency(null, 35.0)` returns `0.0`
- `classifyConsistency(0.9)` returns `'consistent'`
- `classifyConsistency(0.5)` returns `'divergent'`
- `classifyConsistency(0.2)` returns `'inconsistent'`

**Dependencies**: Task 1.1

---

### Task 1.4 — Uncertainty Pricing (`src/processor/uncertainty.js`)

**Description**: Implement doubt pricing for PurpleAir sensors and AirNow observations. The doubt price (0-1) quantifies how much to discount a reading for Theatre position updates.

**What to implement** (per SDD Section 4.5):
1. `buildUncertainty(sensor, quality, theatreThreshold)` — base doubt by source tier, adjusted for channel consistency and freshness, cross-validation reduction, threshold sensitivity amplification
2. `buildAirNowUncertainty(theatreThreshold, currentAQI)` — near-zero doubt (0.0 default, 0.05 if threshold sensitive)
3. `thresholdCrossingProbability(aqi, threshold, doubt_price)` — Normal CDF approximation, `sigma = 5 + doubt_price * 55`
4. `normalCDF(x)` — Abramowitz & Stegun approximation (internal helper)

**Acceptance criteria**:
- `buildAirNowUncertainty(null, 80)` returns `{ doubt_price: 0.0, basis: 'EPA_AIRNOW_REFERENCE', threshold_sensitivity: false }`
- `buildAirNowUncertainty(100, 95)` returns `{ doubt_price: 0.05, threshold_sensitivity: true }` (within ±10 of threshold)
- `buildUncertainty` for `channel_inconsistent` sensor (consistency < 0.4) returns `doubt_price >= 0.75`
- `buildUncertainty` for EPA cross-validated sensor returns `doubt_price < 0.20`
- `thresholdCrossingProbability(100, 100, 0.0)` ≈ `0.5` (AQI exactly at threshold, minimal uncertainty)
- `thresholdCrossingProbability(50, 150, 0.0)` is very low (well below threshold, tight sigma)
- `thresholdCrossingProbability(200, 150, 0.0)` is very high (well above threshold)
- `thresholdCrossingProbability(150, 150, 1.0)` ≈ `0.5` (exactly at threshold even with high uncertainty)

**Dependencies**: Tasks 1.1, 1.3

---

### Task 1.5 — Settlement Logic (`src/processor/settlement.js`)

**Description**: Three-tier settlement assessment for PurpleAir and AirNow bundles.

**What to implement** (per SDD Section 4.6):
1. `assessSettlement(sensor, quality, registryRecord, crossValidated, earliestExpiry)` — returns `SettlementAssessment` with: `sensor_dropout`, `channel_inconsistent`, `degraded`, `provisional_mature`, `market_freeze`, or `provisional`
2. `assessAirNowSettlement()` — always returns `{ evidence_class: 'ground_truth', resolution_eligible: true, brier_discount: 0 }`

**Tier logic** (in priority order):
1. Sensor dropout (state === 'dropout') → `sensor_dropout`, discount 20%
2. Channel inconsistent (consistency < 0.4) → `channel_inconsistent`, discount 20%
3. Quality degraded (score < 0.3) → `degraded`, discount 20%
4. Provisional mature (cross-validated + 3+ sensors + >2h + quality >= 0.7) → `provisional_mature`, discount 10%
5. Market freeze (Theatre expiring in <2h + quality < 0.5) → `market_freeze`, discount 20%
6. Default → `provisional`, discount 0%, not eligible for resolution

**Acceptance criteria**:
- Dropout sensor → `{ evidence_class: 'sensor_dropout', resolution_eligible: false, brier_discount: 0.20 }`
- Channel inconsistent quality → `{ evidence_class: 'channel_inconsistent', resolution_eligible: false, brier_discount: 0.20 }`
- High quality, EPA cross-validated, 5 nearby sensors, 3h old → `{ evidence_class: 'provisional_mature', resolution_eligible: true, brier_discount: 0.10 }`
- `assessAirNowSettlement()` always returns `{ evidence_class: 'ground_truth', resolution_eligible: true, brier_discount: 0 }`
- Standard fresh sensor → `{ evidence_class: 'provisional', resolution_eligible: false, brier_discount: 0 }`

**Dependencies**: Tasks 1.1, 1.3

---

### Task 1.6 — Evidence Bundle Construction (`src/processor/bundles.js`)

**Description**: Pure assembly functions that combine processor outputs into Echelon-compatible evidence bundles. No side effects, no API calls.

**What to implement** (per SDD Section 4.7):
1. `buildPurpleAirBundle(sensor, registryRecord, qualityResult, uncertaintyResult, settlementResult, activeTheatres)` — full EvidenceBundle for PurpleAir sensor
2. `buildAirNowBundle(obs, qualityResult, uncertaintyResult, settlementResult, activeTheatres)` — full EvidenceBundle for AirNow observation
3. `matchTheatres(sensor, theatres)` — filter active theatres by bounding box intersection
4. `matchAirNowObservation(obs, theatres)` — filter active theatres by bounding box intersection

**Attribution requirements**:
- PurpleAir bundles: `attribution: 'PurpleAir Community Sensor Network'`
- AirNow bundles: `attribution: 'U.S. EPA AirNow (preliminary data — not for regulatory use)'`

**Bundle_id format**:
- PurpleAir: `breath-purpleair-{sensor_index}-{last_seen}`
- AirNow: `breath-airnow-{ReportingArea_slugified}-{observation_time}`

**Acceptance criteria**:
- PurpleAir bundle has `data_tier: 'early_warning'`
- AirNow bundle has `data_tier: 'settlement_authority'`
- AirNow bundle has `evidence_class: 'ground_truth'` (regardless of quality inputs)
- AirNow bundle has correct attribution string (exactly as specified)
- PurpleAir bundle `payload.averaging_basis` is `'instantaneous'`
- AirNow bundle `payload.averaging_basis` is `'nowcast'`
- `matchTheatres` with sensor inside bbox returns theatre ID; outside bbox returns empty array
- `matchTheatres` skips theatres in `'resolved'` or `'expired'` state
- Bundle with no matching theatres has `theatre_refs: []`
- `observation_time`, `publication_time`, `ingest_time` all present in payload

**Dependencies**: Tasks 1.1, 1.2, 1.3, 1.4, 1.5

---

### Task 1.7 — Processor Test Suite

**Description**: Comprehensive tests for all processor modules. This is the most test-heavy sprint — AQI boundary coverage is mandatory.

**Target**: ≥38 tests across 8 suites in `test/breath.test.js`

**Required suites and test counts**:

| Suite name | Tests |
|-----------|-------|
| `'AQI computation — NowCast'` | 6 |
| `'AQI computation — breakpoints and truncation'` | 8 |
| `'AQI computation — categories and dominant pollutant'` | 4 |
| `'Quality scoring — PurpleAir'` | 5 |
| `'Quality scoring — AirNow'` | 2 |
| `'Uncertainty pricing'` | 6 |
| `'Settlement logic'` | 5 |
| `'Evidence bundle construction'` | 6 |
| **Total Sprint 1** | **42** |

**Critical breakpoint tests** (all must be explicit, not generated):
```js
// PM2.5 category boundary tests
calculateAQI('PM25', 12.0)  → 50   (top of Good, not 51)
calculateAQI('PM25', 12.1)  → 51   (bottom of Moderate)
calculateAQI('PM25', 35.4)  → 100  (top of Moderate)
calculateAQI('PM25', 35.5)  → 101  (bottom of USG)
calculateAQI('PM25', 55.4)  → 150  (top of USG)
calculateAQI('PM25', 55.5)  → 151  (bottom of Unhealthy)
calculateAQI('PM25', 150.4) → 200  (top of Unhealthy)
calculateAQI('PM25', 150.5) → 201  (bottom of Very Unhealthy)
```

**Acceptance criteria**:
- All 42 tests pass: `node --test test/breath.test.js`
- All 8 breakpoint boundary values above are explicit named tests
- Zero use of live API calls (all data is static objects in test file)
- `node --test` output shows all 8 suite names above

**Dependencies**: Tasks 1.2–1.6

---

## Sprint 2 — Oracle Layer

**Goal**: Real data flows through the processor pipeline. By the end of Sprint 2, BREATH can poll both APIs, normalize responses, build evidence bundles, and maintain the Sensor Registry across polls — all without any Theatres yet.

**Acceptance gate**: Standalone oracle scripts work against live APIs (with valid env vars). Oracle tests pass with mocked HTTP.

### Task 2.1 — Sensor Registry

**Description**: The `SensorRegistry` class. Tracks persistent PurpleAir sensor state across polls. Lives in `src/index.js` (consistent with TREMOR pattern of top-level state in entrypoint).

**What to implement**:

```js
class SensorRegistry {
  constructor() { this.sensors = new Map(); }

  // Update registry from PurpleAir API response
  update(apiSensors) { ... }

  // Get sensors not seen in last 2 × pollInterval
  getDropouts(now, pollIntervalMs) { ... }

  // Get active sensors within bounding box
  getSensorsInBbox(bbox) { ... }

  // Update channel consistency rolling score (10-reading rolling average)
  updateChannelConsistency(sensorIndex, pm25_a, pm25_b) { ... }

  // Get rolling AQI trend over last N hours (for auto-spawn detection)
  getAqiTrend(sensorIndex, hours) { ... }

  // Detect location drift (> 0.001 degree change in lat or lon)
  hasLocationDrift(sensorIndex, newLat, newLon) { ... }

  // Update sensor state
  setState(sensorIndex, state) { ... }
}
```

**Acceptance criteria**:
- `update()` adds new sensors to registry
- `update()` updates `last_seen` for existing sensors
- `getDropouts()` returns sensors with `last_seen` older than `2 × pollIntervalMs`
- `getSensorsInBbox([minLon, minLat, maxLon, maxLat])` returns only sensors within bounds
- `updateChannelConsistency()` maintains rolling 10-reading average (not just latest value)
- `hasLocationDrift()` returns true when coordinates change by > 0.001 degrees
- `getAqiTrend()` returns positive number when recent AQI is rising, negative when falling

**Dependencies**: Sprint 1 complete

---

### Task 2.2 — PurpleAir Oracle (`src/oracles/purpleair.js`)

**Description**: Poll PurpleAir API, normalize response, update Sensor Registry, build evidence bundles for new/updated sensors.

**What to implement**:
1. `pollPurpleAir(config, registry, activeTheatres)` — main poll function
   - HTTP GET to PurpleAir API with bbox and field params
   - Normalize API response (fields array + data array → object per sensor)
   - Update registry (new sensors, updated readings, dropout detection)
   - Build bundles for each sensor (calls `buildPurpleAirBundle`)
   - Handle rate limits: exponential backoff on 429, cache last successful response
   - Location type filter: skip `location_type !== 0`
   - Dedup: skip if `last_seen` unchanged from registry
   - Return `{ bundles, dropouts }`

2. `normalizePurpleAirResponse(apiResponse)` — convert fields/data arrays to sensor objects

3. Standalone script behavior: when run directly (`node src/oracles/purpleair.js`), poll all four cardinal US regions and log sensor counts

**Rate limit / backoff constants** (module-level):
```js
const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;
const BACKOFF_MULTIPLIER = 2;
```

**Acceptance criteria**:
- `normalizePurpleAirResponse` correctly zips `fields` array with `data` rows
- Sensors with `location_type !== 0` are filtered out before bundle creation
- Sensors where `last_seen` is unchanged from registry are not bundled (deduped)
- Sensor dropout (expected sensor missing from response) creates `sensor_dropout` evidence class bundle
- Location drift detection: if sensor coordinates change > 0.001°, `location_stable: false` in registry record
- `pollPurpleAir` handles `fetch` errors without throwing (returns empty result, logs error)
- `pollPurpleAir` handles HTTP 429 with exponential backoff (mock test)
- `pollPurpleAir` returns cached response on 429 if cache exists (mock test)
- Bundles include correct `attribution` string

**Dependencies**: Tasks 2.1, Sprint 1 complete

---

### Task 2.3 — EPA AirNow Oracle (`src/oracles/epa-airnow.js`)

**Description**: Poll EPA AirNow API, normalize response, build settlement-authority evidence bundles.

**What to implement**:
1. `pollAirNow(config, regions)` — main poll function
   - HTTP GET to AirNow latLong endpoint for each region's center point
   - Normalize observation objects
   - Build AirNow bundles (calls `buildAirNowBundle` from `bundles.js`)
   - Handle timezone: map LocalTimeZone strings to UTC offsets (US timezones only)
   - Rate limit: one call per region per hour (caller enforces via `lastAirNowPoll`)
   - Return `{ bundles, observations }`

2. `parseAirNowObservationTime(obs)` — build `{ observation_time, publication_time, ingest_time, averaging_basis }` from AirNow response fields

3. `AIRNOW_TZ_OFFSETS` — map of US timezone abbreviations to UTC offset hours
   ```js
   // At minimum: EST (-5), EDT (-4), CST (-6), CDT (-5), MST (-7), MDT (-6), PST (-8), PDT (-7)
   // AKST (-9), AKDT (-8), HST (-10), HAST (-10)
   ```

4. Standalone script: `node src/oracles/epa-airnow.js` — poll for a default region (e.g., San Francisco) and log current AQI

**Acceptance criteria**:
- `parseAirNowObservationTime` returns correct epoch ms for `DateObserved: "2026-03-19 "`, `HourObserved: 14`, `LocalTimeZone: "PST"` → observation_time = epoch ms for 2026-03-19 14:00 PST (22:00 UTC)
- Note: AirNow `DateObserved` has a trailing space — trim before parsing
- Bundles have `data_tier: 'settlement_authority'`
- Bundles have `evidence_class: 'ground_truth'` (always)
- Bundles have exact attribution string: `'U.S. EPA AirNow (preliminary data — not for regulatory use)'`
- Unknown timezone abbreviation logs a warning and skips the observation (does not throw)
- Network error handled gracefully: returns `{ bundles: [], observations: [] }`
- HTTP 401 logs a critical error (misconfigured API key) and returns empty

**Dependencies**: Tasks 2.1, Sprint 1 complete

---

### Task 2.4 — Oracle Tests + Adversarial Scenarios

**Description**: Tests for both oracle modules with mocked HTTP, plus the 4 adversarial sensor tests.

**Target**: 18 additional tests across 5 suites

| Suite name | Tests |
|-----------|-------|
| `'PurpleAir oracle — normalization and dedup'` | 4 |
| `'PurpleAir oracle — rate limit and backoff'` | 3 |
| `'EPA AirNow oracle — bundle construction'` | 4 |
| `'EPA AirNow oracle — time semantics'` | 3 |
| `'Adversarial sensor scenarios'` | 4 |
| **Total Sprint 2** | **18** |

**Adversarial test cases** (all 4 must be explicit):
1. Indoor sensor (`location_type: 1`) in API response → excluded from bundles
2. Channel A/B severe divergence (`pm2.5_a: 10, pm2.5_b: 80`) → `channel_inconsistent` evidence class
3. Frozen sensor (same `last_seen` across 3 polls) → `sensor_dropout` after 2× poll cadence
4. Location drift (lat changes by 0.002°) → `location_stable: false` in registry record

**Acceptance criteria**:
- All 18 tests pass
- No live API calls — all HTTP responses are static mocks using `globalThis.fetch` override or similar
- Total test count after Sprint 2: **60 tests / 13 suites** (42 from Sprint 1 + 18 from Sprint 2)

**Dependencies**: Tasks 2.1–2.3

---

## Sprint 3 — Theatre Layer + RLMF

**Goal**: Prediction markets work end-to-end. Evidence bundles update Theatre positions. Theatres resolve. RLMF certificates export with correct Brier scores.

**Acceptance gate**: Each Theatre can be created, receive bundles, resolve (YES and NO paths), and export a valid certificate. Multi-class Brier score is correct for T3.

### Task 3.1 — T1: AQI Threshold Gate (`src/theatres/aqi-gate.js`)

**Description**: Binary threshold market. Resolves via EPA AirNow ground truth.

**What to implement** (per SDD Section 4.8):
1. `createAqiThresholdGate(params)` — validates `aqi_threshold` is a valid category boundary (51, 101, 151, 201, 301), sets `threshold_category_number`
2. `processAqiThresholdGate(theatre, bundle)` — handles EPA ground truth resolution, PurpleAir provisional_hold transition, and probability position updates using `thresholdCrossingProbability`
3. `expireAqiThresholdGate(theatre)` — resolve as NO when Theatre window closes without EPA confirmation

**Probability update logic** (from SDD):
- EPA AirNow `ground_truth` bundle → resolve immediately based on `category_number >= threshold_category_number`
- PurpleAir `provisional_mature` exceeds threshold → state transitions to `provisional_hold`
- PurpleAir `provisional` or `cross_validated` → blend position using `thresholdCrossingProbability` weighted by quality

**Auto-spawn note**: `BreathConstruct` (Sprint 4) handles auto-spawn triggers. This module is stateless — just creates/processes/expires.

**Acceptance criteria**:
- `createAqiThresholdGate({ aqi_threshold: 150 })` throws (150 is not a category boundary; 151 is)
- `createAqiThresholdGate({ aqi_threshold: 151, ... })` succeeds with `threshold_category_number: 4`
- Processing an EPA AirNow bundle with `category_number >= 4` resolves theatre with `outcome: true`
- Processing an EPA AirNow bundle with `category_number < 4` and theatre at expiry resolves with `outcome: false`
- Processing a PurpleAir bundle with `evidence_class: 'provisional_mature'` and AQI ≥ threshold sets `state: 'provisional_hold'`
- `current_position` updates toward `thresholdCrossingProbability` result on each PurpleAir provisional bundle
- `position_history` grows by one entry per processed bundle
- `expireAqiThresholdGate` resolves with `outcome: false` if Theatre never resolved
- Resolved theatre is immutable: `processAqiThresholdGate` returns same theatre object if already resolved

**Dependencies**: Task 1.4 (uncertainty.js for thresholdCrossingProbability), Sprint 2 complete

---

### Task 3.2 — T2: Sensor Divergence (`src/theatres/sensor-divergence.js`)

**Description**: The Paradox Engine native theatre. Self-resolving within PurpleAir data. No EPA AirNow involvement.

**What to implement** (per SDD Section 4.8):
1. `createSensorDivergence({ sensor_a_index, sensor_b_index, aqi_divergence_threshold, required_hours, region_bbox, ... })` — stores sensor pair, initializes `divergence_window: []`, `consecutive_hours_divergent: 0`
2. `processSensorDivergence(theatre, bundle)` — only processes bundles from sensor_a or sensor_b; updates rolling divergence window; transitions to resolved if `consecutive_hours_divergent >= required_hours`

**Position update**: `current_position = recentExceeded / required_hours` (smooth 0→1 as divergence accumulates)

**Resolution**: `consecutive_hours_divergent >= required_hours` → `outcome: true`. Theatre expiry without condition → `outcome: false`.

**Acceptance criteria**:
- Theatre ignores bundles from sensors not in the sensor pair
- `consecutive_hours_divergent` increments when `|aqi_a - aqi_b| > aqi_divergence_threshold`
- `consecutive_hours_divergent` resets to 0 when divergence drops below threshold
- Two consecutive hours of AQI_A=200, AQI_B=100 (diff=100 > default threshold 50) → resolved YES with `outcome: true`
- Theatre expiry with `consecutive_hours_divergent < required_hours` → `outcome: false`
- `current_position` smoothly increases as divergent hours accumulate (not binary jump)
- Processing a resolved theatre returns it unchanged

**Dependencies**: Sprint 1 complete (processor modules), Sprint 2 (oracle tests context)

---

### Task 3.3 — T3: Wildfire Cascade (`src/theatres/wildfire-cascade.js`)

**Description**: Multi-class market analogous to TREMOR's Aftershock Cascade. Tracks what fraction of sensors in a region exceed AQI 200.

**What to implement** (per SDD Section 4.8):
1. `createWildfireCascade({ target_region, wildfire_trigger, tracked_sensors, window_hours, ... })` — locks the sensor set at creation time (`tracked_sensors` is a snapshot of sensor IDs in region at Theatre open); initializes `bucket_probabilities: [0.2, 0.2, 0.2, 0.2, 0.2]` (uniform prior)
2. `processWildfireCascade(theatre, bundle)` — updates `current_pct_exceeded` on each poll cycle; shifts `bucket_probabilities` toward observed pct
3. `resolveWildfireCascade(theatre)` — called at `closes_at`; computes final `current_pct_exceeded`; assigns outcome bucket (0-4)

**Bucket definitions** (from SDD):
```js
[0-10%, 10-30%, 30-50%, 50-70%, 70%+] → bucket index 0-4
```

**Bucket probability update**: Simple approach — compute which bucket `current_pct_exceeded` falls in; shift that bucket's probability by 0.15 toward 1.0 and redistribute the remainder proportionally across others.

**Acceptance criteria**:
- Tracked sensor set is frozen at Theatre creation (later sensor additions don't affect the Theatre)
- `current_pct_exceeded` = (sensors with AQI ≥ 200) / `tracked_sensors.length`
- Resolving with 4 of 10 sensors exceeding threshold → `current_pct_exceeded = 0.4` → `outcome: 2` (30-50% bucket)
- Resolving with 0 sensors exceeding → `outcome: 0` (0-10% bucket)
- Resolving with all sensors exceeding → `outcome: 4` (70%+ bucket)
- `bucket_probabilities` sums to 1.0 (or very close) after any update
- `resolveWildfireCascade` returns theatre with `state: 'resolved'` and `outcome` as integer 0-4
- `position_history` entries reflect the evolving `bucket_probabilities` array

**Dependencies**: Sprint 1 complete

---

### Task 3.4 — RLMF Certificate Export (`src/rlmf/certificates.js`)

**Description**: Export RLMF training certificates for resolved Theatres. Schema must be TREMOR/CORONA compatible.

**What to implement** (per SDD Section 4.9):
1. `exportCertificate(theatre, meta)` — builds full RLMFCertificate from resolved Theatre
2. `brierScoreBinary(positionHistory, outcome)` — B = (1/N) × Σ(p_i - o)²
3. `brierScoreMultiClass(bucketProbHistory, outcomeIndex, numBuckets)` — multi-class Brier score
4. `computeLeadTime(positionHistory, outcome, resolvedAt)` — when did position cross 0.5 toward correct outcome?
5. `computeVolatility(positionHistory)` — standard deviation of position changes

**Certificate ID format**: `breath-{theatre_id}-{resolved_at}`

**Acceptance criteria**:
- Certificate has all required top-level fields: `certificate_id`, `construct`, `theatre_id`, `template`, `outcome`, `opened_at`, `resolved_at`, `performance`, `evidence_summary`, `brier_discount`, `settlement_tier`
- `brierScoreBinary([{p:0.5}], true)` → `0.25`
- `brierScoreBinary([{p:1.0}], true)` → `0.0`
- `brierScoreBinary([{p:0.0}], true)` → `1.0`
- `brierScoreBinary([{p:0.5}, {p:0.8}], true)` → average of `0.25` and `0.04` → `0.145`
- `construct` field is always `'BREATH'` (or overridden by `meta.construct_id`)
- `performance.lead_time_seconds` is positive when correct prediction preceded resolution
- `performance.directional_accuracy` is `true` when final pre-resolution position correctly predicted outcome
- Certificates from T3 (multi-class) have `outcome` as integer 0-4, not boolean
- `evidence_summary.epa_airnow_confirmed` is `true` when `resolving_bundle_id` contains `'airnow'`

**Dependencies**: Tasks 3.1, 3.2, 3.3

---

### Task 3.5 — Theatre and RLMF Test Suite

**Description**: Tests for all three Theatre templates and RLMF certificate export.

**Target**: 17 tests across 4 suites

| Suite name | Tests |
|-----------|-------|
| `'T1: AQI Threshold Gate'` | 5 |
| `'T2: Sensor Divergence'` | 4 |
| `'T3: Wildfire Cascade'` | 4 |
| `'RLMF certificates'` | 4 |
| **Total Sprint 3** | **17** |

**Required test cases** (must be explicit):
- T1: EPA AirNow resolves YES (category_number meets threshold)
- T1: EPA AirNow resolves NO (Theatre expires)
- T1: PurpleAir provisional_mature transitions to provisional_hold
- T1: Position update chain (multiple PurpleAir bundles → monotonically increasing position toward threshold)
- T2: Two consecutive divergent hours → resolved YES
- T2: Reset: divergence then convergence resets consecutive counter
- T3: Final pct correctly selects bucket 0 (0 sensors exceeded) and bucket 4 (all exceeded)
- Certificate: Brier score 0.0 for perfect prediction (position always 1.0, outcome true)

**Acceptance criteria**:
- All 17 tests pass
- Total test count after Sprint 3: **77 tests / 17 suites** → wait, Sprint 1 has 8 suites, Sprint 2 has 5, Sprint 3 adds 4 → 17 suites. Target ≥18, achieved in Sprint 4.

**Dependencies**: Tasks 3.1–3.4

---

## Sprint 4 — Integration + Ship

**Goal**: `BreathConstruct` ties everything together. The construct runs as a live polling loop. Packaging is complete. The construct is listable on the Constructs Network.

**Acceptance gate**: `node --test` passes all tests. `node src/index.js` starts without error. `spec/construct.json` is valid JSON. `BUTTERFREEZONE.md` contains required AGENT-CONTEXT header.

### Task 4.1 — `BreathConstruct` Entrypoint (`src/index.js`)

**Description**: The main construct class. Orchestrates dual-oracle coordination, Theatre lifecycle, auto-spawn logic, and certificate export.

**What to implement** (per SDD Section 4.10):

```js
export class BreathConstruct {
  constructor(config = {})    // See SDD 4.10 for full config spec
  openAqiThresholdGate(params)
  openSensorDivergence(params)
  openWildfireCascade(params)
  getActiveTheatres()
  getActiveRegions()           // Unique bboxes from active theatres (for AirNow queries)
  start()
  stop()
  async poll()                 // Dual-oracle coordination (see SDD 2.2)
  _processBundle(bundle)
  _exportCertificate(theatre)
  _checkExpiries()
  _checkAutoSpawn(bundles)
  getState()
  getCertificates()
  flushCertificates()
}
```

**Dual-oracle coordination** (critical, from SDD Section 2.2):
```js
// In poll():
// 1. ALWAYS call pollPurpleAir
// 2. Check if 60m elapsed since lastAirNowPoll
// 3. If yes: call pollAirNow FIRST (before processing PurpleAir bundles — ensures cross-validation is current)
// 4. Process all bundles: AirNow bundles first, then PurpleAir bundles
// 5. Check expiries
// 6. Check auto-spawn
```

**Auto-spawn logic** (T1 only in MVP):
- AQI trend ≥ +20 in 2h AND no open T1 for that region → spawn T1 for next category threshold
- `getNextThreshold(currentAQI)` — return the next EPA category boundary above current AQI

**Standalone script behavior**: `node src/index.js` prints construct version and instructions, does not start polling (requires explicit `.start()` call)

**Credential loading order**:
1. `config.apiKeys.purpleair` / `config.apiKeys.airnow`
2. `process.env.PURPLEAIR_API_KEY` / `process.env.AIRNOW_API_KEY`
3. Log warning if either is missing (do not throw — allow testing without keys)

**Acceptance criteria**:
- `new BreathConstruct()` instantiates without error (no API keys required for construction)
- `start()` throws if called twice without `stop()` in between
- `stop()` is idempotent (calling twice doesn't throw)
- `getState()` returns `{ construct: 'BREATH', running: bool, stats: {...}, theatres: {...} }`
- `getCertificates()` returns array of exported certificates
- `flushCertificates()` returns count flushed and clears the array
- `poll()` calls PurpleAir oracle and (conditionally) AirNow oracle
- `poll()` calls AirNow before processing PurpleAir bundles when AirNow is due
- `getActiveRegions()` returns deduplicated list of bboxes from open/provisional_hold Theatres
- A Theatre resolves to certificate within the same `poll()` call that triggered resolution
- `_checkAutoSpawn` spawns T1 when AQI trend ≥ +20 in 2h and no existing open T1 for that region

**Exports** (for granular use, matching TREMOR pattern):
```js
export { BreathConstruct, SensorRegistry }
export { pollPurpleAir } from './oracles/purpleair.js'
export { pollAirNow } from './oracles/epa-airnow.js'
export { computeNowCast, calculateAQI, BREAKPOINTS } from './processor/aqi.js'
export { computeQuality } from './processor/quality.js'
export { buildUncertainty, thresholdCrossingProbability } from './processor/uncertainty.js'
export { assessSettlement } from './processor/settlement.js'
export { buildPurpleAirBundle, buildAirNowBundle } from './processor/bundles.js'
export { createAqiThresholdGate, processAqiThresholdGate, expireAqiThresholdGate } from './theatres/aqi-gate.js'
export { createSensorDivergence, processSensorDivergence } from './theatres/sensor-divergence.js'
export { createWildfireCascade, processWildfireCascade, resolveWildfireCascade } from './theatres/wildfire-cascade.js'
export { exportCertificate, brierScoreBinary, brierScoreMultiClass } from './rlmf/certificates.js'
```

**Dependencies**: All previous sprints complete

---

### Task 4.2 — Integration Tests

**Description**: Tests for `BreathConstruct` end-to-end behavior.

**Target**: 6 tests in 1 suite

| Suite name | Tests |
|-----------|-------|
| `'BreathConstruct — integration'` | 6 |
| **Total Sprint 4 tests** | **6** |

**Required test cases**:
1. `new BreathConstruct()` + `openAqiThresholdGate(...)` + inject mocked PurpleAir bundles → Theatre gets position updates
2. Inject EPA AirNow bundle that crosses threshold → Theatre resolves, certificate exported
3. `getState()` reflects correct `theatres.by_state` counts
4. `flushCertificates()` returns 1 after one resolved Theatre, then 0 on second call
5. `stop()` after `start()` clears polling timer (timer is null)
6. `poll()` processes AirNow bundles before PurpleAir bundles when both are available (order matters for cross-validation)

**Acceptance criteria**:
- All 6 tests pass
- **Total final count**: 83 tests / 18 suites (well above ≥50/≥18 target)
- `node --test test/breath.test.js` shows 18 suite names and 83 passing

**Dependencies**: Task 4.1

---

### Task 4.3 — Construct Specification (`spec/construct.json`)

**Description**: Machine-readable construct spec for Constructs Network listing.

**Required fields**:
```json
{
  "name": "BREATH",
  "slug": "breath",
  "description": "Air quality intelligence construct for the Echelon prediction market framework. Ingests PurpleAir and EPA AirNow data, runs prediction markets on AQI outcomes, exports Brier-scored RLMF training data.",
  "version": "0.1.0",
  "license": "AGPL-3.0",
  "domain": "air-quality",
  "archetype": "spy",
  "runtime": "node",
  "runtime_version": ">=20",
  "dependencies": [],
  "data_sources": [
    { "id": "purpleair", "role": "early_warning", "auth": "api_key", "url": "api.purpleair.com/v1" },
    { "id": "epa_airnow", "role": "settlement_authority", "auth": "api_key", "url": "www.airnowapi.org/aq" }
  ],
  "theatre_templates": [
    { "id": "aqi_threshold_gate", "type": "binary", "window_hours": "4-72" },
    { "id": "sensor_divergence", "type": "binary", "window_hours": "4-24" },
    { "id": "wildfire_cascade", "type": "multi_class", "buckets": 5, "window_hours": 72 }
  ],
  "rlmf": {
    "schema_version": "0.1.0",
    "compatible_with": ["tremor", "corona"]
  },
  "ecosystem": [
    { "repo": "0xHoneyJar/loa", "role": "framework", "protocol": "loa-constructs@0.1.0" },
    { "repo": "echelon/framework", "role": "runtime", "protocol": "echelon-theatres@0.1.0" }
  ]
}
```

**Acceptance criteria**:
- `JSON.parse(fs.readFileSync('spec/construct.json', 'utf8'))` succeeds without error
- All required fields present
- `"dependencies": []` — confirms zero external dependencies

**Dependencies**: Task 4.1

---

### Task 4.4 — `src/skills/air-quality.md` — Specialization Profile

**Description**: Construct specialization profile. Describes BREATH's domain knowledge for the Constructs Network.

**Required sections**: Domain specializations, data ingestion capabilities, signal processing skills, cross-source corroboration logic, known failure modes, Theatre templates.

**Acceptance criteria**:
- File exists and is non-empty
- Covers all 3 Theatre templates by name
- Describes the PurpleAir early-warning / EPA AirNow settlement-authority tier model
- Lists adversarial failure modes: channel inconsistency, sensor dropout, location drift

**Dependencies**: Task 4.1

---

### Task 4.5 — `BUTTERFREEZONE.md` — Agent-Facing Interface

**Description**: Agent-readable project summary following Loa BUTTERFREEZONE format. Must include AGENT-CONTEXT metadata block.

**Required sections** (following TREMOR's BUTTERFREEZONE.md as template):
- AGENT-CONTEXT YAML block (name, type, purpose, key_files, interfaces, dependencies, ecosystem)
- Key Capabilities (with `file:line` references — add after implementation)
- Architecture diagram (ASCII pipeline)
- Interfaces table (Construct API + Theatre Templates + OSINT Feeds)
- Module Map
- Verification section (test count, dependencies)
- Culture section (naming, principles, domain metaphor)
- Quick Start

**AGENT-CONTEXT block**:
```yaml
name: breath
type: construct
purpose: Air quality intelligence construct for Echelon. Ingests PurpleAir (signal layer) and
  EPA AirNow (settlement authority), builds evidence bundles, runs 3 Theatre types on AQI outcomes,
  and exports Brier-scored RLMF training certificates.
key_files: [src/index.js, src/processor/aqi.js, src/processor/bundles.js, spec/construct.json]
interfaces:
  core: [BreathConstruct, pollAndIngest, buildBundle, exportCertificate]
  theatres: [aqi_threshold_gate, sensor_divergence, wildfire_cascade]
  oracles: [purpleair, epa_airnow]
dependencies: []
ecosystem:
  - repo: 0xHoneyJar/loa
    role: framework
    interface: constructs
    protocol: loa-constructs@0.1.0
  - repo: echelon/framework
    role: runtime
    interface: theatre-registry
    protocol: echelon-theatres@0.1.0
```

**Acceptance criteria**:
- AGENT-CONTEXT block present and valid YAML
- Key capabilities listed with `file:line` references (populated after implementation)
- Interfaces table includes all exported functions
- Verification section shows correct test count (match `node --test` output)

**Dependencies**: Task 4.1 (need actual line numbers for file:line references)

---

### Task 4.6 — `README.md` — Human-Facing Documentation

**Description**: README following TREMOR's structure. Covers what BREATH does, why air quality, quick start, architecture, Theatre templates, and calibration edge cases.

**Required sections**:
1. Title + tagline
2. "What it does" — 2-3 sentences
3. "Why air quality" — 5 bullet points mirroring TREMOR's "Why seismic" section
4. Quick start (including usage as library: `openAqiThresholdGate`, `start`, `getState`, `getCertificates`)
5. Architecture (directory tree)
6. Settlement architecture (EPA AirNow = ground truth, PurpleAir = signal layer)
7. Theatre templates table
8. Calibration edge cases section (EPA AirNow hourly delay, PurpleAir A/B divergence, sensor dropout, AQI breakpoint discontinuities, wildfire smoke transport lag)
9. Dependencies (`Zero. Node.js 20+ only.`)
10. License (`AGPL-3.0`)

**"Why air quality" bullets** (must include):
- Ground truth oracle — EPA reviewed AQI. No human interpretation.
- Binary structure — EPA category breakpoints create natural threshold gates.
- Fast cycles — AQI updates hourly. Theatres resolve in 4-72 hours.
- Exogenous — predictions don't affect air quality. No reflexivity.
- Dense network — 30,000+ PurpleAir sensors enable sensor-to-sensor corroboration.

**Acceptance criteria**:
- All 9 required sections present
- Quick start code block runs (import syntax is valid ESM)
- "Why air quality" section has ≥5 bullet points

**Dependencies**: Task 4.1

---

## Sprint Summary

| Sprint | Tasks | Tests Added | Cumulative Tests | Cumulative Suites |
|--------|-------|-------------|-----------------|-------------------|
| Sprint 1 | 7 | 42 | 42 | 8 |
| Sprint 2 | 4 | 18 | 60 | 13 |
| Sprint 3 | 5 | 17 | 77 | 17 |
| Sprint 4 | 6 | 6 | 83 | 18 |

**Final**: 83 tests / 18 suites. Target was ≥50/≥18. ✓

---

## Dependencies Map

```
Task 1.1 (bootstrap)
  └─→ Task 1.2 (aqi.js)
        └─→ Task 1.3 (quality.js)
              └─→ Task 1.4 (uncertainty.js)
              └─→ Task 1.5 (settlement.js)
                    └─→ Task 1.6 (bundles.js)
                          └─→ Task 1.7 (processor tests) ← Sprint 1 COMPLETE
                                └─→ Task 2.1 (SensorRegistry)
                                      └─→ Task 2.2 (purpleair.js)
                                      └─→ Task 2.3 (epa-airnow.js)
                                            └─→ Task 2.4 (oracle tests) ← Sprint 2 COMPLETE
                                                  └─→ Task 3.1 (aqi-gate.js)
                                                  └─→ Task 3.2 (sensor-divergence.js)
                                                  └─→ Task 3.3 (wildfire-cascade.js)
                                                        └─→ Task 3.4 (certificates.js)
                                                              └─→ Task 3.5 (theatre tests) ← Sprint 3 COMPLETE
                                                                    └─→ Task 4.1 (index.js)
                                                                          └─→ Task 4.2 (integration tests)
                                                                          └─→ Task 4.3 (construct.json)
                                                                          └─→ Task 4.4 (air-quality.md)
                                                                          └─→ Task 4.5 (BUTTERFREEZONE.md)
                                                                          └─→ Task 4.6 (README.md) ← Sprint 4 COMPLETE
```

---

## Risk Register

| Risk | Sprint | Mitigation |
|------|--------|-----------|
| NowCast algorithm bugs | 1 | 8 explicit breakpoint boundary tests. Implement aqi.js first, test exhaustively before proceeding. |
| AirNow timezone string parsing | 2 | US-only TZ abbreviation table. Skip + log warning on unknown. |
| PurpleAir API response shape changes | 2 | `normalizePurpleAirResponse()` as isolated adapter — one place to fix. |
| Dual-oracle ordering bug | 4 | Integration test explicitly verifies AirNow processed before PurpleAir. |
| AQI truncation vs rounding | 1 | Explicit test: `calculateAQI('PM25', 12.0)` must return 50 (not 51). |

---

## Reference Materials

| What | Where |
|------|-------|
| TREMOR source (architecture template) | `grimoires/pub/TREMOR docs/` |
| CORONA source (second template) | `grimoires/pub/Corona docs/` |
| Echelon platform context | `grimoires/pub/Echelon/ECHELON readme.md` |
| Design conversation | `grimoires/pub/ALPHA PROMPT.md` |
| PRD | `grimoires/loa/prd.md` |
| SDD | `grimoires/loa/sdd.md` |
