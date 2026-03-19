# BREATH — Product Requirements Document

> **Construct**: Air Quality Intelligence Agent for Echelon
> **Version**: 0.1.0 (PurpleAir MVP)
> **Date**: 2026-03-19
> **Status**: APPROVED FOR ARCHITECTURE

---

## 1. Problem Statement

> *Source: grimoires/pub/ALPHA PROMPT.md (design conversation), Phase 1 interview*

The Echelon prediction market framework runs on OSINT constructs — autonomous agents that ingest real-world data, open prediction markets (Theatres), and export calibrated training data (RLMF certificates). TREMOR proved the pattern on seismic data. CORONA proved it on space weather. Both share a critical property: their data sources are exogenous, ground-truth verifiable, and controlled by authoritative institutions (USGS, NOAA).

Air quality is the third domain that satisfies all of these properties:

- **Ground truth oracle**: EPA AirNow publishes AQI data continuously. No human interpretation required. Clean binary resolution (did AQI exceed threshold or not?).
- **Binary structure**: EPA AQI breakpoints (50/100/150/200/300) create natural threshold gates — the same structure TREMOR uses for magnitude gates.
- **Fast cycles**: AQI readings update hourly (NowCast updates more frequently). Theatres can resolve in 4–72 hours.
- **Exogenous**: Predictions don't affect air quality. No reflexivity.
- **Free data**: EPA AirNow is public API, no cost. PurpleAir is points-based but affordable.
- **Density**: PurpleAir's 30,000+ global sensors create a dense enough network for sensor-to-sensor corroboration — something seismic networks in sparse regions can't do.

**The gap**: No construct exists to run air quality prediction markets on Echelon. BREATH fills this gap as the third construct in the established TREMOR→CORONA lineage.

**The strategic vision** (captured but deferred to Phase 2): The deeper opportunity is a *meta-construct* — a factory that classifies arbitrary sensor feeds and auto-generates Theatre templates. PurpleAir is the proving ground for this pattern before full generalization.

---

## 2. Product Vision & Mission

> *Source: grimoires/pub/ALPHA PROMPT.md (Opus 4.6 + Tobias/Perplexity synthesis)*

**Vision**: The canonical air quality intelligence construct on the Echelon Constructs Network — producing the most calibrated, adversarially-resistant AQI prediction training data available.

**Mission**: BREATH ingests real-time air quality data from PurpleAir (community sensors) and EPA AirNow (reference grade), converts it into structured evidence bundles, runs three Theatre types on air quality outcomes, and exports Brier-scored RLMF training data that can't be produced by cheaper, single-source approaches.

**The product is the calibrated training data. The prediction markets are the factory.**

**Why PurpleAir first**: 30,000+ sensors, dense urban coverage, public API, real-time PM2.5 data, and natural AQI thresholds from EPA breakpoints. This is the ideal network to prove the BREATH pattern before generalizing to the meta-construct.

---

## 3. Goals & Success Metrics

### MVP Goals (v0.1.0)

| Goal | Success Criterion |
|------|------------------|
| Pattern proof | 3 Theatre templates implemented, all resolving to RLMF certificates |
| Test coverage | ≥50 tests across ≥18 suites (exceeds TREMOR's 48/16 baseline) |
| Zero dependencies | `npm install` not required. Node.js 20+ only. |
| Pipeline compatibility | RLMF certificate schema matches TREMOR/CORONA exactly |
| Settlement integrity | EPA AirNow resolves all AQI Threshold Gate and Wildfire Cascade theatres |
| Adversarial resistance | PurpleAir A/B channel consistency check implemented and tested |
| AQI computation | Explicit EPA breakpoint module with tests at boundary edges |
| Constructs Network listing | `spec/construct.json` complete, BUTTERFREEZONE.md written |

### Phase 2 Goals (meta-construct)

- ThingSpeak sensor recruitment mechanic
- Feed grammar classifier (the 5-question framework)
- Theatre template auto-generation from feed characteristics
- Composition layer for multi-feed Theatres
- OpenAQ corroboration tier

---

## 4. Users & Stakeholders

### Primary Users

| User | Role | What They Need |
|------|------|----------------|
| **Echelon Theatre operators** | Create and manage air quality prediction markets | Reliable evidence bundles with clear settlement authority and quality scores |
| **RLMF pipeline consumers** | Use exported training data for AI calibration | Brier-scored certificates with full position history, compatible schema |
| **Echelon AI agents** (Shark, Spy, Diplomat, Saboteur) | Trade positions in BREATH Theatres | Accurate probability updates, doubt pricing, evidence class signals |
| **Constructs Network users** | Discover and install BREATH | Clear skill profile, BUTTERFREEZONE.md, construct.json |

### Stakeholders

| Stakeholder | Interest |
|-------------|---------|
| **Tobias James (Echelon)** | Third construct proves Echelon network breadth; RLMF training data product quality |
| **El Capitan (builder)** | Proving the meta-construct pattern via domain-specific MVP |
| **PurpleAir sensor operators** | Data use (read-only, public API — no obligation, Phase 2 recruitment is opt-in) |
| **EPA AirNow** | Data use per AirNow exchange guidelines (preliminary data, attribution required) |

---

## 5. Functional Requirements

### 5.1 Oracle Modules

#### PurpleAir Oracle (`src/oracles/purpleair.js`)

**Role**: Signal layer — early warning, density, cross-sensor corroboration. NOT settlement authority.

| Requirement | Detail |
|-------------|--------|
| API endpoint | `api.purpleair.com/v1/sensors` |
| Auth | `X-API-Key` header (points-based billing — API key required) |
| Poll cadence | Configurable, default 120s (PurpleAir updates ~2 min) |
| Fields required | `sensor_index`, `name`, `latitude`, `longitude`, `pm2.5`, `pm2.5_a`, `pm2.5_b`, `confidence`, `last_seen`, `location_type` |
| Channel A/B check | If `abs(pm2.5_a - pm2.5_b) / avg > 0.7`, flag as `channel_inconsistent` → doubt_price = 0.8+ |
| Location type filter | Only `location_type: 0` (outdoor sensors) in MVP. Indoor sensors excluded. |
| Deduplication | By `sensor_index`, skip if `last_seen` unchanged |
| Geographic query | Bounding box query: `nwlng`, `nwlat`, `selng`, `selat` params |
| Fields param | Request only required fields to minimize point usage |
| Rate limit handling | Exponential backoff on 429. Cache last successful response per region. |
| Graceful degradation | If PurpleAir unavailable: log, reduce Theatre update frequency, do not halt |

**Known failure modes**:
- Sensor goes offline mid-Theatre → mark as `sensor_dropout`, flag evidence bundle
- Channel A/B divergence (internal sensor fault vs actual pollution event) → `channel_inconsistent` evidence class
- Location spoofing (indoor sensor tagged outdoor) → `location_type` filter + cross-reference with EPA if nearby

#### EPA AirNow Oracle (`src/oracles/epa-airnow.js`)

**Role**: Settlement authority. Resolves all AQI Threshold Gate and Wildfire Cascade Theatres.

| Requirement | Detail |
|-------------|--------|
| API endpoint | `https://www.airnowapi.org/aq/observation/zipCode/current/` and `/aq/observation/latLong/current/` |
| Auth | `API_KEY` query param (free, registration required) |
| Poll cadence | 60 min (EPA updates hourly) |
| Data type | NowCast AQI (real-time, preliminary) — NOT regulatory AQS data |
| Fields required | `DateObserved`, `HourObserved`, `LocalTimeZone`, `ReportingArea`, `StateCode`, `Latitude`, `Longitude`, `ParameterName`, `AQI`, `Category.Number`, `Category.Name` |
| Preliminary flag | All AirNow data is preliminary. Evidence bundles must carry `data_tier: "preliminary"` and `attribution: "U.S. EPA AirNow"` |
| Settlement window | Theatre closes 2h after EPA AirNow reports AQI for the observation window |
| Fallback | If AirNow unavailable at settlement: use `market_freeze` evidence class (20% Brier discount), 24h retry window |
| Attribution | Display constraint: data must be attributed to U.S. EPA AirNow in any downstream presentation |

**Time semantics (critical)**:
- **Observation time**: The hour the measurement was taken (from `DateObserved` + `HourObserved`)
- **Publication time**: When AirNow published it (typically within the same hour)
- **Ingest time**: `Date.now()` at time of polling
- **Averaging basis**: NowCast (real-time weighted average, heavier weight on recent hours)
- Every evidence bundle preserves all four fields.

### 5.2 Processor Pipeline (`src/processor/`)

#### AQI Computation Module (`src/processor/aqi.js`)

This module is **unique to BREATH** — TREMOR and CORONA don't need it. It is the highest-risk source of subtle bugs and requires the most thorough testing.

| Requirement | Detail |
|-------------|--------|
| EPA breakpoint tables | Hard-coded for all 6 pollutants: PM2.5, PM10, O3 (8h and 1h), NO2, SO2, CO |
| NowCast algorithm | PM2.5 NowCast: weighted 12-hour average with weight = (min_concentration / max_concentration) for each hour |
| Category mapping | 6 categories: Good (0-50), Moderate (51-100), USG (101-150), Unhealthy (151-200), Very Unhealthy (201-300), Hazardous (301+) |
| Dominant pollutant | Pollutant with highest AQI value across all measured pollutants |
| Rounding rules | AQI truncated to integer (not rounded) per EPA spec |
| Breakpoint discontinuities | Explicit tests at exact breakpoints (50, 100, 150, 200, 300) — these are the threshold crossing points for Theatre gates |
| PurpleAir correction | Apply EPA CF=1 correction for PurpleAir PM2.5 readings (PurpleAir CF=1 is already applied in their API — verify in docs) |

**Test requirement**: Tests MUST cover all breakpoint boundaries and category transition edges. These are the sharp discontinuities that cause position update bugs.

#### Quality Scoring (`src/processor/quality.js`)

Analogous to TREMOR's `computeQuality`. Adapted for air quality sensor networks.

| Requirement | Detail |
|-------------|--------|
| Source tier weight | EPA AirNow: 1.0, PurpleAir cross-validated: 0.85, PurpleAir single-sensor: 0.65, PurpleAir channel_inconsistent: 0.2 |
| Sensor freshness | `last_seen` age vs poll cadence. >2× cadence age → freshness penalty |
| Network density | Number of sensors within N km radius. Urban dense (>10 sensors/50km²): baseline 1.0. Rural sparse: normalize down. |
| Channel consistency | A/B divergence ratio → consistency score component |
| Cross-validated flag | If nearby EPA monitor confirms PurpleAir reading within 30% → cross_validated bonus |
| Output | `{ score: 0-1, components: { source_tier, freshness, density, consistency }, cross_validated: bool }` |

#### Uncertainty Pricing (`src/processor/uncertainty.js`)

The "doubt price" (0-1) for AQI readings. Analogous to TREMOR's `buildMagnitudeUncertainty`.

| Requirement | Detail |
|-------------|--------|
| Source tier doubt | EPA AirNow: 0.0, PurpleAir cross-validated: 0.15, PurpleAir single-sensor: 0.30, channel_inconsistent: 0.75+, sensor_dropout: 0.95 |
| Averaging basis doubt | NowCast (recent data): low doubt. Hourly average with old readings: higher doubt. |
| Review status | AirNow preliminary: slight doubt penalty vs AQS reviewed (AQS not in MVP) |
| Threshold proximity | AQI within ±5 of Theatre threshold: doubt price amplified (uncertainty at boundary matters more) |
| Output | `{ doubt_price: 0-1, basis: string, threshold_sensitivity: bool }` |

#### Settlement Logic (`src/processor/settlement.js`)

Three-tier settlement, analogous to TREMOR's `assessStatusFlip`.

| Tier | Condition | Brier discount |
|------|-----------|----------------|
| **Oracle** | EPA AirNow confirmed, observation window complete | 0% |
| **Provisional mature** | PurpleAir cross-validated (>3 sensors agree), >2h stable, quality >0.7 | 10% |
| **Market freeze** | Theatre expiring, EPA data insufficient, sensor dropout | 20% |

Hard expiry: Theatres that never receive EPA AirNow confirmation get 25% discount and resolve on PurpleAir consensus (≥3 sensors, same ZIP/cluster).

#### Evidence Bundle Construction (`src/processor/bundles.js`)

| Field | Source | Notes |
|-------|--------|-------|
| `bundle_id` | `breath-{source}-{sensor_id}-{observation_ts}` | |
| `construct` | `"BREATH"` | |
| `source` | `"EPA_AIRNOW"` or `"PURPLEAIR"` | |
| `ingestion_ts` | `Date.now()` | |
| `evidence_class` | From settlement logic | `ground_truth`, `cross_validated`, `provisional`, `provisional_mature`, `channel_inconsistent`, `sensor_dropout`, `degraded` |
| `data_tier` | `"settlement_authority"`, `"early_warning"`, `"corroboration"` | Source role in trust hierarchy |
| `attribution` | Per-source attribution string | Required for AirNow |
| `payload.observation_time` | Measurement hour | From source |
| `payload.publication_time` | When source published | From source metadata |
| `payload.ingest_time` | `Date.now()` | |
| `payload.averaging_basis` | `"nowcast"`, `"hourly"`, `"instantaneous"` | |
| `payload.location` | `{ latitude, longitude, location_type, region_label }` | |
| `payload.aqi` | `{ value, category, category_number, dominant_pollutant, calculation_method }` | |
| `payload.pollutants` | Array of `{ name, concentration, unit, aqi_value }` | |
| `payload.quality` | Quality score object | |
| `payload.uncertainty` | Doubt price object | |
| `cross_validation` | PurpleAir vs EPA agreement | Null if not yet cross-validated |
| `theatre_refs` | Array of Theatre IDs | |
| `resolution` | Settlement assessment | |

### 5.3 Theatre Templates (`src/theatres/`)

#### T1: AQI Threshold Gate (`src/theatres/aqi-gate.js`)

**Question**: Will AQI exceed [threshold] in [region] within [N] hours?

| Parameter | Value |
|-----------|-------|
| Resolution type | Binary |
| Timeframe | 4h – 72h |
| Threshold options | 51 (Moderate), 101 (USG), 151 (Unhealthy), 201 (Very Unhealthy), 301 (Hazardous) |
| Settlement authority | EPA AirNow NowCast AQI |
| Settlement field | `Category.Number ≥ threshold_category` for observation window |
| Fallback | PurpleAir consensus (≥3 sensors in region, same category) if AirNow unavailable |
| Auto-spawn | On significant AQI trend (configurable, e.g. 20-point increase in 2h) |
| Position update | On each new EPA bundle: compute P(threshold_crossed) from current AQI + doubt price |
| Resolution trigger | EPA AirNow confirms AQI category for full Theatre window |

**RLMF value**: Clean binary ground truth (EPA category) with measurable lead time advantage from PurpleAir early signal. Demonstrates sensor network alpha.

#### T2: Sensor Divergence (`src/theatres/sensor-divergence.js`)

**Question**: Will PurpleAir sensors A and B diverge by >N AQI for >M consecutive hours?

| Parameter | Value |
|-----------|-------|
| Resolution type | Binary |
| Timeframe | 4h – 24h |
| Divergence threshold | Configurable (default: 50 AQI for >2 consecutive hours) |
| Settlement authority | PurpleAir (self-resolving — divergence is measured within PurpleAir data) |
| Paradox Engine role | Native — this IS the divergence check. Divergence between nearby sensors signals either: sensor fault OR hyperlocal pollution event (e.g., one sensor near a road, one not) |
| Auto-spawn | On channel A/B internal divergence exceeding consistency threshold |
| Position update | On each new PurpleAir bundle: compute rolling divergence between sensor pair |
| Resolution trigger | 2 consecutive hours of divergence > threshold = YES. Theatre closes = NO. |

**Note**: This theatre does NOT use EPA AirNow for settlement — it measures PurpleAir network self-consistency, making it the Paradox Engine native theatre for BREATH.

**RLMF value**: Labels sensor fault events vs hyperlocal pollution hotspot events. High value for training agents to distinguish data quality issues from genuine signals.

#### T3: Wildfire Cascade (`src/theatres/wildfire-cascade.js`)

**Question**: Following a wildfire smoke alert for region X, how many sensors in region Y will exceed AQI 200 (Very Unhealthy) within 72h?

| Parameter | Value |
|-----------|-------|
| Resolution type | Multi-class (5 buckets: 0-10%, 10-30%, 30-50%, 50-70%, 70%+) |
| Timeframe | 72h from Theatre open |
| Trigger | External wildfire alert (AirNow fire smoke category, or manual trigger) |
| Settlement authority | PurpleAir sensor count (% of tracked sensors in region exceeding AQI 200) — EPA AirNow confirms category |
| Pattern | Analogous to TREMOR's Aftershock Cascade |
| Position update | On each polling cycle: recompute % sensors exceeding threshold |
| Resolution trigger | Theatre closes at 72h. Final % determines bucket outcome. |

**RLMF value**: Multi-class calibration data for wildfire smoke transport prediction. High public health relevance. Direct analogue to TREMOR aftershock cascade which produced strong RLMF certificates.

### 5.4 RLMF Certificate Export (`src/rlmf/certificates.js`)

Schema MUST be compatible with TREMOR/CORONA for pipeline compatibility. Key fields:

```js
{
  certificate_id: string,       // "breath-{theatre_id}-{resolved_at}"
  construct: "BREATH",
  theatre_id: string,
  template: string,             // "aqi_threshold_gate" | "sensor_divergence" | "wildfire_cascade"
  outcome: bool | number,       // boolean for binary, bucket index for multi-class
  opened_at: timestamp,
  resolved_at: timestamp,
  performance: {
    brier_score: number,        // Lower is better
    brier_time_weighted: number,
    position_history: Array,    // [{timestamp, probability, evidence_class}]
    directional_accuracy: bool,
    lead_time_seconds: number,  // Time before resolution that correct direction was taken
    volatility: number,
  },
  evidence_summary: {
    total_bundles: number,
    by_evidence_class: object,
    by_source: object,
    epa_airnow_confirmed: bool,
    purpleair_sensor_count: number,
  },
  brier_discount: number,       // 0, 0.1, 0.2, or 0.25
  settlement_tier: string,
}
```

### 5.5 Construct Entrypoint (`src/index.js`)

Class: `BreathConstruct` (mirrors `TremorConstruct` pattern exactly)

| Method | Description |
|--------|-------------|
| `constructor(config)` | `{ pollIntervalMs, apiKeys: {purpleair, airnow}, enableCrossValidation }` |
| `openAqiThresholdGate(params)` | Creates T1 Theatre |
| `openSensorDivergence(params)` | Creates T2 Theatre |
| `openWildfireCascade(params)` | Creates T3 Theatre |
| `getActiveTheatres()` | Returns open/provisional_hold theatres |
| `start()` | Begin polling loop |
| `stop()` | Clear polling interval |
| `poll()` | Single poll cycle: both oracles → bundles → theatre updates → expiry checks |
| `getState()` | Health/status snapshot |
| `getCertificates()` | Exported RLMF certificates |
| `flushCertificates()` | Clear after pipeline consumption |

### 5.6 Construct Specification (`spec/construct.json`)

Machine-readable spec for Constructs Network listing. Required fields: `name`, `slug`, `description`, `version`, `license`, `domain`, `archetype`, `data_sources`, `theatre_templates`, `dependencies`, `ecosystem`.

---

## 6. Technical & Non-Functional Requirements

### Stack

| Requirement | Value |
|-------------|-------|
| Runtime | Node.js 20+ |
| External dependencies | **Zero** (no npm install required) |
| Module format | ESM (`import`/`export`) |
| Test runner | `node:test` built-in |
| HTTP | Built-in `fetch` (Node.js 18+) |
| Architecture | Mirrors TREMOR/CORONA exactly |

### Performance

| Requirement | Value |
|-------------|-------|
| PurpleAir poll latency | <5s per regional bounding box query |
| EPA AirNow poll latency | <3s per region |
| Bundle construction | Synchronous, <1ms per observation |
| Theatre update | Synchronous, <5ms per bundle |
| Certificate export | Synchronous, <1ms |

### API Auth & Credentials

| Source | Auth | Env var |
|--------|------|---------|
| PurpleAir | API key (header) | `PURPLEAIR_API_KEY` |
| EPA AirNow | API key (query param) | `AIRNOW_API_KEY` |
| ThingSpeak | None in MVP | N/A |

Credentials via env vars or `config.apiKeys` object. `.env.example` required.

### Rate Limits & Polling Budget

| Source | Rate limit | Strategy |
|--------|-----------|----------|
| PurpleAir | Points-based (varies by field count) | Minimal field selection. Cache last response. Exponential backoff on 429. |
| EPA AirNow | ~1000 calls/day on free tier | Once per hour per region. No more. Cache hourly result. |
| Graceful degradation | If quota exhausted | Log warning, extend poll interval, do not halt Theatre |

### Adversarial Sensor Model (PurpleAir-specific)

| Attack vector | Mitigation |
|---------------|-----------|
| Indoor sensor tagged as outdoor | `location_type: 0` filter (outdoor only) |
| Channel A/B manipulation | A/B consistency check → `channel_inconsistent` evidence class |
| Frozen/stale data stream | `last_seen` freshness check. Age > 2× poll cadence → `sensor_dropout` |
| Replayed data | Deduplication by `sensor_index` + `last_seen` timestamp |
| Location drift (sensor moved) | Flag if sensor coordinates change across polls |
| Coordinated sensor cluster manipulation | Cross-reference with EPA AirNow within 20km. Divergence >50 AQI → Paradox Engine flag |

**Note**: EPA AirNow reference monitors cannot be gamed (they're government installations). When PurpleAir sensors diverge significantly from a nearby AirNow monitor, this is a signal. The Sensor Tier Divergence theatre (T4, Phase 2) will make this explicit.

### AQI Computation Spec

| Requirement | Value |
|-------------|-------|
| Module | `src/processor/aqi.js` |
| Pollutants | PM2.5 (NowCast), PM10 (24h avg), O3 (8h avg), NO2 (1h avg), SO2 (1h avg), CO (8h avg) |
| Breakpoint tables | Hard-coded from EPA technical assistance document (current revision) |
| Truncation | Integer truncation, not rounding |
| Dominant pollutant | Highest AQI value wins |
| NowCast | Weighted 12-hour average: weight = (Cmin/Cmax) for each hour. Requires ≥2 of last 12 hours valid. |
| Test requirement | Breakpoint edges, category transitions, NowCast vs raw concentration divergence, dominant pollutant tie-breaking |

### Data Attribution

| Source | Attribution requirement |
|--------|------------------------|
| EPA AirNow | "U.S. EPA AirNow" — required in all evidence bundles and documentation |
| PurpleAir | Attribution per their API terms |

### Testing Requirements

| Requirement | Target |
|-------------|--------|
| Total tests | ≥50 |
| Total suites | ≥18 |
| Pass rate | 100% |
| Coverage areas | Oracles (mocked), AQI computation (boundary tests), processor pipeline, all 3 Theatre templates, RLMF certificate export, adversarial sensor scenarios |

---

## 7. Scope & Prioritization

### MVP (v0.1.0) — In Scope

| Component | Status |
|-----------|--------|
| PurpleAir oracle | In MVP |
| EPA AirNow oracle | In MVP (settlement authority) |
| AQI computation module | In MVP |
| Quality scoring | In MVP |
| Uncertainty pricing | In MVP |
| Settlement logic (3-tier) | In MVP |
| Evidence bundle construction | In MVP |
| T1: AQI Threshold Gate | In MVP |
| T2: Sensor Divergence | In MVP |
| T3: Wildfire Cascade | In MVP |
| RLMF certificate export | In MVP |
| `BreathConstruct` entrypoint | In MVP |
| Test suite (≥50 tests) | In MVP |
| `spec/construct.json` | In MVP |
| `BUTTERFREEZONE.md` | In MVP |
| `.env.example` | In MVP |
| Adversarial sensor mitigations | In MVP |
| Attribution metadata | In MVP |

### Phase 2 — Out of Scope for v0.1.0

| Component | Reason for deferral |
|-----------|---------------------|
| ThingSpeak oracle & recruitment mechanic | Incentive economics TBD (depends on Echelon on-chain settlement). Core differentiator but adds scope. |
| T4: Sensor Tier Divergence (EPA vs PurpleAir) | Requires OpenAQ corroboration tier |
| T5: ThingSpeak Recruitment Oracle | Requires ThingSpeak oracle |
| OpenAQ corroboration tier | Requires API key, adds corroboration value but not settlement-critical for MVP |
| Sensor trust promotion state machine | Relevant when ThingSpeak joins as recruitable source |
| Historical backfill / replay mode | TREMOR/CORONA don't have it either. Phase 2 for RLMF backtesting. |
| Meta-construct (feed grammar classifier) | The Uniswap moment — extracted from BREATH patterns after MVP proves |
| Multi-feed composition layer | Requires meta-construct foundation |

### Explicitly Out of Scope (forever)

- EPA AQS regulatory data (significant delay, wrong latency profile for prediction markets)
- Satellite data (MODIS, VIIRS) — too complex for v0.1, may be Phase 3
- Indoor air quality monitoring
- Personal/consumer air quality devices (not public APIs)

---

## 8. Risks & Dependencies

### Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| AQI NowCast algorithm subtle bugs | High | High | Explicit AQI module with breakpoint boundary tests. Cross-check against EPA NowCast docs. |
| PurpleAir A/B channel inconsistency misclassification | Medium | Medium | A/B check formula tested against known good/bad sensor data |
| EPA AirNow hourly delay creates Theatre resolution lag | High | Low | Expected — built into settlement tier model (provisional_mature handles the gap) |
| PurpleAir API point cost exceeds budget | Low | Medium | Minimal field selection, bounding box queries, caching |
| EPA AirNow rate limit on free tier | Low | Low | One poll/hour/region. Well within 1000/day limit. |
| Sensor coordinate drift (mobile sensors) | Low | Low | Location drift flag in oracle module |

### External Dependencies

| Dependency | Criticality | Risk |
|------------|------------|------|
| PurpleAir API availability | High | Service degradation → Theatre evidence gaps. Mitigated by degraded evidence class. |
| EPA AirNow API availability | High (settlement) | AirNow downtime → market_freeze settlement. 24h retry window. |
| USGS AirNow data quality | High | Preliminary data is AirNow's stated limitation. Not a bug — documented in attribution. |

### Open Questions

| Question | Decision needed by | Owner |
|----------|-------------------|-------|
| ThingSpeak recruitment incentive mechanics | Phase 2 planning | Tobias (Echelon on-chain settlement) |
| PurpleAir CF correction factor for AQI calculation | Architecture | Verify from PurpleAir API docs — CF=1 may already be applied |
| OpenAQ v3 API key provisioning for Phase 2 | Phase 2 planning | El Capitan |
| Sensor tier divergence Theatre threshold (EPA vs PurpleAir ±30%? ±50%?) | Phase 2 | Both |

---

## 9. Reference Architecture

### Directory Structure (mirroring TREMOR)

```
breath/
├── src/
│   ├── index.js                    # BreathConstruct entrypoint
│   ├── skills/
│   │   └── air-quality.md          # Construct specialization profile
│   ├── oracles/
│   │   ├── purpleair.js            # PurpleAir community sensor poller
│   │   └── epa-airnow.js           # EPA AirNow settlement oracle
│   ├── processor/
│   │   ├── aqi.js                  # AQI computation module (breakpoints, NowCast, categories)
│   │   ├── quality.js              # Quality scoring (source tier, freshness, density, consistency)
│   │   ├── uncertainty.js          # Doubt pricing engine
│   │   ├── settlement.js           # 3-tier settlement logic
│   │   └── bundles.js              # Evidence bundle construction
│   └── theatres/
│       ├── aqi-gate.js             # T1: AQI Threshold Gate (binary)
│       ├── sensor-divergence.js    # T2: Sensor Divergence (binary, Paradox Engine native)
│       └── wildfire-cascade.js     # T3: Wildfire Cascade (5-bucket multi-class)
├── rlmf/
│   └── certificates.js             # RLMF training data export (Brier scoring)
├── spec/
│   └── construct.json              # Machine-readable construct spec
├── test/
│   └── breath.test.js              # Test suite (≥50 tests, ≥18 suites, node:test)
├── BUTTERFREEZONE.md               # Agent-facing project interface
├── .env.example                    # PURPLEAIR_API_KEY, AIRNOW_API_KEY
├── package.json                    # name, version, type: "module", scripts.test
└── README.md                       # Human-facing documentation
```

### Data Flow

```
PurpleAir API (120s)  ──→ ┌──────────────────┐
                          │   Processor       │
EPA AirNow API (60m)  ──→ │   Pipeline        │──→ Evidence Bundles ──→ Theatre Matching ──→ RLMF Certs
                          │   aqi → quality   │
                          │   → uncertainty   │
                          │   → settlement    │
                          │   → bundles       │
                          └──────────────────┘
```

### Theatre Auto-Spawn Logic

| Trigger | Theatre |
|---------|---------|
| AQI trend: +20 in 2h | T1: AQI Threshold Gate (next category threshold) |
| A/B channel divergence > consistency threshold | T2: Sensor Divergence |
| AirNow fire smoke category detected | T3: Wildfire Cascade |
| Manual `openX()` call | Any |

---

## 10. Source Tracing

| Section | Primary Source |
|---------|---------------|
| Problem statement | `grimoires/pub/ALPHA PROMPT.md` — design conversation |
| Settlement architecture | Phase 1 interview (2026-03-19): EPA AirNow selected as settlement authority |
| Theatre selection (3 templates) | Phase 1 interview (2026-03-19): 3 core selected over 5 |
| ThingSpeak deferral | Phase 1 interview (2026-03-19): Phase 2 confirmed |
| Adversarial model | `grimoires/pub/ALPHA PROMPT.md` — second model review + Opus 4.6 synthesis |
| AQI computation requirements | `grimoires/pub/ALPHA PROMPT.md` — El Capitan's suggestions, Opus 4.6 acceptance |
| Source tier model | `grimoires/pub/ALPHA PROMPT.md` — Opus 4.6 RESOLUTION AUTHORITY section |
| Time semantics | `grimoires/pub/ALPHA PROMPT.md` — El Capitan's TIME SEMANTICS suggestion |
| TREMOR pattern | `grimoires/pub/TREMOR docs/TREMOR index.js`, `bundles.js`, `BUTTERFREEZONE.md` |
| CORONA pattern | `grimoires/pub/Corona docs/CORONA readme.md` |
| Platform context | `grimoires/pub/Echelon/ECHELON readme.md` |
