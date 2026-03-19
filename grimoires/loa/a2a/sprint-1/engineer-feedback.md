# Sprint 1 Review — CHANGES REQUIRED

**Reviewer**: Senior Technical Lead
**Date**: 2026-03-19
**Sprint**: sprint-1 (Processor Core)
**Test result as reported**: 60 pass / 0 fail / 12 suites

---

## Critical Issues (must fix before proceeding)

### 1. `settlement.js` line 112 — market_freeze evidence_class is wrong

**File**: `src/processor/settlement.js:112`

**Bug**: The market_freeze branch returns `evidence_class: 'provisional'` instead of `'market_freeze'`.

```js
// Current (WRONG):
return {
  evidence_class: 'provisional',        // ← BUG
  resolution_eligible: false,
  ineligible_reason: 'Market freeze: insufficient quality near Theatre expiry',
  recommended_state: 'market_freeze',
  brier_discount: 0.20,
};
```

**Expected**: `evidence_class: 'market_freeze'`

**Why this matters**: Evidence class is the field that downstream Theatre modules, RLMF certificate export, and the Brier scoring pipeline consume to determine settlement tier. A `provisional` evidence_class carries no Brier discount (0%) and no settlement signal. The market_freeze discount (20%) is set correctly in `brier_discount`, but the evidence_class mismatch means any code that branches on `evidence_class === 'market_freeze'` — which the Theatre templates in Sprint 3 will — will silently treat a market_freeze bundle as a standard provisional. Sprint 1 states are the contract that Sprint 3 Theatres build against. This must be corrected now.

The sprint plan Task 1.5 is explicit: "Market freeze → `market_freeze`, discount 20%", where `market_freeze` is the evidence_class, not just the recommended_state.

**Required fix**: Change `evidence_class: 'provisional'` to `evidence_class: 'market_freeze'` in the market_freeze return block.

---

### 2. `test/breath.test.js` — market_freeze evidence_class is untested

**File**: `test/breath.test.js`

**Bug**: The settlement test suite has 5 tests but none of them cover the market_freeze case. Because market_freeze returns the wrong evidence_class (Issue #1), this test gap allowed the bug to pass silently.

**Required fix**: Add a test that exercises the market_freeze path and asserts `evidence_class === 'market_freeze'`:

```js
it('expiring Theatre with low quality → market_freeze evidence class, discount 0.20', () => {
  const sensor = makeSensor({ state: 'active' });
  const lowQ = { ...goodQuality(), score: 0.40, cross_validated: false };
  const soonExpiry = Date.now() + 60 * 60 * 1000; // 1h from now (< 2h window)
  const result = assessSettlement(sensor, lowQ, null, false, soonExpiry);
  assert.equal(result.evidence_class, 'market_freeze');
  assert.equal(result.resolution_eligible, false);
  assert.equal(result.brier_discount, 0.20);
});
```

This test will currently fail (due to Issue #1), confirming the bug is real.

---

## Non-Critical Issues (fix before sprint-3 or ship)

### 3. `test/breath.test.js` line 15 — suite count comment is stale

**File**: `test/breath.test.js:15`

The comment at the top of the file says `Total Sprint 1: 45 tests / 9 suites`. The actual delivery is 60 tests across 12 suites (the suite breakdown table in the reviewer.md confirms 12). This comment was not updated after suites were split. No functional impact, but the comment is wrong and will confuse future reviewers doing a count.

**Required fix**: Update the comment to `Total Sprint 1: 60 tests / 12 suites`.

---

## What Is Correct (explicit confirmation)

The following were verified against EPA spec, SDD, and sprint plan. All pass:

**AQI Module**
- BREAKPOINTS table matches SDD (which references the EPA Technical Assistance Document). All 6 pollutant tables verified.
- `calculateAQI` uses `Math.trunc()` — confirmed. Boundary tests cover all 8 PM2.5 breakpoints explicitly.
- `computeNowCast` validity gate: ≥2 valid readings in indices 0–2 only — correct. Cmin/Cmax computed over ALL valid readings in 12-hour window — correct. Weight w = max(0.5, Cmin/Cmax) — correct. Weighted sum formula is correct.
- `getDominantPollutant` alphabetical tiebreak is correct (localeCompare, ascending).
- Edge cases (out-of-range → null, negative → null) handled correctly.

**Quality Module**
- `computeChannelConsistency`: null → 0.0, avg < 2 → 1.0, linear decay to 0 at divergenceRatio ≥ 0.7 — correct.
- Weights sum correctly: 0.35 + 0.30 + 0.20 + 0.15 = 1.0.
- Cross-validation bonus: multiplicative ×1.2 (20% of composite), capped at 1.0 — matches SDD.
- Cross-validation condition: agrees within 30% OR within 15 AQI (whichever is larger) — correct. `Math.max(AQI * 0.3, 15)` implements "whichever is larger" correctly.
- `computeAirNowQuality`: score 1.0, cross_validated true — correct.

**Uncertainty Module**
- Base doubt_price tiers: inconsistent→0.80, divergent→0.45, consistent→0.30 — correct.
- Freshness penalties are additive (+0.30, +0.15) — correct.
- Cross-validation discount: −0.15 — correct.
- Threshold sensitivity multiplier ×1.3 applied AFTER additions/subtractions — correct.
- doubt_price capped at 0.95 (the SDD specifies 0.95, not 1.0 — implementation matches SDD).
- `normalCDF`: A&S approximation, x > 0 → 1-p, x ≤ 0 → p — correct direction.
- `thresholdCrossingProbability`: sigma = 5 + doubt_price × 55, P = normalCDF(-z) — formula is correct.

**Settlement Module**
- Priority order enforced: dropout (1) > inconsistency (2) > degraded (3) > provisional_mature (4) > market_freeze (5) > default (6) — code order is correct.
- `provisional_mature` conditions: crossValidated AND nearbySensorsCount >= 3 AND ageHours > 2 AND quality.score >= 0.7 — all four conditions present and correct.
- `assessAirNowSettlement`: always ground_truth, eligible, 0 discount — correct.
- Issue #1 above is the only defect in this module.

**Bundles Module**
- PurpleAir: data_tier 'early_warning', averaging_basis 'instantaneous' — correct.
- AirNow: data_tier 'settlement_authority', evidence_class 'ground_truth' (hardcoded, not from settlementResult) — correct.
- All four time fields present in both bundle types — correct.
- AirNow attribution string exact match: `'U.S. EPA AirNow (preliminary data — not for regulatory use)'` — confirmed.
- PurpleAir cross_validation: non-null object when cross_validated, null when not — correct.
- AirNow cross_validation: always null — correct.
- `matchTheatres` and `matchAirNowObservation`: filter to open/provisional_hold only, resolved skipped — correct.
- Bbox intersection logic (minLon ≤ lon ≤ maxLon, minLat ≤ lat ≤ maxLat) — correct.

**Tests**
- All 8 PM2.5 boundary values tested explicitly (not generated) — confirmed.
- NowCast tests cover all-null, <2 valid in last 3h, weight floor — confirmed.
- Settlement priority: dropout over inconsistency confirmed. Inconsistency over degraded is implicitly covered (inconsistentQuality has both consistency < 0.4 AND score < 0.3 — channel_inconsistent wins as expected by code order).
- Bundle theatre matching: inside bbox, outside bbox, resolved theatres filtered — all three covered.
- Uses `node:test` natively — confirmed.
- No imports from non-existent files — confirmed.

---

## NowCast Mental Trace (Step 4)

Input: `[null, null, null, 10, 20, 15, 12, 8, 25, 18, 22, 16]` (indices 0-2 are null, 3-11 have values).

Step 1: `hourlyReadings.slice(0, 3)` = `[null, null, null]`. Filter non-null → length 0. `recentValid < 2` → returns `null`.

Correct. The implementation handles this case exactly as the spec requires.

---

## Settlement Priority Mental Trace (Step 4)

Input: sensor with `consistency = 0.15 (< 0.4)` AND `quality.score = 0.20 (< 0.3)`.

- Check 1 (sensor_dropout): state = 'active' → skip.
- Check 2 (channel_inconsistent): `quality.components.consistency (0.15) < 0.4` → TRUE → returns `channel_inconsistent`, discount 0.20.

Does not reach Check 3 (degraded). Priority is correct: channel_inconsistent (priority 2) beats degraded (priority 3).

---

## Summary

One true correctness bug found (Issue #1, settlement.js market_freeze evidence_class), with a corresponding test gap (Issue #2) that prevented detection. The fix is two lines. All other modules — AQI math, quality weights, uncertainty pricing, bundle construction, theatre matching — are implemented correctly against the SDD and EPA spec.

The bug in Issue #1 must be fixed and Issue #2's test added before Sprint 2 begins. Sprint 3 Theatre templates will depend on `evidence_class === 'market_freeze'` for correct settlement routing, and the bug would only manifest at that stage — which is exactly when it's most expensive to fix.

---

## Resolution (2026-03-19)

All three issues addressed:

1. **`settlement.js:111`** — `evidence_class: 'provisional'` → `'market_freeze'` ✔
2. **`test/breath.test.js`** — market_freeze test added (asserts evidence_class, recommended_state, resolution_eligible, brier_discount) ✔
3. **`test/breath.test.js:15`** — comment updated to `61 tests / 12 suites` ✔

**Final test run**: 61 pass / 0 fail / 12 suites ✔
