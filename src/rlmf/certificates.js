/**
 * RLMF Certificate Export
 *
 * Exports resolved Theatres as RLMF training certificates for the
 * Reinforcement Learning from Market Feedback pipeline.
 *
 * Schema is TREMOR/CORONA compatible — all three constructs emit the same
 * top-level certificate structure for downstream aggregation.
 *
 * Certificate ID: `breath-{theatre_id}-{resolved_at}`
 */

// ---------------------------------------------------------------------------
// Brier scoring
// ---------------------------------------------------------------------------

/**
 * Binary Brier score: B = (1/N) × Σ(p_i − o)²
 *
 * Where o = 1 if outcome is true, 0 if false.
 * Lower is better. Perfect prediction → 0.0.
 *
 * @param {Array<{p: number}>} positionHistory
 * @param {boolean} outcome
 * @returns {number|null} Brier score, or null if history is empty
 */
export function brierScoreBinary(positionHistory, outcome) {
  if (!positionHistory || positionHistory.length === 0) return null;
  const o   = outcome ? 1 : 0;
  const sum = positionHistory.reduce((acc, h) => acc + Math.pow(h.p - o, 2), 0);
  return sum / positionHistory.length;
}

/**
 * Multi-class Brier score for T3 Wildfire Cascade.
 *
 * B = (1/N) × Σ_i Σ_k (p_ik − o_ik)²
 *
 * Where o_ik = 1 if k === outcomeIndex, else 0.
 * Each entry in bucketProbHistory must have a `bucket_probabilities` array.
 *
 * @param {Array<{bucket_probabilities: number[]}>} bucketProbHistory
 * @param {number} outcomeIndex - Bucket index 0–4 that actually resolved
 * @param {number} [numBuckets=5]
 * @returns {number|null}
 */
export function brierScoreMultiClass(bucketProbHistory, outcomeIndex, numBuckets = 5) {
  if (!bucketProbHistory || bucketProbHistory.length === 0) return null;
  let totalScore = 0;
  let validEntries = 0;
  for (const entry of bucketProbHistory) {
    const probs = Array.isArray(entry) ? entry : entry.bucket_probabilities;
    if (!probs) continue;
    let entryScore = 0;
    for (let k = 0; k < numBuckets; k++) {
      const p = probs[k] ?? 0;
      const o = k === outcomeIndex ? 1 : 0;
      entryScore += Math.pow(p - o, 2);
    }
    totalScore += entryScore;
    validEntries++;
  }
  return validEntries > 0 ? totalScore / validEntries : null;
}

// ---------------------------------------------------------------------------
// Performance metrics
// ---------------------------------------------------------------------------

/**
 * Compute lead time in seconds: when did the position first cross 0.5 toward
 * the correct outcome, prior to resolution?
 *
 * Returns 0 if position never crossed 0.5 in the correct direction.
 *
 * @param {Array<{t: number, p: number}>} positionHistory
 * @param {boolean|number} outcome - Boolean for T1/T2; integer bucket for T3
 * @param {number} resolvedAt - Resolution timestamp (epoch ms)
 * @returns {number} Lead time in seconds (0 if none)
 */
export function computeLeadTime(positionHistory, outcome, resolvedAt) {
  if (!positionHistory || positionHistory.length === 0) return 0;
  const correctCross = typeof outcome === 'boolean'
    ? (outcome ? (p => p > 0.5) : (p => p < 0.5))
    : outcome <= 1
      ? (p => p < 0.5)   // T3 bucket 0–1: low cascade (<30% exceeded) — correct if p < 0.5
      : (p => p > 0.5);  // T3 bucket 2–4: high cascade (≥30% exceeded) — correct if p > 0.5

  for (const entry of positionHistory) {
    if (correctCross(entry.p)) {
      const leadMs = (resolvedAt ?? Date.now()) - entry.t;
      return leadMs > 0 ? leadMs / 1000 : 0;
    }
  }
  return 0;
}

/**
 * Compute position volatility: standard deviation of consecutive position changes.
 *
 * @param {Array<{p: number}>} positionHistory
 * @returns {number} Standard deviation, or 0 if fewer than 2 entries
 */
export function computeVolatility(positionHistory) {
  if (!positionHistory || positionHistory.length < 2) return 0;
  const changes = [];
  for (let i = 1; i < positionHistory.length; i++) {
    changes.push(positionHistory[i].p - positionHistory[i - 1].p);
  }
  const mean     = changes.reduce((a, b) => a + b, 0) / changes.length;
  const variance = changes.reduce((acc, c) => acc + Math.pow(c - mean, 2), 0) / changes.length;
  return Math.sqrt(variance);
}

/**
 * Time-weighted Brier score: later predictions are weighted more heavily.
 *
 * Weight for entry i: w_i = (t_i − opens_at) / (resolved_at − opens_at)
 * Weighted B = Σ(w_i × (p_i − o)²) / Σ(w_i)
 *
 * Falls back to unweighted binary Brier if duration is zero or all weights are zero.
 *
 * @param {Array<{t: number, p: number}>} positionHistory
 * @param {boolean|number} outcome
 * @param {number} opensAt
 * @param {number} resolvedAt
 * @returns {number}
 */
function computeTimeWeightedBrier(positionHistory, outcome, opensAt, resolvedAt) {
  if (!positionHistory || positionHistory.length === 0) return 0;
  const duration = (resolvedAt ?? Date.now()) - (opensAt ?? 0);
  if (duration <= 0) return brierScoreBinary(positionHistory, outcome) ?? 0;

  const o = typeof outcome === 'boolean' ? (outcome ? 1 : 0) : null;
  let weightedSum = 0;
  let totalWeight = 0;

  for (const h of positionHistory) {
    const w       = Math.max(0, ((h.t ?? opensAt) - opensAt) / duration);
    const rawScore = o !== null ? Math.pow(h.p - o, 2) : Math.pow(h.p - 0.5, 2);
    weightedSum   += w * rawScore;
    totalWeight   += w;
  }

  return totalWeight > 0
    ? weightedSum / totalWeight
    : brierScoreBinary(positionHistory, outcome) ?? 0;
}

// ---------------------------------------------------------------------------
// Certificate export
// ---------------------------------------------------------------------------

/**
 * Export an RLMF training certificate for a resolved theatre.
 *
 * Handles both binary theatres (T1, T2: boolean outcome) and multi-class
 * theatres (T3 Wildfire Cascade: integer bucket outcome 0–4).
 *
 * @param {object} theatre - Resolved theatre (theatre.state === 'resolved')
 * @param {object} [meta={}] - Optional: { construct_id }
 * @returns {object} RLMFCertificate
 */
export function exportCertificate(theatre, meta = {}) {
  const positionHistory = theatre.position_history ?? [];
  const outcome         = theatre.outcome;
  const isMultiClass    = theatre.template === 'wildfire_cascade';

  // Brier score
  let brierScore;
  if (isMultiClass) {
    const bucketProbHistory = positionHistory.filter(h => h.bucket_probabilities);
    brierScore = brierScoreMultiClass(bucketProbHistory, outcome, 5) ?? 0;
  } else {
    brierScore = brierScoreBinary(positionHistory, outcome) ?? 0;
  }

  const brierTimeWeighted = computeTimeWeightedBrier(
    positionHistory, outcome, theatre.opens_at, theatre.resolved_at,
  );

  const leadTime   = computeLeadTime(positionHistory, outcome, theatre.resolved_at);
  const volatility = computeVolatility(positionHistory);

  // Directional accuracy: was final pre-resolution position in the correct direction?
  const finalP = positionHistory[positionHistory.length - 1]?.p ?? 0.5;
  const directionalAccuracy = typeof outcome === 'boolean'
    ? (outcome ? finalP > 0.5 : finalP < 0.5)
    : outcome <= 1
      ? finalP < 0.5   // T3 bucket 0–1: low cascade — correct if position leaned low
      : finalP > 0.5;  // T3 bucket 2–4: high cascade — correct if position leaned high

  return {
    certificate_id: `breath-${theatre.id}-${theatre.resolved_at}`,
    construct:      meta.construct_id ?? 'BREATH',
    theatre_id:     theatre.id,
    template:       theatre.template,
    outcome,
    opened_at:      theatre.opens_at,
    resolved_at:    theatre.resolved_at,
    performance: {
      brier_score:          brierScore,
      brier_time_weighted:  brierTimeWeighted,
      position_history:     positionHistory,
      directional_accuracy: directionalAccuracy,
      lead_time_seconds:    leadTime,
      volatility,
    },
    evidence_summary: {
      total_bundles:          theatre.evidence_bundles?.length ?? 0,
      by_evidence_class:      {},
      by_source:              {},
      epa_airnow_confirmed:   theatre.resolving_bundle_id?.includes('airnow') ?? false,
      purpleair_sensor_count: theatre.unique_sensor_count ?? 0,
    },
    brier_discount:  theatre.resolution?.brier_discount ?? 0,
    settlement_tier: theatre.resolution?.recommended_state ?? 'unknown',
  };
}
