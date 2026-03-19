<!-- AGENT-CONTEXT
name: corona
type: construct
purpose: Space weather intelligence construct for Echelon — monitors solar flares, CMEs, geomagnetic storms, and solar wind through structured prediction markets (Theatres) producing Brier-scored RLMF training data
version: 0.1.0
key_files: [src/index.js, src/oracles/swpc.js, src/oracles/donki.js, src/processor/bundles.js, src/theatres/flare-gate.js]
interfaces:
  oracles: [SWPC_GOES, SWPC_DSCOVR, SWPC_KP, DONKI]
  theatres: [flare_class_gate, geomagnetic_storm_gate, cme_arrival, proton_event_cascade, solar_wind_divergence]
  exports: [RLMF certificates]
dependencies: []
ecosystem:
  - repo: echelon-protocol/echelon
    role: platform
    interface: theatre-api
    protocol: echelon@0.1.0
  - repo: echelon-protocol/tremor
    role: sibling-construct
    interface: rlmf-pipeline
    protocol: echelon@0.1.0
capability_requirements:
  - network: read
trust_level: L1-tested
-->

# CORONA

<!-- provenance: DERIVED -->
**Coronal Oracle & Realtime Observation Network Agent.** Space weather intelligence construct for the Echelon prediction market protocol. Monitors solar activity through NOAA SWPC and NASA DONKI data pipelines, produces calibrated training data via 5 Theatre templates resolving against real-time GOES X-ray flux, planetary Kp index, CME arrival signatures, and proton event cascades.

## Key Capabilities

<!-- provenance: CODE-FACTUAL -->

- **SWPC Oracle** — Polls NOAA GOES X-ray flux (1-min), planetary Kp index (3-hr), integral proton flux, and DSCOVR real-time solar wind. Zero auth, JSON feeds. (`src/oracles/swpc.js`)
- **DONKI Oracle** — Fetches NASA DONKI solar flares, CMEs with WSA-Enlil arrival predictions, geomagnetic storms, and interplanetary shocks with cause-effect linkages. (`src/oracles/donki.js`)
- **Evidence Bundle Builder** — Converts raw SWPC/DONKI data into Echelon-compatible bundles with quality scoring, uncertainty pricing, and settlement assessment. (`src/processor/bundles.js`)
- **Quality Scoring** — Multi-component quality model: source reliability, data freshness, instrument status, measurement completeness. (`src/processor/quality.js`)
- **Uncertainty Pricing** — Flare class reclassification doubt, Kp preliminary vs definitive, CME arrival time sigma (WSA-Enlil MAE ~10h). Normal CDF threshold crossing probabilities. (`src/processor/uncertainty.js`)
- **Settlement Logic** — Evidence class determination: ground_truth (DONKI-confirmed, GFZ definitive), provisional_mature, cross_validated, provisional, degraded. Handles GOES satellite switching, flare reclassification, Kp preliminary lag. (`src/processor/settlement.js`)
- **Flare Class Gate (T1)** — Binary market on GOES X-ray class threshold. Position updates via doubt pricing on in-progress flares. (`src/theatres/flare-gate.js`)
- **Geomagnetic Storm Gate (T2)** — Binary Kp threshold market. Multi-input: Kp observations, solar wind precursors (Bz, speed), CME arrival predictions, DONKI GST events. (`src/theatres/geomag-gate.js`)
- **CME Arrival (T3)** — Binary market on WSA-Enlil predicted arrival ±6h. Resolves via L1 solar wind shock detection (speed jump + Bt increase). (`src/theatres/cme-arrival.js`)
- **Proton Event Cascade (T4)** — Multi-bucket radio blackout count following M5+ trigger. Wheatland waiting-time prior, Poisson bucket probabilities, rate-blended updating. (`src/theatres/proton-cascade.js`)
- **Solar Wind Divergence (T5)** — Paradox Engine native: DSCOVR-ACE Bz volatility as divergence proxy. Sustained streak detection. (`src/theatres/solar-wind-divergence.js`)
- **RLMF Certificate Export** — Binary and multi-class Brier scores, temporal analysis (volatility, directional accuracy, time-weighted Brier), calibration buckets. Pipeline-compatible with TREMOR certificates. (`src/rlmf/certificates.js`)

## Architecture

<!-- provenance: DERIVED -->
The architecture follows the Echelon construct pattern established by TREMOR: dual-oracle polling feeds a processor pipeline that builds typed evidence bundles, which are matched against active Theatres for position updates. Resolved Theatres export RLMF certificates. The construct runs as a single-process event loop with configurable poll intervals (1-min SWPC, 5-min DONKI).

```
                    CoronaConstruct
                         |
          ┌──────────────┼──────────────┐
          |              |              |
     ┌────┴────┐   ┌────┴────┐   ┌────┴────┐
     | Oracles |   | Process |   | Theatres|
     | swpc.js |   | bundles |   | T1-T5   |
     | donki.js|   | quality |   | flare   |
     |         |   | uncert. |   | geomag  |
     |         |   | settle. |   | cme     |
     |         |   |         |   | proton  |
     |         |   |         |   | sw-div  |
     └─────────┘   └─────────┘   └────┬────┘
                                       |
                                 ┌─────┴─────┐
                                 |    RLMF    |
                                 | certificates|
                                 └───────────┘
```

Directory structure:
```
corona/
├── src/
│   ├── index.js              # Construct entrypoint + lifecycle
│   ├── oracles/
│   │   ├── swpc.js           # NOAA SWPC feeds
│   │   └── donki.js          # NASA DONKI API
│   ├── processor/
│   │   ├── bundles.js        # Evidence bundle construction
│   │   ├── quality.js        # Quality scoring
│   │   ├── uncertainty.js    # Uncertainty pricing
│   │   └── settlement.js     # Evidence class + resolution
│   ├── theatres/
│   │   ├── flare-gate.js     # T1: Flare Class Gate
│   │   ├── geomag-gate.js    # T2: Geomagnetic Storm Gate
│   │   ├── cme-arrival.js    # T3: CME Arrival
│   │   ├── proton-cascade.js # T4: Proton Event Cascade
│   │   └── solar-wind-divergence.js  # T5: Paradox Engine
│   └── rlmf/
│       └── certificates.js   # RLMF export
├── tests/
│   └── corona_test.js        # 60 tests, 21 suites
└── package.json
```

## Interfaces

<!-- provenance: CODE-FACTUAL -->

### Data Sources

| Source | Base URL | Auth | Cadence |
|--------|----------|------|---------|
| SWPC GOES X-ray | services.swpc.noaa.gov/json/goes/ | None | 1-min |
| SWPC Kp Index | services.swpc.noaa.gov/products/ | None | 3-hr |
| SWPC Proton Flux | services.swpc.noaa.gov/json/goes/ | None | 5-min |
| SWPC Solar Wind | services.swpc.noaa.gov/products/solar-wind/ | None | 1-min |
| NASA DONKI FLR | api.nasa.gov/DONKI/FLR | API key | Event |
| NASA DONKI CME | api.nasa.gov/DONKI/CME | API key | Event |
| NASA DONKI GST | api.nasa.gov/DONKI/GST | API key | Event |

### Theatre Templates

| ID | Template | Type | Resolution Source |
|----|----------|------|-------------------|
| T1 | flare_class_gate | Binary | GOES X-ray + DONKI FLR |
| T2 | geomagnetic_storm_gate | Binary | Kp index + DONKI GST |
| T3 | cme_arrival | Binary | L1 solar wind shock |
| T4 | proton_event_cascade | Multi-class (5 buckets) | Flare count |
| T5 | solar_wind_divergence | Binary | Bz volatility streak |

## Module Map

<!-- provenance: CODE-FACTUAL -->

| Module | Files | Purpose |
|--------|-------|---------|
| `src/oracles/` | 2 | SWPC + DONKI data fetching and normalization |
| `src/processor/` | 4 | Bundle construction, quality, uncertainty, settlement |
| `src/theatres/` | 5 | Theatre templates T1-T5 |
| `src/rlmf/` | 1 | Certificate export for RLMF pipeline |
| `tests/` | 1 | 60 tests across 21 suites (node:test) |

## Verification

<!-- provenance: CODE-FACTUAL -->
- Trust Level: **L1 — Tested**
- 60 tests across 21 suites, all passing
- Zero external dependencies
- Node.js 20+ required
- RLMF certificates compatible with TREMOR pipeline schema

## Ecosystem

<!-- provenance: DERIVED -->
CORONA is the second construct in the Echelon ecosystem after TREMOR (seismic intelligence). Both produce RLMF certificates with identical schemas for pipeline compatibility. CORONA's Theatre templates follow the same patterns: binary gates (T1, T2, T3, T5) map to Magnitude Gate, multi-class cascades (T4) map to Aftershock Cascade. The key architectural difference is dual-oracle (SWPC + DONKI) with different cadences, and multi-input theatres (T2: Geomagnetic Storm Gate accepts Kp, solar wind, CME, and GST evidence).

## Calibration Edge Cases

<!-- provenance: OPERATIONAL -->
- **GOES primary/secondary switching**: Source reliability scores differ; satellite field tracked in evidence bundles
- **Flare reclassification**: In-progress flares carry high doubt_price (0.55+); only complete/DONKI-confirmed events resolve theatres
- **Kp preliminary vs definitive**: SWPC Kp is provisional for ~30 days; GFZ definitive Kp is ground truth. Settlement requires either GFZ or 6h-aged SWPC
- **Eclipse season**: GOES data gaps during spring/fall equinox periods; null flux handled as quality degradation, not evidence
- **CME arrival uncertainty**: WSA-Enlil sigma ~10-18h depending on CME type; glancing blows get 1.5× wider sigma

## Quick Start

<!-- provenance: OPERATIONAL -->

```bash
# Run tests
node --test tests/corona_test.js

# Poll SWPC feeds (standalone)
node src/oracles/swpc.js

# Poll DONKI (requires NASA_API_KEY env var, or uses DEMO_KEY)
NASA_API_KEY=your_key node src/oracles/donki.js

# Programmatic usage
import { CoronaConstruct } from './src/index.js';
const corona = new CoronaConstruct();

// Open a flare gate
corona.openFlareClassGate({
  threshold_class: 'M1.0',
  window_hours: 24,
  base_rate: 0.15,
});

// Start polling
corona.start();
```

<!-- ground-truth-meta
generator: manual
generated_at: 2026-03-18T00:00:00Z
-->
