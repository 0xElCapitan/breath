<!-- AGENT-CONTEXT
name: tremor
type: construct
purpose: Seismic intelligence construct for the Echelon prediction market framework. Ingests USGS/EMSC/IRIS real-time earthquake feeds, builds evidence bundles, runs binary and multi-class prediction markets (Theatres), and exports Brier-scored RLMF training data.
key_files: [src/index.js, src/processor/bundles.js, src/oracles/usgs.js, spec/construct.json, src/skills/seismic.md]
interfaces:
  core: [TremorConstruct, pollAndIngest, buildBundle, exportCertificate]
  theatres: [magnitude_gate, aftershock_cascade, swarm_watch, depth_regime, oracle_divergence]
  oracles: [usgs, emsc]
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
capability_requirements:
  - network: read (scope: usgs.gov, seismicportal.eu, iris.edu)
  - filesystem: write (scope: state)
version: v0.1.0
installation_mode: standalone
trust_level: L1-local
-->

# tremor

<!-- provenance: OPERATIONAL -->
TREMOR (Threshold Resolution & Earth Movement Oracle) is a seismic intelligence construct for the Echelon prediction market framework. It converts real-time earthquake data from three public OSINT sources into structured evidence bundles, manages five Theatre types for binary and multi-class prediction markets, and exports Brier-scored RLMF training certificates with full position history and temporal analysis.

## Key Capabilities
<!-- provenance: CODE-FACTUAL -->

- **pollAndIngest** — Polls USGS real-time GeoJSON feeds, deduplicates against seen events, and builds evidence bundles for all new/updated features. (`src/oracles/usgs.js:83`)
- **buildBundle** — Core ingestion pipeline: composes quality scoring, magnitude uncertainty, settlement assessment, and theatre matching into a single evidence bundle. (`src/processor/bundles.js:16`)
- **computeQuality** — Quality scoring with regional station density normalization across 8 network profiles. Normalizes gap, RMS, and station count against region-specific baselines. (`src/processor/quality.js:37`)
- **buildMagnitudeUncertainty** — Doubt pricing engine: converts raw USGS magnitude data into a 0-1 doubt price from magType, station count, network density, and review status. (`src/processor/magnitude.js:51`)
- **thresholdCrossingProbability** — Normal CDF approximation for probability that true magnitude exceeds a Theatre threshold given the uncertainty model. (`src/processor/magnitude.js:92`)
- **assessStatusFlip** — Three-tier settlement logic handling USGS review latency: oracle (reviewed), provisional mature (stable + cross-validated), and market freeze. (`src/processor/settlement.js:30`)
- **crossValidateEMSC** — Queries EMSC for independent magnitude readings. Divergence ≥0.3 triggers Paradox Engine flag. (`src/oracles/emsc.js:16`)
- **processMagnitudeGate** — Updates Magnitude Gate Theatre positions using doubt-priced threshold crossing probabilities. (`src/theatres/mag-gate.js:56`)
- **processAftershockCascade** — Bayesian update blending Omori-law prior with observed aftershock rate to recompute 5-bucket probabilities. (`src/theatres/aftershock.js:151`)
- **processSwarmWatch** — Recomputes rolling Gutenberg-Richter b-value and escalation signal on each new cluster event. (`src/theatres/swarm.js:150`)
- **processDepthRegime** — Updates P(shallow) from precursory event depth trend blended with zone-specific historical prior. (`src/theatres/depth.js:150`)
- **resolveOracleDivergence** — Settles meta-market by comparing automatic vs reviewed magnitude for the same event. (`src/theatres/paradox.js:57`)
- **exportCertificate** — Exports RLMF training certificate with Brier score, position history, volatility, directional accuracy, and time-weighted Brier. (`src/rlmf/certificates.js:58`)
- **computeBValue** — Aki (1965) maximum likelihood b-value estimator with Shi & Bolt binning correction. (`src/theatres/swarm.js:14`)
- **TremorConstruct** — Top-level construct class managing polling loop, theatre lifecycle, auto-spawn logic, and certificate export. (`src/index.js:20`)

## Architecture
<!-- provenance: DERIVED -->
TREMOR follows a pipeline architecture: OSINT oracles feed raw data through a processor layer (quality scoring → magnitude uncertainty → settlement assessment → bundle construction), which routes evidence bundles to matched Theatres. Theatres maintain position histories and resolve to RLMF certificates. The construct entrypoint orchestrates the polling loop and theatre lifecycle.

```
                    ┌─────────────┐
                    │  USGS Feed  │
                    │  (60s poll) │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐     ┌──────────┐
                    │   Oracles   │◄────│   EMSC   │
                    │  usgs.js    │     │  (x-val) │
                    └──────┬──────┘     └──────────┘
                           │
              ┌────────────▼────────────┐
              │       Processor         │
              │  quality → magnitude    │
              │  → settlement → bundle  │
              └────────────┬────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
    ┌────▼────┐     ┌──────▼──────┐    ┌─────▼─────┐
    │ Mag Gate│     │  Aftershock │    │  Swarm    │ ...
    │  (T1)   │     │  Cascade(T2)│    │  Watch(T3)│
    └────┬────┘     └──────┬──────┘    └─────┬─────┘
         │                 │                 │
         └─────────────────┼─────────────────┘
                           │
                    ┌──────▼──────┐
                    │    RLMF     │
                    │ Certificates│
                    └─────────────┘
```

Directory structure:
```
./src
./src/index.js
./src/oracles
./src/oracles/usgs.js
./src/oracles/emsc.js
./src/processor
./src/processor/bundles.js
./src/processor/quality.js
./src/processor/magnitude.js
./src/processor/settlement.js
./src/processor/regions.js
./src/skills
./src/skills/seismic.md
./src/theatres
./src/theatres/mag-gate.js
./src/theatres/aftershock.js
./src/theatres/swarm.js
./src/theatres/depth.js
./src/theatres/paradox.js
./src/rlmf
./src/rlmf/certificates.js
./spec
./spec/construct.json
./test
./test/tremor.test.js
```

## Interfaces
<!-- provenance: CODE-FACTUAL -->

### Construct API

| Export | Type | Description |
|--------|------|-------------|
| `TremorConstruct` | Class | Main construct. `.start()`, `.stop()`, `.poll()`, `.getState()`, `.getCertificates()` |
| `pollAndIngest` | Function | One-shot poll of USGS feed |
| `buildBundle` | Function | Single feature → evidence bundle |
| `computeQuality` | Function | Feature → quality score with density normalization |
| `buildMagnitudeUncertainty` | Function | Feature → doubt-priced uncertainty model |
| `thresholdCrossingProbability` | Function | Uncertainty + threshold → crossing probability |
| `assessStatusFlip` | Function | Feature + quality → settlement assessment |
| `exportCertificate` | Function | Resolved theatre → RLMF certificate |

### Theatre Templates

| Template | ID | Resolution | Timeframe | Auto-spawn |
|----------|----|------------|-----------|------------|
| Magnitude Gate | `magnitude_gate` | Binary | 4h–72h | Manual |
| Aftershock Cascade | `aftershock_cascade` | 5 buckets | 72h | On M≥6.0 |
| Swarm Watch | `swarm_watch` | Binary | 7 days | On cluster detection |
| Depth Regime | `depth_regime` | Binary | Up to 14 days | Manual |
| Oracle Divergence | `oracle_divergence` | Binary | 1h–48h | On M≥4.5 automatic |

### OSINT Feeds

| Source | Endpoint | Format | Auth |
|--------|----------|--------|------|
| USGS NEIC | `earthquake.usgs.gov/earthquakes/feed/v1.0/summary/*.geojson` | GeoJSON | None |
| USGS API | `earthquake.usgs.gov/fdsnws/event/1/query` | GeoJSON | None |
| EMSC | `seismicportal.eu/fdsnws/event/1/query` | JSON | None |

## Module Map
<!-- provenance: DERIVED -->

| Module | Files | Purpose |
|--------|-------|---------|
| `src/oracles/` | 2 | OSINT data source adapters (USGS polling, EMSC cross-validation) |
| `src/processor/` | 5 | Evidence bundle construction pipeline (quality, magnitude, settlement, regions, bundle orchestration) |
| `src/theatres/` | 5 | Theatre-specific market logic (magnitude gate, aftershock cascade, swarm watch, depth regime, oracle divergence) |
| `src/rlmf/` | 1 | RLMF training data export (Brier scoring, temporal analysis, certificate generation) |
| `src/skills/` | 1 | Construct specialization profile |
| `spec/` | 1 | Machine-readable construct specification |
| `test/` | 1 | Test suite (48 tests, 16 suites, node:test) |

## Verification
<!-- provenance: CODE-FACTUAL -->

- Trust Level: **L1 — Local**
- 48 tests across 16 suites (node --test, zero dependencies)
- Zero external dependencies (Node.js 20+ built-in fetch + test runner)
- All OSINT sources are public, free, and require no authentication

## Culture
<!-- provenance: OPERATIONAL -->

**Naming**: TREMOR — Threshold Resolution & Earth Movement Oracle. Construct names in the Echelon framework describe function, not aspiration.

**Principles**: Ground truth first — every market resolves to a number that is what it is. Accountability over accuracy — on-chain P&L makes every prediction auditable. The token is not the product — the calibrated training data is.

**Domain metaphor**: Seismic intelligence as the ideal OSINT substrate. Machine-readable, always-on, ground-truth verifiable within minutes, and structurally binary. The Earth generates training data whether anyone is watching or not.

## Quick Start
<!-- provenance: OPERATIONAL -->

```bash
# No install needed — zero dependencies, Node.js 20+ only
node --test test/tremor.test.js        # Run tests
node src/oracles/usgs.js m4.5_day      # Standalone USGS poll
```

```js
import { TremorConstruct } from './src/index.js';

const tremor = new TremorConstruct();
tremor.openMagnitudeGate({
  region_name: 'Cascadia',
  region_bbox: [-130, 40, -120, 50],
  magnitude_threshold: 5.0,
  window_hours: 24,
  base_rate: 0.12,
});
tremor.start();
```

<!-- ground-truth-meta
head_sha: initial
generated_at: 2026-03-18T00:00:00Z
generator: manual
sections:
  agent_context: tremor-v0.1.0
  capabilities: 15-entries-code-factual
  architecture: pipeline-oracle-processor-theatre-rlmf
  interfaces: construct-api-theatre-templates-osint-feeds
  module_map: 7-modules
  verification: 48-tests-16-suites
  culture: echelon-ground-truth-first
  quick_start: zero-deps-node20
-->
