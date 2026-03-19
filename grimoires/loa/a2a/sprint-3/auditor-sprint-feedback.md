# Sprint 3 Security Audit — APPROVED - LETS FUCKING GO

**Verdict**: APPROVED
**Sprint**: sprint-3 (global sprint-3) — Theatre Layer + RLMF
**Files audited**: `src/theatres/aqi-gate.js`, `src/theatres/sensor-divergence.js`, `src/theatres/wildfire-cascade.js`, `src/rlmf/certificates.js`

---

## Security Checklist

| Category | Status | Notes |
|----------|--------|-------|
| Secrets / credentials | PASS | No hardcoded keys, tokens, passwords, or env var access in any Sprint 3 file |
| Auth / authz | PASS | N/A — pure data transformation, no access control surface |
| Injection (XSS / SQLi / command) | PASS | No external output, no DB, no shell — string interpolation used only in internal reason fields |
| PII / data privacy | PASS | AQI numeric data only — no names, emails, IPs, locations, or personal identifiers |
| External calls | PASS | Zero outbound HTTP/network calls in all four files |
| Prototype pollution | PASS | Spread copies (`{ ...theatre }`) throughout — no `Object.assign` with user input, no dynamic key assignment from external data |
| Divide-by-zero | PASS | T3 `updateBucketProbabilities`: total always ≥ 0.15 (0.15 added to observed bucket before reduce). T3 `trackedCount > 0` guard at line 157. Safe. |
| Integer/float overflow | PASS | All values are AQI integers (0–500 range) and probabilities (0.0–1.0). No overflow risk. |
| Denial of service | PASS | No unbounded loops. `divergence_window` and `position_history` grow by one entry per bundle. `_sensor_readings` is bounded by `tracked_sensors.length`. |
| Code quality / logic bugs | PASS (with LOWs — see below) | |

---

## Findings

### LOW-1: Non-optional bundle payload access on EPA AirNow path

**File**: `src/theatres/aqi-gate.js:100, 111`

```js
// Line 100 — no optional chaining
const crossed = bundle.payload.aqi.category_number >= theatre.threshold_category_number;

// Line 111 — no optional chaining in template literal
reason: `EPA AirNow: AQI=${currentAQI} (${bundle.payload.aqi.category})`,
```

**Risk**: If the oracle layer emits a malformed EPA AirNow bundle with `null` payload, this throws a `TypeError`. Not exploitable externally — the oracle layer is the only bundle producer, and Sprint 2's EPA bundle construction always sets `payload.aqi`. The `bundle.source === 'EPA_AIRNOW' && bundle.evidence_class === 'ground_truth'` guard narrows the risk further.

**Context**: Identical class of issue to `obs.AQI` / `obs.ParameterName` from Sprint 2 (L5, deferred). Deferred to Sprint 4 when the oracle→Theatre interface is hardened end-to-end.

**Action**: Defer to Sprint 4. No fix required for Sprint 3 approval.

---

### LOW-2: Non-optional `bundle.payload.location` access in reason template

**File**: `src/theatres/aqi-gate.js:141`

```js
reason: `PurpleAir sensor ${bundle.payload.location.sensor_id}: AQI=...`
```

**Risk**: `bundle.payload.location` undefined → `TypeError`. Only reached on the PurpleAir provisional update path (line 122 guard). Oracle layer always provides `location.sensor_id` for PurpleAir bundles.

**Action**: Defer to Sprint 4. Non-blocking.

---

### OBSERVATION: `epa_airnow_confirmed` string match on bundle ID

**File**: `src/rlmf/certificates.js:209`

```js
epa_airnow_confirmed: theatre.resolving_bundle_id?.includes('airnow') ?? false,
```

Bundle IDs are constructed as `breath-airnow-*` by the oracle layer (Sprint 2). This string match is reliable for the current implementation. A future oracle that uses a different ID format would silently break this field — worth noting for Sprint 4 when the bundle ID schema is finalized.

**Action**: No fix required. Document in Sprint 4 bundle ID spec.

---

## Clean Patterns — Verified ✓

| Pattern | Where |
|---------|-------|
| Immutable state (spread copies throughout) | All three Theatre files |
| Optional chaining on all non-gated payload access | `aqi-gate.js:95-96,126-128`, `sensor-divergence.js:90,98`, `wildfire-cascade.js:144,150` |
| Input validation with throw | `createAqiThresholdGate` (invalid threshold), `createWildfireCascade` (non-array sensors) |
| Idempotency guards on all resolution functions | `expireAqiThresholdGate`, `expireSensorDivergence`, `resolveWildfireCascade` |
| Resolved state immutability (early return) | `processAqiThresholdGate:90`, `processSensorDivergence:88`, `processWildfireCascade:142` |
| Null-safe Brier computation | `brierScoreBinary`, `brierScoreMultiClass` both return null on empty history |
| Safe position clamping | `[0.01, 0.99]` range enforced in T1 and T2 |
| No mutation of input theatre | All functions return new objects |

---

## Test Coverage Assessment

98/98 pass. Sprint 3 adds 18 tests covering all critical paths:
- T1: threshold validation, YES/NO resolution, provisional_hold, position blending, expiry
- T2: sensor filtering, consecutive counter mechanics, YES resolution, position smoothing, expiry + idempotency
- T3: sensor exclusion, all three bucket boundaries (0%, 40%, 100%), resolution
- RLMF: Brier scores (binary + multi-point), certificate fields, T3 integer outcome

No security-relevant untested paths identified.

---

**APPROVED - LETS FUCKING GO**

Sprint 3 is clean. Two LOW findings are carry-forwards from the Sprint 2 audit pattern, deferred to Sprint 4 for the oracle→Theatre interface hardening pass. No blocking issues.
