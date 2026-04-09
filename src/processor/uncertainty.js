/**
 * Uncertainty Pricing
 *
 * Computes a "doubt price" (0–1) that quantifies how much to discount a
 * sensor reading when updating Theatre position probabilities.
 *
 * doubt_price = 0.0  → absolute certainty (EPA reference grade)
 * doubt_price = 1.0  → no useful information (sensor completely unreliable)
 *
 * The doubt price feeds into thresholdCrossingProbability() which maps
 * an AQI reading + uncertainty to P(AQI ≥ threshold).
 *
 * Analogous to TREMOR's buildMagnitudeUncertainty / thresholdCrossingProbability.
 */

import { classifyConsistency } from './quality.js';

// ---------------------------------------------------------------------------
// Doubt pricing
// ---------------------------------------------------------------------------

/**
 * Build uncertainty model for a PurpleAir sensor reading.
 *
 * @param {object} sensor - Normalised sensor
 *   @param {number} sensor.aqi_computed - Computed AQI
 * @param {object} quality - From computeQuality()
 *   @param {object} quality.components
 *   @param {number} quality.components.consistency - Channel A/B score
 *   @param {number} quality.components.freshness
 *   @param {boolean} quality.cross_validated
 * @param {number|null} theatreThreshold - AQI threshold of the nearest active Theatre, or null
 * @returns {UncertaintyModel}
 */
export function buildUncertainty(sensor, quality, theatreThreshold = null) {
  const consistency = quality.components.consistency;
  const consistency_class = classifyConsistency(consistency);

  // --- Base doubt by channel consistency ---
  // TBD: empirical calibration needed — base doubt prices by
  // consistency class are engineering values
  let doubt_price;
  if (consistency_class === 'inconsistent') {
    // Channel A/B divergence too high — sensor is unreliable
    doubt_price = 0.80;
  } else if (consistency_class === 'divergent') {
    // Elevated but not severe divergence
    doubt_price = 0.45;
  } else {
    // Consistent channels — PurpleAir single-sensor baseline
    doubt_price = 0.30;
  }

  // --- Freshness penalty ---
  if (quality.components.freshness < 0.4) {
    doubt_price = Math.min(0.95, doubt_price + 0.30);
  } else if (quality.components.freshness < 0.7) {
    doubt_price = Math.min(0.95, doubt_price + 0.15);
  }

  // --- Cross-validation discount ---
  if (quality.cross_validated) {
    doubt_price = Math.max(0.05, doubt_price - 0.15);
  }

  // --- Threshold sensitivity amplification ---
  // When AQI is within ±10 of a Theatre threshold, uncertainty at the boundary
  // matters most. Amplify by 30% to reflect this.
  let threshold_sensitivity = false;
  if (
    theatreThreshold !== null &&
    typeof sensor.aqi_computed === 'number' &&
    Math.abs(sensor.aqi_computed - theatreThreshold) <= 10
  ) {
    threshold_sensitivity = true;
    doubt_price = Math.min(0.95, doubt_price * 1.3);
  }

  const basis = deriveDoubtBasis(consistency_class, quality, sensor);

  return {
    doubt_price: Math.round(doubt_price * 1000) / 1000,
    basis,
    threshold_sensitivity,
  };
}

/**
 * Uncertainty model for an EPA AirNow observation.
 *
 * AirNow is settlement authority — doubt is near-zero by default.
 * Slight amplification if the reading is right at a Theatre threshold boundary.
 *
 * @param {number|null} theatreThreshold - AQI threshold or null
 * @param {number} currentAQI - AirNow AQI value
 * @returns {UncertaintyModel}
 */
export function buildAirNowUncertainty(theatreThreshold, currentAQI) {
  const threshold_sensitivity =
    theatreThreshold !== null &&
    typeof currentAQI === 'number' &&
    Math.abs(currentAQI - theatreThreshold) <= 10;

  return {
    doubt_price: threshold_sensitivity ? 0.05 : 0.0,
    basis: 'EPA_AIRNOW_REFERENCE',
    threshold_sensitivity,
  };
}

// ---------------------------------------------------------------------------
// Threshold crossing probability
// ---------------------------------------------------------------------------

/**
 * Compute P(true AQI ≥ threshold) given a measured AQI and doubt price.
 *
 * Maps doubt_price to a sigma in AQI units:
 *   doubt_price=0   → sigma=5  (very tight uncertainty)
 *   doubt_price=1   → sigma=60 (completely uncertain)
 *
 * Then uses Normal CDF: P(exceeds threshold) = Φ(-(threshold - aqi) / sigma)
 *
 * Analogous to TREMOR's thresholdCrossingProbability.
 *
 * @param {number} aqi - Measured AQI
 * @param {number} threshold - Theatre AQI threshold
 * @param {number} doubt_price - 0–1 from buildUncertainty
 * @returns {number} Probability 0–1
 */
export function thresholdCrossingProbability(aqi, threshold, doubt_price) {
  if (typeof aqi !== 'number' || !isFinite(aqi)) return 0.5; // maximum uncertainty
  // source: corrected PurpleAir best-case RMSE is low, but true AQI-unit
  // uncertainty is band-dependent; fixed sigma is an approximation.
  // TBD: concentration-aware sigma model still needed.
  const sigma = 5 + doubt_price * 55;
  const z = (threshold - aqi) / sigma;
  return normalCDF(-z);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Abramowitz & Stegun approximation for the Normal CDF Φ(x).
 * Maximum error < 7.5e-8. Matches TREMOR's implementation.
 *
 * @param {number} x
 * @returns {number} Φ(x)
 */
export function normalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (
    0.3193815 +
    t * (-0.3565638 +
    t * (1.7814779 +
    t * (-1.8212560 +
    t * 1.3302744)))
  );
  return x > 0 ? 1 - p : p;
}

function deriveDoubtBasis(consistency_class, quality, sensor) {
  if (consistency_class === 'inconsistent') return 'CHANNEL_INCONSISTENT';
  if (quality.components.freshness < 0.4) return 'STALE_READING';
  if (quality.cross_validated) return 'PURPLEAIR_EPA_CROSSVALIDATED';
  return 'PURPLEAIR_SINGLE_SENSOR';
}
