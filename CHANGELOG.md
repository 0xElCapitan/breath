# Changelog

All notable changes to BREATH will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- **B1**: `getAqiTrend` history ordering reversed — auto-spawn now correctly fires on rising AQI
- **B10**: `last_seen` unit mismatch in settlement — `assessSettlement` now converts Unix seconds to ms
- **B4**: NaN propagation via undefined AQI — `thresholdCrossingProbability` returns 0.5 for non-numeric input; `processAqiThresholdGate` guards against missing `category_number`
- **B2**: Zombie theatre on certificate export failure — `_exportCertificate` wrapped in try/catch with error counter
- **B3**: `processedBundleIds` memory leak — replaced unbounded Set with TTL-based Map (5-minute expiry)
- **B6**: No single-flight guard on `poll()` — concurrent polls now skipped with counter
- **B7**: Poll error visibility — added `poll_errors`, `purpleair_errors`, `airnow_errors` stats; stack traces logged
- **B11**: AirNow `obs.AQI` null guard — malformed observations with non-numeric AQI now dropped with warning
- **B5a**: PurpleAir schema validation — `normalizePurpleAirResponse` now drops truncated rows and sensors with missing/non-numeric required fields
- **B5b**: AirNow coordinate validation — observations with non-numeric or infinite `Latitude`/`Longitude` now dropped with warning
- **B8**: T3 directional logic in `computeLeadTime` and `directionalAccuracy` — low-cascade outcomes (bucket 0–1) now correctly use `p < 0.5`
- **B9**: `required_hours` → `required_consecutive_readings` rename in Sensor Divergence — backward-compatible alias preserved; internal field renamed from `consecutive_hours_divergent` to `consecutive_divergent_readings`

### Added
- `certificate_export_errors`, `poll_errors`, `purpleair_errors`, `airnow_errors`, `skipped_polls` stats in `getState()`
- `SECURITY.md` — vulnerability disclosure policy
- `CONTRIBUTING.md` — development setup and contribution guidelines
- `CHANGELOG.md` — this file
- GitHub Actions CI workflow for automated testing
- Settlement trust policy section in README
- Calibration status section in README
- `// TBD: empirical calibration needed` annotations on 10 hardcoded parameters
- 12 regression tests for Sprint 2 fixes (B5a, B5b, B8, B9) — suite now at 128 tests / 32 suites

## [0.1.0] - 2026-03-19

### Added
- Initial release — PurpleAir MVP
- EPA AQI breakpoint tables (PM2.5, PM10, O3, NO2, SO2, CO)
- NowCast algorithm for PM2.5
- PurpleAir oracle with rate limiting and response cache
- EPA AirNow oracle with timezone handling
- T1: AQI Threshold Gate theatre
- T2: Sensor Divergence theatre
- T3: Wildfire Cascade theatre (multi-class)
- RLMF certificate export with Brier scoring
- SensorRegistry with channel consistency, dropout detection, location drift
- BreathConstruct entrypoint with dual-oracle polling
- 104-test suite across 22 suites
