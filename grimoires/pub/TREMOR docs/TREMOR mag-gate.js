/**
 * Magnitude Gate Theatre
 *
 * Binary threshold market: "Will a M≥X event occur in region Y within Z hours?"
 *
 * The cleanest possible Brier target. Resolves against USGS reviewed catalog.
 * Base rates calculable from Gutenberg-Richter historical catalog.
 */

import { thresholdCrossingProbability } from '../processor/magnitude.js';

/**
 * Create a new Magnitude Gate theatre.
 *
 * @param {object} params
 * @param {string} params.id - Unique theatre ID
 * @param {string} params.region_name - Human-readable region
 * @param {number[]} params.region_bbox - [minLon, minLat, maxLon, maxLat]
 * @param {number} params.magnitude_threshold - e.g. 5.0
 * @param {number} params.window_hours - Duration in hours
 * @param {number} params.base_rate - Historical probability from GR catalog
 * @returns {object} Theatre definition
 */
export function createMagnitudeGate({
  id,
  region_name,
  region_bbox,
  magnitude_threshold,
  window_hours,
  base_rate = 0.1,
}) {
  const now = Date.now();
  const closes_at = now + window_hours * 60 * 60 * 1000;

  return {
    id: id || `T1-${region_name.replace(/\s/g, '_').toUpperCase()}-${window_hours}H-${now}`,
    template: 'magnitude_gate',
    question: `Will a M≥${magnitude_threshold} event occur in ${region_name} within ${window_hours}h?`,
    region_name,
    region_bbox,
    magnitude_threshold,
    opens_at: now,
    closes_at,
    state: 'open',
    outcome: null,        // null until resolved, then true/false

    // Position tracking for RLMF
    position_history: [
      {
        t: now,
        p: base_rate,
        evidence: null,
        reason: `GR base rate for M≥${magnitude_threshold} in ${region_name} over ${window_hours}h`,
      },
    ],
    current_position: base_rate,
    evidence_bundles: [],

    // Resolution
    resolving_bundle_id: null,
    resolved_at: null,
  };
}

/**
 * Process an evidence bundle against a Magnitude Gate theatre.
 *
 * Returns the updated theatre with new position and state transitions.
 *
 * @param {object} theatre - Magnitude Gate theatre
 * @param {object} bundle - Evidence bundle from the ingestion pipeline
 * @returns {object} Updated theatre
 */
export function processMagnitudeGate(theatre, bundle) {
  if (theatre.state === 'resolved' || theatre.state === 'expired') {
    return theatre;
  }

  const updated = { ...theatre };
  const mag = bundle.payload.magnitude;
  const threshold = theatre.magnitude_threshold;

  // Track the bundle
  updated.evidence_bundles = [...theatre.evidence_bundles, bundle.bundle_id];

  // Check if this event crosses the threshold
  const eventCrossesThreshold = mag.value >= threshold;

  // If ground_truth or provisional_mature and crosses threshold → resolve YES
  if (
    eventCrossesThreshold &&
    (bundle.evidence_class === 'ground_truth' || bundle.evidence_class === 'provisional_mature')
  ) {
    updated.state = bundle.evidence_class === 'ground_truth' ? 'resolved' : 'provisional_hold';
    updated.outcome = true;
    updated.resolving_bundle_id = bundle.bundle_id;
    updated.resolved_at = Date.now();
    updated.current_position = 1.0;
    updated.position_history = [
      ...theatre.position_history,
      {
        t: Date.now(),
        p: 1.0,
        evidence: bundle.bundle_id,
        reason: `M${mag.value} ${mag.type} — threshold crossed (${bundle.evidence_class})`,
      },
    ];
    return updated;
  }

  // If automatic event near threshold, update position using doubt pricing
  if (bundle.evidence_class === 'provisional' || bundle.evidence_class === 'cross_validated') {
    const crossingProb = thresholdCrossingProbability(mag, threshold);

    // Bayesian-ish update: blend current position with new evidence
    // Weight by quality composite — low quality evidence shifts position less
    const qualityWeight = bundle.payload.quality.composite;
    const evidenceWeight = 0.3 * qualityWeight;

    let newPosition;
    if (eventCrossesThreshold) {
      // Automatic event crosses threshold — strong shift but not resolution
      newPosition = theatre.current_position + (1 - theatre.current_position) * evidenceWeight * 0.8;
    } else if (crossingProb > 0.1) {
      // Near-threshold event — magnitude uncertainty makes crossing possible
      newPosition = theatre.current_position + (crossingProb - theatre.current_position) * evidenceWeight * 0.3;
    } else {
      // Sub-threshold event — mild positive evidence (seismic activity exists)
      newPosition = theatre.current_position * (1 + 0.02 * qualityWeight);
    }

    // Clamp to [0.01, 0.99]
    newPosition = Math.max(0.01, Math.min(0.99, newPosition));

    updated.current_position = Math.round(newPosition * 1000) / 1000;
    updated.position_history = [
      ...theatre.position_history,
      {
        t: Date.now(),
        p: updated.current_position,
        evidence: bundle.bundle_id,
        reason: `M${mag.value} ${mag.type} (auto) — crossing_prob=${crossingProb.toFixed(3)}, quality=${qualityWeight.toFixed(3)}`,
      },
    ];
  }

  return updated;
}

/**
 * Expire a Magnitude Gate theatre that has run out of time
 * without a qualifying event.
 *
 * @param {object} theatre - Magnitude Gate theatre
 * @returns {object} Theatre resolved as NO
 */
export function expireMagnitudeGate(theatre) {
  if (theatre.state === 'resolved') return theatre;

  return {
    ...theatre,
    state: 'resolved',
    outcome: false,
    resolved_at: Date.now(),
    position_history: [
      ...theatre.position_history,
      {
        t: Date.now(),
        p: theatre.current_position,
        evidence: null,
        reason: 'Theatre expired — no qualifying event',
      },
    ],
  };
}
