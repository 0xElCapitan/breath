# Sprint 2 Review — APPROVED

All acceptance criteria met. Every checklist item verified against source code. No blocking issues.

---

## Verification Summary

### SensorRegistry (`src/index.js`)

All methods implemented correctly:

- `update()` adds new sensors and updates `last_seen` for existing ones.
- `pm25_history` capped at 12 via `.slice(0, 12)` and dedup-guarded by `sensor.last_seen !== existing.last_seen` (pre-update comparison, line 68).
- Location drift: `latDelta <= 0.001 && lonDelta <= 0.001` sets `location_stable` (strict boundary — drift detected at > 0.001°, not ≥). Matches SDD spec.
- `getDropouts(now, pollIntervalMs)`: threshold = `now - 2 * pollIntervalMs`, compares `record.last_seen * 1000` (PurpleAir Unix seconds converted correctly). Correct.
- `getSensorsInBbox([minLon, minLat, maxLon, maxLat])`: bbox convention correct.
- `updateChannelConsistency()`: rolling `[...history, score].slice(-10)` average. Correct.
- `getAqiTrend()`: `newAvg - oldAvg` — positive when rising, negative when falling, 0 for insufficient data. Correct.
- `hasLocationDrift()`: `> 0.001°` threshold on either axis. Correct.
- `setState()`: spreads and replaces state field. Correct.

### PurpleAir Oracle (`src/oracles/purpleair.js`)

- `normalizePurpleAirResponse()`: zips `fields` with `data` rows; maps `pm2.5` → `pm25_avg`, `pm2.5_a` → `pm25_a`, `pm2.5_b` → `pm25_b`. Correct.
- Indoor filter (`location_type === 0`) applied BEFORE `registry.update()` — indoor sensors never enter registry. Correct.
- Dedup map (`isNewReadingMap`) populated from pre-update registry state BEFORE `registry.update()` call (lines 209–215 before line 219). Race-condition-free.
- NowCast uses `pm25_history.map(h => h.avg)` after registry update. Falls back to raw `pm25_avg` when NowCast returns null (< 12 history entries). Correct.
- `registry.updateChannelConsistency()` called after AQI computed in Phase 2. Correct order.
- `nearby_agreement_count` computed in Phase 3 after all Phase 2 AQIs are set. Correct.
- Dropout Phase 5: `seenThisCycle = new Set(outdoorSensors.map(s => s.sensor_index))` correctly excludes active sensors from dropout candidates.
- Dropout bundles synthesised with `state: 'dropout'`, pass through `assessSettlement()` which returns `evidence_class: 'sensor_dropout'`. Correct.
- HTTP 429 → `advanceBackoff()`, uses cache if available, `continue` (skip bbox) if not. No throw.
- Network error → caught, logged, `continue`. No throw.
- HTTP 401 → `console.error('[BREATH:PurpleAir] CRITICAL: 401...')`. Correct severity.
- `export const POLL_INTERVAL_MS = 120_000` present.

### EPA AirNow Oracle (`src/oracles/epa-airnow.js`)

- `AIRNOW_TZ_OFFSETS` contains all 12 required abbreviations plus AZT.
- `parseAirNowObservationTime()`: trims `DateObserved` via `.trim()`. Correct.
- Timezone formula verified: PST offset = −8. `localMs - (-8) × 3_600_000 = localMs + 28_800_000`. For 14:00 UTC-as-parsed + 8h = 22:00 UTC. Matches test expectation `Date.parse('2026-03-19T22:00:00Z')`. Correct.
- Unknown timezone → `console.warn` + `return null` → caller skips. No throw.
- Network error caught, returns empty. HTTP 401 logged CRITICAL, returns empty. No throw paths.
- `obs._observation_time = times.observation_time` set before `buildAirNowBundle()` call (line 170 before line 176).
- All AirNow bundles: `data_tier: 'settlement_authority'`, `evidence_class: 'ground_truth'` (hardcoded in `buildAirNowBundle`, not derived from quality/settlement pipeline).
- Attribution: `'U.S. EPA AirNow (preliminary data — not for regulatory use)'` — exact string match.

### Processor M1–M5 Fixes

All five confirmed present:
- M1 (`aqi.js` line 182): `if (hourlyReadings.length > 12) return null`
- M2 (`bundles.js` lines 243, 270): `!Array.isArray(t.region_bbox) || t.region_bbox.length < 4`
- M3 (`bundles.js` line 155): `const reportingArea = obs.ReportingArea ?? ''`
- M4 (`aqi.js` lines 185, 226): `typeof v === 'number' && isFinite(v)`
- M5 (`settlement.js` line 88): `Math.max(0, ageHours)`

### Tests (`test/breath.test.js` — Sprint 2 suites)

Five suites present with names matching sprint plan exactly (Suites 13–17). 18 tests total.

- All HTTP via `globalThis.fetch` mock. No live calls.
- `mockFetch()` returns a restore function; all callers invoke `restore()` after assertions.
- Adversarial 1: indoor sensor excluded from bundles AND registry (asserts `registry.sensors.size === 0`).
- Adversarial 2: pm25_a=10, pm25_b=80 → divergenceRatio ≈ 1.56 → consistency score = 0 → `quality.components.consistency < 0.4` → `channel_inconsistent`. Trace confirmed.
- Adversarial 3: frozen sensor `last_seen = 1710000000`, futureNow 5 minutes later → `last_seen * 1000 < futureNow - 2 × 120_000` → detected as dropout. Correct.
- Adversarial 4: Δlat = 0.002° > 0.001° → `location_stable: false`. Correct.
- Rate limit test with cache: test asserts `second !== null` (no-throw), with explanatory comment acknowledging that dedup produces 0 bundles from cached data. Logic is sound — the test correctly validates the no-throw contract.

---

## Non-Blocking Observations

1. **Test count in sprint plan is stale**: Task 2.4 acceptance criteria states "Total test count after Sprint 2: 60 tests / 13 suites (42 from Sprint 1 + 18 from Sprint 2)". Actual count is 79/17. Sprint 1 over-delivered (61 tests / 12 suites vs 42/8 projected). Sprint 2 delivered exactly 18/5 as specified. The discrepancy is in the Sprint 1 projection, not Sprint 2 work. No action needed.

2. **`nearby_agreement_count` approximation**: Implemented as ±0.5° lat/lon + AQI within ±20, noted in reviewer.md as an MVP approximation. Acceptable for Sprint 2; geodesic refinement deferred to Sprint 4.

3. **`aqi_history` not in SDD 2.3 SensorRecord schema**: Added to support `getAqiTrend()`. The schema extension is additive and does not break any SDD contract. Initialised to `[]` for new sensors.

Sprint 3 (Theatre Layer) may proceed.
