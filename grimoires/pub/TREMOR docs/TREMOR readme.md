# TREMOR

**Threshold Resolution & Earth Movement Oracle**

A seismic intelligence construct for the [Echelon](https://github.com/AITOBIAS04/Echelon) prediction market framework, built on constructs by [Soju](https://github.com/0xHoneyJar/loa). Ridden by [Loa](https://github.com/0xHoneyJar/loa).

## What it does

TREMOR ingests real-time earthquake data from USGS, EMSC, and IRIS, converts it into structured evidence bundles, runs prediction markets (Theatres) on seismic outcomes, and exports Brier-scored training data for the RLMF pipeline.

The prediction market is the factory. The calibrated training data is the product.

## Why seismic

Earthquakes are uniquely good training data for AI prediction markets:

- **Ground truth oracle** — USGS reviewed catalog. No human interpretation, no disputes.
- **Binary structure** — did the threshold get crossed or not? Clean Brier targets.
- **Fast cycles** — hours to days, not weeks. ~55 M5.0+ events per month globally.
- **Exogenous** — no reflexivity. Predictions don't influence earthquakes.
- **Free data** — all sources are public, always-on, machine-readable GeoJSON.

## Quick start

```bash
# Clone
git clone https://github.com/0xElCapitan/tremor.git
cd tremor

# No npm install needed — zero external dependencies
# Requires Node.js 20+

# Run tests
node --test test/tremor.test.js

# Poll USGS feed (standalone)
node src/oracles/usgs.js m4.5_day

# Use as a library
```

```js
import { TremorConstruct } from './src/index.js';

const tremor = new TremorConstruct({
  feedType: 'm4.5_hour',
  pollIntervalMs: 60_000,
});

// Open a prediction market
tremor.openMagnitudeGate({
  region_name: 'Cascadia',
  region_bbox: [-130, 40, -120, 50],
  magnitude_threshold: 5.0,
  window_hours: 24,
  base_rate: 0.12,
});

// Start polling
tremor.start();

// Later: check state
console.log(tremor.getState());

// Get exported RLMF certificates
const certs = tremor.getCertificates();
```

## Architecture

```
tremor/
├── src/
│   ├── index.js              # Construct entrypoint + main loop
│   ├── skills/
│   │   └── seismic.md        # Specialization profile
│   ├── oracles/
│   │   ├── usgs.js           # USGS GeoJSON poller
│   │   └── emsc.js           # EMSC cross-validation
│   ├── theatres/
│   │   ├── mag-gate.js       # Magnitude Gate (binary threshold)
│   │   ├── aftershock.js     # Aftershock Cascade (multi-class Omori)
│   │   ├── swarm.js          # Swarm Watch (b-value escalation)
│   │   ├── depth.js          # Depth Regime (subduction zone)
│   │   └── paradox.js        # Oracle Divergence (Paradox Engine)
│   ├── processor/
│   │   ├── bundles.js        # Evidence bundle construction
│   │   ├── quality.js        # Quality scoring + density normalization
│   │   ├── magnitude.js      # Magnitude uncertainty + doubt pricing
│   │   ├── settlement.js     # 3-tier settlement logic
│   │   └── regions.js        # Regional network profiles
│   └── rlmf/
│       └── certificates.js   # RLMF training data export
├── spec/
│   └── construct.json        # Machine-readable construct spec
├── test/
│   └── tremor.test.js        # Test suite (48 tests, 16 suites)
├── BUTTERFREEZONE.md          # Agent-facing project interface
├── .env.example
├── package.json
└── README.md
```

## Three calibration refinements

### 1. Status flip latency

USGS "reviewed" status can take hours to weeks. TREMOR uses three-tier settlement:

| Tier | Condition | Brier discount |
|------|-----------|----------------|
| Oracle | `status=reviewed` | 0% |
| Provisional mature | Automatic, >2h old, stable, cross-validated, quality>0.5 | 10% |
| Market freeze | Theatre expiring, data insufficient | 20% |

7-day hard expiry for never-reviewed events (25% discount).

### 2. Station density bias

Seismic networks are denser in wealthy regions. TREMOR normalizes quality metrics against 8 regional profiles so a 40° azimuthal gap in Japan (dense) isn't scored the same as 40° in the South Pacific (sparse).

### 3. Magnitude uncertainty

The "doubt price" (0-1) tells the construct how much to discount a magnitude reading for threshold decisions. Computed from magnitude type (Mw vs Ml), station count, network density, and review status.

## Theatre templates

| Template | Question | Resolution | Timeframe |
|----------|----------|------------|-----------|
| Magnitude Gate | Will M≥X occur in region Y within Z hours? | Binary | 4h–72h |
| Aftershock Cascade | How many M≥X aftershocks in 72h? | 5 buckets | 72h |
| Swarm Watch | Will cluster produce M≥X in 7 days? | Binary | 7 days |
| Depth Regime | Shallow or deep? | Binary | Up to 14 days |
| Oracle Divergence | Will reviewed mag differ from auto by ≥0.3? | Binary | 1h–48h |

## Dependencies

Zero. Node.js 20+ only (uses built-in `fetch` and `node:test`).

## License

AGPL-3.0
