# Sprint 3 — Empirical Calibration: Senior Technical Lead Review

**Verdict: CHANGES REQUESTED**

One critical test bug must be fixed before approval. The rest of the implementation is clean and correct.

---

## Critical Issue

### CRIT-1: Auto-spawn AQI floor test does not exercise the AQI floor guard

**File**: `test/breath.test.js:1529-1553`

The test named `_checkAutoSpawn: does not spawn when AQI is 110 with rising trend of 25` has a misleading name and does NOT test the `if (latestAqi >= 100) continue` guard.

**Proof**: The aqi_history is `[110, 100, 95, 85]` (newest-first). In `getAqiTrend`:
- Reversed to oldest-first: `[85, 95, 100, 110]`
- mid = 2
- oldSlice `[85, 95]` avg = 90
- newSlice `[100, 110]` avg = 105
- **trend = 15**, not 25

Since 15 < 20, the sensor is filtered out at `if (trend < 20) continue` on line 724 and never reaches the AQI floor check on line 734. The test passes for the wrong reason.

**Fix**: Change the aqi_history so the computed trend is >= 20 while latestAqi remains >= 100. For example:

```js
aqi_history: [
  { t: now,                aqi: 110 },
  { t: now - 30 * 60_000, aqi: 100 },
  { t: now - 60 * 60_000, aqi: 80  },
  { t: now - 90 * 60_000, aqi: 70  },
],
```

This gives old avg = 75, new avg = 105, trend = 30. The sensor passes the trend check and then hits the AQI floor guard, which is the code path this test is supposed to verify.

This is a **success criterion 7** issue: the test exists and passes, but it does not actually validate the behavior described in the sprint plan.

---

## Non-Critical Concerns

### CONCERN-1: BUTTERFREEZONE line reference is stale

`BUTTERFREEZONE.md:58` references `src/index.js:430` for the auto-spawn capability, but `_checkAutoSpawn` is at line 717. The sprint plan only required updating the capability text (not the line reference), so this is not a sprint 3 deliverable violation. However, it should be noted for future cleanup.

### CONCERN-2: Task 3.2 comment does not use the "below USG" framing

The sprint plan (Task 3.2) specifically says the guard means "only spawn while still below USG" and instructs the comment to convey this. The implemented comment says "absolute floor prevents redundant spawn while already elevated; replay still needed for false-positive rate" -- which is the Task 3.5 annotation wording. This technically complies (it does not describe 100 as the USG lower boundary, which the plan prohibits), but it also lost the "below USG" framing that the plan wanted. The Task 3.5 wording is arguably better because it avoids baking in a specific AQI category interpretation, but this is a reviewer judgment call, not a blocking issue.

### CONCERN-3: `permission-requests.jsonl` appears in the diff

`grimoires/loa/analytics/permission-requests.jsonl` is modified in the working tree. This is a Loa State Zone analytics file, not application code, and is not on the "DO NOT TOUCH" list. However, it is also not on the "ALLOWED FILES" list. Since it was modified by the Loa framework itself (hook-generated analytics) and not by the engineer as part of sprint work, this is acceptable. Just flagging for awareness.

---

## Adversarial Analysis

### Concerns

1. **CRIT-1 above**: The AQI floor test is a false positive -- it passes but does not test what it claims to test. This undermines success criterion 7.

2. **Prior weight sensitivity**: The prior `[0.40, 0.25, 0.15, 0.12, 0.08]` is correctly documented as provisional. However, the `+0.15` update step (which is preserved unchanged per the sprint constraints) was designed for a uniform prior. With the new skewed prior, the first update to a low-exceedance observation will push bucket 0 from 0.40 toward 0.55, potentially creating an even more extreme skew. The interaction between the new prior and the unchanged update step has not been analyzed. This is not a sprint 3 issue (the sprint explicitly says "do not change the +0.15 update rule"), but it should be noted for post-sprint analysis.

3. **AQI floor at 100 is a hard cutoff with no hysteresis**: If a sensor oscillates around AQI 99-101, auto-spawn will trigger at 99 but not at 101, then potentially trigger again when it drops back to 99. The sprint plan acknowledges this needs replay calibration, but the test suite does not cover this boundary oscillation scenario.

### Implicit Assumption

The engineer assumed the aqi_history entries in the AQI=110 test would produce a trend >= 20. The `getAqiTrend` algorithm (average of second half minus average of first half) means trend depends on the distribution of values across the window, not just the difference between the first and last values. The test values `[85, 95, 100, 110]` only produce a trend of 15 because the halves overlap significantly. This should have been caught by hand-tracing the algorithm before writing the test.

### Alternative Approach Not Considered

For the AQI floor (Task 3.2), an alternative to a hard cutoff at AQI 100 would be a probability-weighted spawn gate: as AQI rises toward 100, spawn probability decreases smoothly (e.g., sigmoid). This avoids the cliff-edge behavior at exactly 100. The sprint plan prescribed the hard cutoff, so this is not actionable now, but it would reduce false negatives at the boundary.

---

## What Passed Review

- **Task 3.1**: Near-zero guard raised correctly from 2.0 to 5.0 with accurate Barkjohn citation. Tests are well-structured with boundary coverage (3 avg, 4.9 avg, 5.0 avg).
- **Task 3.2**: Code change is correct (placement, guard logic, value).
- **Task 3.3**: Threshold correctly set to 151 (not 150, not 200). Citation accurate.
- **Task 3.4**: Both bucket_probabilities locations updated, sum verified to 1.0, provisional labeling is honest.
- **Task 3.5**: All annotation wordings match the sprint plan specifications where values were not already changed by 3.1-3.4. TBD labels are honest.
- **Task 3.6**: README transport lag distinguishes local vs long-range, T3 window guidance covers both 72h and 72-168h, settlement trust policy properly softened with AQS reference, BUTTERFREEZONE auto-spawn text is accurate.
- **Hard constraints**: No refactors, no new dependencies, no API changes, no bucket boundary changes, no sigma changes, no update step changes, no files outside the allowed list were modified as application code.
- **Style**: All changes are minimal and surgical, matching existing code style.

---

## Required Action

Fix the aqi_history in the AQI=110 auto-spawn test so that `getAqiTrend` computes a trend >= 20, ensuring the test actually exercises the `if (latestAqi >= 100) continue` guard. Re-run the full suite and confirm 146 pass / 0 fail.

After this fix, the sprint is approved.
