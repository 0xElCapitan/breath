# Project Description (from /plan)
> Auto-generated from user's initial project description and reference documents.

## Project: BREATH — Air Quality Intelligence Construct

Building the third construct in the TREMOR/CORONA lineage for the Echelon prediction market framework.

**Domain**: Ambient air quality intelligence
**Construct archetype**: Spy (information specialist — early signal, cross-source pattern detection)
**Framework**: Loa Constructs / Echelon Theatre engine
**Stack**: Node.js 20+, zero external dependencies (matching TREMOR/CORONA pattern)

## Core Vision

A two-phase build:

### Phase 1 — PurpleAir MVP
Prove the construct pattern on PurpleAir's sensor network specifically:
- 30,000+ sensors globally, public API, real-time PM2.5 data
- Natural AQI thresholds (EPA breakpoints) for crisp Theatre resolution
- Dense enough in urban areas for sensor-to-sensor corroboration
- Known, well-documented API with points-based billing model

Theatre templates built around PurpleAir's native strengths:
- AQI Threshold Gate: Will AQI exceed 150 (Unhealthy) at sensor cluster X within 24h?
- Sensor Divergence: Will AQI divergence between sensors A and B exceed 50 for >4h?
- Wildfire Cascade: Following fire alert, how many sensors in region Y exceed AQI 200 within 72h?

### Phase 2 — Meta-Construct (the Uniswap moment)
Extract generalizable patterns into a factory construct:
- Feed grammar classifier (5 questions: cadence, value distribution, noise profile, sensor density, threshold structure)
- Theatre template selector based on feed classification
- Composition layer for multi-feed Theatres (air + wind + fire → smoke plume prediction)
- Economic usefulness filter (measurable ≠ worth betting on)

## Data Source Trust Hierarchy (full BREATH architecture)

1. **Settlement authority**: EPA AirNow (real-time NowCast AQI, preliminary) / EPA AQS (regulatory, delayed)
2. **Corroboration source**: OpenAQ v3 (requires API key, global government monitors)
3. **Early-warning source**: PurpleAir (community sensors, dual-laser A/B self-consistency)
4. **Recruitable source**: ThingSpeak public channels (hobbyist IoT, no auth)

## Key Differentiator

Sensor recruitment mechanic: BREATH creates incentive for sensor operators to publish data publicly in exchange for being oracle anchors for Theatres. This turns BREATH from a passive data consumer into an active oracle network builder.

## Reference Implementations

- TREMOR: `grimoires/pub/TREMOR docs/` — seismic construct (full source)
- CORONA: `grimoires/pub/Corona docs/` — space weather construct (full source)
- Design conversation: `grimoires/pub/ALPHA PROMPT.md`

## Key Design Decisions Already Made (from Opus 4.6 review)

1. **Resolution authority**: Crisp per-Theatre — which exact endpoint/field resolves, fallback hierarchy
2. **Time semantics**: Preserve observation time, publication time, ingest time, averaging basis per record
3. **Source tier model**: Each source explicitly modeled as settlement/corroboration/early-warning/recruitable
4. **Adversarial model**: Location spoofing, value manipulation, replayed data, Sybil sensors — must be addressed
5. **AQI computation module**: EPA breakpoint tables, NowCast algorithm, category mapping — explicit, tested
6. **Trust promotion ladder**: State machine for sensor promotion (onboarding → probation → corroborated → trusted-anchor → degraded/suspended)

## Open Questions (flagged for PRD)

- Sensor recruitment incentive economics (depends on Echelon's on-chain settlement mechanics)
- Historical backfill/replay mode (deferred to v0.2 — TREMOR/CORONA don't have it either)
- Whether to support OpenAQ's non-US government monitors in MVP or defer to Phase 2
