# BREATH

An air quality intelligence construct for the [Echelon](https://github.com/AITOBIAS04/Echelon) prediction market framework, built on constructs by [Soju](https://github.com/0xHoneyJar/loa). Ridden by [Loa](https://github.com/0xHoneyJar/loa). 

## What it does

BREATH ingests real-time air quality data from PurpleAir's 30,000+ sensor network and EPA AirNow federal monitoring stations, runs prediction markets on AQI outcomes across configurable time windows, and exports Brier-scored RLMF training certificates. It is the third construct in the TREMOR → CORONA lineage, adapting the proven seismic prediction market architecture to the air quality domain.

---

## Why air quality

- **Ground truth oracle** — EPA-reviewed AQI values are published hourly. No interpretation required: `category_number >= threshold_category_number` closes the market.
- **Binary structure** — EPA AQI category breakpoints (51, 101, 151, 201, 301) create natural threshold gates. Every question has a crisp YES/NO resolution.
- **Fast cycles** — AQI updates hourly. Theatres resolve in 4–72 hours. High-frequency RLMF data generation.
- **Exogenous** — Predictions do not affect air quality. No reflexivity. Clean RLMF signal.
- **Dense network** — 30,000+ PurpleAir sensors enable sensor-to-sensor corroboration. Localized phenomena (divergence, dropout) are detectable before EPA stations report.

---

## Quick start

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

// Open a prediction market
bc.openAqiThresholdGate({
  region_name:   'San Francisco Bay',
  region_bbox:   [-123.0, 37.5, -122.0, 38.0],
  aqi_threshold: 151,    // Will AQI reach Unhealthy (>=151)?
  window_hours:  24,
});

bc.start();                        // Begin polling (PurpleAir every 2m, AirNow every 60m)
const state = bc.getState();       // { construct, running, stats, theatres }
const certs = bc.getCertificates(); // RLMF training certificates
bc.stop();
```

---

## Architecture

```
src/
  index.js              BreathConstruct, SensorRegistry
  processor/
    aqi.js              NowCast, breakpoints, AQI categories
    quality.js          Channel consistency, freshness, density scoring
    uncertainty.js      Doubt pricing, threshold crossing probability
    settlement.js       Evidence class: provisional -> ground_truth
    bundles.js          EvidenceBundle assembly
  oracles/
    purpleair.js        PurpleAir API v1 (120s cadence)
    epa-airnow.js       EPA AirNow API (60m cadence)
  theatres/
    aqi-gate.js         T1: AQI Threshold Gate
    sensor-divergence.js T2: Sensor Divergence
    wildfire-cascade.js  T3: Wildfire Cascade
  rlmf/
    certificates.js     Brier scoring, certificate export
spec/
  construct.json        Constructs Network spec
```

---

## Settlement architecture

BREATH uses a two-tier oracle model:

| Tier | Source | Cadence | Role |
|------|--------|---------|------|
| Signal layer | PurpleAir | 120s | Early warning — updates Theatre position probability |
| Settlement authority | EPA AirNow | 60m | Ground truth — resolves Theatre YES/NO |

PurpleAir bundles never resolve a Theatre directly; they blend position toward `thresholdCrossingProbability`. EPA AirNow bundles resolve immediately based on `category_number >= threshold_category_number`.

AirNow bundles are always processed **before** PurpleAir bundles in each poll cycle to ensure settlement signals resolve markets before signal-layer updates can affect post-resolution positions.

---

## Theatre templates

| Template | Type | Question format | Window | Resolution |
|----------|------|----------------|--------|------------|
| `aqi_threshold_gate` | Binary | Will AQI reach category X in region R? | 4–72h | EPA AirNow confirmation or expiry |
| `sensor_divergence` | Binary | Will sensors A and B diverge by >N AQI for K consecutive readings? | 4–24h | Self-resolving (consecutive counter) or expiry |
| `wildfire_cascade` | Multi-class (5 buckets) | What fraction of sensors will exceed AQI 200? | Up to 72h | `resolveWildfireCascade` at window close |

**Wildfire cascade buckets**: 0–10% | 10–30% | 30–50% | 50–70% | 70%+

---

## Calibration edge cases

**EPA AirNow hourly delay** — AirNow publishes observations on the hour, not in real-time. A theatre that should resolve at 14:00 may not see the confirming bundle until 14:05–14:15. `closes_at` should account for this lag; using `window_hours >= 1` is always safe.

**PurpleAir A/B divergence** — PurpleAir sensors have two independent measurement channels. When `|pm25_a - pm25_b| / avg > 0.7`, the bundle is classified `channel_inconsistent` and does not update Theatre position. This prevents degraded sensors from corrupting market prices.

**Sensor dropout** — Sensors absent from the PurpleAir API response for > 2× poll cadence are flagged `dropout` in SensorRegistry. Dropout bundles have `evidence_class: 'sensor_dropout'` and are not forwarded to Theatres.

**AQI breakpoint discontinuities** — EPA breakpoint tables have a gap at category boundaries (e.g., PM2.5 12.0 = AQI 50, PM2.5 12.1 = AQI 51). BREATH uses `<=` on Chigh per the official formula. A PM2.5 of exactly 12.0 maps to AQI 50 (Good), not 51 (Moderate). Values are **truncated**, not rounded, per EPA specification.

**Wildfire smoke transport lag** — Smoke plumes may take 2–12 hours to reach downwind sensors after ignition. T3 `window_hours` should be set generously (24–72h) to capture the full cascade arrival. The uniform prior `[0.2, 0.2, 0.2, 0.2, 0.2]` correctly reflects initial ignorance; bucket probabilities converge as sensors report.

---

## Dependencies

Zero. Node.js 20+ only.

---

## License

AGPL-3.0
