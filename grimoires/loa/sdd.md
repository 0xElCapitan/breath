# BREATH — Software Design Document

> **Construct**: Air Quality Intelligence Agent for Echelon
> **Version**: 0.1.0 (PurpleAir MVP)
> **Date**: 2026-03-19
> **Status**: APPROVED FOR SPRINT PLANNING
> **PRD**: `grimoires/loa/prd.md`

---

## 1. Executive Summary

BREATH is the third construct in the TREMOR → CORONA lineage. The architecture follows the established pattern exactly: **Oracle → Processor → Theatre → RLMF**. The novel elements are:

1. **Dual-oracle coordination** — Two oracles with different cadences (PurpleAir 120s, EPA AirNow 60m) coordinated inside a single `poll()` call.
2. **Sensor Registry** — Persistent sensor state across polls (not needed in TREMOR/CORONA because earthquake events are ephemeral; PurpleAir sensors are persistent entities).
3. **AQI computation module** — The highest-risk module. Full NowCast algorithm implementation with EPA breakpoint tables. TREMOR/CORONA don't need anything like this.
4. **Source tier model** — Two oracles with different settlement roles. EPA AirNow resolves; PurpleAir signals.

Everything else inherits from TREMOR without modification: Theatre state machine pattern, RLMF certificate schema, Brier scoring, position history, quality/uncertainty/settlement pipeline architecture.

---

## 2. System Architecture

### 2.1 Pipeline Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         BREATH CONSTRUCT                              │
├──────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Oracle Layer (dual-cadence)                                           │
│  ┌─────────────────────┐    ┌──────────────────────────────────────┐  │
│  │  PurpleAir Oracle   │    │        EPA AirNow Oracle             │  │
│  │  (120s poll)        │    │  (60m poll — cadence-checked inside  │  │
│  │  Signal layer       │    │   poll(), not separate timer)        │  │
│  │  src/oracles/       │    │  Settlement authority                 │  │
│  │  purpleair.js       │    │  src/oracles/epa-airnow.js           │  │
│  └──────────┬──────────┘    └────────────────────┬─────────────────┘  │
│             │                                     │                    │
│             ▼                                     ▼                    │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │                    Processor Pipeline                         │     │
│  │                                                               │     │
│  │  aqi.js          quality.js      uncertainty.js              │     │
│  │  (NowCast,       (source tier,   (doubt pricing,             │     │
│  │   breakpoints)    freshness,      threshold                  │     │
│  │                   density,        sensitivity)               │     │
│  │                   consistency)                               │     │
│  │                                                               │     │
│  │  settlement.js                   bundles.js                  │     │
│  │  (3-tier: oracle/                (assemble evidence          │     │
│  │   provisional_mature/             bundle from all            │     │
│  │   market_freeze)                  processor outputs)         │     │
│  └──────────────────────────────┬───────────────────────────────┘     │
│                                 │ Evidence Bundles                     │
│                                 ▼                                      │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │                    Theatre Layer                              │     │
│  │                                                               │     │
│  │  aqi-gate.js          sensor-divergence.js                   │     │
│  │  T1: AQI Threshold    T2: Sensor Divergence                  │     │
│  │  Gate (binary)        (binary, Paradox native)               │     │
│  │                                                               │     │
│  │  wildfire-cascade.js                                         │     │
│  │  T3: Wildfire Cascade (5-bucket multi-class)                 │     │
│  └──────────────────────────────┬───────────────────────────────┘     │
│                                 │ Resolved Theatres                    │
│                                 ▼                                      │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │                    RLMF Layer                                 │     │
│  │  certificates.js                                             │     │
│  │  Brier scoring, temporal analysis, certificate export         │     │
│  │  Schema: TREMOR/CORONA compatible                            │     │
│  └──────────────────────────────────────────────────────────────┘     │
│                                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 Dual-Oracle Coordination

**Problem**: PurpleAir updates every 2 minutes, AirNow every 60 minutes. A single timer for both is wasteful; two timers complicate state management.

**Solution**: Single polling timer at the PurpleAir cadence (120s). Inside `poll()`, a cadence check determines whether AirNow should also be called:

```js
async poll() {
  const now = Date.now();

  // Always poll PurpleAir (signal layer)
  const paResult = await pollPurpleAir(this.config, this.sensorRegistry);

  // Poll AirNow if ≥60m has elapsed since last call (settlement authority)
  let ainowResult = null;
  if (now - this.lastAirNowPoll >= AIR_NOW_CADENCE_MS) {
    ainowResult = await pollAirNow(this.config, this.getActiveRegions());
    this.lastAirNowPoll = now;
    this.airNowCache = ainowResult; // cache for Theatre resolution checks
  }

  // Process all bundles (PurpleAir bundles + AirNow bundles if available)
  const allBundles = [...paResult.bundles, ...(ainowResult?.bundles ?? [])];
  // ... Theatre processing
}
```

AirNow bundles are **settlement triggers**: when an AirNow bundle shows AQI ≥ threshold for T1, the Theatre resolves immediately. When AirNow is not polled this cycle, the cached AirNow state is checked against open Theatre expiry times.

### 2.3 Sensor Registry

TREMOR processes ephemeral earthquake events. PurpleAir sensors are **persistent entities** that BREATH tracks across polls. The `SensorRegistry` class manages this:

```
SensorRegistry
  sensors: Map<sensor_index, SensorRecord>

SensorRecord {
  sensor_index: number
  name: string
  location: { latitude, longitude, location_type }
  location_stable: bool         // false if coordinates changed across polls
  pm25_history: Array<{t, a, b, avg}>  // last N readings (rolling window)
  last_seen: number             // timestamp of last API response
  state: 'active' | 'dropout' | 'degraded'
  channel_consistency_score: number  // 0-1, rolling A/B agreement
}
```

The Sensor Registry is updated on every PurpleAir poll. Sensors absent from a response but expected (within active Theatre bounding box) are flagged as `dropout` after 2× poll cadence.

---

## 3. Technology Stack

| Component | Choice | Justification |
|-----------|--------|---------------|
| Runtime | Node.js 20+ | Established by TREMOR/CORONA. Built-in `fetch`, `node:test`. |
| Module format | ESM (`import`/`export`) | Established by TREMOR/CORONA. |
| HTTP client | Built-in `fetch` | Zero dependencies requirement. Available Node.js 18+. |
| Test runner | `node:test` | Zero dependencies requirement. |
| External deps | **None** | Core invariant: `npm install` not required. |
| Config | Env vars + constructor config | `PURPLEAIR_API_KEY`, `AIRNOW_API_KEY` or `config.apiKeys.*` |

---

## 4. Component Design

### 4.1 `src/oracles/purpleair.js`

#### Exported Functions

```js
/**
 * Poll PurpleAir API for sensors within registered bounding boxes.
 * Updates sensorRegistry in place.
 * Returns new/updated bundles.
 *
 * @param {object} config - { apiKey, bboxes: Array<{nwlng,nwlat,selng,selat,label}> }
 * @param {SensorRegistry} registry
 * @returns {Promise<{ bundles: EvidenceBundle[], dropouts: SensorRecord[] }>}
 */
export async function pollPurpleAir(config, registry) { ... }

/**
 * Build an evidence bundle from a PurpleAir API sensor object.
 * Pure function — no side effects.
 *
 * @param {object} sensor - PurpleAir API sensor object (normalized)
 * @param {SensorRecord} registryRecord - Current registry state for this sensor
 * @param {object[]} activeTheatres - For theatre_refs matching
 * @returns {EvidenceBundle}
 */
export function buildPurpleAirBundle(sensor, registryRecord, activeTheatres) { ... }
```

#### PurpleAir API Request

```
GET https://api.purpleair.com/v1/sensors
  ?fields=sensor_index,name,latitude,longitude,pm2.5,pm2.5_a,pm2.5_b,confidence,last_seen,location_type
  &nwlng={nwlng}&nwlat={nwlat}&selng={selng}&selat={selat}
  &location_type=0    # outdoor only
  X-API-Key: {PURPLEAIR_API_KEY}
```

**Note on location_type**: PurpleAir `location_type=0` is outdoor, `1` is indoor. The API supports filtering by this parameter. BREATH always requests `location_type=0`.

**Note on CF correction**: PurpleAir's API `pm2.5` field returns CF=1 (ATM) values by default. This is the field BREATH uses. Do **not** apply additional CF correction — it is already applied. Reference this in code comments.

#### Channel A/B Consistency Check

```js
function computeChannelConsistency(pm25_a, pm25_b) {
  if (pm25_a === null || pm25_b === null) return 0.0; // missing channel
  const avg = (pm25_a + pm25_b) / 2;
  if (avg < 2.0) return 1.0; // near-zero readings — divergence ratio meaningless
  const divergenceRatio = Math.abs(pm25_a - pm25_b) / avg;
  // > 0.7 = inconsistent (high doubt), < 0.2 = consistent (low doubt)
  return Math.max(0, 1 - divergenceRatio / 0.7);
}

// Classification:
// consistency >= 0.8  → 'consistent'
// consistency 0.4-0.8 → 'divergent' (mild doubt)
// consistency < 0.4   → 'inconsistent' (high doubt)
```

#### Location Drift Detection

```js
function detectLocationDrift(currentLat, currentLon, registryRecord) {
  if (!registryRecord) return false;
  const latDelta = Math.abs(currentLat - registryRecord.location.latitude);
  const lonDelta = Math.abs(currentLon - registryRecord.location.longitude);
  // > 0.001 degrees ≈ >100m — flag as drift
  return latDelta > 0.001 || lonDelta > 0.001;
}
```

#### Rate Limit & Backoff

```js
// Exponential backoff on 429
const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 300_000; // 5 minutes max
const BACKOFF_MULTIPLIER = 2;

// Cache: last successful response per bbox label
const responseCache = new Map(); // label → { timestamp, data }
// If 429 and cache available → return cached (with degraded quality flag)
// If 429 and no cache → return { bundles: [], dropouts: [] }
```

---

### 4.2 `src/oracles/epa-airnow.js`

#### Exported Functions

```js
/**
 * Poll EPA AirNow for current observations within active Theatre regions.
 * Called at most once per 60 minutes (cadence-checked in BreathConstruct.poll()).
 *
 * @param {object} config - { apiKey, regions: Array<{lat, lon, radius_miles, label}> }
 * @returns {Promise<{ bundles: EvidenceBundle[], observations: AirNowObservation[] }>}
 */
export async function pollAirNow(config, regions) { ... }

/**
 * Build an evidence bundle from an AirNow observation.
 * AirNow bundles always have data_tier='settlement_authority'.
 *
 * @param {object} obs - AirNow API observation object
 * @param {object[]} activeTheatres
 * @returns {EvidenceBundle}
 */
export function buildAirNowBundle(obs, activeTheatres) { ... }
```

#### AirNow API Request

```
GET https://www.airnowapi.org/aq/observation/latLong/current/
  ?format=application/json
  &latitude={lat}
  &longitude={lon}
  &distance={radius_miles}   # default 25
  &API_KEY={AIRNOW_API_KEY}
```

**Rate limit strategy**: One call per region per 60 minutes. Max ~24 calls/day for a single region — well within the 1000/day free tier. Multiple regions multiply linearly; design must track per-region last-polled timestamp.

#### Time Semantics for AirNow Bundles

```js
function buildAirNowObservationTime(obs) {
  // AirNow: DateObserved = "YYYY-MM-DD", HourObserved = 0-23
  const dateStr = obs.DateObserved.trim();
  const hour = obs.HourObserved;
  const tzOffset = obs.LocalTimeZone; // e.g., "EST" — convert to UTC offset

  // observation_time = epoch ms for start of observation hour (local)
  // publication_time = Date.now() at poll time (AirNow doesn't publish timestamps)
  // ingest_time = Date.now()
  // averaging_basis = 'nowcast' (AirNow NowCast for PM2.5)

  return {
    observation_time: parseLocalTime(dateStr, hour, tzOffset),
    publication_time: Date.now(), // AirNow API doesn't expose pub timestamp
    ingest_time: Date.now(),
    averaging_basis: 'nowcast',
  };
}
```

**Note on timezone handling**: AirNow returns `LocalTimeZone` as a string abbreviation (e.g., "EST", "PST"). Maintain a mapping table of common US timezone abbreviations to UTC offsets. Non-US timezones are not expected in MVP (EPA coverage is primarily US).

#### AirNow Attribution

Every AirNow evidence bundle MUST include:
```js
attribution: 'U.S. EPA AirNow (preliminary data — not for regulatory use)'
```

---

### 4.3 `src/processor/aqi.js`

This is the highest-risk module. Full specification follows.

#### NowCast Algorithm (PM2.5)

The EPA NowCast algorithm for PM2.5 computes a real-time weighted average from the last 12 hours of hourly data:

```js
/**
 * Compute PM2.5 NowCast concentration.
 *
 * @param {(number|null)[]} hourlyReadings - Array of 12 readings, index 0 = most recent hour,
 *                                           index 11 = 11 hours ago. null = missing/invalid.
 * @returns {number|null} NowCast concentration, or null if insufficient data
 */
export function computeNowCast(hourlyReadings) {
  // Step 1: Require at least 2 valid readings in the 3 most recent hours
  const recentValid = hourlyReadings.slice(0, 3).filter(v => v !== null).length;
  if (recentValid < 2) return null;

  // Step 2: Find Cmin and Cmax across all valid readings in window
  const valid = hourlyReadings.filter(v => v !== null);
  const Cmin = Math.min(...valid);
  const Cmax = Math.max(...valid);

  // Step 3: Compute weight factor w = Cmin/Cmax, clamped to [0.5, 1.0]
  const w = Cmax === 0 ? 1.0 : Math.max(0.5, Cmin / Cmax);

  // Step 4: Compute NowCast = weighted sum / sum of weights
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < 12; i++) {
    if (hourlyReadings[i] === null) continue;
    const weight = Math.pow(w, i);
    numerator += hourlyReadings[i] * weight;
    denominator += weight;
  }

  return denominator === 0 ? null : numerator / denominator;
}
```

#### AQI Breakpoint Tables

```js
// EPA AQI Breakpoint Tables (from EPA Technical Assistance Document for AQI)
// Format: [Clow, Chigh, AQIlow, AQIhigh]
// Note: concentration values are INCLUSIVE at both ends

export const BREAKPOINTS = {
  PM25: [ // PM2.5 24-hour average (µg/m³) — also used for NowCast input
    [0.0,   12.0,  0,   50],
    [12.1,  35.4,  51,  100],
    [35.5,  55.4,  101, 150],
    [55.5,  150.4, 151, 200],
    [150.5, 250.4, 201, 300],
    [250.5, 350.4, 301, 400],
    [350.5, 500.4, 401, 500],
  ],
  PM10: [ // PM10 24-hour average (µg/m³)
    [0,   54,   0,   50],
    [55,  154,  51,  100],
    [155, 254,  101, 150],
    [255, 354,  151, 200],
    [355, 424,  201, 300],
    [425, 504,  301, 400],
    [505, 604,  401, 500],
  ],
  O3_8H: [ // Ozone 8-hour average (ppm) — for AQI 0-300 range
    [0.000, 0.054, 0,   50],
    [0.055, 0.070, 51,  100],
    [0.071, 0.085, 101, 150],
    [0.086, 0.105, 151, 200],
    [0.106, 0.200, 201, 300],
    // Note: O3 8-hour AQI > 300 not calculated
  ],
  O3_1H: [ // Ozone 1-hour average (ppm) — only used for AQI > 100
    [0.125, 0.164, 101, 150],
    [0.165, 0.204, 151, 200],
    [0.205, 0.404, 201, 300],
    [0.405, 0.504, 301, 400],
    [0.505, 0.604, 401, 500],
  ],
  NO2: [ // NO2 1-hour average (ppb)
    [0,    53,   0,   50],
    [54,   100,  51,  100],
    [101,  360,  101, 150],
    [361,  649,  151, 200],
    [650,  1249, 201, 300],
    [1250, 1649, 301, 400],
    [1650, 2049, 401, 500],
  ],
  SO2: [ // SO2 1-hour average (ppb) for AQI 0-200; 24-hour for AQI 200+
    [0,   35,  0,   50],
    [36,  75,  51,  100],
    [76,  185, 101, 150],
    [186, 304, 151, 200],
    // 24-hour SO2 for higher AQI:
    [305, 604, 201, 300],
    [605, 804, 301, 400],
    [805, 1004, 401, 500],
  ],
  CO: [ // CO 8-hour average (ppm)
    [0.0,  4.4,  0,   50],
    [4.5,  9.4,  51,  100],
    [9.5,  12.4, 101, 150],
    [12.5, 15.4, 151, 200],
    [15.5, 30.4, 201, 300],
    [30.5, 40.4, 301, 400],
    [40.5, 50.4, 401, 500],
  ],
};
```

#### AQI Calculation Formula

```js
/**
 * Calculate AQI for a single pollutant from concentration.
 * Uses linear interpolation between breakpoints.
 * Returns integer (truncated, not rounded) per EPA spec.
 *
 * @param {string} pollutant - Key in BREAKPOINTS
 * @param {number} concentration - Measured concentration
 * @returns {number|null} AQI value, or null if out of range
 */
export function calculateAQI(pollutant, concentration) {
  const table = BREAKPOINTS[pollutant];
  if (!table) throw new Error(`Unknown pollutant: ${pollutant}`);

  // Find applicable breakpoint row
  const row = table.find(([Clow, Chigh]) => concentration >= Clow && concentration <= Chigh);
  if (!row) return null; // Out of range (above 500 or negative)

  const [Clow, Chigh, AQIlow, AQIhigh] = row;

  // Linear interpolation formula (EPA standard)
  // AQI = ((AQIhigh - AQIlow) / (Chigh - Clow)) * (Cp - Clow) + AQIlow
  const aqi = ((AQIhigh - AQIlow) / (Chigh - Clow)) * (concentration - Clow) + AQIlow;

  // Truncate to integer (not round)
  return Math.trunc(aqi);
}
```

**Critical**: `Math.trunc()` not `Math.round()`. EPA spec specifies truncation. Tests MUST verify this at breakpoint boundaries.

#### Category Mapping

```js
export const AQI_CATEGORIES = [
  { number: 1, name: 'Good',          range: [0,   50]  },
  { number: 2, name: 'Moderate',      range: [51,  100] },
  { number: 3, name: 'USG',           range: [101, 150] },
  { number: 4, name: 'Unhealthy',     range: [151, 200] },
  { number: 5, name: 'Very Unhealthy',range: [201, 300] },
  { number: 6, name: 'Hazardous',     range: [301, 500] },
];

export function getCategory(aqi) {
  const cat = AQI_CATEGORIES.find(c => aqi >= c.range[0] && aqi <= c.range[1]);
  return cat ?? { number: 6, name: 'Hazardous', range: [301, 500] }; // clamp above 500
}
```

#### Dominant Pollutant

```js
/**
 * Given AQI values for multiple pollutants, return the dominant one.
 * Dominant = highest AQI value. Ties broken alphabetically (deterministic).
 *
 * @param {object} pollutantAqis - { PM25: 45, PM10: 30, O3: 82, ... }
 * @returns {string} Dominant pollutant key
 */
export function getDominantPollutant(pollutantAqis) {
  return Object.entries(pollutantAqis)
    .filter(([, v]) => v !== null)
    .sort(([ka, va], [kb, vb]) => vb - va || ka.localeCompare(kb))
    [0]?.[0] ?? null;
}
```

---

### 4.4 `src/processor/quality.js`

```js
/**
 * Compute quality score for a PurpleAir sensor reading.
 * Analogous to TREMOR's computeQuality.
 *
 * @param {object} sensor - Normalized PurpleAir sensor data
 * @param {SensorRecord} registryRecord - Sensor registry record
 * @param {object[]} nearbySensors - Other sensors within density radius
 * @param {object|null} nearbyAirNow - Nearest AirNow observation (may be null)
 * @returns {QualityScore}
 */
export function computeQuality(sensor, registryRecord, nearbySensors, nearbyAirNow) {
  // Source tier component
  const source_tier = 0.65; // PurpleAir single-sensor baseline

  // Freshness component: decay if last_seen is stale
  const ageSeconds = (Date.now() - sensor.last_seen * 1000) / 1000;
  const cadenceSeconds = 120;
  const freshness = ageSeconds < cadenceSeconds    ? 1.0
                  : ageSeconds < cadenceSeconds * 2 ? 0.7
                  : ageSeconds < cadenceSeconds * 4 ? 0.4
                  : 0.1; // very stale

  // Network density component: sensors within ~5km
  const density = Math.min(1.0, nearbySensors.length / 10); // 10+ sensors = baseline 1.0

  // Channel consistency component
  const consistency = registryRecord?.channel_consistency_score ?? 0.5;

  // Cross-validation bonus: EPA AirNow within 20km agrees within 30%
  let cross_validated = false;
  if (nearbyAirNow) {
    const aqiDiff = Math.abs(sensor.aqi_computed - nearbyAirNow.AQI);
    const aqiThreshold = Math.max(nearbyAirNow.AQI * 0.3, 15); // 30% or 15 AQI, whichever larger
    cross_validated = aqiDiff <= aqiThreshold;
  }

  // Composite: weighted combination
  const composite = (
    source_tier * 0.35 +
    freshness   * 0.30 +
    density     * 0.20 +
    consistency * 0.15
  ) * (cross_validated ? 1.2 : 1.0); // 20% bonus for EPA cross-validation

  return {
    score: Math.min(1.0, composite),
    composite: Math.min(1.0, composite),
    components: { source_tier, freshness, density, consistency },
    cross_validated,
  };
}

/**
 * Compute quality score for an EPA AirNow observation.
 * AirNow is always settlement_authority tier — quality is uniformly high.
 */
export function computeAirNowQuality() {
  return {
    score: 1.0,
    composite: 1.0,
    components: {
      source_tier: 1.0,
      freshness: 1.0,    // AirNow data is current by definition at poll time
      density: 1.0,      // Government reference monitors
      consistency: 1.0,  // No A/B channels
    },
    cross_validated: true,
  };
}
```

---

### 4.5 `src/processor/uncertainty.js`

```js
/**
 * Build doubt price for a PurpleAir sensor reading.
 * Analogous to TREMOR's buildMagnitudeUncertainty.
 *
 * @param {object} sensor - Normalized sensor data
 * @param {QualityScore} quality
 * @param {number|null} theatreThreshold - AQI threshold for nearest active theatre (or null)
 * @returns {UncertaintyModel}
 */
export function buildUncertainty(sensor, quality, theatreThreshold) {
  // Base doubt by source tier
  let doubt_price = 0.30; // PurpleAir single-sensor baseline

  // Adjust for channel consistency
  if (quality.components.consistency < 0.4) {
    doubt_price = 0.80; // channel_inconsistent → high doubt
  } else if (quality.components.consistency < 0.8) {
    doubt_price = 0.45; // divergent channels → elevated doubt
  }

  // Freshness penalty
  if (quality.components.freshness < 0.4) {
    doubt_price = Math.min(0.95, doubt_price + 0.30);
  } else if (quality.components.freshness < 0.7) {
    doubt_price = Math.min(0.95, doubt_price + 0.15);
  }

  // Cross-validation reduces doubt
  if (quality.cross_validated) {
    doubt_price = Math.max(0.05, doubt_price - 0.15);
  }

  // Threshold sensitivity amplification
  // When AQI is within ±10 of theatre threshold, uncertainty at the boundary
  // matters more — amplify doubt_price slightly
  let threshold_sensitivity = false;
  if (theatreThreshold !== null) {
    const distance = Math.abs(sensor.aqi_computed - theatreThreshold);
    if (distance <= 10) {
      threshold_sensitivity = true;
      doubt_price = Math.min(0.95, doubt_price * 1.3);
    }
  }

  return {
    doubt_price: Math.round(doubt_price * 1000) / 1000,
    basis: deriveDoubtBasis(sensor, quality),
    threshold_sensitivity,
  };
}

/**
 * Doubt price for EPA AirNow observation.
 * AirNow is settlement authority — doubt is near-zero.
 */
export function buildAirNowUncertainty(theatreThreshold, currentAQI) {
  const threshold_sensitivity = theatreThreshold !== null &&
    Math.abs(currentAQI - theatreThreshold) <= 10;
  return {
    doubt_price: threshold_sensitivity ? 0.05 : 0.0,
    basis: 'EPA_AIRNOW_REFERENCE',
    threshold_sensitivity,
  };
}

/**
 * Threshold crossing probability.
 * Given a PurpleAir AQI reading and a Theatre threshold,
 * compute P(true_AQI >= threshold) accounting for doubt.
 *
 * Uses Normal CDF approximation (matches TREMOR's thresholdCrossingProbability pattern).
 *
 * @param {number} aqi - Measured AQI
 * @param {number} threshold - Theatre AQI threshold
 * @param {number} doubt_price - 0-1 uncertainty
 * @returns {number} Probability 0-1
 */
export function thresholdCrossingProbability(aqi, threshold, doubt_price) {
  // Map doubt_price to sigma in AQI units
  // doubt_price=0 → sigma=5 (very tight), doubt_price=1 → sigma=60 (very uncertain)
  const sigma = 5 + doubt_price * 55;

  // z-score for the threshold given current AQI
  const z = (threshold - aqi) / sigma;

  // P(exceeds threshold) = 1 - Φ(z) = Φ(-z)
  return normalCDF(-z);
}

// Abramowitz & Stegun approximation for Φ(x) (same as TREMOR)
function normalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return x > 0 ? 1 - p : p;
}
```

---

### 4.6 `src/processor/settlement.js`

```js
/**
 * Assess settlement eligibility for a PurpleAir bundle.
 * Analogous to TREMOR's assessStatusFlip.
 *
 * @param {object} sensor - Normalized sensor reading
 * @param {QualityScore} quality
 * @param {SensorRecord} registryRecord
 * @param {boolean} crossValidated - EPA nearby confirmed
 * @param {number|null} earliestExpiry - Earliest expiry of matched theatres (ms)
 * @returns {SettlementAssessment}
 */
export function assessSettlement(sensor, quality, registryRecord, crossValidated, earliestExpiry) {
  const now = Date.now();

  // Sensor dropout: missing from expected region
  if (sensor.state === 'dropout') {
    return {
      evidence_class: 'sensor_dropout',
      resolution_eligible: false,
      ineligible_reason: 'Sensor not seen in last 2 poll cycles',
      recommended_state: 'sensor_dropout',
      brier_discount: 0.20,
    };
  }

  // Channel inconsistent: A/B divergence too high
  if (quality.components.consistency < 0.4) {
    return {
      evidence_class: 'channel_inconsistent',
      resolution_eligible: false,
      ineligible_reason: 'Channel A/B divergence exceeds consistency threshold',
      recommended_state: 'channel_inconsistent',
      brier_discount: 0.20,
    };
  }

  // Degraded: very stale or very low quality
  if (quality.score < 0.3) {
    return {
      evidence_class: 'degraded',
      resolution_eligible: false,
      ineligible_reason: 'Quality score below degraded threshold (0.3)',
      recommended_state: 'degraded',
      brier_discount: 0.20,
    };
  }

  // Provisional mature: cross-validated by EPA, 3+ nearby sensors agree, >2h old
  const ageHours = (now - (registryRecord?.last_seen ?? now)) / 3_600_000;
  const nearbySensorsCount = registryRecord?.nearby_agreement_count ?? 0;
  if (crossValidated && nearbySensorsCount >= 3 && ageHours > 2 && quality.score >= 0.7) {
    return {
      evidence_class: 'provisional_mature',
      resolution_eligible: true,
      ineligible_reason: null,
      recommended_state: 'provisional_mature',
      brier_discount: 0.10,
    };
  }

  // Market freeze: theatre about to expire, data insufficient
  if (earliestExpiry !== null && (earliestExpiry - now) < 2 * 60 * 60 * 1000) { // <2h
    if (quality.score < 0.5) {
      return {
        evidence_class: 'provisional',
        resolution_eligible: false,
        ineligible_reason: 'Market freeze: insufficient quality near expiry',
        recommended_state: 'market_freeze',
        brier_discount: 0.20,
      };
    }
  }

  // Standard provisional
  return {
    evidence_class: 'provisional',
    resolution_eligible: false,
    ineligible_reason: 'Awaiting EPA AirNow confirmation',
    recommended_state: 'provisional',
    brier_discount: 0,
  };
}

/**
 * Assess settlement for an EPA AirNow bundle.
 * AirNow = ground truth tier. Always eligible for resolution.
 */
export function assessAirNowSettlement() {
  return {
    evidence_class: 'ground_truth',
    resolution_eligible: true,
    ineligible_reason: null,
    recommended_state: 'ground_truth',
    brier_discount: 0,
  };
}
```

---

### 4.7 `src/processor/bundles.js`

```js
/**
 * Build an evidence bundle from a PurpleAir sensor reading.
 *
 * @param {object} sensor - Normalized PurpleAir sensor (with aqi_computed)
 * @param {SensorRecord} registryRecord
 * @param {object} qualityResult - From computeQuality()
 * @param {object} uncertaintyResult - From buildUncertainty()
 * @param {object} settlementResult - From assessSettlement()
 * @param {object[]} activeTheatres - For theatre_refs matching
 * @returns {EvidenceBundle}
 */
export function buildPurpleAirBundle(sensor, registryRecord, qualityResult,
                                     uncertaintyResult, settlementResult, activeTheatres) {
  const now = Date.now();
  const theatreRefs = matchTheatres(sensor, activeTheatres);

  return {
    bundle_id: `breath-purpleair-${sensor.sensor_index}-${sensor.last_seen}`,
    construct: 'BREATH',
    source: 'PURPLEAIR',
    ingestion_ts: now,
    evidence_class: settlementResult.evidence_class,
    data_tier: 'early_warning',
    attribution: 'PurpleAir Community Sensor Network',

    payload: {
      observation_time: sensor.last_seen * 1000, // PurpleAir last_seen is Unix seconds
      publication_time: sensor.last_seen * 1000,
      ingest_time: now,
      averaging_basis: 'instantaneous', // PurpleAir reports real-time 2-min avg

      location: {
        latitude: sensor.latitude,
        longitude: sensor.longitude,
        location_type: sensor.location_type,
        region_label: sensor.name,
        sensor_id: sensor.sensor_index,
      },

      aqi: {
        value: sensor.aqi_computed,
        category: sensor.aqi_category.name,
        category_number: sensor.aqi_category.number,
        dominant_pollutant: 'PM25', // PurpleAir is PM2.5 specialist
        calculation_method: 'nowcast_equivalent', // PurpleAir 2-min avg ≈ NowCast input
      },

      pollutants: [
        {
          name: 'PM2.5',
          concentration: sensor.pm25_avg,
          unit: 'µg/m³',
          aqi_value: sensor.aqi_computed,
        },
      ],

      quality: qualityResult,
      uncertainty: uncertaintyResult,

      // PurpleAir-specific
      channel_a: sensor.pm25_a,
      channel_b: sensor.pm25_b,
      channel_consistency: classifyConsistency(qualityResult.components.consistency),
      sensor_state: registryRecord?.state ?? 'active',
    },

    cross_validation: qualityResult.cross_validated ? {
      epa_nearby: { agreement: true }, // populated by oracle layer
    } : null,

    theatre_refs: theatreRefs,

    resolution: {
      eligible: settlementResult.resolution_eligible,
      ineligible_reason: settlementResult.ineligible_reason,
      recommended_state: settlementResult.recommended_state,
      brier_discount: settlementResult.brier_discount,
    },
  };
}

/**
 * Build an evidence bundle from an EPA AirNow observation.
 */
export function buildAirNowBundle(obs, qualityResult, uncertaintyResult, settlementResult, activeTheatres) {
  const now = Date.now();
  const timeSemantic = buildAirNowObservationTime(obs);
  const theatreRefs = matchAirNowObservation(obs, activeTheatres);

  return {
    bundle_id: `breath-airnow-${obs.ReportingArea.replace(/\s/g,'_')}-${timeSemantic.observation_time}`,
    construct: 'BREATH',
    source: 'EPA_AIRNOW',
    ingestion_ts: now,
    evidence_class: 'ground_truth',
    data_tier: 'settlement_authority',
    attribution: 'U.S. EPA AirNow (preliminary data — not for regulatory use)',

    payload: {
      ...timeSemantic,

      location: {
        latitude: obs.Latitude,
        longitude: obs.Longitude,
        location_type: null, // AirNow is region-based, not point sensor
        region_label: obs.ReportingArea,
        sensor_id: obs.ReportingArea,
      },

      aqi: {
        value: obs.AQI,
        category: obs.Category.Name,
        category_number: obs.Category.Number,
        dominant_pollutant: obs.ParameterName,
        calculation_method: 'official',
      },

      pollutants: [
        {
          name: obs.ParameterName,
          concentration: null, // AirNow API returns AQI, not raw concentration
          unit: null,
          aqi_value: obs.AQI,
        },
      ],

      quality: qualityResult,
      uncertainty: uncertaintyResult,
    },

    cross_validation: null, // AirNow is the reference — it IS the cross-validator

    theatre_refs: theatreRefs,

    resolution: {
      eligible: true,
      ineligible_reason: null,
      recommended_state: 'ground_truth',
      brier_discount: 0,
    },
  };
}
```

#### Theatre Matching (for bundles)

```js
function matchTheatres(sensor, theatres) {
  return theatres
    .filter(t => {
      if (t.state !== 'open' && t.state !== 'provisional_hold') return false;
      // Bounding box check
      const [minLon, minLat, maxLon, maxLat] = t.region_bbox;
      return (
        sensor.longitude >= minLon && sensor.longitude <= maxLon &&
        sensor.latitude  >= minLat && sensor.latitude  <= maxLat
      );
    })
    .map(t => t.id);
}

function matchAirNowObservation(obs, theatres) {
  // AirNow matches by rough proximity to theatre region center
  return theatres
    .filter(t => {
      if (t.state !== 'open' && t.state !== 'provisional_hold') return false;
      const [minLon, minLat, maxLon, maxLat] = t.region_bbox;
      return (
        obs.Longitude >= minLon && obs.Longitude <= maxLon &&
        obs.Latitude  >= minLat && obs.Latitude  <= maxLat
      );
    })
    .map(t => t.id);
}
```

---

### 4.8 Theatre State Machines

#### T1: AQI Threshold Gate (`src/theatres/aqi-gate.js`)

**State transitions:**
```
created → open
open → provisional_hold   (PurpleAir provisional_mature exceeds threshold)
open/provisional_hold → resolved (YES)  (EPA AirNow ground_truth exceeds threshold_category)
open/provisional_hold → resolved (NO)   (Theatre expires without threshold crossed)
open → expired            (market_freeze: insufficient data at expiry)
```

**Probability update algorithm:**
```js
export function processAqiThresholdGate(theatre, bundle) {
  if (theatre.state === 'resolved' || theatre.state === 'expired') return theatre;

  const updated = { ...theatre };
  updated.evidence_bundles = [...theatre.evidence_bundles, bundle.bundle_id];

  const currentAQI = bundle.payload.aqi.value;
  const threshold = theatre.aqi_threshold;

  // EPA AirNow ground truth → resolution
  if (bundle.source === 'EPA_AIRNOW' && bundle.evidence_class === 'ground_truth') {
    const crossed = bundle.payload.aqi.category_number >= theatre.threshold_category_number;
    updated.state = 'resolved';
    updated.outcome = crossed;
    updated.resolving_bundle_id = bundle.bundle_id;
    updated.resolved_at = Date.now();
    updated.current_position = crossed ? 1.0 : 0.0;
    updated.position_history = [...theatre.position_history, {
      t: Date.now(),
      p: updated.current_position,
      evidence: bundle.bundle_id,
      reason: `EPA AirNow: AQI=${currentAQI} (${bundle.payload.aqi.category})`,
    }];
    return updated;
  }

  // PurpleAir provisional_mature → provisional_hold
  if (bundle.evidence_class === 'provisional_mature' && currentAQI >= threshold) {
    updated.state = 'provisional_hold';
  }

  // Position update using threshold crossing probability
  if (bundle.source === 'PURPLEAIR' &&
      (bundle.evidence_class === 'provisional' || bundle.evidence_class === 'provisional_mature' || bundle.evidence_class === 'cross_validated')) {
    const crossingProb = thresholdCrossingProbability(currentAQI, threshold, bundle.payload.uncertainty.doubt_price);
    const qualityWeight = bundle.payload.quality.composite;
    const evidenceWeight = 0.3 * qualityWeight;

    // Blend current position toward crossing probability
    const newPosition = theatre.current_position + (crossingProb - theatre.current_position) * evidenceWeight;
    updated.current_position = Math.max(0.01, Math.min(0.99, Math.round(newPosition * 1000) / 1000));
    updated.position_history = [...theatre.position_history, {
      t: Date.now(),
      p: updated.current_position,
      evidence: bundle.bundle_id,
      reason: `PurpleAir sensor ${bundle.payload.location.sensor_id}: AQI=${currentAQI}, crossing_prob=${crossingProb.toFixed(3)}`,
    }];
  }

  return updated;
}

export function expireAqiThresholdGate(theatre) {
  if (theatre.state === 'resolved') return theatre;
  // No EPA confirmation → resolve as NO with market_freeze discount
  return {
    ...theatre,
    state: 'resolved',
    outcome: false,
    resolved_at: Date.now(),
    position_history: [...theatre.position_history, {
      t: Date.now(),
      p: theatre.current_position,
      evidence: null,
      reason: 'Theatre expired — no EPA AirNow confirmation received',
    }],
  };
}
```

**Theatre creation:**
```js
export function createAqiThresholdGate({
  id,
  region_name,
  region_bbox,          // [minLon, minLat, maxLon, maxLat]
  aqi_threshold,        // 51, 101, 151, 201, or 301
  window_hours,         // 4-72
  base_rate = 0.15,     // Historical P(threshold crossed in window) for this region
}) {
  const thresholdCategory = AQI_CATEGORIES.find(c => c.range[0] === aqi_threshold);
  if (!thresholdCategory) throw new Error(`Invalid AQI threshold: ${aqi_threshold}`);

  const now = Date.now();
  return {
    id: id || `T1-${region_name.replace(/\s/g,'_').toUpperCase()}-AQI${aqi_threshold}-${now}`,
    template: 'aqi_threshold_gate',
    question: `Will AQI reach ${thresholdCategory.name} (≥${aqi_threshold}) in ${region_name} within ${window_hours}h?`,
    region_name,
    region_bbox,
    aqi_threshold,
    threshold_category_number: thresholdCategory.number,
    window_hours,
    opens_at: now,
    closes_at: now + window_hours * 3_600_000,
    state: 'open',
    outcome: null,
    position_history: [{
      t: now,
      p: base_rate,
      evidence: null,
      reason: `Base rate: P(AQI≥${aqi_threshold} in ${region_name} within ${window_hours}h)`,
    }],
    current_position: base_rate,
    evidence_bundles: [],
    resolving_bundle_id: null,
    resolved_at: null,
  };
}
```

#### T2: Sensor Divergence (`src/theatres/sensor-divergence.js`)

**State transitions:**
```
created → open
open → resolved (YES)  (consecutive_hours_divergent >= required_hours)
open → resolved (NO)   (Theatre closes without condition met)
```

This Theatre is **self-resolving within PurpleAir data**. No EPA AirNow involvement.

**Key state tracked:**
```js
{
  // ...standard theatre fields...
  sensor_a_index: number,     // PurpleAir sensor_index for sensor A
  sensor_b_index: number,     // PurpleAir sensor_index for sensor B
  aqi_divergence_threshold: number,  // default: 50
  required_hours: number,            // default: 2
  divergence_window: [               // rolling window of {t, diff, exceeded}
    { t: timestamp, aqi_a: number, aqi_b: number, diff: number, exceeded: bool }
  ],
  consecutive_hours_divergent: number,
}
```

**Position update:**
```js
export function processSensorDivergence(theatre, bundle) {
  // Only process bundles from sensor_a or sensor_b
  const sensorId = bundle.payload.location.sensor_id;
  if (sensorId !== theatre.sensor_a_index && sensorId !== theatre.sensor_b_index) return theatre;

  // Update the reading for this sensor
  const updated = { ...theatre };
  // ... (update sensor A or B reading, compute diff, update window)

  // Position = fraction of required_hours that have been divergent
  // This gives a smooth 0→1 probability as divergence accumulates
  const recentExceeded = updated.divergence_window
    .slice(-updated.required_hours)
    .filter(e => e.exceeded).length;
  const position = recentExceeded / updated.required_hours;
  updated.current_position = Math.max(0.01, Math.min(0.99, position));

  // Resolution: required_hours consecutive exceeded readings
  if (updated.consecutive_hours_divergent >= updated.required_hours) {
    updated.state = 'resolved';
    updated.outcome = true;
    updated.resolved_at = Date.now();
    updated.current_position = 1.0;
  }

  return updated;
}
```

#### T3: Wildfire Cascade (`src/theatres/wildfire-cascade.js`)

**State transitions:**
```
created → open
open → resolving  (at closes_at)
resolving → resolved  (final % computed, bucket assigned)
```

**Bucket definitions:**
```js
export const WILDFIRE_BUCKETS = [
  { index: 0, label: '0–10%',  range: [0,    0.10] },
  { index: 1, label: '10–30%', range: [0.10, 0.30] },
  { index: 2, label: '30–50%', range: [0.30, 0.50] },
  { index: 3, label: '50–70%', range: [0.50, 0.70] },
  { index: 4, label: '70%+',   range: [0.70, 1.01] },
];
```

**Key state tracked:**
```js
{
  // ...standard theatre fields...
  wildfire_trigger: string,         // "AIRNOW_FIRE_SMOKE" or "MANUAL"
  trigger_region: string,           // Fire origin region label
  target_region: { name, bbox },    // Where smoke will arrive
  threshold_aqi: 200,               // "Very Unhealthy"
  tracked_sensors: Set<number>,     // sensor_index set in target_region at open time
  sensor_snapshot_time: timestamp,  // When sensor set was locked
  bucket_probabilities: number[],   // [0..4] probabilities, sum to 1.0
  current_pct_exceeded: number,     // Live running %
}
```

**Position update:** On each poll cycle, recompute `current_pct_exceeded` from latest readings of all tracked sensors. Map to bucket probability distribution (Dirichlet update toward observed %). At `closes_at`, final % determines outcome bucket.

---

### 4.9 `src/rlmf/certificates.js`

Schema matches TREMOR/CORONA for pipeline compatibility.

```js
/**
 * Export an RLMF training certificate for a resolved theatre.
 *
 * @param {object} theatre - Resolved theatre (state === 'resolved')
 * @param {object} meta - { construct_id }
 * @returns {RLMFCertificate}
 */
export function exportCertificate(theatre, meta) {
  const positionHistory = theatre.position_history;
  const outcome = theatre.outcome; // bool for binary, bucket index for multi-class

  // Brier score computation
  const brierScore = computeBrierScore(positionHistory, outcome);
  const brierTimeWeighted = computeTimeWeightedBrier(positionHistory, outcome, theatre.opens_at, theatre.resolved_at);

  // Lead time: when did position cross 0.5 toward correct outcome?
  const leadTime = computeLeadTime(positionHistory, outcome, theatre.resolved_at);

  // Directional accuracy: was final pre-resolution position correct?
  const finalPosition = positionHistory[positionHistory.length - 1]?.p ?? 0.5;
  const directionalAccuracy = outcome ? finalPosition > 0.5 : finalPosition < 0.5;

  // Volatility: std dev of position changes
  const volatility = computeVolatility(positionHistory);

  // Evidence summary
  const evidenceSummary = {
    total_bundles: theatre.evidence_bundles.length,
    by_evidence_class: groupBy(theatre.evidence_bundles_detail, 'evidence_class'),
    by_source: groupBy(theatre.evidence_bundles_detail, 'source'),
    epa_airnow_confirmed: theatre.resolving_bundle_id?.includes('airnow') ?? false,
    purpleair_sensor_count: theatre.unique_sensor_count ?? 0,
  };

  return {
    certificate_id: `breath-${theatre.id}-${theatre.resolved_at}`,
    construct: meta.construct_id ?? 'BREATH',
    theatre_id: theatre.id,
    template: theatre.template,
    outcome,
    opened_at: theatre.opens_at,
    resolved_at: theatre.resolved_at,
    performance: {
      brier_score: brierScore,
      brier_time_weighted: brierTimeWeighted,
      position_history: positionHistory,
      directional_accuracy: directionalAccuracy,
      lead_time_seconds: leadTime,
      volatility,
    },
    evidence_summary: evidenceSummary,
    brier_discount: theatre.resolution?.brier_discount ?? 0,
    settlement_tier: theatre.resolution?.recommended_state ?? 'unknown',
  };
}

// Binary Brier score: B = (1/N) * Σ(p_i - o)²
// where o = 1 if outcome=true, 0 if false
export function brierScoreBinary(positionHistory, outcome) {
  const o = outcome ? 1 : 0;
  const scores = positionHistory.map(h => Math.pow(h.p - o, 2));
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

// Multi-class Brier score (for T3 Wildfire Cascade)
export function brierScoreMultiClass(bucketProbHistory, outcomeIndex, numBuckets) {
  // ... analogous to TREMOR's multi-class Brier
}
```

---

### 4.10 `src/index.js` — `BreathConstruct`

```js
export class BreathConstruct {
  constructor(config = {}) {
    this.constructId = config.constructId ?? 'BREATH';
    this.pollIntervalMs = config.pollIntervalMs ?? 120_000;
    this.apiKeys = {
      purpleair: config.apiKeys?.purpleair ?? process.env.PURPLEAIR_API_KEY,
      airnow: config.apiKeys?.airnow ?? process.env.AIRNOW_API_KEY,
    };
    this.enableCrossValidation = config.enableCrossValidation ?? true;

    // State
    this.theatres = new Map();
    this.sensorRegistry = new SensorRegistry();
    this.airNowCache = new Map();     // region_label → last observation
    this.lastAirNowPoll = 0;         // timestamp of last AirNow poll
    this.processedBundleIds = new Set(); // deduplication

    // RLMF
    this.certificates = [];

    // Stats
    this.stats = {
      polls: 0,
      purpleair_bundles: 0,
      airnow_bundles: 0,
      theatres_created: 0,
      theatres_resolved: 0,
      certificates_exported: 0,
    };

    this.pollTimer = null;
  }

  // Theatre creation
  openAqiThresholdGate(params) { ... }
  openSensorDivergence(params) { ... }
  openWildfireCascade(params) { ... }

  // Accessors
  getActiveTheatres() { ... }
  getActiveRegions() { ... }   // Unique bboxes from active theatres (for AirNow queries)
  getState() { ... }
  getCertificates() { ... }
  flushCertificates() { ... }

  // Lifecycle
  start() { ... }
  stop() { ... }

  // Core loop
  async poll() { ... }          // Dual-oracle coordination
  _processBundle(bundle) { ... }
  _exportCertificate(theatre) { ... }
  _checkExpiries() { ... }
  _checkAutoSpawn() { ... }     // Auto-spawn logic from AQI trends / AirNow fire smoke
}
```

#### Auto-Spawn Logic

```js
_checkAutoSpawn(bundles) {
  for (const bundle of bundles) {
    // T1 auto-spawn: AQI trend +20 in 2h
    if (bundle.source === 'PURPLEAIR') {
      const trend = this.sensorRegistry.getAqiTrend(bundle.payload.location.sensor_id, 2);
      if (trend >= 20) {
        const currentAQI = bundle.payload.aqi.value;
        const nextThreshold = getNextThreshold(currentAQI);
        if (nextThreshold && !this.hasOpenTheatreFor(bundle.payload.location, nextThreshold)) {
          this.openAqiThresholdGate({
            region_name: bundle.payload.location.region_label,
            region_bbox: expandBbox(bundle.payload.location, 0.1), // ~10km box
            aqi_threshold: nextThreshold,
            window_hours: 24,
            base_rate: 0.15,
          });
        }
      }
    }

    // T3 auto-spawn: AirNow fire smoke category detected
    if (bundle.source === 'EPA_AIRNOW' && bundle.payload.aqi.category === 'USG') {
      // Note: AirNow doesn't directly tag smoke events. Auto-spawn on high AQI
      // from AirNow in conjunction with external wildfire alert is Phase 2.
      // In MVP: T3 is manually opened only.
    }
  }
}
```

---

## 5. Data Schemas

### 5.1 Evidence Bundle (Full Schema)

```
EvidenceBundle {
  bundle_id:      string    // "breath-{source}-{sensor_id}-{observation_ts}"
  construct:      "BREATH"
  source:         "EPA_AIRNOW" | "PURPLEAIR"
  ingestion_ts:   number    // Date.now()
  evidence_class: "ground_truth" | "provisional_mature" | "cross_validated" |
                  "provisional" | "channel_inconsistent" | "sensor_dropout" | "degraded"
  data_tier:      "settlement_authority" | "early_warning"
  attribution:    string

  payload: {
    observation_time:  number    // epoch ms — when measurement was taken
    publication_time:  number    // epoch ms — when source published
    ingest_time:       number    // Date.now()
    averaging_basis:   "nowcast" | "hourly" | "instantaneous" | "nowcast_equivalent"

    location: {
      latitude:      number
      longitude:     number
      location_type: number | null   // 0=outdoor (PurpleAir), null (AirNow)
      region_label:  string
      sensor_id:     number | string | null
    }

    aqi: {
      value:             number    // truncated integer
      category:          string    // 'Good'|'Moderate'|'USG'|'Unhealthy'|'Very Unhealthy'|'Hazardous'
      category_number:   number    // 1-6
      dominant_pollutant: string   // 'PM2.5'|'PM10'|'O3'|'NO2'|'SO2'|'CO'
      calculation_method: string
    }

    pollutants: Array<{
      name:          string
      concentration: number | null
      unit:          string | null
      aqi_value:     number
    }>

    quality: {
      score:     number    // 0-1
      composite: number    // 0-1 (identical to score, follows TREMOR naming)
      components: {
        source_tier: number
        freshness:   number
        density:     number
        consistency: number
      }
      cross_validated: boolean
    }

    uncertainty: {
      doubt_price:         number    // 0-1
      basis:               string
      threshold_sensitivity: boolean
    }

    // PurpleAir-specific (undefined for AirNow)
    channel_a?:           number | null
    channel_b?:           number | null
    channel_consistency?: "consistent" | "divergent" | "inconsistent"
    sensor_state?:        "active" | "dropout" | "degraded"
  }

  cross_validation: {
    epa_nearby?:       { aqi: number, distance_km: number, agreement: boolean }
    purpleair_cluster?: { sensor_count: number, consensus_aqi: number, agreement: boolean }
  } | null

  theatre_refs: string[]

  resolution: {
    eligible:          boolean
    ineligible_reason: string | null
    recommended_state: string
    brier_discount:    number    // 0 | 0.10 | 0.20 | 0.25
  }
}
```

### 5.2 Theatre (Base Schema)

```
Theatre {
  id:               string
  template:         "aqi_threshold_gate" | "sensor_divergence" | "wildfire_cascade"
  question:         string
  region_name:      string
  region_bbox:      [minLon, minLat, maxLon, maxLat]
  opens_at:         number    // epoch ms
  closes_at:        number    // epoch ms
  state:            "open" | "provisional_hold" | "resolved" | "expired"
  outcome:          boolean | number | null   // null until resolved
  position_history: Array<{ t: number, p: number, evidence: string|null, reason: string }>
  current_position: number    // 0-1
  evidence_bundles: string[]  // bundle_ids
  resolving_bundle_id: string | null
  resolved_at:      number | null
}
```

### 5.3 RLMF Certificate (Full Schema, TREMOR-compatible)

```
RLMFCertificate {
  certificate_id:  string    // "breath-{theatre_id}-{resolved_at}"
  construct:       "BREATH"
  theatre_id:      string
  template:        string
  outcome:         boolean | number
  opened_at:       number
  resolved_at:     number

  performance: {
    brier_score:         number
    brier_time_weighted: number
    position_history:    Array<{ t, p, evidence, reason }>
    directional_accuracy: boolean
    lead_time_seconds:   number
    volatility:          number
  }

  evidence_summary: {
    total_bundles:         number
    by_evidence_class:     object
    by_source:             object
    epa_airnow_confirmed:  boolean
    purpleair_sensor_count: number
  }

  brier_discount:  number    // 0 | 0.10 | 0.20 | 0.25
  settlement_tier: string
}
```

### 5.4 Sensor Registry Record

```
SensorRecord {
  sensor_index:         number
  name:                 string
  location: {
    latitude:   number
    longitude:  number
    location_type: number
  }
  location_stable:          boolean   // false if coordinates changed
  pm25_history:             Array<{ t: number, pm25: number }>   // last 12 readings for NowCast
  aqi_history:              Array<{ t: number, aqi: number }>    // last 12 AQI readings (for trend)
  last_seen:                number    // epoch ms of last response
  state:                    "active" | "dropout" | "degraded"
  channel_consistency_score: number   // 0-1, rolling 10-reading average
  nearby_agreement_count:   number    // sensors within density radius with similar AQI
}
```

---

## 6. Integration Design

### 6.1 PurpleAir API

| Parameter | Value |
|-----------|-------|
| Base URL | `https://api.purpleair.com/v1/sensors` |
| Auth | `X-API-Key: {PURPLEAIR_API_KEY}` header |
| Method | GET |
| Required fields | `sensor_index,name,latitude,longitude,pm2.5,pm2.5_a,pm2.5_b,confidence,last_seen,location_type` |
| Location filter | `location_type=0` (outdoor only) |
| Bbox params | `nwlng`, `nwlat`, `selng`, `selat` |
| Point cost | Approximately 1 point per sensor per field requested. Minimize fields. |
| Rate limit | Not published. Backoff on 429. Default 120s poll is conservative. |
| CF correction | `pm2.5` field returns CF=1 (ATM) — no additional correction needed |

**Bbox per Theatre**: Each active Theatre provides a `region_bbox`. Multiple bboxes are queried independently (no merging in MVP). If two Theatres share overlapping regions, sensors in the overlap get bundled and matched to both.

### 6.2 EPA AirNow API

| Parameter | Value |
|-----------|-------|
| Base URL | `https://www.airnowapi.org/aq/observation/latLong/current/` |
| Auth | `API_KEY={AIRNOW_API_KEY}` query param |
| Method | GET |
| Format | `format=application/json` |
| Distance | `distance=25` (miles) default |
| Rate limit | ~1000 calls/day free tier |
| Data lag | AirNow typically updates once per hour |
| Time format | `DateObserved: "YYYY-MM-DD "`, `HourObserved: 0-23` (note trailing space in date) |

**One call per region per hour**: Track `lastAirNowPoll` per `region_label`. Call AirNow only if `Date.now() - lastPollForRegion >= 3_600_000`.

### 6.3 Error Handling

```
Network timeout (>10s) → log, return { bundles: [], dropouts: [] }
HTTP 429 → exponential backoff (5s → 10s → 20s → ... max 300s)
HTTP 401 → log critical, halt polling (misconfigured API key)
HTTP 500 → log, retry once after 30s, then return empty
Invalid JSON → log, skip
Empty response → log, return empty (not an error condition — no data for bbox)
```

---

## 7. Testing Architecture

### 7.1 Suite Breakdown (target: ≥50 tests, ≥18 suites)

| Suite | Count | Focus |
|-------|-------|-------|
| AQI computation — NowCast | 6 | Valid/invalid inputs, weight clamp, insufficient data |
| AQI computation — breakpoints | 8 | All pollutants, boundary edges, truncation vs rounding |
| AQI computation — categories | 4 | All 6 categories, boundary values |
| AQI computation — dominant pollutant | 3 | Ties, null values, single pollutant |
| Quality scoring — PurpleAir | 4 | Source tier, freshness, density, cross-validation |
| Quality scoring — AirNow | 2 | Always high, consistent |
| Uncertainty pricing | 5 | Source tiers, channel inconsistency, threshold sensitivity |
| Settlement logic — PurpleAir | 4 | Dropout, inconsistent, degraded, provisional mature |
| Settlement logic — AirNow | 2 | Always ground_truth |
| Evidence bundles — PurpleAir | 3 | Field mapping, attribution, time semantics |
| Evidence bundles — AirNow | 3 | Attribution required, time semantics |
| T1 AQI Threshold Gate | 5 | Create, EPA resolves YES, EPA resolves NO, PurpleAir update, expiry |
| T2 Sensor Divergence | 4 | Create, divergence accumulation, resolution YES, resolution NO |
| T3 Wildfire Cascade | 4 | Create, bucket assignment, position update, final resolution |
| RLMF certificates | 4 | Binary Brier, multi-class Brier, lead time, schema |
| Adversarial scenarios | 4 | Indoor filter, A/B manipulation, frozen sensor, dropout |
| BreathConstruct lifecycle | 3 | Start/stop, dual-oracle cadence, state snapshot |
| **Total** | **68** | Exceeds ≥50 requirement |

### 7.2 Test Patterns

All tests use `node:test` + `describe`/`it` + `assert` built-ins. HTTP calls are mocked — no live API calls in tests.

```js
// Mock pattern (matching TREMOR's test approach)
const mockPurpleAirResponse = {
  fields: ['sensor_index', 'name', 'latitude', 'longitude', 'pm2.5', 'pm2.5_a', 'pm2.5_b', 'confidence', 'last_seen', 'location_type'],
  data: [
    [12345, 'Test Sensor A', 37.77, -122.41, 35.5, 35.2, 35.8, 100, Math.floor(Date.now()/1000), 0],
  ],
};

// Critical: breakpoint boundary tests
test('AQI at exact breakpoint 150→151 (truncation)', () => {
  // PM2.5 = 55.5 µg/m³ → AQI should be 151 (first value of Unhealthy)
  // PM2.5 = 55.4 µg/m³ → AQI should be 150 (last value of USG)
  assert.strictEqual(calculateAQI('PM25', 55.5), 151);
  assert.strictEqual(calculateAQI('PM25', 55.4), 150);
});

test('AQI truncation not rounding', () => {
  // A value that would round up but should truncate
  // e.g. PM2.5 = 12.0 → AQI = 50 (not 51)
  assert.strictEqual(calculateAQI('PM25', 12.0), 50);
});
```

---

## 8. Directory Structure (Final)

```
breath/
├── src/
│   ├── index.js                    # BreathConstruct + SensorRegistry
│   ├── skills/
│   │   └── air-quality.md          # Construct specialization profile
│   ├── oracles/
│   │   ├── purpleair.js            # pollPurpleAir(), buildPurpleAirBundle()
│   │   └── epa-airnow.js           # pollAirNow(), buildAirNowBundle()
│   ├── processor/
│   │   ├── aqi.js                  # computeNowCast(), calculateAQI(), BREAKPOINTS, getCategory()
│   │   ├── quality.js              # computeQuality(), computeAirNowQuality()
│   │   ├── uncertainty.js          # buildUncertainty(), thresholdCrossingProbability()
│   │   ├── settlement.js           # assessSettlement(), assessAirNowSettlement()
│   │   └── bundles.js              # buildPurpleAirBundle(), buildAirNowBundle(), matchTheatres()
│   └── theatres/
│       ├── aqi-gate.js             # createAqiThresholdGate(), processAqiThresholdGate(), expireAqiThresholdGate()
│       ├── sensor-divergence.js    # createSensorDivergence(), processSensorDivergence()
│       └── wildfire-cascade.js     # createWildfireCascade(), processWildfireCascade(), resolveWildfireCascade()
├── rlmf/
│   └── certificates.js             # exportCertificate(), brierScoreBinary(), brierScoreMultiClass()
├── spec/
│   └── construct.json
├── test/
│   └── breath.test.js              # All 68 tests, 18 suites
├── BUTTERFREEZONE.md
├── .env.example
├── package.json
└── README.md
```

**Note on `rlmf/` placement**: At project root level, not inside `src/`, to match TREMOR's structure exactly.

---

## 9. Technical Risks & Mitigations

| Risk | Detail | Mitigation |
|------|--------|-----------|
| NowCast algorithm bugs | Sharp breakpoints + weight-clamping logic has subtle edge cases | 8 dedicated boundary tests. Cross-check against EPA NowCast documentation. |
| AirNow timezone parsing | LocalTimeZone field uses informal abbreviations (EST, PST, MDT) — ambiguous for some zones | US-only TZ abbreviation table. Log warning and skip if unknown timezone. |
| PurpleAir CF=1 assumption | CF correction already applied in API — if PurpleAir changes this behavior silently | Code comment + README note. Monitor for significant AQI discrepancy vs AirNow. |
| AirNow returning no data for bbox | API returns empty array if no monitors within `distance` miles | Not an error — return empty bundles, log at debug level. Theatres continue on PurpleAir only. |
| Dual-oracle timing race | PurpleAir bundle references AirNow data that hasn't been fetched yet this cycle | AirNow is polled first within `poll()`. Cache ensures it's available for cross-validation. |
| Theatre bbox too small for AirNow | AirNow uses monitoring station density which is much lower than PurpleAir — small bboxes may have no AirNow coverage | `distance=25miles` on AirNow query covers most urban Theatre regions. Accept market_freeze in rural Theatres. |

---

## 10. Implementation Notes for Sprint

### Critical Path

The implementation order matters. These dependencies must be respected:

```
1. aqi.js (no deps)
2. quality.js (depends on aqi.js for AQI computation)
3. uncertainty.js (depends on quality.js)
4. settlement.js (depends on quality.js)
5. bundles.js (depends on aqi, quality, uncertainty, settlement)
6. purpleair.js (depends on bundles.js, aqi.js)
7. epa-airnow.js (depends on bundles.js)
8. aqi-gate.js (depends on uncertainty.js for thresholdCrossingProbability)
9. sensor-divergence.js (no processor deps — self-contained)
10. wildfire-cascade.js (depends on quality.js for sensor count weighting)
11. certificates.js (depends on theatre outputs)
12. index.js (depends on everything)
13. breath.test.js (tests all of the above)
14. spec/construct.json, BUTTERFREEZONE.md, README.md
```

### The Highest-Risk Module

`src/processor/aqi.js` should be implemented **first** and tested exhaustively before any other module touches AQI values. Every other module assumes `calculateAQI()` is correct — a bug here propagates everywhere.

### The Novel Module

`SensorRegistry` (inside `src/index.js`) is BREATH's most architecturally novel element — no TREMOR/CORONA equivalent. It is relatively simple (a `Map` with a few methods) but the sensor state tracking logic (dropout detection, channel consistency rolling average, AQI trend for auto-spawn) is new ground. Keep it minimal in v0.1.0.

### Matching TREMOR's Voice

TREMOR's code has a consistent style: concise JSDoc, flat module structure, pure functions preferred, no classes except the top-level construct. Match this exactly. The Theatre modules especially should feel like TREMOR's `mag-gate.js`.
