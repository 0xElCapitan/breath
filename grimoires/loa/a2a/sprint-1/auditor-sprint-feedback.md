# Sprint 1 Security Audit

**Auditor**: Paranoid Cypherpunk
**Date**: 2026-03-19
**Sprint**: sprint-1 (Processor Core)
**Verdict**: APPROVED — LETS FUCKING GO

---

## Preamble

Prerequisites confirmed:
- `grimoires/loa/a2a/sprint-1/reviewer.md` — present.
- `grimoires/loa/a2a/sprint-1/engineer-feedback.md` — present, resolution appended 2026-03-19.

Resolution confirmed: Issues #1 (market_freeze evidence_class), #2 (market_freeze test), and #3 (comment stale count) all resolved. Final test run: 61 pass / 0 fail.

The processor core is a pure computation library. No network calls, no file I/O, no auth, no subprocess execution. Attack surface is narrow by construction. The audit focused on numeric safety, input type confusion, DoS from unbounded input sizes, and crash vectors from malformed caller data.

---

## Findings

### CRITICAL (block approval)

None.

---

### HIGH (fix before Sprint 3)

None.

---

### MEDIUM (fix before ship)

#### M1 — `computeNowCast`: unbounded array scan on oversized input
**File**: `src/processor/aqi.js:179,182,186`

`computeNowCast` validates that the array has at least 12 elements (`length < 12`) but places **no upper bound** on array size. Lines 182 and 186 call `.slice(0, 3)` and `.filter(...)` respectively on the full input array. The `.filter()` at line 186 iterates every element. If a caller passes a 10,000-element array (e.g., from an unbounded API response buffer), this performs O(n) work on the full array rather than the expected O(12).

In Sprint 2 the Oracle layer will populate `pm25_history` for NowCast. If the accumulation logic in `SensorRegistry` does not cap the history array at 12 entries before passing to `computeNowCast`, a long-running sensor could accumulate unbounded history and degrade poll cycle performance.

**Recommendation**: Add `if (hourlyReadings.length > 12) return null;` (or clamp to first 12) immediately after the `length < 12` guard at line 179. The spec is explicit: NowCast uses exactly 12 hours of data.

---

#### M2 — `matchTheatres` / `matchAirNowObservation`: unguarded destructuring crash on malformed theatre
**File**: `src/processor/bundles.js:241`, `src/processor/bundles.js:266`

Both functions destructure `t.region_bbox` directly:
```js
const [minLon, minLat, maxLon, maxLat] = t.region_bbox;
```
If `t.region_bbox` is `undefined`, `null`, or a non-iterable, this throws a `TypeError` that propagates unhandled to the Theatre layer. The only guard is the state filter on line 239 (`t.state !== 'open' && ...`), which does not protect against a malformed `region_bbox` on an otherwise-valid open theatre.

Sprint 3 Theatre templates will construct the `region_bbox` field. If a single malformed Theatre enters the active theatres list, every subsequent bundle construction call will crash.

**Recommendation**: Add a guard before destructuring: `if (!Array.isArray(t.region_bbox) || t.region_bbox.length < 4) return false;`

---

#### M3 — `buildAirNowBundle`: unguarded `.trim()` crash on null `ReportingArea`
**File**: `src/processor/bundles.js:154,181,183`

Line 154:
```js
const regionSlug = obs.ReportingArea.trim().replace(...)
```
Line 181: `region_label: obs.ReportingArea.trim()`
Line 183: `sensor_id: obs.ReportingArea.trim()`

If `obs.ReportingArea` is `undefined` or `null` (malformed AirNow API response — the EPA AirNow API does return observations without a ReportingArea in some edge cases), all three accesses throw `TypeError: Cannot read properties of undefined (reading 'trim')`. The AirNow oracle in Sprint 2 should normalize this, but defense-in-depth requires the bundle builder to guard it.

**Recommendation**: Assign `const reportingArea = obs.ReportingArea ?? ''` at the top of `buildAirNowBundle` and use `reportingArea` throughout. An empty string produces bundle_id `breath-airnow--{ts}` which is ugly but not a crash.

---

#### M4 — `isFinite()` coercion accepts numeric strings as valid readings
**File**: `src/processor/aqi.js:182,186,200`, `src/processor/aqi.js:219`

JavaScript's `isFinite()` coerces its argument: `isFinite("25")` returns `true`. This means a caller who passes `hourlyReadings = ["25", "20", null, ...]` will have the string `"25"` treated as a valid reading. In the NowCast weighted sum, `"25" * 0.5` evaluates to `12.5` via JS numeric coercion — mathematically correct by accident, not by design.

The same issue exists in `getDominantPollutant` (line 219) where `isFinite("100")` passes the filter and `"100" - "80" = 20` coerces correctly but accidentally.

If the Oracle layer passes a raw API field that wasn't fully normalized (e.g., a string `"25.3"` instead of `25.3`), the computation proceeds silently with a type mismatch. This is a silent data integrity risk: the result may be numerically correct now but could change unexpectedly if JS behavior around coercion ever changes, and it makes the processor's type contract implicit rather than explicit.

**Recommendation**: Use `typeof v === 'number' && isFinite(v)` instead of `isFinite(v)` in all validity checks (aqi.js:182, 186, 200, and 219). This tightens the type contract and removes reliance on coercion.

---

#### M5 — `settlement.js`: negative `ageHours` when `registryRecord.last_seen` is a future timestamp
**File**: `src/processor/settlement.js:85-92`

```js
const lastSeenMs = registryRecord?.last_seen ?? now;
const ageHours = (now - lastSeenMs) / 3_600_000;
...
if (crossValidated && nearbySensorsCount >= 3 && ageHours > 2 && quality.score >= 0.7) {
```

If `registryRecord.last_seen` is a future timestamp (e.g., due to system clock skew, NTP drift, or a malicious/malformed registry record), `ageHours` is negative. The condition `ageHours > 2` is false — `provisional_mature` never fires, even for a sensor that has been running perfectly for 10 hours of real time.

There is no crash, no exception, and no indication that this happened. The sensor silently degrades from `provisional_mature` (eligible, 10% discount) to `provisional` (not eligible, 0% discount). The RLMF certificate receives no signal from what could have been a valid cross-validated reading.

The checklist item anticipated this exact scenario. The current `registryRecord.last_seen` appears to be epoch milliseconds (as set in the test at `Date.now() - 3.5 * 3_600_000`), but there is no validation or clamping.

**Recommendation**: Clamp `ageHours` to `Math.max(0, ageHours)` to prevent negative ages from silently blocking `provisional_mature`. Document the clock-skew behavior.

---

### LOW / INFORMATIONAL

#### L1 — `getCategory(aqi)` returns Hazardous for AQI > 500 (undocumented behavior)
**File**: `src/processor/aqi.js:159-163`

```js
return cat ?? { number: 6, name: 'Hazardous', range: [301, 500] };
```

The fallback for AQI values above 500 (which `calculateAQI` never produces — it returns `null` above 500.4) returns a Hazardous category with `range: [301, 500]`. The `aqi` value would be outside this range, which could confuse downstream consumers that check `aqi >= cat.range[0] && aqi <= cat.range[1]`. This is a cosmetic issue since `calculateAQI` already caps at `null` for out-of-range concentrations, but the getCategory contract is underspecified. INFORMATIONAL.

---

#### L2 — `getDominantPollutant`: key names from untrusted caller become RLMF data fields
**File**: `src/processor/aqi.js:218-229`

The function returns a key name string (e.g., `'PM25'`, `'O3_8H'`) that propagates into evidence bundles and RLMF certificates. The key set is unvalidated — a caller could pass `{ '__proto__': 100, 'PM25': 80 }`. `Object.entries()` will enumerate `__proto__` as a regular key. No prototype mutation occurs (this is NOT a prototype pollution vulnerability), but the string `'__proto__'` would propagate as the `dominant_pollutant` field in an RLMF certificate. In Sprint 2, keys will come from the normalized sensor object where the pollutant map is constructed explicitly — this is informational for that normalization step. INFORMATIONAL.

---

#### L3 — Bundle ID collision edge case for AirNow
**File**: `src/processor/bundles.js:154,158`

Two AirNow reporting areas that normalize to identical slugs AND share an `observation_time` would produce identical `bundle_id` values. Example: `"San Francisco"` and `"San_Francisco"` both normalize to `"San_Francisco"`. In practice, the AirNow API uses consistent reporting area names and this collision is improbable. Worth a code comment. INFORMATIONAL.

---

#### L4 — Test suite: no tests for invalid/malformed inputs to public functions
**File**: `test/breath.test.js`

Tests cover the happy path and specified null/edge cases thoroughly. No tests exercise:
- `calculateAQI` with NaN or Infinity concentration
- `matchTheatres` with a theatre missing `region_bbox` (would crash — see M2)
- `buildAirNowBundle` with null `ReportingArea` (would crash — see M3)
- `computeNowCast` with a 10,000-element array (DoS path — see M1)

These gaps are the test corollaries of findings M1–M3. The market_freeze coverage gap from the senior review was caught and fixed. These are the next tier. LOW.

---

## Security Checklist Results

| Category | Item | Result |
|----------|------|--------|
| **A. Secrets** | No hardcoded API keys or tokens in processor files | PASS |
| **A. Secrets** | No `.env` interpolation in processor files | PASS |
| **A. Secrets** | `package.json` has no production dependencies | PASS |
| **B. Injection** | No `eval()` or `new Function()` | PASS |
| **B. Injection** | No template literals constructing shell commands | PASS |
| **B. Injection** | No prototype pollution via `__proto__` mutation | PASS — keys may propagate (see L2) but no mutation |
| **B. Injection** | No `JSON.parse` on untrusted data | N/A — no JSON.parse calls |
| **C. DoS** | NowCast loop bounded to 12 iterations | PASS — loop hardcoded; filter is unbounded (M1) |
| **C. DoS** | Array size validation for hourlyReadings | FAIL — no upper bound (M1) |
| **C. DoS** | No catastrophic regex backtracking | PASS — no untrusted regex |
| **C. DoS** | No division by zero in denominators | PASS — all denominators guarded |
| **D. Numeric** | AQI formula: Clow === Chigh guard | PASS — hardcoded tables have no zero-width intervals |
| **D. Numeric** | NowCast: all-zero readings (Cmax=0) | PASS — explicit guard at aqi.js:193 |
| **D. Numeric** | NowCast: Cmax=0 division guard | PASS — aqi.js:193 uses 1.0 fallback |
| **D. Numeric** | doubt_price clamped ≤ 0.95 | PASS — all additions use Math.min(0.95, ...) |
| **D. Numeric** | settlement: future last_seen causes silent provisional_mature block | FAIL — negative ageHours not clamped (M5) |
| **E. Data Integrity** | Bundle IDs: PurpleAir collision check | PASS — sensor_index is globally unique |
| **E. Data Integrity** | Bundle IDs: AirNow collision edge case | LOW — see L3 |
| **E. Data Integrity** | All four time fields always set in both bundle types | PASS — verified in code and tests |
| **E. Data Integrity** | Attribution strings hardcoded, not user-supplied | PASS |
| **F. Input Validation** | computeNowCast: non-numeric, non-null values | FAIL — isFinite() coercion accepts numeric strings (M4) |
| **F. Input Validation** | calculateAQI: NaN, Infinity, -Infinity | PASS — NaN returns null; Infinity returns null |
| **F. Input Validation** | getDominantPollutant: non-numeric AQI values | PARTIAL — isFinite coercion (M4), no crash |
| **F. Input Validation** | matchTheatres: missing or malformed bbox | FAIL — crashes on missing region_bbox (M2) |
| **G. Dependencies** | Zero production dependencies | PASS — no `dependencies` key in package.json |
| **H. Tests** | No live network calls | PASS — all fixtures are static objects |
| **H. Tests** | No API keys or PII in test fixtures | PASS |
| **H. Tests** | Error/null paths covered | PARTIAL — core null paths covered; crash paths for M1-M3 untested (L4) |

---

## Auditor Notes

**Why APPROVED despite five MEDIUM findings:**

Sprint 1 is a pure computation library. None of the MEDIUM findings can be exploited by an external adversary at this layer — there is no external input path in Sprint 1. All inputs come from the Oracle layer (Sprint 2) and Theatre layer (Sprint 3), which will be the boundary where adversarial data enters the system.

The MEDIUM findings are **hardening requirements for Sprint 2 and Sprint 3**, not blocking issues for Sprint 1's own acceptance gate (which is: all processor tests pass against the SDD specification). That gate passed: 61/61.

The most important finding operationally is **M5** (negative ageHours from future timestamps). Clock skew between the host running BREATH and the PurpleAir/AirNow data timestamps is real (PurpleAir sensors report `last_seen` in Unix seconds, and sensor clocks drift). This should be fixed before Sprint 2 touches registryRecord.last_seen in production.

**M1** (unbounded NowCast array) should be fixed before the SensorRegistry accumulates `pm25_history` in Sprint 2 — one defensive line prevents a latent DoS.

**M2** and **M3** (crash on malformed inputs to bundle builders) should be addressed in Sprint 2 before Oracle-supplied objects flow through the processor.

**M4** (isFinite coercion) is a clean-up that documents the type contract and prevents silent type confusion from propagating into RLMF certificates.

None of these findings invalidate the correctness of Sprint 1's AQI computation, NowCast algorithm, quality weighting, uncertainty pricing, or settlement logic — all of which were independently verified by the senior lead review and confirmed clean here.
