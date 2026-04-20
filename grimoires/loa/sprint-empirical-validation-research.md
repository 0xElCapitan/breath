# BREATH Empirical Validation Research — Primary-Source Calibration Pass

## Mission

BREATH is already production-hardened. This research pass is **not** a code audit and **not** an architecture review.

Your job is to determine whether BREATH’s current **quantitative choices** are empirically defensible, based on primary sources wherever possible.

You are evaluating whether the current values are:
- **defensible**
- **too permissive**
- **too strict**
- **unknown / insufficient evidence**

If a value is not defensible, recommend a **replacement value or range** and explain why.

---

## Construct Context

BREATH is an air-quality prediction market construct with:
- **PurpleAir** as the **signal layer** (120s cadence)
- **EPA AirNow** as the **settlement authority** (60m cadence)
- three Theatre types:
  - **T1** AQI Threshold Gate
  - **T2** Sensor Divergence
  - **T3** Wildfire Cascade
- Brier-scored RLMF certificate export

The code audit is complete. The hardening work is done. This sprint exists because the audit flagged a backlog of **hardcoded parameters with weak or missing empirical grounding**.

This research is about whether those values are defensible **in the world**, not whether the code is safe.

---

## Hard Constraints

### Do not do these things
- Do **not** re-audit the code
- Do **not** propose broad architectural rewrites
- Do **not** drift into generic air-quality explanation
- Do **not** answer with “more data is needed” unless you first exhaust the available literature
- Do **not** treat product/marketing claims as evidence
- Do **not** interpolate from adjacent domains without labeling it explicitly as extrapolation

### You must do these things
- Use **primary sources first**:
  - EPA / AirNow / AQS / AirData documentation
  - PurpleAir documentation
  - peer-reviewed literature
  - state or federal agency documentation
- Use secondary sources only when primary sources are unavailable, and label them as secondary
- Separate:
  - **direct evidence**
  - **inference**
  - **unknowns**
- For every lane, give a clear verdict on the **current BREATH value**
- Where evidence conflicts, present the conflict clearly rather than smoothing it over
- Prefer **ranges, distributions, and uncertainty bounds** over fake precision
- Quote exact thresholds, error magnitudes, or lag windows when available
- Flag any lane where the literature is too weak to support a confident recommendation

---

## Evidence Standard

For each claim, distinguish one of these:

- **Direct evidence** — explicitly supported by a cited source
- **Inference** — derived from cited evidence but not directly stated
- **Extrapolation** — borrowed from adjacent but not identical contexts

Never present inference or extrapolation as direct evidence.

---

## Decision Rubric

Use this rubric consistently across all lanes:

- **Defensible**  
  Supported directly by primary sources, or strongly consistent with multiple high-quality sources.

- **Too permissive**  
  Current value likely allows too much noise, false-positive behavior, or weak evidence through.

- **Too strict**  
  Current value likely suppresses valid signal, creates false negatives, or over-filters.

- **Unknown / insufficient evidence**  
  Literature does not support a confident call. If so, say what specific empirical study or replay would be needed.

---

## Research Lanes

There are **five** research lanes.

---

## Lane 1 — PurpleAir A/B Channel Divergence Threshold

Current BREATH behavior:
- `channel_inconsistent` when  
  `|pm25_a - pm25_b| / avg(pm25_a, pm25_b) > 0.7`
- linear score:  
  `max(0, 1 - divergenceRatio / 0.7)`
- near-zero guard:  
  `avg < 2 µg/m³` bypasses the ratio check

Research questions:
1. What do PurpleAir’s own materials, EPA studies, or peer-reviewed literature say about A/B channel divergence thresholds for data-quality filtering?
2. Is `0.7` defensible, too permissive, or too strict?
3. What thresholds or exclusion logic appear in EPA PurpleAir correction literature, including Barkjohn et al. and related work?
4. Is a **linear score** consistent with existing quality frameworks, or do they mostly use hard filters / binary exclusion?
5. Is `avg < 2 µg/m³` the right floor? At what concentration does the ratio become unstable or misleading?

Required output:
- verdict on `0.7`
- verdict on the linear scoring form
- verdict on the `2 µg/m³` floor
- recommended threshold/range if current values are weak

---

## Lane 2 — AirNow Preliminary Data vs Final EPA Truth (Settlement Drift)

Current BREATH policy:
- AirNow current observations are used as settlement authority
- this is an intentional fast-settlement choice, but it needs empirical validation

Research questions:
1. How often do AirNow current hourly observations differ from later final values in AQS / AirData?
2. Is there published evidence on divergence **rate**, **magnitude**, or **category-boundary drift**?
3. Are there documented cases where AirNow current data crossed an AQI category threshold that later fell back below that threshold in final data?
4. What is the typical lag between AirNow current observations and finalization in AQS?
5. Does the AirNow API expose any fields that distinguish preliminary vs quality-assured data?
6. For BREATH’s use case — fast-cycle markets and RLMF training, not regulatory compliance — is AirNow-as-ground-truth appropriate, or is a deferred reconciliation path recommended?

Required output:
- empirical view of settlement drift risk
- whether category-boundary false positives are material
- whether BREATH’s current trust-policy choice is defensible for its use case

Important:
Do **not** treat “preliminary” as automatically unacceptable. Judge it against BREATH’s actual use case.

---

## Lane 3 — Auto-Spawn Trigger: `+20 AQI in 2 Hours`

Current BREATH behavior:
- auto-spawns a T1 AQI Threshold Gate when a sensor’s AQI rises by **20 or more points in 2 hours**

Research questions:
1. In historical wildfire smoke events, how fast did AQI typically rise in downwind regions?
2. How often would `+20 in 2h` trigger during real smoke incursions versus normal diurnal variation or sensor noise?
3. Is this threshold too early, too late, or roughly right as an early-warning signal?
4. What rise-rate or alert-trigger logic exists in AirNow, EPA, state agencies, or academic alert systems?
5. Is the **2-hour window** appropriate, or would 1h / 4h be better?
6. Should the trigger be purely relative (`ΔAQI = 20`) or also conditioned on absolute level (for example, only if current AQI > 50)?

Required output:
- verdict on `+20 in 2h`
- whether an absolute AQI floor should also be included
- recommended trigger formulation if current one is weak

Important:
Anchor this lane in real wildfire case studies, not generic AQI behavior.

---

## Lane 4 — T3 Wildfire Cascade: Prior, Buckets, Threshold, Update Rule, Window

Current BREATH values:
- prior: `[0.2, 0.2, 0.2, 0.2, 0.2]`
- exceedance threshold: `AQI ≥ 200`
- buckets:
  - `0–10%`
  - `10–30%`
  - `30–50%`
  - `50–70%`
  - `70%+`
- probability update:
  - additive `+0.15` toward observed bucket, then renormalize
- max window:
  - `72h`
- documented smoke transport lag:
  - `2–12h`

Research questions:
1. In major wildfire smoke events, what fraction of downwind PurpleAir sensors typically exceeded AQI 200?
2. Do outcomes cluster at extremes (near 0% or near 100%), making middle buckets rare?
3. Is `AQI ≥ 200` the right exceedance threshold, or would `150` or `300` be more informative?
4. Is the uniform prior appropriate, or is there a better empirical prior?
5. Is the fixed `+0.15` update step defensible, or is it mainly a placeholder?
6. Would a Bayesian/Dirichlet framing be more defensible than additive-renormalize, even if BREATH does not currently implement it?
7. Does the documented `2–12h` smoke transport lag hold across both local fires and long-range transport?
8. Is `72h` a sufficient max window, especially for long-range smoke events?

Required output:
- verdict on threshold
- verdict on buckets
- verdict on prior
- verdict on update rule
- verdict on max window

Important:
Do not recommend a new update mechanism unless you can explain why the current one is empirically indefensible.

---

## Lane 5 — Uncertainty Sigma Mapping

Current BREATH mapping:
- `sigma = 5 + doubt_price * 55`
- so:
  - best case: `sigma = 5`
  - worst case: `sigma = 60`

Research questions:
1. What is the typical measurement uncertainty of a well-functioning PurpleAir sensor relative to a reference FEM monitor?
2. What RMSE / MAE / error distributions are reported in PurpleAir correction studies?
3. Does `sigma = 5` understate or overstate best-case uncertainty?
4. Does `sigma = 60` overstate or understate worst-case uncertainty for degraded or low-confidence sensors?
5. Is a **linear** doubt-price-to-sigma mapping defensible, or would a nonlinear relationship better match observed error behavior?

Required output:
- verdict on lower bound
- verdict on upper bound
- verdict on linear mapping
- recommended range or function shape if current mapping is weak

---

## Required Method

For each lane, do all of the following:

1. Identify the strongest primary sources
2. Summarize what those sources actually say
3. Distinguish evidence from inference
4. Judge the current BREATH value
5. Recommend a replacement value/range only if justified
6. State confidence level:
   - **high**
   - **medium**
   - **low**
7. State what would change your mind

---

## Deliverable Format

Use this exact structure.

# Executive Summary
- 5–10 bullets only
- highest-signal takeaways
- identify which current BREATH values survive review unchanged
- identify which values most likely need recalibration

# Evidence Quality Overview
A short table with:
- Lane
- Primary-source strength
- Amount of direct evidence
- Main uncertainty

# Lane 1 — PurpleAir A/B Divergence
## Findings
## Direct evidence
## Inference
## Verdict on current BREATH value
## Recommended value or range
## Confidence
## What would change my mind

# Lane 2 — AirNow Settlement Drift
## Findings
## Direct evidence
## Inference
## Verdict on current BREATH value
## Recommended value or range
## Confidence
## What would change my mind

# Lane 3 — Auto-Spawn Trigger
## Findings
## Direct evidence
## Inference
## Verdict on current BREATH value
## Recommended value or range
## Confidence
## What would change my mind

# Lane 4 — Wildfire Cascade
## Findings
## Direct evidence
## Inference
## Verdict on current BREATH values
## Recommended value or range
## Confidence
## What would change my mind

# Lane 5 — Sigma Mapping
## Findings
## Direct evidence
## Inference
## Verdict on current BREATH value
## Recommended value or range
## Confidence
## What would change my mind

# Cross-Lane Synthesis
- Which values are ready to keep as-is
- Which values need recalibration now
- Which values are still literature-weak and require historical replay or bespoke data collection
- A prioritized calibration backlog: P1 / P2 / P3

# Final Recommendation
Answer these explicitly:
1. Which current BREATH values are empirically defensible today?
2. Which current BREATH values should be changed before the next release?
3. Which open questions cannot be settled from literature alone?

---

## Output Quality Bar

A weak answer:
- paraphrases general knowledge
- cites loosely
- avoids hard judgments
- blurs evidence and inference

A strong answer:
- uses primary sources
- makes explicit calls on current BREATH values
- shows uncertainty honestly
- recommends ranges only where evidence supports them
- clearly separates literature-backed conclusions from educated extrapolation