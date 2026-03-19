/**
 * Aftershock Cascade Theatre
 *
 * Multi-class market: "Given mainshock M≥6.0 at T₀, how many M≥4.0
 * aftershocks within 72 hours?"
 *
 * Buckets: 0-2, 3-5, 6-10, 11-20, 21+
 *
 * This is the richest RLMF producer — the position history captures
 * a complete time-series of Bayesian updating as aftershocks stream in.
 * The construct's belief trajectory (how it shifted from Omori-law prior
 * to calibrated posterior) is the highest-value training data export.
 */

/**
 * Modified Omori-law parameters by tectonic regime.
 *
 * The Omori-Utsu law: n(t) = K / (t + c)^p
 * where n(t) = aftershock rate at time t after mainshock,
 * K = productivity, c = time offset, p = decay exponent.
 *
 * Bath's law: largest aftershock ≈ mainshock - 1.2
 *
 * These are approximate parameters. In production, calibrate from
 * historical sequences per tectonic regime.
 */
const REGIME_PARAMS = {
  subduction: { K: 25, c: 0.05, p: 1.05, bath_delta: 1.1 },
  transform:  { K: 15, c: 0.03, p: 1.10, bath_delta: 1.2 },
  intraplate: { K: 8,  c: 0.08, p: 0.95, bath_delta: 1.3 },
  volcanic:   { K: 30, c: 0.02, p: 0.90, bath_delta: 1.0 },
  default:    { K: 18, c: 0.05, p: 1.00, bath_delta: 1.2 },
};

const BUCKETS = [
  { label: '0-2',  min: 0,  max: 2 },
  { label: '3-5',  min: 3,  max: 5 },
  { label: '6-10', min: 6,  max: 10 },
  { label: '11-20', min: 11, max: 20 },
  { label: '21+',  min: 21, max: Infinity },
];

/**
 * Estimate expected aftershock count from Omori-law parameters.
 *
 * Integrates n(t) = K / (t + c)^p from t=0 to t=T
 * For p ≠ 1: N(T) = K * [(T+c)^(1-p) - c^(1-p)] / (1-p)
 * For p = 1: N(T) = K * ln((T+c)/c)
 *
 * @param {object} params - Omori parameters {K, c, p}
 * @param {number} mainMag - Mainshock magnitude
 * @param {number} thresholdMag - Minimum aftershock magnitude to count
 * @param {number} windowHours - Prediction window
 * @returns {number} Expected aftershock count
 */
function omoriExpectedCount(params, mainMag, thresholdMag, windowHours) {
  const { K, c, p } = params;

  // Scale productivity by magnitude difference (Reasenberg & Jones 1989)
  // Higher mainshock → more aftershocks above threshold
  const magDiff = mainMag - thresholdMag;
  const scaledK = K * Math.pow(10, 0.75 * (magDiff - 1));

  const T = windowHours / 24; // Convert to days (Omori convention)

  let expectedN;
  if (Math.abs(p - 1) < 0.001) {
    expectedN = scaledK * Math.log((T + c) / c);
  } else {
    expectedN = scaledK * (Math.pow(T + c, 1 - p) - Math.pow(c, 1 - p)) / (1 - p);
  }

  return Math.max(0, expectedN);
}

/**
 * Convert expected count to bucket probabilities.
 *
 * Uses a Poisson-like distribution centered on the expected count
 * to assign probability mass to each bucket.
 *
 * @param {number} expectedCount - From Omori model
 * @returns {number[]} Probabilities for each bucket (sum to ~1)
 */
function countToBucketProbabilities(expectedCount) {
  const probs = BUCKETS.map(({ min, max }) => {
    // Probability of Poisson count falling in [min, max]
    let p = 0;
    const upper = Math.min(max, 50); // cap for computation
    for (let k = min; k <= upper; k++) {
      p += poissonPMF(expectedCount, k);
    }
    // For 21+ bucket, add tail
    if (max === Infinity) {
      let tailP = 0;
      for (let k = 0; k < min; k++) {
        tailP += poissonPMF(expectedCount, k);
      }
      p = Math.max(p, 1 - tailP);
    }
    return p;
  });

  // Normalize to sum to 1
  const total = probs.reduce((s, p) => s + p, 0);
  return probs.map((p) => Math.round((p / total) * 1000) / 1000);
}

function poissonPMF(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  // log-space to avoid overflow for large lambda
  const logP = k * Math.log(lambda) - lambda - logFactorial(k);
  return Math.exp(logP);
}

function logFactorial(n) {
  if (n <= 1) return 0;
  let sum = 0;
  for (let i = 2; i <= n; i++) sum += Math.log(i);
  return sum;
}

/**
 * Infer tectonic regime from depth and location.
 * Rough heuristic — in production use a proper tectonic regionalization.
 */
function inferRegime(depth_km, lat, lon) {
  if (depth_km > 100) return 'subduction';
  if (depth_km > 50) return 'subduction';
  // Pacific ring of fire rough bounds
  if ((lon < -100 && lon > -180 && lat > -60 && lat < 60) ||
      (lon > 100 && lat > -60 && lat < 60)) {
    return depth_km > 30 ? 'subduction' : 'transform';
  }
  // Mid-ocean ridge zones
  if (Math.abs(lat) < 10 && (lon > -50 && lon < -10)) return 'transform';
  return 'default';
}

// =========================================================================
// Theatre lifecycle
// =========================================================================

/**
 * Create an Aftershock Cascade theatre.
 *
 * Auto-spawns when TREMOR detects a M≥6.0 event.
 *
 * @param {object} params
 * @param {object} params.mainshockBundle - Evidence bundle for the triggering mainshock
 * @param {number} [params.threshold_mag] - Minimum aftershock magnitude (default 4.0)
 * @param {number} [params.window_hours] - Prediction window (default 72)
 * @param {string} [params.regime] - Tectonic regime override
 * @returns {object} Theatre definition
 */
export function createAftershockCascade({
  mainshockBundle,
  threshold_mag = 4.0,
  window_hours = 72,
  regime = null,
}) {
  const mainMag = mainshockBundle.payload.magnitude.value;
  const loc = mainshockBundle.payload.location;

  if (mainMag < 6.0) return null;

  const now = Date.now();
  const inferredRegime = regime || inferRegime(loc.depth_km, loc.latitude, loc.longitude);
  const params = REGIME_PARAMS[inferredRegime] || REGIME_PARAMS.default;

  // Compute initial bucket probabilities from Omori model
  const expectedCount = omoriExpectedCount(params, mainMag, threshold_mag, window_hours);
  const initialProbs = countToBucketProbabilities(expectedCount);

  // Rupture length estimate for spatial matching (Wells & Coppersmith 1994)
  // log10(L) = -3.22 + 0.69*M → L in km
  const ruptureLength = Math.pow(10, -3.22 + 0.69 * mainMag);
  const matchRadius = ruptureLength * 1.5; // 1.5× rupture length

  // Convert to approximate degree radius
  const degreeRadius = matchRadius / 111;

  return {
    id: `T2-AFTERSHOCK-${mainshockBundle.payload.event_id}-${now}`,
    template: 'aftershock_cascade',
    question: `M≥${mainMag} mainshock: how many M≥${threshold_mag} aftershocks within ${window_hours}h?`,
    mainshock: {
      event_id: mainshockBundle.payload.event_id,
      magnitude: mainMag,
      location: loc,
      time: mainshockBundle.payload.event_time,
    },
    threshold_mag,
    region_bbox: [
      loc.longitude - degreeRadius,
      loc.latitude - degreeRadius,
      loc.longitude + degreeRadius,
      loc.latitude + degreeRadius,
    ],
    magnitude_threshold: threshold_mag,
    opens_at: now,
    closes_at: now + window_hours * 60 * 60 * 1000,
    state: 'open',
    outcome: null, // bucket index on resolution

    // Omori model state
    omori: {
      regime: inferredRegime,
      params,
      expected_count: Math.round(expectedCount * 10) / 10,
      rupture_length_km: Math.round(ruptureLength * 10) / 10,
      match_radius_deg: Math.round(degreeRadius * 100) / 100,
    },

    // Multi-class position: probability per bucket
    bucket_labels: BUCKETS.map((b) => b.label),
    current_position: initialProbs,
    aftershock_count: 0,
    aftershock_events: [],

    position_history: [
      {
        t: now,
        p: initialProbs,
        aftershock_count: 0,
        evidence: mainshockBundle.bundle_id,
        reason: `Omori prior (${inferredRegime}): expected ${expectedCount.toFixed(1)} aftershocks`,
      },
    ],
    evidence_bundles: [mainshockBundle.bundle_id],
    resolving_bundle_id: null,
    resolved_at: null,
  };
}

/**
 * Process an aftershock evidence bundle.
 *
 * Each aftershock updates the count and recomputes bucket probabilities
 * by blending the Omori prior with the observed rate.
 *
 * @param {object} theatre - Aftershock Cascade theatre
 * @param {object} bundle - Evidence bundle for a potential aftershock
 * @returns {object} Updated theatre
 */
export function processAftershockCascade(theatre, bundle) {
  if (theatre.state === 'resolved' || theatre.state === 'expired') {
    return theatre;
  }

  const mag = bundle.payload.magnitude.value;
  const threshold = theatre.threshold_mag;

  const updated = { ...theatre };
  updated.evidence_bundles = [...theatre.evidence_bundles, bundle.bundle_id];

  // Only count events at or above threshold
  if (mag < threshold) {
    // Sub-threshold event — still evidence (b-value signal) but doesn't increment count
    updated.position_history = [
      ...theatre.position_history,
      {
        t: Date.now(),
        p: theatre.current_position,
        aftershock_count: theatre.aftershock_count,
        evidence: bundle.bundle_id,
        reason: `Sub-threshold M${mag} — no count change (b-value signal)`,
      },
    ];
    return updated;
  }

  // Count this aftershock
  const newCount = theatre.aftershock_count + 1;
  updated.aftershock_count = newCount;
  updated.aftershock_events = [
    ...theatre.aftershock_events,
    {
      bundle_id: bundle.bundle_id,
      magnitude: mag,
      time: bundle.payload.event_time,
      evidence_class: bundle.evidence_class,
    },
  ];

  // Recompute bucket probabilities
  // Blend: weight observed rate more as more aftershocks arrive
  const elapsed = (Date.now() - theatre.opens_at) / (1000 * 60 * 60); // hours
  const remaining = Math.max(1, (theatre.closes_at - Date.now()) / (1000 * 60 * 60));
  const totalWindow = (theatre.closes_at - theatre.opens_at) / (1000 * 60 * 60);

  // Observed rate extrapolation
  const rate = elapsed > 0 ? newCount / elapsed : newCount;
  const projectedTotal = newCount + rate * remaining * 0.7; // 0.7 = Omori decay correction

  // Blend Omori prior with observed projection
  const omoriWeight = Math.max(0.1, 1 - (elapsed / totalWindow));
  const obsWeight = 1 - omoriWeight;
  const blendedExpected =
    omoriWeight * theatre.omori.expected_count +
    obsWeight * projectedTotal;

  const newProbs = countToBucketProbabilities(blendedExpected);

  updated.current_position = newProbs;
  updated.position_history = [
    ...theatre.position_history,
    {
      t: Date.now(),
      p: newProbs,
      aftershock_count: newCount,
      evidence: bundle.bundle_id,
      reason:
        `M${mag} aftershock #${newCount} — ` +
        `rate=${rate.toFixed(2)}/hr, projected=${projectedTotal.toFixed(1)}, ` +
        `blended=${blendedExpected.toFixed(1)} (omori_w=${omoriWeight.toFixed(2)})`,
    },
  ];

  return updated;
}

/**
 * Resolve the Aftershock Cascade at theatre close.
 *
 * @param {object} theatre - Aftershock Cascade theatre
 * @returns {object} Resolved theatre with outcome = bucket index
 */
export function resolveAftershockCascade(theatre) {
  if (theatre.state === 'resolved') return theatre;

  const count = theatre.aftershock_count;

  // Find which bucket the final count falls into
  const outcomeIndex = BUCKETS.findIndex(
    ({ min, max }) => count >= min && count <= max
  );

  return {
    ...theatre,
    state: 'resolved',
    outcome: outcomeIndex >= 0 ? outcomeIndex : BUCKETS.length - 1,
    resolved_at: Date.now(),
    position_history: [
      ...theatre.position_history,
      {
        t: Date.now(),
        p: theatre.current_position,
        aftershock_count: count,
        evidence: null,
        reason: `Theatre closed — final count: ${count} → bucket "${BUCKETS[outcomeIndex >= 0 ? outcomeIndex : BUCKETS.length - 1].label}"`,
      },
    ],
  };
}

export { BUCKETS, REGIME_PARAMS };
