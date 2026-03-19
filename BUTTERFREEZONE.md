<!--
AGENT-CONTEXT
name: breath
type: construct
purpose: Air quality intelligence construct for Echelon. Ingests PurpleAir (signal layer) and
  EPA AirNow (settlement authority), builds evidence bundles, runs 3 Theatre types on AQI outcomes,
  and exports Brier-scored RLMF training certificates.
key_files:
  - src/index.js
  - src/processor/aqi.js
  - src/processor/bundles.js
  - src/oracles/purpleair.js
  - src/oracles/epa-airnow.js
  - spec/construct.json
interfaces:
  core:
    - BreathConstruct        # src/index.js:278
    - SensorRegistry         # src/index.js:79
    - exportCertificate      # src/rlmf/certificates.js:162
  theatres:
    - aqi_threshold_gate     # src/theatres/aqi-gate.js:32
    - sensor_divergence      # src/theatres/sensor-divergence.js:31
    - wildfire_cascade       # src/theatres/wildfire-cascade.js:75
  oracles:
    - pollPurpleAir          # src/oracles/purpleair.js:150
    - pollAirNow             # src/oracles/epa-airnow.js:129
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
-->

# BREATH — Air Quality Intelligence Construct

> TREMOR lineage | Air Quality | PurpleAir + EPA AirNow | Node.js 20+ | Zero dependencies

---

## Key Capabilities

| Capability | Location |
|-----------|----------|
| AQI NowCast computation (12h rolling window) | `src/processor/aqi.js:36` |
| AQI breakpoint calculation with EPA truncation | `src/processor/aqi.js:76` |
| PurpleAir A/B channel consistency scoring | `src/processor/quality.js` |
| Sensor dropout and location drift detection | `src/index.js:141,215` |
| Dual-oracle coordination (PA 120s, AirNow 60m) | `src/index.js:341` |
| T1 AQI Threshold Gate (binary) | `src/theatres/aqi-gate.js:32` |
| T2 Sensor Divergence (self-resolving binary) | `src/theatres/sensor-divergence.js:31` |
| T3 Wildfire Cascade (5-bucket multi-class) | `src/theatres/wildfire-cascade.js:75` |
| RLMF certificate export with Brier scoring | `src/rlmf/certificates.js:162` |
| Auto-spawn T1 on rising AQI trend (+20 in 2h) | `src/index.js:430` |

---

## Architecture

```
BREATH CONSTRUCT
├── Oracle Layer (dual-cadence)
│   ├── PurpleAir Oracle      (120s)   src/oracles/purpleair.js
│   │   └── SensorRegistry            src/index.js (persistent sensor state)
│   └── EPA AirNow Oracle     (60m)   src/oracles/epa-airnow.js
│       └── Settlement authority — resolves theatres
│
├── Processor Pipeline
│   ├── aqi.js        NowCast, breakpoints, categories, dominant pollutant
│   ├── quality.js    Source tier, freshness, density, channel consistency
│   ├── uncertainty.js Doubt pricing, threshold crossing probability
│   ├── settlement.js  Evidence class assignment (provisional -> ground_truth)
│   └── bundles.js    Assemble EvidenceBundle from all processor outputs
│
├── Theatre Layer
│   ├── aqi-gate.js          T1: binary, EPA AirNow settlement
│   ├── sensor-divergence.js T2: binary, self-resolving (Paradox Engine)
│   └── wildfire-cascade.js  T3: 5-bucket multi-class, sensor cohort
│
└── RLMF Layer
    └── certificates.js  Brier scores (binary + multi-class), lead time, volatility
```

---

## Interfaces

### Construct API (`src/index.js`)

| Method | Description |
|--------|-------------|
| `new BreathConstruct(config)` | Instantiate — no API keys required for construction |
| `openAqiThresholdGate(params)` | Open T1 binary market |
| `openSensorDivergence(params)` | Open T2 self-resolving binary market |
| `openWildfireCascade(params)` | Open T3 multi-class cascade market |
| `start()` | Begin polling loop (throws if already running) |
| `stop()` | Stop polling loop (idempotent) |
| `poll()` | Single poll cycle (AirNow first, then PurpleAir) |
| `getActiveTheatres()` | Open or provisional_hold theatres |
| `getActiveRegions()` | Deduplicated bboxes from active theatres |
| `getState()` | `{ construct, running, stats, theatres }` |
| `getCertificates()` | Array of exported RLMF certificates |
| `flushCertificates()` | Returns count flushed, clears array |

### Theatre Templates

| Template | Type | Resolution | Files |
|----------|------|-----------|-------|
| `aqi_threshold_gate` | Binary | EPA AirNow ground_truth / expiry | `src/theatres/aqi-gate.js` |
| `sensor_divergence` | Binary | Self (consecutive divergence) / expiry | `src/theatres/sensor-divergence.js` |
| `wildfire_cascade` | Multi-class (5 buckets) | `resolveWildfireCascade` at close | `src/theatres/wildfire-cascade.js` |

### Data Feeds

| Feed | Role | Cadence | Auth |
|------|------|---------|------|
| PurpleAir API v1/sensors | Signal layer (early warning) | 120s | `PURPLEAIR_API_KEY` |
| EPA AirNow latLong/current | Settlement authority | 60m | `AIRNOW_API_KEY` |

---

## Module Map

```
src/
  index.js              BreathConstruct, SensorRegistry (entrypoint)
  processor/
    aqi.js              computeNowCast, calculateAQI, BREAKPOINTS, AQI_CATEGORIES
    quality.js          computeQuality, computeChannelConsistency
    uncertainty.js      buildUncertainty, thresholdCrossingProbability
    settlement.js       assessSettlement, assessAirNowSettlement
    bundles.js          buildPurpleAirBundle, buildAirNowBundle
  oracles/
    purpleair.js        pollPurpleAir, normalizePurpleAirResponse
    epa-airnow.js       pollAirNow, parseAirNowObservationTime, AIRNOW_TZ_OFFSETS
  theatres/
    aqi-gate.js         createAqiThresholdGate, processAqiThresholdGate, expireAqiThresholdGate
    sensor-divergence.js  createSensorDivergence, processSensorDivergence, expireSensorDivergence
    wildfire-cascade.js   createWildfireCascade, processWildfireCascade, resolveWildfireCascade
  rlmf/
    certificates.js     exportCertificate, brierScoreBinary, brierScoreMultiClass
  skills/
    air-quality.md      Construct specialization profile
spec/
  construct.json        Machine-readable construct spec
test/
  breath.test.js        104 tests / 22 suites
```

---

## Verification

```
node --test test/breath.test.js
# tests 104 | pass 104 | fail 0 | suites 22

node src/index.js
# BREATH Air Quality Intelligence Construct v0.1.0
# (prints usage -- does not start polling)
```

**Dependencies**: Zero. Node.js 20+ only.

---

## Culture

**Naming**: Theatre names encode market type. T1 = threshold gate, T2 = divergence detector, T3 = cascade tracker. Certificate IDs are `breath-{theatre_id}-{resolved_at}`.

**Principles**:
- Immutable state — all Theatre functions return new objects, never mutate
- Zero dependencies — no npm, no bundler, no lock file required
- Settlement authority separation — EPA AirNow is ground truth; PurpleAir is signal
- Brier accountability — every prediction earns a score; the RLMF pipeline closes the loop

**Domain metaphor**: BREATH treats air quality as a signal intelligence problem. PurpleAir is SIGINT — dense, noisy, early. EPA AirNow is HUMINT verification — slower, authoritative, final.

---

## Quick Start

```js
import { BreathConstruct } from './src/index.js';

const bc = new BreathConstruct({
  apiKeys: {
    purpleair: process.env.PURPLEAIR_API_KEY,
    airnow:    process.env.AIRNOW_API_KEY,
  },
  purpleair: {
    bboxes: [{ nwlng: -123.0, nwlat: 38.0, selng: -122.0, selat: 37.5, label: 'sf-bay' }],
  },
  airNow: {
    regions: [{ lat: 37.77, lon: -122.41, radius_miles: 25, label: 'sf-bay' }],
  },
});

bc.openAqiThresholdGate({
  region_name:   'San Francisco Bay',
  region_bbox:   [-123.0, 37.5, -122.0, 38.0],
  aqi_threshold: 151,
  window_hours:  24,
});

bc.start();

console.log(bc.getState());
console.log(bc.getCertificates());
```
