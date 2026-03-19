/**
 * Uncertainty pricing for space weather measurements.
 *
 * Analogous to TREMOR's magnitude uncertainty — converts raw measurements
 * into priced uncertainty distributions for theatre position updates.
 *
 * Key uncertainties in space weather:
 *   - Flare class reclassification (automatic → final, peak flux revision)
 *   - GOES primary/secondary satellite switching
 *   - Kp preliminary vs definitive (30-day lag for GFZ definitive)
 *   - CME arrival time (WSA-Enlil model ±6-12 hours typical)
 *   - Proton flux background subtraction
 */

import { classToFlux, classifyFlux, flareRank } from '../oracles/swpc.js';

// =========================================================================
// Flare uncertainty
// =========================================================================

/**
 * Typical flare class reclassification magnitudes.
 *
 * During a flare's rise phase, GOES may report an initial class
 * that gets revised upward or downward at peak and again at end.
 * Historical analysis shows:
 *   - 15% of M-class flares get reclassified by ≥0.5 sub-class units
 *   - 5% of flares cross a class boundary (e.g. C9.9 → M1.0)
 *   - X-class flares rarely get downgraded
 *
 * Doubt price = cost of uncertainty in the classification.
 */
const FLARE_UNCERTAINTY = {
  // In-progress flares have high uncertainty
  eventInProgress: {
    sigma_fraction: 0.3,  // 30% flux uncertainty
    doubt_base: 0.4,
  },
  // Complete but unconfirmed
  complete: {
    sigma_fraction: 0.1,
    doubt_base: 0.1,
  },
  // DONKI-confirmed (curated)
  confirmed: {
    sigma_fraction: 0.05,
    doubt_base: 0.05,
  },
};

/**
 * Build uncertainty estimate for a solar flare.
 *
 * @param {object} flareEvent - Flare data with class info
 * @returns {object} Uncertainty structure with doubt price and confidence interval
 */
export function buildFlareUncertainty(flareEvent) {
  const classString = flareEvent.max_class ?? flareEvent.class_type ?? 'C1.0';
  const flux = flareEvent.max_xray_flux ?? classToFlux(classString) ?? 1e-6;
  const status = flareEvent.status ?? 'complete';
  const params = FLARE_UNCERTAINTY[status] ?? FLARE_UNCERTAINTY.complete;

  const sigma = flux * params.sigma_fraction;
  const fluxLow = Math.max(1e-8, flux - 1.96 * sigma);
  const fluxHigh = flux + 1.96 * sigma;

  const classLow = classifyFlux(fluxLow);
  const classHigh = classifyFlux(fluxHigh);

  // Doubt price: higher when the uncertainty spans a class boundary
  let doubt = params.doubt_base;
  if (classLow.letter !== classHigh.letter) {
    doubt += 0.2; // Class boundary crossing adds significant doubt
  }
  if (status === 'eventInProgress') {
    doubt += 0.15; // Ongoing flares can still intensify
  }
  doubt = Math.min(doubt, 0.95);

  return {
    value: flux,
    class_string: classString,
    rank: flareRank(classString),
    sigma,
    confidence_interval_95: [fluxLow, fluxHigh],
    class_range: [classLow.class_string, classHigh.class_string],
    doubt_price: Math.round(doubt * 1000) / 1000,
    status,
  };
}

/**
 * Probability that a flare's true class meets or exceeds a threshold.
 *
 * Uses normal approximation on log-flux.
 * Equivalent to TREMOR's thresholdCrossingProbability.
 *
 * @param {object} uncertainty - From buildFlareUncertainty
 * @param {string} thresholdClass - e.g. "M1.0" or "X1.0"
 * @returns {number} Probability [0, 1]
 */
export function flareThresholdProbability(uncertainty, thresholdClass) {
  const thresholdFlux = classToFlux(thresholdClass);
  if (thresholdFlux == null) return 0;

  if (uncertainty.sigma <= 0) {
    return uncertainty.value >= thresholdFlux ? 1.0 : 0.0;
  }

  // Normal CDF approximation via error function
  const z = (thresholdFlux - uncertainty.value) / uncertainty.sigma;
  const prob = 1 - normalCDF(z);
  return Math.round(prob * 1000) / 1000;
}

// =========================================================================
// Kp uncertainty
// =========================================================================

/**
 * Build uncertainty for Kp index reading.
 *
 * Kp uncertainty sources:
 *   - Preliminary vs definitive (SWPC vs GFZ)
 *   - Station coverage (fewer stations = wider spread)
 *   - 3-hour averaging window
 */
export function buildKpUncertainty(kpEvent) {
  const kp = kpEvent.kp ?? 0;
  const isDefinitive = kpEvent.source === 'GFZ';
  const stations = kpEvent.station_count ?? 8;

  // Base sigma: preliminary ≈ ±0.67 Kp units, definitive ≈ ±0.33
  let sigma = isDefinitive ? 0.33 : 0.67;

  // Adjust for station count — fewer stations = wider uncertainty
  if (stations < 6) sigma *= 1.5;
  if (stations < 3) sigma *= 2.0;

  const kpLow = Math.max(0, kp - 1.96 * sigma);
  const kpHigh = Math.min(9, kp + 1.96 * sigma);

  // Doubt price
  let doubt = isDefinitive ? 0.05 : 0.25;
  if (stations < 6) doubt += 0.1;
  doubt = Math.min(doubt, 0.8);

  return {
    value: kp,
    sigma,
    confidence_interval_95: [
      Math.round(kpLow * 10) / 10,
      Math.round(kpHigh * 10) / 10,
    ],
    doubt_price: Math.round(doubt * 1000) / 1000,
    is_definitive: isDefinitive,
    station_count: stations,
  };
}

/**
 * Probability that true Kp meets or exceeds a threshold.
 */
export function kpThresholdProbability(uncertainty, threshold) {
  if (uncertainty.sigma <= 0) {
    return uncertainty.value >= threshold ? 1.0 : 0.0;
  }
  const z = (threshold - uncertainty.value) / uncertainty.sigma;
  return Math.round((1 - normalCDF(z)) * 1000) / 1000;
}

// =========================================================================
// CME arrival uncertainty
// =========================================================================

/**
 * Build uncertainty for CME arrival time prediction.
 *
 * WSA-Enlil model typical errors:
 *   - Mean absolute error: ~10 hours
 *   - Sigma: ~12 hours for halo CMEs, ~18 for partial halo
 *   - Glancing blows have wider uncertainty
 *
 * Reference: Wold et al. (2018), Riley & Love (2017)
 */
export function buildCMEArrivalUncertainty(cmeData) {
  const arrival = cmeData.earth_arrival;
  if (!arrival) return null;

  const estimatedArrival = arrival.estimated_arrival;
  if (!estimatedArrival) return null;

  const speed = cmeData.analysis?.speed ?? 500;
  const isGlancingBlow = arrival.is_glancing_blow;
  const cmeType = cmeData.analysis?.type;

  // Base sigma in hours
  let sigmaHours = 12;
  if (cmeType === 'S') sigmaHours = 10;      // Full halo — better constrained
  if (cmeType === 'C') sigmaHours = 18;      // Common CME — wider uncertainty
  if (isGlancingBlow) sigmaHours *= 1.5;
  if (speed > 1500) sigmaHours *= 0.8;       // Very fast CMEs are more predictable

  const sigmaMs = sigmaHours * 3600_000;

  return {
    estimated_arrival: estimatedArrival,
    sigma_hours: Math.round(sigmaHours * 10) / 10,
    confidence_interval_95: [
      estimatedArrival - 1.96 * sigmaMs,
      estimatedArrival + 1.96 * sigmaMs,
    ],
    doubt_price: Math.round(Math.min(0.95, 0.3 + sigmaHours * 0.03) * 1000) / 1000,
    is_glancing_blow: isGlancingBlow,
    cme_speed: speed,
  };
}

/**
 * Probability that CME arrives within a given time window.
 *
 * @param {object} uncertainty - From buildCMEArrivalUncertainty
 * @param {number} windowStart - Window start timestamp
 * @param {number} windowEnd - Window end timestamp
 * @returns {number} Probability [0, 1]
 */
export function cmeArrivalWindowProbability(uncertainty, windowStart, windowEnd) {
  if (!uncertainty) return 0;
  const mu = uncertainty.estimated_arrival;
  const sigma = uncertainty.sigma_hours * 3600_000;
  if (sigma <= 0) {
    return (mu >= windowStart && mu <= windowEnd) ? 1.0 : 0.0;
  }
  const zLow = (windowStart - mu) / sigma;
  const zHigh = (windowEnd - mu) / sigma;
  const prob = normalCDF(zHigh) - normalCDF(zLow);
  return Math.round(prob * 1000) / 1000;
}

// =========================================================================
// Helpers
// =========================================================================

/**
 * Standard normal CDF approximation (Abramowitz & Stegun).
 */
function normalCDF(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);

  return 0.5 * (1.0 + sign * y);
}

export { normalCDF };
