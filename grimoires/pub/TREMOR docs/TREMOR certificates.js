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
 *   - Paradox Engine event count
 *   - On-chain P&L attribution
 *
 * This is the product. The prediction market is the factory.
 * The training data is what comes out.
 */

/**
 * Compute Brier score for a binary outcome.
 *
 * BS = (forecast - outcome)²
 * Range: 0 (perfect) to 1 (worst)
 *
 * @param {number} forecast - Predicted probability [0, 1]
 * @param {boolean} outcome - Did the event occur?
 * @returns {number} Brier score
 */
export function brierScoreBinary(forecast, outcome) {
  const o = outcome ? 1 : 0;
  return Math.round(Math.pow(forecast - o, 2) * 10000) / 10000;
}

/**
 * Compute Brier score for a multi-class outcome (e.g., aftershock buckets).
 *
 * BS = (1/R) Σ (f_i - o_i)²
 * where R = number of classes
 *
 * @param {number[]} forecasts - Predicted probabilities for each class (sum to 1)
 * @param {number} outcomeIndex - Index of the class that actually occurred
 * @returns {number} Brier score
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
 * Assign a calibration bucket for the forecast.
 * Buckets: 0.0-0.1, 0.1-0.2, ..., 0.9-1.0
 *
 * Used to assess calibration across many forecasts:
 * of all times the construct said "30%", did it happen ~30% of the time?
 *
 * @param {number} forecast - Predicted probability
 * @returns {string} Bucket label e.g. "0.2-0.3"
 */
export function calibrationBucket(forecast) {
  const lower = Math.floor(forecast * 10) / 10;
  const upper = Math.min(1.0, lower + 0.1);
  return `${lower.toFixed(1)}-${upper.toFixed(1)}`;
}

/**
 * Export an RLMF certificate from a resolved Theatre.
 *
 * @param {object} theatre - Resolved theatre with position history
 * @param {object} options - Optional overrides
 * @param {string} options.construct_id - Construct identifier
 * @param {object} options.on_chain - On-chain P&L data {tx_hash, pnl_bera, gas_cost}
 * @returns {object} RLMF certificate
 */
export function exportCertificate(theatre, options = {}) {
  if (theatre.state !== 'resolved' && theatre.state !== 'expired') {
    throw new Error(`Cannot export certificate for theatre in state: ${theatre.state}`);
  }

  const constructId = options.construct_id ?? 'TREMOR';
  const history = theatre.position_history;
  const openingPosition = history[0]?.p ?? 0.5;
  const closingPosition = theatre.current_position;
  const outcome = theatre.outcome;

  // Compute Brier score
  const brierRaw = brierScoreBinary(closingPosition, outcome);

  // Apply settlement discount if applicable
  // (stored on the theatre by the settlement logic)
  const brierDiscount = theatre.resolution?.brier_discount ?? 0;
  const brierAdjusted = Math.round((brierRaw * (1 + brierDiscount)) * 10000) / 10000;

  // Count Paradox Engine events in position history
  const paradoxEvents = history.filter(
    (h) => h.reason && h.reason.includes('paradox')
  ).length;

  // Count cross-validation divergences
  const divergenceEvents = history.filter(
    (h) => h.reason && (h.reason.includes('diverge') || h.reason.includes('EMSC'))
  ).length;

  return {
    certificate_id: `tremor-rlmf-${theatre.id}-${constructId}`,
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
      divergence_events: divergenceEvents,
    },

    // Temporal analysis — how the construct's belief evolved
    temporal: {
      duration_ms: (theatre.resolved_at ?? Date.now()) - theatre.opens_at,
      // Belief volatility: mean absolute change between updates
      volatility: computeVolatility(history),
      // Direction: did the construct move toward or away from the outcome?
      directional_accuracy: computeDirectionalAccuracy(history, outcome),
      // Time-weighted Brier: early correct beliefs count more
      time_weighted_brier: computeTimeWeightedBrier(history, outcome, theatre.opens_at, theatre.resolved_at ?? Date.now()),
    },

    on_chain: options.on_chain ?? null,
  };
}

// --- Temporal analysis helpers ---

/**
 * Mean absolute change between consecutive position updates.
 * High volatility = construct is uncertain / frequently revising.
 */
function computeVolatility(history) {
  if (history.length < 2) return 0;
  let totalChange = 0;
  for (let i = 1; i < history.length; i++) {
    totalChange += Math.abs(history[i].p - history[i - 1].p);
  }
  return Math.round((totalChange / (history.length - 1)) * 10000) / 10000;
}

/**
 * Fraction of position updates that moved toward the eventual outcome.
 * 1.0 = every update moved in the right direction.
 * 0.0 = every update moved the wrong way.
 */
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

/**
 * Time-weighted Brier score: earlier correct beliefs count more.
 *
 * Rewards constructs that converge on the right answer early.
 * Uses exponential decay weighting.
 */
function computeTimeWeightedBrier(history, outcome, openTime, closeTime) {
  if (history.length === 0) return 1;
  const duration = closeTime - openTime;
  if (duration === 0) return brierScoreBinary(history[0].p, outcome);

  const target = outcome ? 1 : 0;
  let weightedSum = 0;
  let totalWeight = 0;

  for (const entry of history) {
    const elapsed = (entry.t - openTime) / duration; // 0 to 1
    const weight = Math.exp(-elapsed); // early = high weight
    const error = Math.pow(entry.p - target, 2);
    weightedSum += error * weight;
    totalWeight += weight;
  }

  return Math.round((weightedSum / totalWeight) * 10000) / 10000;
}
