/**
 * Quality Scoring
 *
 * Computes composite quality scores for PurpleAir sensor readings and
 * EPA AirNow observations.
 *
 * Quality scores drive:
 *   - Evidence class assignment (settlement.js)
 *   - Position update weighting in Theatre modules
 *   - Cross-validation bonuses
 *
 * Analogous to TREMOR's computeQuality (which normalizes against 8 regional
 * seismic network profiles). BREATH normalizes against urban/rural sensor
 * density and source tier.
 */

// ---------------------------------------------------------------------------
// Channel consistency helpers
// ---------------------------------------------------------------------------

/**
 * Compute channel A/B consistency score for a PurpleAir dual-laser sensor.
 *
 * PurpleAir sensors have two laser counters (channels A and B) that should
 * read nearly identically for genuine air quality readings. Divergence between
 * them indicates either sensor malfunction or extreme near-sensor pollution.
 *
 * divergenceRatio = |pm25_a - pm25_b| / avg(pm25_a, pm25_b)
 *
 * Returns a score from 0 (fully inconsistent) to 1 (perfectly consistent).
 * Values near zero → high doubt price in uncertainty.js.
 *
 * @param {number|null} pm25_a - Channel A reading (µg/m³)
 * @param {number|null} pm25_b - Channel B reading (µg/m³)
 * @returns {number} Consistency score 0–1
 */
export function computeChannelConsistency(pm25_a, pm25_b) {
  if (pm25_a === null || pm25_b === null || !isFinite(pm25_a) || !isFinite(pm25_b)) {
    return 0.0; // Missing channel → no consistency information
  }

  const avg = (pm25_a + pm25_b) / 2;

  // Near-zero readings: tiny absolute differences become huge ratios.
  // Below 2 µg/m³ the divergence ratio is not meaningful.
  if (avg < 2.0) return 1.0;

  const divergenceRatio = Math.abs(pm25_a - pm25_b) / avg;

  // Linear mapping: 0 divergence → score 1.0; divergenceRatio ≥ 0.7 → score 0.0
  return Math.max(0, 1 - divergenceRatio / 0.7);
}

/**
 * Classify a channel consistency score into a human-readable category.
 *
 * @param {number} consistencyScore - 0–1 from computeChannelConsistency
 * @returns {'consistent'|'divergent'|'inconsistent'}
 */
export function classifyConsistency(consistencyScore) {
  if (consistencyScore >= 0.8) return 'consistent';
  if (consistencyScore >= 0.4) return 'divergent';
  return 'inconsistent';
}

// ---------------------------------------------------------------------------
// Quality scoring
// ---------------------------------------------------------------------------

/**
 * Compute quality score for a PurpleAir sensor reading.
 *
 * Weighted combination of four components:
 *   source_tier  (0.35) — PurpleAir is community-grade, not reference-grade
 *   freshness    (0.30) — penalise stale readings
 *   density      (0.20) — more nearby sensors = better corroboration
 *   consistency  (0.15) — channel A/B agreement
 *
 * A 20% bonus is applied when a nearby EPA AirNow reading confirms the
 * PurpleAir value within 30% (or 15 AQI points, whichever is larger).
 *
 * @param {object} sensor - Normalised PurpleAir sensor
 *   @param {number} sensor.last_seen - Unix timestamp (seconds) of last reading
 *   @param {number} sensor.aqi_computed - Computed AQI value
 *   @param {number} sensor.pm25_a - Channel A reading
 *   @param {number} sensor.pm25_b - Channel B reading
 * @param {object|null} registryRecord - Current SensorRegistry entry (may be null for new sensors)
 *   @param {number} [registryRecord.channel_consistency_score] - Rolling consistency score
 * @param {object[]} nearbySensors - Other active sensors within density radius
 * @param {object|null} nearbyAirNow - Nearest AirNow observation (null if unavailable)
 *   @param {number} [nearbyAirNow.AQI] - AirNow AQI for comparison
 * @param {number} [pollIntervalMs=120000] - Configured poll interval in ms
 * @returns {QualityScore}
 */
export function computeQuality(sensor, registryRecord, nearbySensors, nearbyAirNow, pollIntervalMs = 120_000) {
  const pollIntervalSeconds = pollIntervalMs / 1000;

  // --- source_tier ---
  // PurpleAir single-sensor baseline: 0.65
  // Will be boosted to 0.85 by cross-validation bonus below.
  const source_tier = 0.65;

  // --- freshness ---
  // Compare sensor's last_seen age to the poll interval cadence.
  const now = Date.now();
  const ageSeconds = (now - sensor.last_seen * 1000) / 1000;
  let freshness;
  if (ageSeconds < pollIntervalSeconds) {
    freshness = 1.0;
  } else if (ageSeconds < pollIntervalSeconds * 2) {
    freshness = 0.7;
  } else if (ageSeconds < pollIntervalSeconds * 4) {
    freshness = 0.4;
  } else {
    freshness = 0.1; // Very stale
  }

  // --- density ---
  // Number of other active sensors within the density radius.
  // 10+ sensors = urban dense = score 1.0. Scales linearly below that.
  const density = Math.min(1.0, nearbySensors.length / 10);

  // --- consistency ---
  // Prefer rolling average from registry; fall back to current reading.
  const consistency = registryRecord?.channel_consistency_score
    ?? computeChannelConsistency(sensor.pm25_a, sensor.pm25_b);

  // --- cross_validated ---
  // EPA AirNow within ~20km agrees within 30% (or 15 AQI, whichever is larger).
  let cross_validated = false;
  if (nearbyAirNow && typeof nearbyAirNow.AQI === 'number' && typeof sensor.aqi_computed === 'number') {
    const tolerance = Math.max(nearbyAirNow.AQI * 0.3, 15);
    cross_validated = Math.abs(sensor.aqi_computed - nearbyAirNow.AQI) <= tolerance;
  }

  // --- composite ---
  const raw = (
    source_tier * 0.35 +
    freshness   * 0.30 +
    density     * 0.20 +
    consistency * 0.15
  );

  // Cross-validation bonus (20%)
  const composite = Math.min(1.0, raw * (cross_validated ? 1.2 : 1.0));

  return {
    score: composite,
    composite,
    components: { source_tier, freshness, density, consistency },
    cross_validated,
  };
}

/**
 * Quality score for an EPA AirNow observation.
 *
 * AirNow is settlement authority — quality is uniformly high.
 * No channel consistency, no density normalisation needed.
 *
 * @returns {QualityScore}
 */
export function computeAirNowQuality() {
  return {
    score: 1.0,
    composite: 1.0,
    components: {
      source_tier: 1.0,
      freshness:   1.0,
      density:     1.0,
      consistency: 1.0,
    },
    cross_validated: true,
  };
}
