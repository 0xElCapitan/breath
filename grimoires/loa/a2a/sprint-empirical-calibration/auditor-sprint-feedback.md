# Sprint 3 — Empirical Calibration: Security & Quality Audit

**Auditor**: Paranoid Cypherpunk Auditor
**Date**: 2026-04-09
**Verdict**: APPROVED - LETS FUCKING GO

---

## Prerequisites

| Check | Status |
|-------|--------|
| Sprint directory exists | PASS |
| Implementation report (`reviewer.md`) present | PASS |
| Engineer feedback present | CONDITIONAL — see PROC-1 below |
| Test suite: 146 pass, 0 fail | PASS |

### PROC-1: Engineer Feedback Procedural Gap (INFORMATIONAL)

`engineer-feedback.md` contains "CHANGES REQUESTED" with a conditional approval: "After this fix, the sprint is approved." The CRIT-1 fix (aqi_history values in the AQI=110 test) has been verified as correctly applied in code — the test now produces trend=25 and exercises the `latestAqi >= 100` guard as intended. However, the feedback file was never updated to contain the literal "All good" string. This is a process hygiene gap, not a technical blocker. The conditional approval's requirement has been met.

---

## Security Checklist

### 1. No Hardcoded Secrets — PASS

API key handling in `src/oracles/purpleair.js` and `src/oracles/epa-airnow.js` uses `process.env` and config-passed values. No Sprint 3 changes touch oracle files. No new secrets, tokens, or credentials introduced. All API key references in `src/index.js` (lines 336-365) are pre-existing config/env patterns, untouched by this sprint.

### 2. No Injection Vulnerabilities — PASS

Sprint 3 changes are value adjustments and annotations only. No user input flows were introduced. No string interpolation into queries or commands. The `threshold_aqi` value (151) is used only in numeric comparisons and template literal log strings (safe).

### 3. Input Validation — PASS

**`computeChannelConsistency` (quality.js:37-53)**:
- `null` inputs: handled by line 38, returns 0.0
- `NaN` / `Infinity`: handled by `isFinite()` check, returns 0.0
- Negative values: fall through to `avg < 5.0` guard, return 1.0 — benign because PurpleAir sensors cannot report negative PM2.5. No division-by-zero risk since the ratio branch only executes when avg >= 5.0.
- Zero / zero: avg = 0.0, caught by `avg < 5.0`, returns 1.0 — safe.

**`_checkAutoSpawn` AQI floor (index.js:732-734)**:
- `latestAqi == null` guard at line 727 prevents null/undefined from reaching the floor check.
- Guard placement verified: AFTER `getNextThreshold` null check (line 730), BEFORE `hasOpenT1` check (line 738). Correct per sprint plan.
- Integer comparison `>= 100` on AQI values — no floating-point ambiguity since AQI values are integers by construction (`calculateAQI` returns integers).

### 4. Numerical Safety — PASS

**Prior distribution `[0.40, 0.25, 0.15, 0.12, 0.08]`**:
- Sum verified: exactly 1.0 in JavaScript IEEE-754 (no floating-point accumulation error for these specific values: 0.40+0.25=0.65, 0.65+0.15=0.80, 0.80+0.12=0.92, 0.92+0.08=1.0).
- All values > 0 — no zero-probability buckets that would cause issues in `updateBucketProbabilities`.
- `updateBucketProbabilities` (wildfire-cascade.js:50-56) divides by `total` after adding 0.15 — `total` cannot be zero because all initial probabilities are > 0 and the update adds 0.15.

**Sigma computation (uncertainty.js:136)**:
- `sigma = 5 + doubt_price * 55` — with doubt_price in [0, 0.95], sigma ranges [5, 57.25]. Never zero. Division by sigma in `thresholdCrossingProbability` is safe.

**Near-zero guard threshold (quality.js:46)**:
- `avg < 5.0` — strict less-than means avg=5.0 engages the ratio check. This is correct per the sprint plan and Barkjohn methodology. The boundary test (A=3, B=7, avg=5.0) verifies this.

### 5. Hard Constraints Compliance — PASS

| Constraint | Verified |
|-----------|----------|
| No refactors | PASS — all changes are value adjustments or annotations |
| No new dependencies | PASS — no new imports |
| No public API changes | PASS — no function signatures changed |
| No bucket-boundary changes | PASS — `WILDFIRE_BUCKETS` array untouched |
| No sigma-value changes | PASS — sigma formula unchanged |
| No update-step changes | PASS — `+0.15` in `updateBucketProbabilities` unchanged |
| No AirNow ingestion changes | PASS — `epa-airnow.js` not modified |
| No certificate changes | PASS — `certificates.js` not modified |
| Files outside allowed list | PASS — only allowed files + test file modified |

Modified files (verified via `git diff --name-only HEAD`):
- `src/processor/quality.js` — allowed
- `src/processor/uncertainty.js` — allowed
- `src/index.js` — allowed
- `src/theatres/wildfire-cascade.js` — allowed
- `test/breath.test.js` — test file (implicitly allowed)
- `README.md` — allowed
- `BUTTERFREEZONE.md` — allowed
- `grimoires/loa/analytics/permission-requests.jsonl` — Loa framework analytics, not application code

### 6. Test Coverage — PASS

**9 new tests verified**:

| Test | Exercises Correct Code Path | Verified |
|------|---------------------------|----------|
| avg 3 µg/m³ returns 1.0 | `avg < 5.0` guard | PASS — avg(2,4)=3 < 5.0 |
| avg 5.0 µg/m³ engages ratio | Bypasses guard, hits ratio branch | PASS — avg(3,7)=5.0, not < 5.0 |
| avg 4.9 µg/m³ returns 1.0 | Boundary test for guard | PASS — avg(2.4,7.4)=4.9 < 5.0 |
| AQI=110 does not spawn | `latestAqi >= 100` guard | PASS — trend=25 (>=20), latestAqi=110 (>=100) |
| AQI=80 does spawn | Passes all guards | PASS — trend=25 (>=20), latestAqi=80 (<100) |
| default threshold_aqi is 151 | Constructor default | PASS |
| threshold is 151, not 150 or 200 | Negative regression guard | PASS |
| default prior matches expected | Both locations checked | PASS — theatre field + position_history[0] |
| prior sums to 1.0 | Numerical correctness | PASS — tolerance 1e-10 |

**CRIT-1 fix verification (the reviewer's critical finding)**:
- Original aqi_history `[110, 100, 95, 85]` produced trend=15, failing at `trend < 20` — never reaching the AQI floor guard.
- Fixed aqi_history `[110, 105, 85, 80]` produces trend=25 (old avg 82.5, new avg 107.5) — correctly passes the trend check and exercises the `latestAqi >= 100` guard.
- Hand-traced through `getAqiTrend` algorithm (index.js:265-282): reverse, split at midpoint, compare half-averages. Math confirmed.

### 7. Annotation Accuracy — PASS

| Annotation | Citation | Verified |
|-----------|---------|----------|
| Barkjohn et al. 2021 (AMT 14:4617) | 5 µg/m³ near-zero floor | Real paper, correct journal/volume |
| Barkjohn et al. 2022 (PMC9784900) | 0.7 EPA QC threshold | Real PMC ID, correct context |
| Camp Fire PurpleAir study (PMC7374346) | Wildfire threshold evidence | Real PMC ID |
| TBD labels on engineering estimates | quality weights, density norm, cross-validation tolerance, doubt prices, sigma model, trend threshold, AQI floor, prior weights | All honestly flagged |

---

## Documentation Audit

### README.md — PASS

- Transport lag distinguishes local/regional (2-12h) vs long-range (12-72+h): verified at line 118.
- T3 window guidance covers 72h (short/snapshot) and 72-168h (fire sieges): verified.
- Settlement trust policy: preliminary status stated, AQS identified as final system, product trust-policy framing explicit: verified at lines 122-124.

### BUTTERFREEZONE.md — PASS

- Auto-spawn capability line updated to reflect AQI < 100 floor: verified at line 58.
- Note: line reference still says `src/index.js:430` while `_checkAutoSpawn` is at line 717. This was flagged by the reviewer as CONCERN-1 (not a sprint 3 deliverable — the sprint plan only required updating the capability text, not the line reference).

---

## Adversarial Notes

### NOTE-1: Prior + Update Step Interaction (INFORMATIONAL, not blocking)

The reviewer correctly identified this. The skewed prior `[0.40, 0.25, 0.15, 0.12, 0.08]` combined with the unchanged `+0.15` update step (designed for uniform priors) could amplify bucket 0 to ~0.55 after one low-exceedance observation. The sprint explicitly says "do not change the +0.15 update rule," so this is out of scope. Post-sprint analysis is warranted.

### NOTE-2: AQI Floor Boundary Oscillation (INFORMATIONAL, not blocking)

Sensors oscillating around AQI 99-101 will see auto-spawn trigger at 99 but not at 101. No hysteresis mechanism exists. Sprint plan acknowledges this needs replay calibration. Not a security issue — worst case is a missed spawn (false negative), not a dangerous action.

### NOTE-3: BUTTERFREEZONE Line Reference Drift (LOW)

`BUTTERFREEZONE.md:58` references `src/index.js:430` but the actual function is at line 717. This is cosmetic drift in a documentation file, not a functional issue. Flagged for future cleanup.

---

## Verdict

All security checks pass. All 146 tests pass. All hard constraints respected. All value changes are cite-backed or honestly marked as provisional. Test coverage exercises the actual code paths (including the fixed CRIT-1). No secrets, no injection vectors, no numerical hazards.

**APPROVED - LETS FUCKING GO**
