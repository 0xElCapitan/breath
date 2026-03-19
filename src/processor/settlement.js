/**
 * Settlement Logic
 *
 * Three-tier settlement assessment for PurpleAir and EPA AirNow evidence bundles.
 *
 * Tier 1 — Oracle (ground_truth):
 *   EPA AirNow confirmed, 0% Brier discount.
 *
 * Tier 2 — Provisional mature:
 *   PurpleAir cross-validated by EPA + 3+ sensors agree + >2h stability + quality ≥ 0.7.
 *   10% Brier discount.
 *
 * Tier 3 — Market freeze:
 *   Theatre expiring with insufficient data.
 *   20% Brier discount.
 *
 * Hard expiry: 25% discount when Theatre resolves on PurpleAir consensus only
 * (EPA never confirmed).
 *
 * Analogous to TREMOR's assessStatusFlip (3-tier: oracle / provisional mature / market freeze).
 */

// ---------------------------------------------------------------------------
// PurpleAir settlement assessment
// ---------------------------------------------------------------------------

/**
 * Assess settlement eligibility for a PurpleAir sensor reading.
 *
 * Evaluation priority (first matching tier wins):
 *   1. sensor_dropout   — missing from expected region
 *   2. channel_inconsistent — A/B divergence too high
 *   3. degraded         — quality score too low
 *   4. provisional_mature — cross-validated, stable, multi-sensor
 *   5. market_freeze    — Theatre expiring with low quality
 *   6. provisional      — default (awaiting EPA confirmation)
 *
 * @param {object} sensor - Normalised PurpleAir sensor reading
 *   @param {string} [sensor.state] - 'active' | 'dropout' | 'degraded'
 * @param {object} quality - From computeQuality()
 * @param {object|null} registryRecord - Sensor registry record
 *   @param {number} [registryRecord.nearby_agreement_count] - Sensors within density radius with similar AQI
 *   @param {number} [registryRecord.last_seen] - Epoch ms of last response
 * @param {boolean} crossValidated - Whether a nearby EPA AirNow monitor agrees
 * @param {number|null} earliestExpiry - Epoch ms of earliest active Theatre expiry
 * @returns {SettlementAssessment}
 */
export function assessSettlement(sensor, quality, registryRecord, crossValidated, earliestExpiry) {
  const now = Date.now();

  // 1. Sensor dropout
  if (sensor.state === 'dropout') {
    return {
      evidence_class: 'sensor_dropout',
      resolution_eligible: false,
      ineligible_reason: 'Sensor not seen in last 2 poll cycles',
      recommended_state: 'sensor_dropout',
      brier_discount: 0.20,
    };
  }

  // 2. Channel inconsistent
  if (quality.components.consistency < 0.4) {
    return {
      evidence_class: 'channel_inconsistent',
      resolution_eligible: false,
      ineligible_reason: 'Channel A/B divergence exceeds consistency threshold (0.4)',
      recommended_state: 'channel_inconsistent',
      brier_discount: 0.20,
    };
  }

  // 3. Degraded quality
  if (quality.score < 0.3) {
    return {
      evidence_class: 'degraded',
      resolution_eligible: false,
      ineligible_reason: 'Quality score below degraded threshold (0.3)',
      recommended_state: 'degraded',
      brier_discount: 0.20,
    };
  }

  // 4. Provisional mature
  const lastSeenMs = registryRecord?.last_seen ?? now;
  // M5: Clamp to 0 — a future last_seen (clock skew, NTP drift) must not
  // produce negative ageHours and silently block provisional_mature.
  const ageHours = Math.max(0, (now - lastSeenMs) / 3_600_000);
  const nearbySensorsCount = registryRecord?.nearby_agreement_count ?? 0;

  if (
    crossValidated &&
    nearbySensorsCount >= 3 &&
    ageHours > 2 &&
    quality.score >= 0.7
  ) {
    return {
      evidence_class: 'provisional_mature',
      resolution_eligible: true,
      ineligible_reason: null,
      recommended_state: 'provisional_mature',
      brier_discount: 0.10,
    };
  }

  // 5. Market freeze: Theatre about to expire with low quality
  if (
    earliestExpiry !== null &&
    (earliestExpiry - now) < 2 * 60 * 60 * 1000 && // < 2h to expiry
    quality.score < 0.5
  ) {
    return {
      evidence_class: 'market_freeze',
      resolution_eligible: false,
      ineligible_reason: 'Market freeze: insufficient quality near Theatre expiry',
      recommended_state: 'market_freeze',
      brier_discount: 0.20,
    };
  }

  // 6. Standard provisional
  return {
    evidence_class: 'provisional',
    resolution_eligible: false,
    ineligible_reason: 'Awaiting EPA AirNow confirmation',
    recommended_state: 'provisional',
    brier_discount: 0,
  };
}

// ---------------------------------------------------------------------------
// EPA AirNow settlement assessment
// ---------------------------------------------------------------------------

/**
 * Settlement assessment for an EPA AirNow observation.
 *
 * AirNow is always the settlement authority for T1 and T3 — ground truth tier,
 * 0% Brier discount, always eligible for Theatre resolution.
 *
 * @returns {SettlementAssessment}
 */
export function assessAirNowSettlement() {
  return {
    evidence_class: 'ground_truth',
    resolution_eligible: true,
    ineligible_reason: null,
    recommended_state: 'ground_truth',
    brier_discount: 0,
  };
}
