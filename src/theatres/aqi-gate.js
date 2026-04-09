/**
 * T1: AQI Threshold Gate
 *
 * Binary prediction market: Will AQI reach a given category threshold within
 * a time window? Resolves via EPA AirNow ground truth. PurpleAir provides
 * early warning signals that update the probability position.
 *
 * State flow:
 *   open → provisional_hold   (PurpleAir provisional_mature exceeds threshold)
 *   open | provisional_hold → resolved (EPA AirNow confirms crossing or expiry)
 *
 * Valid thresholds: 51 (Moderate), 101 (USG), 151 (Unhealthy),
 *                  201 (Very Unhealthy), 301 (Hazardous)
 */

import { AQI_CATEGORIES } from '../processor/aqi.js';
import { thresholdCrossingProbability } from '../processor/uncertainty.js';

/**
 * Create an AQI Threshold Gate theatre.
 *
 * @param {object} params
 *   @param {string} [params.id]          - Override auto-generated ID
 *   @param {string}  params.region_name  - Human-readable region name
 *   @param {number[]} params.region_bbox - [minLon, minLat, maxLon, maxLat]
 *   @param {number}  params.aqi_threshold - Must be a category lower boundary: 51, 101, 151, 201, 301
 *   @param {number}  params.window_hours  - Duration 1–168
 *   @param {number}  [params.base_rate=0.15] - Historical P(crossing in window)
 * @returns {object} Theatre state
 * @throws {Error} If aqi_threshold is not a valid category boundary
 */
export function createAqiThresholdGate({
  id,
  region_name,
  region_bbox,
  aqi_threshold,
  window_hours,
  base_rate = 0.15,
}) {
  const thresholdCategory = AQI_CATEGORIES.find(c => c.range[0] === aqi_threshold);
  if (!thresholdCategory) {
    throw new Error(
      `Invalid AQI threshold: ${aqi_threshold}. Must be a category lower boundary: 51, 101, 151, 201, 301`,
    );
  }

  const now = Date.now();
  const theatreId = id ||
    `T1-${region_name.replace(/\s+/g, '_').toUpperCase()}-AQI${aqi_threshold}-${now}`;

  return {
    id: theatreId,
    template: 'aqi_threshold_gate',
    question: `Will AQI reach ${thresholdCategory.name} (≥${aqi_threshold}) in ${region_name} within ${window_hours}h?`,
    region_name,
    region_bbox,
    aqi_threshold,
    threshold_category_number: thresholdCategory.number,
    window_hours,
    opens_at: now,
    closes_at: now + window_hours * 3_600_000,
    state: 'open',
    outcome: null,
    position_history: [{
      t: now,
      p: base_rate,
      evidence: null,
      reason: `Base rate: P(AQI≥${aqi_threshold} in ${region_name} within ${window_hours}h)`,
    }],
    current_position: base_rate,
    evidence_bundles: [],
    resolving_bundle_id: null,
    resolved_at: null,
  };
}

/**
 * Process an evidence bundle against an AQI Threshold Gate theatre.
 *
 * Handles three cases:
 * 1. EPA AirNow ground_truth → immediate resolution
 * 2. PurpleAir provisional_mature above threshold → provisional_hold state
 * 3. PurpleAir provisional/cross_validated → blend position toward crossing probability
 *
 * @param {object} theatre - Current theatre state
 * @param {object} bundle  - Evidence bundle from oracle pipeline
 * @returns {object} Updated theatre state (immutable copy)
 */
export function processAqiThresholdGate(theatre, bundle) {
  if (theatre.state === 'resolved' || theatre.state === 'expired') return theatre;

  const updated = { ...theatre };
  updated.evidence_bundles = [...theatre.evidence_bundles, bundle.bundle_id];

  const currentAQI = bundle.payload?.aqi?.value;
  const threshold   = theatre.aqi_threshold;

  // EPA AirNow ground truth → immediate resolution based on category_number
  if (bundle.source === 'EPA_AIRNOW' && bundle.evidence_class === 'ground_truth') {
    const categoryNumber = bundle.payload?.aqi?.category_number;
    if (typeof categoryNumber !== 'number') return updated; // skip malformed bundle
    const crossed = categoryNumber >= theatre.threshold_category_number;
    const now = Date.now();
    updated.state               = 'resolved';
    updated.outcome             = crossed;
    updated.resolving_bundle_id = bundle.bundle_id;
    updated.resolved_at         = now;
    updated.current_position    = crossed ? 1.0 : 0.0;
    updated.position_history    = [...theatre.position_history, {
      t:        now,
      p:        updated.current_position,
      evidence: bundle.bundle_id,
      reason:   `EPA AirNow: AQI=${currentAQI} (${bundle.payload.aqi.category})`,
    }];
    return updated;
  }

  // PurpleAir provisional_mature above threshold → provisional_hold
  if (bundle.evidence_class === 'provisional_mature' && currentAQI >= threshold) {
    updated.state = 'provisional_hold';
  }

  // PurpleAir provisional/provisional_mature/cross_validated → position update
  if (bundle.source === 'PURPLEAIR' &&
      (bundle.evidence_class === 'provisional' ||
       bundle.evidence_class === 'provisional_mature' ||
       bundle.evidence_class === 'cross_validated')) {
    const doubtPrice  = bundle.payload?.uncertainty?.doubt_price ?? 0.5;
    const crossingProb = thresholdCrossingProbability(currentAQI, threshold, doubtPrice);
    const qualityWeight  = bundle.payload?.quality?.composite ?? 0.5;
    const evidenceWeight = 0.3 * qualityWeight;

    // Blend current position toward crossing probability
    const newPosition = theatre.current_position +
      (crossingProb - theatre.current_position) * evidenceWeight;
    updated.current_position = Math.max(0.01, Math.min(0.99,
      Math.round(newPosition * 1000) / 1000,
    ));
    updated.position_history = [...theatre.position_history, {
      t:        Date.now(),
      p:        updated.current_position,
      evidence: bundle.bundle_id,
      reason:   `PurpleAir sensor ${bundle.payload.location.sensor_id}: AQI=${currentAQI}, crossing_prob=${crossingProb.toFixed(3)}`,
    }];
  }

  return updated;
}

/**
 * Expire an AQI Threshold Gate theatre (called at closes_at without EPA resolution).
 * Resolves as NO (outcome: false).
 *
 * @param {object} theatre
 * @returns {object} Resolved theatre with outcome: false
 */
export function expireAqiThresholdGate(theatre) {
  if (theatre.state === 'resolved') return theatre;
  const now = Date.now();
  return {
    ...theatre,
    state:       'resolved',
    outcome:     false,
    resolved_at: now,
    position_history: [...theatre.position_history, {
      t:        now,
      p:        theatre.current_position,
      evidence: null,
      reason:   'Theatre expired — no EPA AirNow confirmation received',
    }],
  };
}
