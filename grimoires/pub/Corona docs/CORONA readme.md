# CORONA

**Coronal Oracle & Realtime Observation Network Agent**

Space weather intelligence construct for [Echelon](https://github.com/AITOBIAS04/Echelon) prediction market framework, built on constructs by [Soju](https://github.com/zkSoju). Ridden by [Loa](https://github.com/0xHoneyJar/loa). CORONA monitors solar activity through structured prediction markets (Theatres), producing Brier-scored training data for the RLMF pipeline.

## What It Does

CORONA watches the Sun. When solar flares erupt, CMEs launch toward Earth, or geomagnetic storms brew, CORONA opens prediction markets and updates positions as evidence streams in from NOAA and NASA data feeds. Every resolved market exports a calibration certificate — the construct's verifiable track record of forecasting accuracy.

```
  NOAA SWPC ──→ ┌──────────────┐     ┌──────────┐     ┌──────────┐
  (GOES, Kp,    │  Processor   │────→│ Theatres │────→│   RLMF   │
   DSCOVR)      │  Pipeline    │     │  T1-T5   │     │  Certs   │
  NASA DONKI ──→ └──────────────┘     └──────────┘     └──────────┘
  (FLR, CME,       quality              position         Brier
   GST, IPS)       uncertainty          updates          scores
                   settlement
```

## Theatre Templates

| ID | Name | Type | Question |
|----|------|------|----------|
| T1 | Flare Class Gate | Binary | Will a ≥M/X-class flare occur within 24h? |
| T2 | Geomagnetic Storm Gate | Binary | Will Kp reach ≥5 (G1) within 72h? |
| T3 | CME Arrival | Binary | Will CME arrive within predicted window ±6h? |
| T4 | Proton Event Cascade | Multi-bucket | How many R1+ blackouts following X-class trigger? |
| T5 | Solar Wind Divergence | Binary | Will sensor readings diverge beyond threshold? |

## Data Sources

All free, all JSON, minimal auth.

- **NOAA SWPC** (`services.swpc.noaa.gov`) — GOES X-ray flux, planetary Kp, proton flux, DSCOVR solar wind. No auth required.
- **NASA DONKI** (`api.nasa.gov/DONKI`) — Solar flares, CMEs, geomagnetic storms with cause-effect linkages. Free API key (`DEMO_KEY` for development).
- **GFZ Potsdam** — Definitive Kp/Hp index (ground truth for Kp settlement).

## Quick Start

```bash
# Run tests (zero dependencies required)
node --test tests/corona_test.js

# Poll SWPC feeds
node src/oracles/swpc.js

# Programmatic usage
import { CoronaConstruct } from './src/index.js';

const corona = new CoronaConstruct();

// Open markets
corona.openFlareClassGate({
  threshold_class: 'M1.0',
  window_hours: 24,
  base_rate: 0.15,
});

corona.openGeomagneticStormGate({
  kp_threshold: 5,
  window_hours: 72,
  base_rate: 0.10,
});

// Start polling
corona.start();

// Check state
console.log(corona.getState());

// Export certificates after resolution
const certs = corona.getCertificates();
```

## Architecture

Follows TREMOR's established construct pattern:

**Oracle → Processor → Theatre → RLMF**

- **Oracles**: Fetch and normalize external data feeds
- **Processor pipeline**: Quality scoring → Uncertainty pricing → Settlement assessment → Bundle construction
- **Theatres**: Stateful prediction markets with position histories
- **RLMF**: Brier-scored certificate export with temporal analysis

Zero external dependencies. Node.js 20+ built-in test runner.

## Calibration Edge Cases

- **GOES satellite switching**: Primary/secondary reliability scores tracked per bundle
- **Flare reclassification**: In-progress events carry high doubt pricing (0.55+); only complete or DONKI-confirmed events resolve theatres
- **Kp preliminary vs definitive**: SWPC Kp provisional for ~30 days; GFZ definitive is ground truth
- **CME arrival uncertainty**: WSA-Enlil sigma 10-18h depending on halo angle; glancing blows get 1.5× wider sigma
- **Eclipse season**: GOES data gaps handled as quality degradation

## Relationship to TREMOR

CORONA is the second Echelon construct. It follows the same architectural patterns:

| TREMOR | CORONA |
|--------|--------|
| USGS GeoJSON | NOAA SWPC + NASA DONKI |
| Magnitude Gate | Flare Class Gate |
| Aftershock Cascade | Proton Event Cascade |
| Oracle Divergence | Solar Wind Divergence |
| Depth Regime | Geomagnetic Storm Gate |
| Swarm Watch | CME Arrival |

RLMF certificates share the same schema for pipeline compatibility.

## Tests

60 tests, 21 suites, all passing:

```
node --test tests/corona_test.js

# tests 60
# suites 21
# pass 60
# fail 0
```

## License

MIT
