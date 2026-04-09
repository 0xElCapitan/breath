BREATH Sprint 3 — Empirical Calibration (Post-P0)

PREREQUISITE
P0 (2024 PM2.5 breakpoint correction) must already be merged and green before
this sprint starts. Several Sprint 3 decisions depend on the corrected AQI regime.

MISSION
This is a calibration sprint, not a code audit and not a structural redesign.
Implement the narrow set of empirically supported calibration changes below,
add the listed tests, and update comments/docs so the construct’s claims match
its current evidence base.

SOURCE BASIS
This sprint is derived from:
- Empirical Validation Research (2026-04-08)
- External review of that research
- Audit documentation backlog (honesty / annotation follow-through)

ALLOWED FILES
- src/processor/quality.js
- src/processor/uncertainty.js          (annotation only)
- src/index.js
- src/theatres/wildfire-cascade.js
- README.md
- BUTTERFREEZONE.md

DO NOT TOUCH
- src/processor/aqi.js                  (P0 already handled this)
- certificates.js
- AirNow ingestion code
- wildfire bucket structure
- wildfire +0.15 update step
- sigma formula values
- any file not listed above

NO REFACTORING
No new dependencies. No API-shape changes. No formatting-only churn.

======================================================================
TASK 3.1 — Raise A/B near-zero guard from 2 µg/m³ to 5 µg/m³
======================================================================

File:
- src/processor/quality.js

Why:
Barkjohn et al. 2021 used a 5 µg/m³ absolute floor to avoid penalizing
channel differences dominated by near-zero quantization noise. PMS5003
resolution is 1 µg/m³. Below ~5 µg/m³, ratio-based divergence becomes unstable.

Change:

BEFORE:
  if (avg < 2.0) return 1.0;

AFTER:
  // source: Barkjohn et al. 2021 (AMT 14:4617) — 5 µg/m³ absolute floor
  // to avoid penalizing near-zero PMS5003 quantization noise
  if (avg < 5.0) return 1.0;

Tests to add in the existing "Channel consistency helpers" suite:
- it('computeChannelConsistency: avg 3 µg/m³ (A=2, B=4) returns 1.0 under 5 µg/m³ guard')
- it('computeChannelConsistency: avg 5.0 µg/m³ (A=3, B=7) engages ratio check')
- it('computeChannelConsistency: avg 4.9 µg/m³ returns 1.0 (just under guard)')

Notes:
- Keep the existing 0.7 ratio threshold unchanged
- Do not convert this to Barkjohn’s full dual-threshold logic in this sprint

======================================================================
TASK 3.2 — Add absolute AQI floor to auto-spawn trigger
======================================================================

File:
- src/index.js
- function: _checkAutoSpawn

Why:
The +20 AQI / 2h trigger is meant to detect transition into threatening
conditions, not to re-trigger during already-elevated smoke regimes where
±20 AQI swings can happen from wind shifts.

Implementation rule:
Only allow auto-spawn when current AQI is still below USG.

Change:

BEFORE:
  if (trend < 20) continue;

AFTER:
  if (trend < 20) continue;

  // TBD: empirical calibration needed — absolute AQI floor is an
  // engineering safeguard to prevent redundant spawn during already-
  // elevated smoke conditions. Spawn only while still below USG.
  if (latestAqi >= 100) continue;

Placement:
- keep this AFTER the null / latestAqi guard
- keep this AFTER getNextThreshold(...) null handling
- place it BEFORE the hasOpenT1 check

Comment wording note:
Do not describe 100 as the lower boundary of USG.
100 is the top of Moderate. This guard means “only spawn while still below USG.”

Tests to add in the existing "BreathConstruct — integration" suite:
- it('_checkAutoSpawn: does not spawn when AQI is 110 with rising trend of 25')
- it('_checkAutoSpawn: spawns when AQI is 80 with rising trend of 25')

======================================================================
TASK 3.3 — Lower T3 wildfire exceedance threshold default from 200 to 151
======================================================================

File:
- src/theatres/wildfire-cascade.js
- function: createWildfireCascade

Why:
AQI 200 is too strict for typical regional smoke penetration and produces
sparse exceedance outcomes. The defensible health-aligned threshold is the
start of Unhealthy, which is AQI 151 under the current AQI regime.

Important correctness note:
Use 151, not 150.
151 is the lower boundary of Unhealthy and aligns with the Cal/OSHA wildfire
protection threshold logic.

Change:

BEFORE:
  threshold_aqi = 200,

AFTER:
  // source: Camp Fire PurpleAir study (PMC7374346) + health-threshold alignment.
  // Default set to the lower boundary of Unhealthy (AQI 151), which is more
  // informative than AQI 200 for regional smoke events.
  // TBD: historical replay needed across many events to confirm this default.
  threshold_aqi = 151,

Tests to add in the existing wildfire-cascade suite:
- it('createWildfireCascade: default threshold_aqi is 151')
- it('createWildfireCascade: default exceedance threshold is the start of Unhealthy, not 150')

For the second test, keep it simple and explicit. It should fail if someone
quietly slides the default to 150 or back to 200 later.

======================================================================
TASK 3.4 — Skew wildfire prior away from uniform
======================================================================

File:
- src/theatres/wildfire-cascade.js
- function: createWildfireCascade

Why:
The current uniform prior assigns equal weight to low-exceedance and extreme
high-exceedance outcomes. The available evidence supports the direction
“skew toward low exceedance,” but does NOT strongly support one exact vector.
So implement this as a clearly labeled provisional prior, not as a “settled”
calibration truth.

Change both locations where the initial T3 bucket distribution is set:
- the theatre object field
- the initial position_history entry

BEFORE:
  bucket_probabilities: [0.2, 0.2, 0.2, 0.2, 0.2],

AFTER:
  // source: inferred from Camp Fire PurpleAir evidence — low-exceedance
  // outcomes appear more common than high-exceedance outcomes.
  // Specific weights below are provisional working values, not final
  // empirical truth. Historical replay across many events is still needed.
  // TBD: empirical calibration needed.
  bucket_probabilities: [0.40, 0.25, 0.15, 0.12, 0.08],

Constraints:
- Leave base_rate unchanged
- Do not change bucket boundaries in this sprint
- Do not change the +0.15 update rule in this sprint

Tests to add in the existing wildfire-cascade suite:
- it('createWildfireCascade: default prior is [0.40, 0.25, 0.15, 0.12, 0.08]')
- it('createWildfireCascade: default prior sums to 1.0')

======================================================================
TASK 3.5 — Annotation pass: replace unsupported hardcoded comments with
source-backed or explicitly provisional comments
======================================================================

Files:
- src/processor/quality.js
- src/processor/uncertainty.js
- src/index.js
- src/theatres/wildfire-cascade.js

Goal:
Where the current value is directly supported, add a `source:` annotation.
Where it remains an engineering estimate, label it explicitly as
`TBD: empirical calibration needed`.

This task is annotation-only unless a value is already being changed by
Tasks 3.1–3.4.

Required annotations:

quality.js
```js
// source: Barkjohn et al. 2021 (AMT 14:4617) — 5 µg/m³ near-zero floor
if (avg < 5.0) return 1.0;

// source: Barkjohn et al. 2022 (PMC9784900) — 70% is the EPA hourly QC
// threshold used for Fire and Smoke Map handling
return Math.max(0, 1 - divergenceRatio / 0.7);

// TBD: empirical calibration needed — quality weight allocation
// has no primary-source basis yet
const raw = (
  source_tier * 0.35 + freshness * 0.30 + density * 0.20 + consistency * 0.15
);

// TBD: empirical calibration needed — 10-sensor density normalization
const density = Math.min(1.0, nearbySensors.length / 10);

// TBD: empirical calibration needed — cross-validation tolerance
const tolerance = Math.max(nearbyAirNow.AQI * 0.3, 15);
````

uncertainty.js

```js
// TBD: empirical calibration needed — base doubt prices by
// consistency class are engineering values

// source: corrected PurpleAir best-case RMSE is low, but true AQI-unit
// uncertainty is band-dependent; fixed sigma is an approximation.
// TBD: concentration-aware sigma model still needed.
const sigma = 5 + doubt_price * 55;
```

index.js

```js
// TBD: empirical calibration needed — +20 AQI / 2h is directionally
// supported but not yet replay-calibrated across non-smoke conditions
if (trend < 20) continue;

// TBD: empirical calibration needed — absolute floor prevents redundant
// spawn while already elevated; replay still needed for false-positive rate
if (latestAqi >= 100) continue;
```

wildfire-cascade.js

```js
// source: threshold direction supported; exact default remains a working value
threshold_aqi = 151,

// source: prior direction supported; exact weights remain provisional
bucket_probabilities: [0.40, 0.25, 0.15, 0.12, 0.08],
```

No tests required for annotation-only edits.

======================================================================
TASK 3.6 — README and BUTTERFREEZONE honesty updates
====================================================

Files:

* README.md
* BUTTERFREEZONE.md

3.6a — Transport lag: distinguish local vs long-range

Replace the one-size-fits-all smoke transport sentence with wording that
clearly separates:

* local / regional transport: roughly 2–12h
* long-range transport: roughly 12–72+h

Required meaning:

* local fires under ~200 km can reach sensors in hours
* long-range transport can take much longer
* T3 window guidance should reflect event type

3.6b — T3 window guidance by event type

Add clear guidance that:

* 72h is reasonable for short long-range or snapshot-style events
* regional fires may need 72–168h
* this is usage guidance, not a code default change in this sprint

3.6c — AirNow trust policy: soften certainty language

Replace any wording that sounds like:

* “EPA-reviewed AQI values are published hourly”
* “No interpretation required”

with language that makes all of the following clear:

* AirNow current observations are preliminary
* AQS is the final regulatory system
* BREATH intentionally uses AirNow for low-latency settlement
* normal-condition drift is likely modest but not directly quantified
* this is a product trust-policy choice, not regulatory finality

3.6d — Auto-spawn capability line

Update BUTTERFREEZONE capability text so it reflects the actual post-fix behavior:

Auto-spawn T1 on rising AQI trend (+20 in 2h, only when current AQI < 100)

Do not mention the historical broken state. Just make the capability line accurate.

No tests required for documentation changes.

======================================================================
SUCCESS CRITERIA / STOP CONDITIONS
==================================

All of the following must be true:

1. All pre-existing tests pass
2. All new Sprint 3 tests pass
3. computeChannelConsistency(2, 4) === 1.0
4. computeChannelConsistency(3, 7) < 1.0
5. createWildfireCascade({ tracked_sensors: [] }).threshold_aqi === 151
6. createWildfireCascade({ tracked_sensors: [] }).bucket_probabilities
   deep-equals [0.40, 0.25, 0.15, 0.12, 0.08]
7. _checkAutoSpawn does not open T1 when latestAqi === 110 and trend === 25
8. _checkAutoSpawn does open T1 when latestAqi === 80 and trend === 25
9. README distinguishes local vs long-range transport lag
10. README uses softened AirNow settlement language
11. No file outside the allowed-file list was modified

======================================================================
HARD CONSTRAINTS
================

* No refactors
* No new dependencies
* No public API changes
* No bucket-boundary changes
* No sigma-value changes
* No update-step changes
* No AirNow ingestion changes
* No certificate changes
* No edits to files outside the allowed list

DELIVERABLE
Return:

1. concise summary of exactly what changed
2. exact files modified
3. exact test results
4. confirmation that the T3 threshold/prior changes are documented as
   provisional where evidence is still weak