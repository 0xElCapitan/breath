# BREATH — Air Quality Construct Specialization Profile

## Domain Specializations

BREATH operates in the air quality monitoring domain, applying prediction market mechanics to AQI outcomes. Core expertise:

- **EPA AQI framework** — Full NowCast algorithm, all six EPA pollutant breakpoint tables (PM2.5, PM10, O₃, NO₂, SO₂, CO), category classification, truncation-not-rounding per EPA spec
- **PurpleAir sensor network** — Dual-channel PM2.5 sensors, A/B channel consistency scoring, sensor dropout detection, location drift detection, rolling NowCast history across polls
- **Dual-tier source model** — PurpleAir as early warning signal layer (2-minute cadence), EPA AirNow as settlement authority (60-minute cadence)
- **Wildfire smoke transport** — Multi-sensor cascade detection, pct-exceeded trajectory prediction across five coverage buckets

## Data Ingestion Capabilities

| Source | Cadence | Auth | Coverage |
|--------|---------|------|----------|
| PurpleAir API v1/sensors | 120s | API key (X-API-Key header) | 30,000+ sensors globally |
| EPA AirNow latLong/current | 60m | API key (query param) | US federal monitoring stations |

**PurpleAir fields consumed**: `sensor_index`, `name`, `latitude`, `longitude`, `pm2.5` (CF=1 ATM), `pm2.5_a`, `pm2.5_b`, `confidence`, `last_seen`, `location_type`

**EPA AirNow fields consumed**: `DateObserved`, `HourObserved`, `LocalTimeZone`, `ParameterName`, `AQI`, `Category`

## Signal Processing Skills

### NowCast PM2.5 → AQI Pipeline

```
pm2.5 readings (12h rolling) → computeNowCast() → PM2.5 concentration
PM2.5 concentration → calculateAQI('PM25', concentration) → AQI integer
AQI integer → getCategory(aqi) → { name, number, range }
```

### Channel Consistency Assessment

```
(pm25_a, pm25_b) → computeChannelConsistency() → score [0, 1]
score ≥ 0.8  → 'consistent'
score 0.4–0.8 → 'divergent'
score < 0.4  → 'inconsistent'
```

Rolling 10-reading average tracked in SensorRegistry per sensor for stable settlement classification.

### Quality Scoring

Multi-component quality score used for Theatre position weighting:
- `source_tier`: 0.65 (PurpleAir) / 1.0 (EPA AirNow)
- `freshness`: exponential decay from last_seen timestamp
- `density`: nearby sensor agreement (within 0.5° / ±20 AQI)
- `consistency`: channel A/B agreement score

### Uncertainty Pricing

`buildUncertainty(quality, currentAQI, contextualFactors)` → `doubt_price` used by `thresholdCrossingProbability()` for T1 position updates.

## Cross-Source Corroboration Logic

PurpleAir and EPA AirNow corroborate via the dual-tier model:

1. **Normal signal**: PurpleAir `provisional` bundles blend Theatre position toward `thresholdCrossingProbability(aqi, threshold, doubt_price)`
2. **Threshold alert**: PurpleAir `provisional_mature` bundle with AQI ≥ threshold → Theatre enters `provisional_hold` state
3. **Settlement**: EPA AirNow `ground_truth` bundle → immediate Theatre resolution (YES/NO) based on `category_number >= threshold_category_number`
4. **Expiry**: If `closes_at` reached without AirNow confirmation → Theatre expires with `outcome: false`

AirNow bundles are always processed before PurpleAir bundles in each `poll()` cycle to ensure settlement signals resolve markets before signal-layer updates can corrupt final positions.

## Known Failure Modes

### Channel Inconsistency
One of two PurpleAir dual channels (A or B) fails. Detected via `computeChannelConsistency(pm25_a, pm25_b)`. Bundle receives `evidence_class: 'channel_inconsistent'`. Not forwarded to Theatre position update.

### Sensor Dropout
Sensor absent from PurpleAir API response for > 2× poll cadence. Detected in `SensorRegistry.getDropouts()`. Bundle receives `evidence_class: 'sensor_dropout'`. Theatre receives no signal from this sensor until it recovers.

### Location Drift
Sensor coordinates change > 0.001° (≈100m) between polls. Detected in `SensorRegistry.hasLocationDrift()`. `location_stable: false` on the SensorRecord. May indicate sensor relocation or GPS instability.

### AQI Breakpoint Discontinuities
PM2.5 breakpoint boundaries are inclusive on both ends in the EPA table (e.g., `[12.0, 12.1]` overlap). `calculateAQI` uses `>=` on Clow and `<=` on Chigh — a value of exactly `12.0` maps to the first row (AQI 50), not the second. Truncation, not rounding, per EPA spec.

### Wildfire Smoke Transport Lag
Smoke plumes may take 2–12 hours to reach downwind sensors after fire ignition. T3 wildfire_cascade theatre's `window_hours` must account for this. Bucket probability distribution starts uniform and converges as sensors report.

## Theatre Templates

### T1: AQI Threshold Gate (`aqi_threshold_gate`)
**Type**: Binary prediction market
**Question**: Will AQI reach category boundary X in region R within N hours?
**Valid thresholds**: 51 (Moderate), 101 (USG), 151 (Unhealthy), 201 (Very Unhealthy), 301 (Hazardous)
**Resolution**: EPA AirNow `ground_truth` → YES if `category_number >= threshold_category_number`; window close → NO
**Position update**: Exponential blend toward `thresholdCrossingProbability`, weighted by `0.3 * quality.composite`

### T2: Sensor Divergence (`sensor_divergence`)
**Type**: Self-resolving binary market (Paradox Engine native)
**Question**: Will sensors A and B diverge by > N AQI for K consecutive readings?
**Resolution**: `consecutive_hours_divergent >= required_hours` → YES (self-resolving); window close → NO
**Position update**: `recentExceeded / required_hours` — smooth [0, 1] approach
**Note**: No EPA AirNow involvement. Detects sensor degradation or localized phenomena.

### T3: Wildfire Cascade (`wildfire_cascade`)
**Type**: Multi-class market (5 buckets)
**Question**: What fraction of tracked sensors will exceed AQI 200 at window close?
**Buckets**: 0–10% | 10–30% | 30–50% | 50–70% | 70%+
**Resolution**: `resolveWildfireCascade()` → `findBucketIndex(current_pct_exceeded)` → outcome 0–4
**Position update**: Bucket probability += 0.15 on observed bucket, renormalize
**Sensor cohort**: Frozen at creation — new sensors do not affect tracked denominator
