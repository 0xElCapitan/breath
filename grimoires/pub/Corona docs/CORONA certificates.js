/**
 * RLMF Certificate Export
 *
 * Converts resolved Theatres into calibrated training data for the
 * Echelon RLMF pipeline.
 *
 * Each certificate contains:
 *   - Brier score (binary or multi-class)
 *   - Full position history with evidence references
 *   - Calibration bucket assignment
 *   - Temporal analysis (volatility, directional accuracy, time-weighted Brier)
 *   - On-chain P&L attribution
 *
 * Identical schema to TREMOR certificates for pipeline compatibility.
 */

/**
 * Compute Brier score for a binary outcome.
 * BS = (forecast - outcome)²
 * Range: 0 (perfect) to 1 (worst)
 */
export function brierScoreBinary(forecast, outcome) {
  const o = outcome ? 1 : 0;
  return Math.round(Math.pow(forecast - o, 2) * 10000) / 10000;
}

/**
 * Compute Brier score for a multi-class outcome.
 * BS = (1/R) Σ (f_i - o_i)²
 */
export function brierScoreMultiClass(forecasts, outcomeIndex) {
  let sum = 0;
  for (let i = 0; i < forecasts.length; i++) {
    const o = i === outcomeIndex ? 1 : 0;
    sum += Math.pow(forecasts[i] - o, 2);
  }
  return Math.round((sum / forecasts.length) * 10000) / 10000;
}

/**
 * Assign calibration bucket.
 * Buckets: 0.0-0.1, 0.1-0.2, ..., 0.9-1.0
 */
export function calibrationBucket(forecast) {
  // For multi-class (array), use the max probability
  const p = Array.isArray(forecast) ? Math.max(...forecast) : forecast;
  const lower = Math.floor(p * 10) / 10;
  const upper = Math.min(1.0, lower + 0.1);
  return `${lower.toFixed(1)}-${upper.toFixed(1)}`;
}

/**
 * Export an RLMF certificate from a resolved Theatre.
 *
 * @param {object} theatre - Resolved theatre with position history
 * @param {object} options
 * @param {string} [options.construct_id] - Construct identifier
 * @param {object} [options.on_chain] - On-chain P&L data
 * @returns {object} RLMF certificate
 */
export function exportCertificate(theatre, options = {}) {
  if (theatre.state !== 'resolved' && theatre.state !== 'expired') {
    throw new Error(`Cannot export certificate for theatre in state: ${theatre.state}`);
  }

  const constructId = options.construct_id ?? 'CORONA';
  const history = theatre.position_history;
  const openingPosition = history[0]?.p ?? 0.5;
  const closingPosition = theatre.current_position;
  const outcome = theatre.outcome;

  // Compute Brier score
  const isMultiClass = Array.isArray(closingPosition);
  let brierRaw;
  if (isMultiClass) {
    brierRaw = typeof outcome === 'number'
      ? brierScoreMultiClass(closingPosition, outcome)
      : 0.5;
  } else {
    brierRaw = brierScoreBinary(closingPosition, outcome);
  }

  // Apply settlement discount
  const brierDiscount = theatre.resolution?.brier_discount ?? 0;
  const brierAdjusted = Math.round((brierRaw * (1 + brierDiscount)) * 10000) / 10000;

  // Count paradox events
  const paradoxEvents = history.filter(
    (h) => h.reason && h.reason.includes('diverge')
  ).length;

  // Count cross-validation events
  const crossValEvents = history.filter(
    (h) => h.reason && (h.reason.includes('DONKI') || h.reason.includes('cross'))
  ).length;

  return {
    certificate_id: `corona-rlmf-${theatre.id}-${constructId}`,
    construct: constructId,
    version: '0.1.0',
    exported_at: Date.now(),

    theatre: {
      id: theatre.id,
      template: theatre.template,
      question: theatre.question,
      opened: theatre.opens_at,
      closed: theatre.resolved_at ?? Date.now(),
      outcome,
    },

    performance: {
      brier_score: brierRaw,
      brier_adjusted: brierAdjusted,
      brier_discount: brierDiscount,
      opening_position: openingPosition,
      closing_position: closingPosition,
      position_history: history.map((h) => ({
        t: h.t,
        p: h.p,
        evidence: h.evidence,
      })),
      n_updates: history.length,
      n_evidence_bundles: theatre.evidence_bundles.length,
      calibration_bucket: calibrationBucket(closingPosition),
      paradox_events: paradoxEvents,
      cross_validation_events: crossValEvents,
    },

    temporal: {
      duration_ms: (theatre.resolved_at ?? Date.now()) - theatre.opens_at,
      volatility: computeVolatility(history),
      directional_accuracy: isMultiClass
        ? computeMultiClassDirectionalAccuracy(history, outcome)
        : computeDirectionalAccuracy(history, outcome),
      time_weighted_brier: isMultiClass
        ? brierRaw // Simplified for multi-class
        : computeTimeWeightedBrier(history, outcome, theatre.opens_at, theatre.resolved_at ?? Date.now()),
    },

    on_chain: options.on_chain ?? null,
  };
}

// =========================================================================
// Temporal analysis helpers
// =========================================================================

function computeVolatility(history) {
  if (history.length < 2) return 0;
  let totalChange = 0;
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].p;
    const curr = history[i].p;
    if (Array.isArray(prev) && Array.isArray(curr)) {
      // Multi-class: sum of absolute changes across buckets
      let change = 0;
      for (let j = 0; j < prev.length; j++) {
        change += Math.abs((curr[j] ?? 0) - (prev[j] ?? 0));
      }
      totalChange += change / prev.length;
    } else {
      totalChange += Math.abs(curr - prev);
    }
  }
  return Math.round((totalChange / (history.length - 1)) * 10000) / 10000;
}

function computeDirectionalAccuracy(history, outcome) {
  if (history.length < 2) return 0.5;
  const target = outcome ? 1 : 0;
  let correct = 0;
  for (let i = 1; i < history.length; i++) {
    const prevDist = Math.abs(history[i - 1].p - target);
    const currDist = Math.abs(history[i].p - target);
    if (currDist < prevDist) correct++;
  }
  return Math.round((correct / (history.length - 1)) * 1000) / 1000;
}

function computeMultiClassDirectionalAccuracy(history, outcomeIndex) {
  if (history.length < 2 || typeof outcomeIndex !== 'number') return 0.5;
  let correct = 0;
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].p;
    const curr = history[i].p;
    if (!Array.isArray(prev) || !Array.isArray(curr)) continue;
    const prevProb = prev[outcomeIndex] ?? 0;
    const currProb = curr[outcomeIndex] ?? 0;
    if (currProb > prevProb) correct++;
  }
  return Math.round((correct / Math.max(1, history.length - 1)) * 1000) / 1000;
}

function computeTimeWeightedBrier(history, outcome, openTime, closeTime) {
  if (history.length === 0) return 1;
  const duration = closeTime - openTime;
  if (duration === 0) return brierScoreBinary(history[0].p, outcome);

  const target = outcome ? 1 : 0;
  let weightedSum = 0;
  let totalWeight = 0;

  for (const entry of history) {
    const elapsed = (entry.t - openTime) / duration;
    const weight = Math.exp(-elapsed);
    const error = Math.pow(entry.p - target, 2);
    weightedSum += error * weight;
    totalWeight += weight;
  }

  return Math.round((weightedSum / totalWeight) * 10000) / 10000;
}
