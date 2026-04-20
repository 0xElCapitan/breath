# BREATH Empirical Validation Research — Primary-Source Calibration Report

> **Date**: 2026-04-08
> **Sprint**: sprint-empirical-validation-research
> **Status**: COMPLETE
> **Scope**: 5 research lanes evaluating hardcoded parameter defensibility

---

# Executive Summary

- **Lane 1 (A/B Divergence 0.7)**: The 70% threshold is **directly defensible** — it matches Barkjohn et al. (2022) EPA hourly QC threshold exactly. However, the 2 µg/m³ near-zero floor is **too strict** and should be raised to 5 µg/m³ to match the literature's absolute-difference guard.
- **Lane 2 (AirNow Settlement)**: Using AirNow as settlement authority is **defensible** for BREATH's fast-cycle prediction market use case. Normal-condition drift is bounded by ±10% FEM bias envelope. The 6–18 month AQS finalization lag makes deferred settlement impractical.
- **Lane 3 (Auto-Spawn +20/2h)**: The trigger is a **defensible engineering estimate** — it sits well above normal diurnal variation (~2–10 AQI) and below real smoke event rises (50–200+ AQI in 2h). An **absolute AQI floor** (current AQI < 100) should be added to prevent false triggers during already-elevated conditions.
- **Lane 4 (Wildfire Cascade)**: AQI ≥ 200 is **too strict** — even during the Camp Fire, sensors exceeded AQI 200 only ~30% of the time at 135 km downwind. The **uniform prior is wrong** — outcomes cluster heavily toward low-exceedance buckets. The **72h window is too short** for regional fires (Camp Fire lasted 11–12 days; 2020 Bay Area had 30 consecutive alert days).
- **Lane 5 (Sigma Mapping)**: The [5, 60] range is **roughly defensible** for the operational AQI bands BREATH targets. The biggest gap is not the range but the absence of **concentration-awareness** — PM2.5 error-to-AQI-unit conversion varies 8x across breakpoint bands.

**Bottom line**: 3 of 5 lanes survive with minor adjustments (Lanes 1, 2, 5). Lane 3 needs an absolute floor condition. Lane 4 needs the most recalibration — threshold, prior, and window are all empirically weak.

---

# Evidence Quality Overview

| Lane | Primary-Source Strength | Direct Evidence | Main Uncertainty |
|------|------------------------|-----------------|------------------|
| 1 — A/B Divergence | **Strong** — Barkjohn 2021/2022, Tryner 2020, Jiao 2023 | High — EPA hourly QC threshold directly matches | Linear scoring has no literature precedent |
| 2 — Settlement Drift | **Medium** — EPA docs, GAO report, T640 case | Medium — no study directly quantifies AirNow-vs-AQS hourly drift | Drift magnitude inferred from bias envelope, not measured |
| 3 — Auto-Spawn | **Medium** — case studies, diurnal variation studies | Medium — smoke rise rates inferred from daily data, not hourly | No existing system uses rate-of-change triggers for comparison |
| 4 — Wildfire Cascade | **Medium** — Camp Fire PurpleAir study, transport studies | Medium — exceedance fraction from 1 study (53 sensors) | Bucket distribution is inferred, not directly measured |
| 5 — Sigma Mapping | **Strong** — Barkjohn, Wallace, Watt, Li, Bi studies | High — RMSE values convergent across studies | PM2.5-to-AQI slope conversion introduces band-dependent uncertainty |

---

# Lane 1 — PurpleAir A/B Divergence

## Findings

The literature on PurpleAir A/B channel divergence thresholds converges around a well-established dual-threshold approach. The key studies come from EPA researchers (Barkjohn et al. 2021, 2022) and independent evaluations (Jiao et al. 2023), building on Tryner et al. 2020's foundational work. Thresholds vary by temporal resolution: stricter for 24-hour averages, looser for hourly data due to inherent sensor noise at shorter averaging periods.

**Barkjohn et al. (2021)** established the canonical approach: exclude 24-hour averaged data where channels differ by more than **5 µg/m³ AND 61%** (2 standard deviations of the percent difference distribution). This removed only 2.1% of data. The 5 µg/m³ absolute floor was adopted from Tryner et al. (2020).

**Barkjohn et al. (2022)** applied these criteria to **hourly data** and explicitly relaxed the percentage threshold from 62% to **70%**, stating the relaxation was necessary because sensors exhibit higher noise at hourly averaging. The dual threshold (5 µg/m³ absolute OR 70% relative) for hourly data removed 2.7% of observations.

**Jiao et al. (2023)** used a **30%** threshold for hourly channel agreement in their evaluation, and noted actual differences averaged around 10% with well-functioning sensors. This stricter threshold was for evaluating correction equation performance, not operational data inclusion.

BREATH's `divergenceRatio = |A-B| / avg(A,B)` is mathematically identical to the percent difference formula `|A-B| * 2 / (A+B)` used by Barkjohn, expressed as a ratio. A ratio of 0.7 = 70%.

## Direct Evidence

1. **Barkjohn et al. (2021)**: 24-hour data excluded when `|A-B|*2/(A+B) > 61%` AND `|A-B| > 5 µg/m³`. Removed 2.1% of data.
   - Source: [AMT 14, 4617-4637](https://amt.copernicus.org/articles/14/4617/2021/) / [PMC8422884](https://pmc.ncbi.nlm.nih.gov/articles/PMC8422884/)

2. **Barkjohn et al. (2022)**: For hourly data, relaxed the percentage criterion to **70%**. Used dual threshold: valid if `|A-B| < 5 µg/m³` OR `percent difference < 70%`. Removed 2.7% of hourly averages.
   - Source: [PMC9784900](https://pmc.ncbi.nlm.nih.gov/articles/PMC9784900/)

3. **Jiao et al. (2023)**: Used **30%** threshold for hourly AB channel agreement. Observed actual differences of ~10%.
   - Source: [AMT 16, 1311-1322](https://amt.copernicus.org/articles/16/1311/2023/)

4. **PurpleAir community / EPA citation**: NowCast-related criteria reference **56% for 24-hour data** and **70% for 1-hour data**, combined with 5 µg/m³ absolute floor.
   - Source: [PurpleAir Community — Confidence Values](https://community.purpleair.com/t/explanation-of-the-confidence-values/1766)

5. **Plantower PMS5003 datasheet**: Resolution of 1 µg/m³, effective range 0–500 µg/m³.
   - Source: [AQMD PMS5003 manual](https://www.aqmd.gov/docs/default-source/aq-spec/resources-page/plantower-pms5003-manual_v2-3.pdf)

## Inference

1. BREATH's 0.7 (70%) threshold is directly aligned with Barkjohn et al. (2022) hourly threshold — the EPA's operational standard for the Fire and Smoke Map. BREATH processes near-real-time data, so the hourly threshold is the correct comparison.

2. The 2 µg/m³ near-zero guard is more conservative than the literature's 5 µg/m³ absolute floor. At avg = 2 µg/m³, a 1 µg/m³ difference (within PMS5003 resolution) produces a ratio of 0.5, which scores 0.29 in BREATH — a harsh penalty for sensor quantization noise.

3. The Barkjohn dual-threshold (5 µg/m³ absolute OR percentage) is architecturally different from BREATH's single-threshold-with-floor. Barkjohn considers data valid if EITHER the absolute difference is below 5 µg/m³ OR the percent difference is below 70%. BREATH could penalize data at avg = 3 µg/m³ with a 2 µg/m³ absolute difference (ratio = 0.67, score = 0.04), whereas Barkjohn would keep it.

4. The linear scoring form has no direct literature precedent (the field uses binary exclusion), but it is more information-preserving and aligns with emerging trends in continuous trust scoring.

## Verdict on Current BREATH Value

- **0.7 threshold**: **Defensible.** Directly matches Barkjohn et al. (2022) hourly threshold of 70%, the EPA operational standard.
- **Linear score**: **Defensible with caveat.** No literature precedent for continuous AB-channel scoring, but a reasonable engineering choice. The linear shape is arbitrary — no evidence for or against linear vs sigmoid.
- **2 µg/m³ floor**: **Too strict — should be raised to ~5 µg/m³.** The Barkjohn dual-threshold exempts data when absolute difference is below 5 µg/m³. PMS5003 has 1 µg/m³ resolution, making readings in the 2–5 µg/m³ avg range dominated by quantization noise.

## Recommended Value or Range

| Parameter | Current | Recommended | Rationale |
|-----------|---------|-------------|-----------|
| Threshold | 0.7 | **Keep 0.7** | Matches EPA hourly QC standard |
| Near-zero floor | avg < 2 µg/m³ | **avg < 5 µg/m³** OR adopt Barkjohn dual-threshold: bypass ratio when `\|A-B\| < 5 µg/m³` | Multiple sources converge on 5 µg/m³ as noise floor |
| Scoring form | Linear | **Keep linear** | Reasonable first approximation; no evidence against it |

## Confidence

- **High** for 0.7 threshold (directly matches peer-reviewed EPA standard)
- **Medium** for linear score (no direct precedent but reasonable)
- **High** for 2 µg/m³ floor being too low (multiple sources converge on 5 µg/m³)

## What Would Change My Mind

- Finding that the EPA Fire and Smoke Map has updated its hourly QC threshold since the 2022 Barkjohn publication
- A study comparing continuous vs binary AB-channel QC on downstream correction accuracy
- Evidence that PMS5003 sensors show meaningful (non-noise) channel divergence in the 2–5 µg/m³ range

---

# Lane 2 — AirNow Settlement Drift

## Findings

The literature reveals a clear two-tier architecture in U.S. air quality data: AirNow provides near-real-time hourly observations for public reporting, while AQS stores certified, quality-assured data for regulatory compliance. **No published study was found that directly quantifies the divergence rate between AirNow hourly observations and their AQS-finalized counterparts at the individual-record level.** This gap is itself significant.

Strong indirect evidence constrains the magnitude of likely drift:

**Instrument-level accuracy envelope**: EPA requires continuous PM2.5 monitors reporting to AirNow to be within ±10% bias with correlation ≥ 0.92 with FRM.

**The Teledyne T640 case (2024)**: The most dramatic documented correction — T640/T640X monitors at ~1/3 of U.S. stations had systematic bias requiring an average 20% PM2.5 reduction. EPA retroactively updated all affected AQS data. This is not normal drift but a rare systemic defect.

**AirNow automated QC**: Range checks, sticking checks, rate-of-change checks, and buddy checks. Files for the preceding 48 hours are updated every hour.

**AQS finalization lag**: 90 days after quarter-end for submission; annual certification by May 1 of following year; historical data can be revised years later.

## Direct Evidence

1. **EPA data quality objectives**: ±10% total bias, CV ≤10%, correlation ≥ 0.92 with FRM.
   - Source: [EPA AQS Technical Note](https://www.epa.gov/aqs/aqs-memos-technical-note-reporting-pm25-continuous-monitoring-and-speciation-data-air-quality)

2. **AirNow data is explicitly preliminary**: "These data are not fully verified or validated; they should be considered preliminary and subject to change."
   - Source: [AirNow About the Data](https://www.airnow.gov/about-the-data/)

3. **AQS finalization timeline**: 90 days after quarter-end; May 1 annual certification; revisions possible indefinitely.
   - Source: [About AQS Data](https://aqs.epa.gov/aqsweb/documents/about_aqs_data.html)

4. **Teledyne T640 correction (May 2024)**: Average 20% reduction across ~1/3 of U.S. monitoring sites.
   - Source: [Federal Register 2024-10750](https://www.federalregister.gov/documents/2024/05/16/2024-10750/update-of-pm25-data-from-t640t640x-pm-mass-monitors)

5. **AQCSV format exposes data_status field**: Field 2 distinguishes "0 = Preliminary" from "1 = Final". AirNow current observations are always status 0.
   - Source: [AQCSV Format](https://aqs.epa.gov/aqsweb/documents/AQCSV_Format.html)

6. **GAO Report (2023)**: Both AQS and AirNow "can provide different results for the same prompt regarding air quality assurance standards, largely due to data submitted to AirNow being later corrected."
   - Source: [GAO-23-105618](https://www.gao.gov/products/gao-23-105618)

7. **Corrected PurpleAir vs AirNow NowCast agreement**: 94% category agreement; when categories disagree, 77% differ by < 5 µg/m³.
   - Source: [Barkjohn et al. 2022, PMC9784900](https://pmc.ncbi.nlm.nih.gov/articles/PMC9784900/)

## Inference

1. **Normal-condition drift is bounded by the ±10% bias envelope.** Most drift would NOT cross AQI category boundaries because categories span wide concentration ranges (e.g., PM2.5 "Moderate" is 9.1–35.4 µg/m³). A 10% error on 30 µg/m³ is 3 µg/m³ — well within Moderate.

2. **Category-boundary drift is most likely near threshold values.** At concentrations within ~10% of a boundary, category-crossing is plausible but structurally constrained to a minority of hours.

3. **The 6–18 month AQS finalization lag is incompatible with fast-cycle market settlement.** Waiting for certified data would destroy market function.

4. **BREATH could consume the data_status and qc_code fields** from AirNow as additional metadata, even if not acting on them.

## Verdict on Current BREATH Value

- **AirNow as settlement authority**: **Defensible** for BREATH's use case. AirNow is the best available source for timely settlement. The "preliminary" label reflects EPA regulatory conservatism, not a fundamental quality problem for non-regulatory use.
- **Settlement drift risk**: **Immaterial under normal conditions; material only for rare systemic events** (T640-type corrections, which are multi-year in scope — far beyond BREATH's settlement window).
- **Category-boundary false positives**: **Immaterial for the majority of observations; conditionally material near thresholds** (±10% of boundary values).

## Recommended Value or Range

The current design — AirNow as `settlement_authority` with 0% Brier discount — is appropriate. Three enhancements worth considering:

1. **Capture data quality fields**: Log `data_status` and `qc_code` from AirNow AQCSV in evidence bundles for future drift analysis.
2. **Optional 48-hour reconciliation check**: Re-query AirNow 48h after settlement; log any deltas without blocking settlement.
3. **Threshold-proximity flag**: When AQI falls within 10% of a category boundary, annotate as "boundary-adjacent" (informational only).

## Confidence

**Medium-high.** Well-supported by EPA documentation and structural reasoning. Limited by the absence of a published empirical study directly comparing AirNow hourly values to AQS-finalized counterparts.

## What Would Change My Mind

- A published study showing AirNow-to-AQS divergence rate > 5% of hourly observations crossing AQI category boundaries
- Discovery of another T640-scale systematic bias during BREATH's operating period
- AirNow API returning non-zero qc_code values at > 2–3% rate

---

# Lane 3 — Auto-Spawn Trigger

## Findings

The core question is whether +20 AQI in 2 hours separates real smoke intrusions from background noise. The evidence says yes — with a recommended enhancement.

**Real wildfire events dwarf +20 AQI in 2 hours:**

- **Camp Fire (Nov 2018)**: Sacramento (130 km downwind) went from sub-NAAQS PM2.5 to 50+ µg/m³ "within hours." Peak 263 µg/m³ (24-hr). Bay Area peaked ~200 µg/m³ from a baseline under 9 µg/m³.
- **Oregon Labor Day 2020**: Eugene went from AQI 106 to 342 in one day (+236 AQI). Bend from AQI 37 to 485 in three days. Portland from AQI 18 to 477 in five days. Overnight transitions documented.
- **NYC Canadian Smoke (Jun 2023)**: Normal AQI ~50 → 342+ (Hazardous) within ~24h. Brooklyn hit 413, Queens 407.

**Normal variation is much smaller:** Global diurnal PM2.5 variation averages 13.1% of mean. At clean baselines (5–9 µg/m³), this is ~0.7–1.2 µg/m³ — negligible in AQI terms (~2–4 points). PurpleAir RMSE of ~3–4 µg/m³ could cause ~5–15 AQI point fluctuations on individual readings, but a 2-hour trend smooths most noise.

**No existing system uses rate-of-change triggers.** EPA AirNow, state agencies (CARB, ODEQ, SCAQMD), and commercial systems all use absolute AQI thresholds. BREATH's approach is novel but suited to its early-warning use case.

## Direct Evidence

1. **Camp Fire**: PM2.5 from sub-NAAQS to 50+ µg/m³ within hours at 130–240 km downwind. Sacramento peak 263 µg/m³.
   - Source: [ACP 20, 14597](https://acp.copernicus.org/articles/20/14597/2020/)

2. **Oregon 2020**: Eugene AQI 106 → 342 (Sept 7–8); Bend AQI 37 → 485 (Sept 8–11); Portland AQI 18 → 477 (Sept 8–13).
   - Source: [Oregon DEQ Blog](https://deqblog.com/2020/09/16/wildfire-smoke-brings-record-poor-air-quality-to-oregon-new-data-shows/)

3. **NYC 2023**: AQI ~50 → 342+ on June 7. Daily mean PM2.5 = 117 µg/m³ (3x EPA standard).
   - Sources: [NBC News](https://www.nbcnews.com/news/us-news/live-blog/unhealthy-air-quality-canada-wildfires-live-updates-rcna88092), [CREA](https://energyandcleanair.org/record-breaking-pm2-5-pollution-levels-in-nyc-in-early-june-2023-regular-occurrence-in-over-350-cities-worldwide/)

4. **Diurnal PM2.5 variation**: Global average 13.1% of mean concentration.
   - Source: [ACS EST Letters](https://pubs.acs.org/doi/abs/10.1021/acs.estlett.8b00573)

5. **PurpleAir RMSE**: 3–4 µg/m³ at low concentrations after correction.
   - Source: [Barkjohn et al. 2022, PMC9784900](https://pmc.ncbi.nlm.nih.gov/articles/PMC9784900/)

6. **NowCast algorithm**: w = cmin/cmax, floored at 0.5. No rate-of-change alert mechanism.
   - Source: [Wikipedia NowCast](https://en.wikipedia.org/wiki/NowCast_(air_quality_index))

7. **All identified alert systems use absolute thresholds, not rate-of-change triggers.**
   - Sources: [AirNow Alerts](https://www.airnow.gov/alerts/), [Oregon DEQ](https://www.oregon.gov/deq/aq/pages/air-pollution-advisories.aspx), [SCAQMD](https://www.aqmd.gov/home/air-quality/air-quality-advisories)

## Inference

1. **+20 AQI in 2h would reliably fire during genuine smoke intrusions.** Oregon 2020 data shows 236 AQI points in one day — the steep portion almost certainly exceeded +20/hr. Camp Fire evidence of "within hours" transport maps to +50–70 AQI in 2–4 hours.

2. **+20 AQI in 2h would NOT fire on normal diurnal variation.** Normal swings are ~2–7 AQI points over 2 hours, well below the threshold.

3. **At high absolute AQI (>150), +20 in 2h is normal fluctuation during active smoke events** — wind shifts routinely cause ±20–30 AQI swings. This argues for an absolute floor condition.

4. **The trigger is novel — no existing system provides a direct comparison point.** Rate-of-change detection is arguably better suited to BREATH's early-warning market use case than the absolute thresholds used by public health advisory systems.

## Verdict on Current BREATH Value

- **+20 AQI threshold**: **Defensible** — sits well above normal variation and sensor noise, well below real smoke event rises.
- **2-hour window**: **Defensible** — balances noise rejection (better than 1h) with early detection (Camp Fire evidence confirms meaningful smoke onset within 2h).
- **Absolute floor needed**: **Yes** — the trigger should only fire when conditions are transitioning from non-threatening to threatening. At AQI 180, a +20 swing is noise.

## Recommended Value or Range

| Parameter | Current | Recommended | Rationale |
|-----------|---------|-------------|-----------|
| ΔAQI threshold | +20 | **Keep +20** | Good separation from noise (~2–10 AQI) and real events (50–200+ AQI) |
| Window | 2 hours | **Keep 2h** | Sweet spot between noise rejection and early detection |
| Absolute floor | None | **Add: current AQI < 100** | Prevents false spawning when already elevated |

## Confidence

**Medium.** Directional conclusion well-supported. Specific quantitative calibration constrained by absence of publicly available hour-by-hour AQI time series from smoke onset phases.

## What Would Change My Mind

- Hourly PurpleAir data from the first 6 hours of a smoke event showing the trigger fires too late (AQI already at 150+ by time trend hits +20)
- Analysis showing +20 AQI 2h swings occur > 1% of the time from non-smoke sources
- Discovery of any operational system with rate-of-change triggering and published calibration

---

# Lane 4 — Wildfire Cascade

## Findings

Wildfire smoke events produce highly variable AQI outcomes across sensor networks, with significant spatial heterogeneity even within small regions.

**Camp Fire 2018**: Adjusted PurpleAir data showed AQI ≥ 200 ("Very Unhealthy"/"Hazardous") for ~30% of the time at 135 km downwind, ~10% at 210 km, and ~0–2% at 270 km. The event persisted 11–12 days (264–288 hours).

**California 2020**: 30 consecutive Spare-the-Air days in the Bay Area. AQI reached 200s–300s in parts of the southern Bay Area. The August Complex fire alone burned 55+ days.

**NYC Canadian Smoke (Jun 2023)**: Peak AQI 484, but the severe episode lasted only ~2–3 days. This was a 1000+ km long-range transport event.

**Transport timing**: HYSPLIT trajectory data shows Northwest/Southwest smoke is typically < 24h old; Great Plains smoke averages ~1 day older; Northeast/Midwest smoke > 48h old. Alberta-to-Manitoba (2000 km) documented at ~15h (~130 km/h). Typical boundary-layer transport: 100–200 km in 3–12 hours.

## Direct Evidence

1. **Camp Fire exceedance fraction**: Regulatory-calibrated PurpleAir showed AQI ≥ 200 for ~30% of time at 135 km, ~10% at 210 km, ~0–2% at 270 km.
   - Source: [PMC7374346](https://pmc.ncbi.nlm.nih.gov/articles/PMC7374346/)

2. **AQI 200+ is "infrequent"**: EPA states values above 200 are infrequent; above 300 "extremely rare — they generally occur only during events such as forest fires."
   - Source: [EPA AQI Basics](https://www.airnow.gov/aqi/aqi-basics/)

3. **AQI 150 marks general-population health threshold**: Cal/OSHA wildfire smoke protection triggers at AQI ≥ 151. Research shows 7.2% increase in respiratory admissions when wildfire PM2.5 > 37 µg/m³ (~AQI 110–130).
   - Sources: [Cal/OSHA 5141.1](https://www.dir.ca.gov/title8/5141_1.html), [PMC5130603](https://pmc.ncbi.nlm.nih.gov/articles/PMC5130603/)

4. **Camp Fire persisted 11–12 days; 2020 Bay Area had 30 consecutive alert days.**
   - Sources: [ACP 20, 14597](https://acp.copernicus.org/articles/20/14597/2020/), [Palo Alto Online](https://www.paloaltoonline.com/news/2020/09/14/by-wednesday-bay-area-will-be-under-spare-the-air-alerts-for-30-consecutive-days/)

5. **Short-range transport (< 200 km) arrives within hours.** Long-range Great Plains smoke ~1 day; Northeast/Midwest > 48h.
   - Source: [ACP 18, 1745](https://acp.copernicus.org/articles/18/1745/2018/)

6. **2024 PM2.5 AQI breakpoints**: AQI 150 = 55.4 µg/m³, AQI 200 = 125.4 µg/m³, AQI 300 = 225.4 µg/m³.
   - Source: [EPA AQI Breakpoints](https://aqs.epa.gov/aqsweb/documents/codetables/aqi_breakpoints.html)

7. **Dirichlet distribution is the conjugate prior for categorical/multinomial distributions**: alpha_posterior = alpha_prior + observation_counts.
   - Source: [Dirichlet-Multinomial](https://stephentu.github.io/writeups/dirichlet-conjugate-prior.pdf)

## Inference

1. **Outcomes likely cluster toward the 0–10% bucket** when using AQI ≥ 200. Even during the Camp Fire, exceedance was ~30% at 135 km and near 0% at 270 km. The middle and high buckets (30–50%, 50–70%, 70%+) would require simultaneous exceedance at most sensors — empirically very rare.

2. **AQI 150 would produce more informative bucket distributions**, aligning with the general-population health threshold and the point where hospital admissions start rising.

3. **The uniform prior overweights middle and high buckets.** An empirically grounded prior might look more like [0.45, 0.25, 0.15, 0.10, 0.05] — heavily skewed toward low exceedance.

4. **The +0.15 additive step has no empirical basis** but is not wrong — it is a simplified approximation of Bayesian updating. A Dirichlet conjugate approach would be mathematically principled.

5. **72h is grossly insufficient for regional fires** (Camp Fire: 11–12 days; Bay Area 2020: 30 days). Adequate for short long-range transport events (NYC 2023: 2–3 days).

6. **The 2–12h transport lag is valid for local fires (< ~200 km) only.** Long-range transport takes 12–72+ hours.

## Verdict on Current BREATH Values

- **AQI ≥ 200 threshold**: **Too strict.** Rarely exceeded even during catastrophic fires. AQI ≥ 150 would be more informative while aligning with health thresholds. However, AQI 200 is not indefensible if the goal is predicting truly dangerous conditions.
- **Uniform prior [0.2 × 5]**: **Too permissive toward high buckets.** Outcomes cluster at the low end. Equal weight to 70%+ exceedance is empirically unsupported.
- **+0.15 update step**: **Placeholder, not empirically defensible, but not broken.** Reasonable heuristic; Dirichlet would be more principled.
- **Bucket boundaries**: **Too evenly spaced.** More resolution needed in the 0–30% range where outcomes actually cluster.
- **72h max window**: **Too short for regional fires.** Adequate for long-range transport snapshots. Depends on design intent.
- **2–12h transport lag**: **Defensible for local fires only (< ~200 km).** Not valid for long-range events (24–72+ hours).

## Recommended Value or Range

| Parameter | Current | Recommended | Confidence | Rationale |
|-----------|---------|-------------|------------|-----------|
| Exceedance threshold | AQI ≥ 200 | **AQI ≥ 150** | Medium | Better discrimination; aligns with health threshold |
| Prior | [0.2 × 5] | **[0.40, 0.25, 0.15, 0.12, 0.08]** | Low | Directionally supported; specific weights are inferential |
| Update step | +0.15 additive | **Consider Dirichlet (α += 1)** | Medium | Mathematically principled; practical difference may be small |
| Bucket boundaries | 0–10, 10–30, 30–50, 50–70, 70+ | **0–5%, 5–15%, 15–30%, 30–50%, 50%+** | Low | Better resolution at low end where outcomes cluster |
| Max window | 72h (24h default) | **72–168h depending on trigger type** | Medium | Regional fires last 10–30+ days |
| Transport lag | 2–12h | **2–12h (local); 12–72h (long-range)** | Medium-High | Supported by HYSPLIT data and case studies |

## Confidence

- AQI threshold: **Medium** — strong directional evidence, but optimal value depends on design intent
- Uniform prior: **Medium** — clearly wrong direction, but correct prior requires fire-specific data
- Update step: **Low** — no evidence for or against 0.15 specifically
- Bucket boundaries: **Low** — directionally supported, specific values speculative
- Max window: **Medium-High** — strong evidence events exceed 72h
- Transport lag: **Medium-High** — well-supported for local; insufficient for long-range

## What Would Change My Mind

- Historical PurpleAir data showing AQI ≥ 200 exceedance fractions distribute meaningfully across all five current buckets during typical (not just extreme) wildfire events
- Simulation comparing additive-renormalize vs Dirichlet on realistic wildfire data
- Clarification of design intent: "first 72h after smoke arrival" vs "full event lifetime"

---

# Lane 5 — Sigma Mapping

## Findings

The literature on PurpleAir (Plantower PMS5003) measurement uncertainty after EPA correction is extensive and convergent.

**Corrected sensor performance under typical conditions:**
- Barkjohn et al. (2021): RMSE ~3 µg/m³, MAE ~1.6 µg/m³ on 24-hour averages
- Watt et al. (2023): 5-year RMSE 1.4–2.5 µg/m³ at woodsmoke sites
- Li et al. (2024): Barkjohn model RMSE = 3.52 µg/m³ hourly; improved MLR = 2.96 µg/m³

**Error is strongly concentration-dependent (heteroscedastic).** Wallace et al. (2022) RMSE by concentration: 3 µg/m³ at 0–10 µg/m³, 12 at 44–66, 31 at 200–300, 89 at 400–600, 216 at 600+ µg/m³.

**Critical unit conversion issue:** BREATH's sigma operates in AQI units, but literature reports RMSE in µg/m³. The PM2.5-to-AQI conversion has strongly varying slopes:

| AQI Band | PM2.5 Range (µg/m³) | Slope (AQI/µg) | RMSE 3 µg/m³ → AQI |
|----------|---------------------|-----------------|---------------------|
| 0–50 (Good) | 0–12 | 4.17 | ~12.5 |
| 51–100 (Moderate) | 12.1–35.4 | 2.10 | ~6.3 |
| 101–150 (USG) | 35.5–55.4 | 2.51 | ~7.5 |
| 151–200 (Unhealthy) | 55.5–150.4 | 0.52 | ~1.6 |
| 201–300 (V. Unhealthy) | 150.5–250.4 | 0.99 | ~3.0 |

**Dust events are a catastrophic failure mode**: EPA correction underestimates PM2.5 by 5–6x during dust events.

**Sensor degradation**: Only 2% permanently degraded (240/11,932 studied). Bias drift -0.12 µg/m³/year overall.

## Direct Evidence

1. **Barkjohn et al. (2021)**: EPA correction RMSE = 3 µg/m³, MAE = 1.6 µg/m³, correct AQI category 91%.
   - Source: [PMC8422884](https://pmc.ncbi.nlm.nih.gov/articles/PMC8422884/)

2. **Wallace et al. (2022)**: Corrected RMSE by band — 3 at 0–10, 4 at 10–14, 9 at 28–42, 12 at 44–66, 18 at 120–180, 31 at 200–300, 89 at 400–600, 216 at 600+ µg/m³.
   - Source: [PMC9784900](https://pmc.ncbi.nlm.nih.gov/articles/PMC9784900/)

3. **Jaffe et al. (2023)**: EPA correction 5–6x underestimate for dust aerosols; mean bias 51.4 µg/m³ for dust vs 1.3 µg/m³ for smoke.
   - Source: [AMT 16, 1311](https://amt.copernicus.org/articles/16/1311/2023/)

4. **Watt et al. (2023)**: 5-year RMSE = 2.0 µg/m³ daily, r = 0.98 at woodsmoke sites.
   - Source: [PMC10706150](https://pmc.ncbi.nlm.nih.gov/articles/PMC10706150/)

5. **Li et al. (2024)**: Barkjohn RMSE = 3.52 µg/m³ hourly; improved MLR = 2.96 µg/m³.
   - Source: [PMC11900072](https://pmc.ncbi.nlm.nih.gov/articles/PMC11900072/)

6. **Sensor degradation study**: 2% permanently degraded; flagged measurements +0.93%/year; bias drift -0.12 µg/m³/year.
   - Source: [PMC10208317](https://pmc.ncbi.nlm.nih.gov/articles/PMC10208317/)

7. **Bi et al. (2022)**: A/B channel precision 4.6–5.7% median; LOD 0.6–1.3 µg/m³; bias 3.0% stable over 3 years.
   - Source: [PMC9002513](https://pmc.ncbi.nlm.nih.gov/articles/PMC9002513/)

8. **PMS5003 spec**: ±10 µg/m³ for 0–100 µg/m³; ±10% for 100–500 µg/m³.
   - Source: [AQMD](https://www.aqmd.gov/docs/default-source/aq-spec/resources-page/plantower-pms5003-manual_v2-3.pdf)

## Inference

1. **Best-case sigma in AQI units**: A well-functioning PurpleAir at typical concentrations (< 35 µg/m³) has RMSE ~2–3 µg/m³ PM2.5, translating to ~5–12 AQI units. BREATH's practical minimum (doubt_price ≈ 0.15, sigma ≈ 13) aligns with the upper end. sigma = 5 maps to EPA reference instruments (doubt_price = 0), for which ~1–2 µg/m³ uncertainty is reasonable.

2. **Worst-case sigma in AQI units**: A degraded sensor with RMSE 10–20 µg/m³ PM2.5 maps to 20–80 AQI units at moderate concentrations. sigma = 60 sits within this range. Insufficient for extreme wildfire smoke (RMSE 200+ µg/m³) or dust events (5–6x systematic bias).

3. **Error is both additive (~2–3 µg/m³ floor) and multiplicative (~10% at high concentrations).** A linear doubt-price-to-sigma mapping is a rough approximation; the true error structure is concentration-dependent.

4. **The biggest gap is not the sigma range but the absence of concentration-awareness.** The PM2.5-to-AQI slope varies ~8x across bands (0.52 to 4.17 AQI/µg), meaning the same PM2.5 RMSE produces very different AQI-unit uncertainty depending on concentration.

## Verdict on Current BREATH Value

- **sigma = 5 (best case)**: **Slightly too strict for PurpleAir at low concentrations** (~8–12 AQI uncertainty), but **appropriate for EPA reference instruments** (doubt_price = 0). Since practical PurpleAir minimum is ~13.25, the floor issue is largely theoretical.
- **sigma = 60 (worst case)**: **Roughly defensible** as upper bound for random uncertainty in degraded sensors at typical concentrations. Does not capture systematic biases (dust) or extreme smoke (RMSE > 200 µg/m³ PM2.5).
- **Linear mapping**: **Weakly defensible but suboptimal.** True error is heteroscedastic and PM2.5-to-AQI slope varies by band. A concentration-aware model would be more physically grounded.

## Recommended Value or Range

| Parameter | Current | Recommended | Rationale |
|-----------|---------|-------------|-----------|
| sigma_min (doubt_price=0) | 5 | **Keep 5** | Appropriate for EPA FEM/FRM instruments |
| sigma at PurpleAir baseline (doubt_price≈0.30) | ~21.5 | **Keep ~20** | Consistent with corrected RMSE at typical concentrations |
| sigma_max (doubt_price=0.95) | ~57 | **Keep ~57** | Within plausible range for degraded sensors |
| Mapping shape | Linear | **Consider concentration-aware model**: `sigma = (base + doubt_price * scale) * aqi_slope_factor` | 8x variation in PM2.5→AQI slope makes fixed sigma band-dependent |

## Confidence

**Medium.** PM2.5 RMSE literature is strong and convergent. Translation to AQI-unit sigma involves assumptions about which bands dominate BREATH's operational cases.

## What Would Change My Mind

- Empirical calibration from BREATH itself — comparing PurpleAir-derived AQI predictions against collocated FEM/FRM readings
- Distribution of BREATH predictions across AQI bands (if clustered in 0–50 range, minimum sigma should be higher for PurpleAir)
- Evidence that dust events are significant in BREATH's operational geography
- Studies showing corrected PurpleAir error distributions are non-Gaussian (fat-tailed or skewed)

---

# Cross-Lane Synthesis

## Values Ready to Keep As-Is

| Parameter | Lane | Why |
|-----------|------|-----|
| A/B divergence threshold 0.7 | 1 | Matches EPA hourly QC standard exactly (Barkjohn 2022) |
| AirNow as settlement authority | 2 | Best available fast-settlement source; ±10% bias bounded |
| +20 AQI trigger threshold | 3 | Good separation from noise; fires well above |
| 2-hour trigger window | 3 | Balances noise rejection and early detection |
| sigma range [5, 60] | 5 | Within plausible bounds for the operational range |
| Linear sigma mapping | 5 | Acceptable first approximation |

## Values Needing Recalibration Now

| Parameter | Lane | Current | Recommended | Priority |
|-----------|------|---------|-------------|----------|
| Near-zero floor | 1 | 2 µg/m³ | **5 µg/m³** | **P1** |
| Auto-spawn absolute floor | 3 | None | **Current AQI < 100** | **P1** |
| Wildfire exceedance threshold | 4 | AQI ≥ 200 | **AQI ≥ 150** | **P1** |
| Wildfire prior | 4 | [0.2 × 5] | **Skewed toward low-exceedance** | **P2** |
| Wildfire max window | 4 | 72h | **72–168h** | **P2** |
| Transport lag documentation | 4 | 2–12h | **2–12h local; 12–72h long-range** | **P2** |

## Values Still Literature-Weak (Require Replay or Data Collection)

| Parameter | Lane | What's Needed |
|-----------|------|---------------|
| Wildfire bucket boundaries | 4 | Historical PurpleAir exceedance fraction distributions from 50+ events |
| +0.15 update step | 4 | Simulation comparing additive vs Dirichlet on realistic data |
| Sigma concentration-awareness | 5 | BREATH operational AQI band distribution + collocated FEM comparison |
| Auto-spawn false positive rate | 3 | Analysis of 2-hour AQI deltas during non-smoke conditions |
| AirNow settlement drift rate | 2 | Direct AirNow-vs-AQS comparison study at record level |

## Prioritized Calibration Backlog

**P1 — Change before next release:**
1. Raise A/B divergence near-zero floor from 2 to 5 µg/m³ (or adopt Barkjohn dual-threshold)
2. Add absolute AQI floor (< 100) to auto-spawn trigger
3. Lower wildfire exceedance threshold from AQI 200 to AQI 150

**P2 — Change when feasible:**
4. Skew wildfire prior toward low-exceedance buckets
5. Extend wildfire max window to 72–168h (or parameterize by trigger type)
6. Differentiate transport lag for local vs long-range events

**P3 — Requires empirical data collection:**
7. Redesign wildfire bucket boundaries based on historical exceedance distributions
8. Evaluate Dirichlet updating vs additive-renormalize
9. Add concentration-aware sigma mapping
10. Capture AirNow data_status/qc_code fields in evidence bundles

---

# Final Recommendation

## 1. Which current BREATH values are empirically defensible today?

- **A/B channel divergence threshold (0.7)** — directly matches EPA Barkjohn 2022 hourly standard
- **AirNow as settlement authority** — best available fast-settlement source; drift bounded by ±10%
- **Auto-spawn threshold (+20 AQI)** — good separation from noise and real smoke events
- **Auto-spawn window (2 hours)** — supported by smoke transport evidence
- **Sigma range [5, 60]** — within plausible bounds for corrected sensor error

## 2. Which current BREATH values should be changed before the next release?

- **Near-zero floor (2 µg/m³ → 5 µg/m³)**: Current value penalizes sensor quantization noise. Literature converges on 5 µg/m³.
- **Auto-spawn absolute floor (add AQI < 100)**: Without this, the trigger fires on normal fluctuation during already-elevated smoke conditions.
- **Wildfire exceedance threshold (AQI 200 → 150)**: AQI 200 is too rarely exceeded to produce informative bucket distributions. AQI 150 aligns with health thresholds.

## 3. Which open questions cannot be settled from literature alone?

- **Wildfire bucket boundary optimization**: Requires historical PurpleAir exceedance fraction data from multiple events
- **Additive vs Dirichlet update comparison**: Requires simulation on realistic evidence bundle sequences
- **Concentration-aware sigma calibration**: Requires BREATH operational data + collocated reference comparison
- **AirNow-vs-AQS divergence rate**: No published study quantifies this at the record level
- **Auto-spawn false positive rate**: Requires analysis of 2-hour AQI deltas across seasons and geographies

---

# Source Index

| ID | Citation | URL |
|----|----------|-----|
| B21 | Barkjohn et al. 2021, AMT 14 | https://amt.copernicus.org/articles/14/4617/2021/ |
| B22 | Barkjohn et al. 2022, Sensors (wildfire) | https://pmc.ncbi.nlm.nih.gov/articles/PMC9784900/ |
| J23 | Jiao et al. 2023, AMT 16 | https://amt.copernicus.org/articles/16/1311/2023/ |
| W23 | Watt et al. 2023 (5-year study) | https://pmc.ncbi.nlm.nih.gov/articles/PMC10706150/ |
| L24 | Li et al. 2024 (humidity correction) | https://pmc.ncbi.nlm.nih.gov/articles/PMC11900072/ |
| Bi22 | Bi et al. 2022 (3-year intercomparison) | https://pmc.ncbi.nlm.nih.gov/articles/PMC9002513/ |
| D22 | Degradation study 2022 | https://pmc.ncbi.nlm.nih.gov/articles/PMC10208317/ |
| CF20 | Camp Fire Copernicus study | https://acp.copernicus.org/articles/20/14597/2020/ |
| CF-PA | Camp Fire PurpleAir study | https://pmc.ncbi.nlm.nih.gov/articles/PMC7374346/ |
| ST18 | Smoke transport ACP study | https://acp.copernicus.org/articles/18/1745/2018/ |
| GAO23 | GAO Air Quality Report | https://www.gao.gov/products/gao-23-105618 |
| T640 | Teledyne T640 Federal Register | https://www.federalregister.gov/documents/2024/05/16/2024-10750/ |
| EPA-AQI | EPA AQI Basics | https://www.airnow.gov/aqi/aqi-basics/ |
| EPA-BRK | EPA AQI Breakpoints | https://aqs.epa.gov/aqsweb/documents/codetables/aqi_breakpoints.html |
| PMS | PMS5003 Datasheet | https://www.aqmd.gov/docs/default-source/aq-spec/resources-page/plantower-pms5003-manual_v2-3.pdf |
