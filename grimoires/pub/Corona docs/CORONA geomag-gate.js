/**
 * Geomagnetic Storm Gate Theatre
 *
 * Binary threshold market: "Will Kp reach ≥N within Mh?"
 *
 * Resolves against 3-hour Kp index. The Kp index is the standard
 * measure of geomagnetic disturbance (0-9 scale).
 *
 * NOAA G-Scale mapping:
 *   Kp 5 = G1 (Minor), Kp 6 = G2, Kp 7 = G3, Kp 8 = G4, Kp 9 = G5
 *
 * Base rates vary enormously with solar cycle phase:
 *   - Solar minimum: P(Kp≥5 in 72h) ≈ 0.05
 *   - Solar maximum: P(Kp≥5 in 72h) ≈ 0.30
 *
 * Key inputs for position updates:
 *   - Kp index observations (direct evidence)
 *   - CME arrival predictions (leading indicator)
 *   - Solar wind conditions (Bz, speed — immediate precursor)
 *   - DONKI geomagnetic storm events (confirmation)
 */

import { kpThresholdProbability } from '../processor/uncertainty.js';
import { kpToGScale } from '../oracles/swpc.js';

/**
 * Create a Geomagnetic Storm Gate theatre.
 *
 * @param {object} params
 * @param {number} params.kp_threshold - Minimum Kp index (e.g. 5 for G1)
 * @param {number} params.window_hours - Duration (typically 24-72h)
 * @param {number} params.base_rate - Historical probability
 * @returns {object} Theatre definition
 */
export function createGeomagneticStormGate({
  id,
  kp_threshold,
  window_hours,
  base_rate = 0.10,
}) {
  const now = Date.now();
  const gScale = kpToGScale(kp_threshold);

  return {
    id: id || `T2-GEOMAG-KP${kp_threshold}-${window_hours}H-${now}`,
    template: 'geomagnetic_storm_gate',
    question: `Will Kp reach ≥${kp_threshold} (${gScale.label}) within ${window_hours}h?`,
    kp_threshold,
    g_scale: gScale,
    opens_at: now,
    closes_at: now + window_hours * 60 * 60 * 1000,
    state: 'open',
    outcome: null,

    // Track peak Kp observed during theatre window
    peak_kp_observed: 0,
    kp_observations: [],

    // CME arrival predictions that could drive storms
    pending_cmes: [],

    position_history: [
      {
        t: now,
        p: base_rate,
        evidence: null,
        reason: `Base rate for Kp≥${kp_threshold} over ${window_hours}h`,
      },
    ],
    current_position: base_rate,
    evidence_bundles: [],

    resolving_bundle_id: null,
    resolved_at: null,
  };
}

/**
 * Process evidence against a Geomagnetic Storm Gate.
 *
 * Multi-input position updating:
 *   1. Kp observations directly test the threshold
 *   2. Solar wind (southward Bz + high speed) is a ~30min leading indicator
 *   3. CME arrival predictions shift position hours/days in advance
 *   4. DONKI GST events confirm storms
 */
export function processGeomagneticStormGate(theatre, bundle) {
  if (theatre.state === 'resolved' || theatre.state === 'expired') return theatre;

  const updated = { ...theatre };
  updated.evidence_bundles = [...theatre.evidence_bundles, bundle.bundle_id];

  const payload = bundle.payload;

  // --- Kp index observation ---
  if (payload.event_type === 'kp_index') {
    return processKpObservation(updated, bundle);
  }

  // --- Solar wind conditions ---
  if (payload.event_type === 'solar_wind') {
    return processSolarWindSignal(updated, bundle);
  }

  // --- CME arrival prediction ---
  if (payload.event_type === 'cme') {
    return processCMEArrival(updated, bundle);
  }

  // --- DONKI geomagnetic storm ---
  if (payload.event_type === 'geomagnetic_storm') {
    return processGSTEvent(updated, bundle);
  }

  return updated;
}

/**
 * Process a Kp index observation.
 */
function processKpObservation(theatre, bundle) {
  const kp = bundle.payload.kp.value;
  const uncertainty = bundle.payload.kp.uncertainty;
  const threshold = theatre.kp_threshold;

  // Record observation
  theatre.kp_observations = [
    ...theatre.kp_observations,
    { time: bundle.payload.event_time, kp, evidence: bundle.bundle_id },
  ];
  theatre.peak_kp_observed = Math.max(theatre.peak_kp_observed, kp);

  const crossesThreshold = kp >= threshold;

  // Ground truth crossing → resolve YES
  if (crossesThreshold && (bundle.evidence_class === 'ground_truth' || bundle.evidence_class === 'provisional_mature')) {
    theatre.state = bundle.evidence_class === 'ground_truth' ? 'resolved' : 'provisional_hold';
    theatre.outcome = true;
    theatre.resolving_bundle_id = bundle.bundle_id;
    theatre.resolved_at = Date.now();
    theatre.current_position = 1.0;
    theatre.position_history = [
      ...theatre.position_history,
      {
        t: Date.now(),
        p: 1.0,
        evidence: bundle.bundle_id,
        reason: `Kp=${kp} — threshold ≥${threshold} crossed (${bundle.evidence_class})`,
      },
    ];
    return theatre;
  }

  // Provisional Kp — update position
  const crossingProb = kpThresholdProbability(uncertainty, threshold);
  const qualityWeight = bundle.payload.quality.composite;

  let newPosition;
  if (crossesThreshold) {
    // Provisional crossing — strong shift
    newPosition = theatre.current_position + (1 - theatre.current_position) * 0.6;
  } else if (crossingProb > 0.15) {
    // Near threshold
    newPosition = theatre.current_position + (crossingProb - theatre.current_position) * 0.3 * qualityWeight;
  } else {
    // Below threshold — slight decay toward base rate for quiet conditions
    const decayFactor = kp < threshold - 3 ? 0.95 : 0.98;
    newPosition = theatre.current_position * decayFactor;
  }

  newPosition = Math.max(0.01, Math.min(0.99, newPosition));
  theatre.current_position = Math.round(newPosition * 1000) / 1000;
  theatre.position_history = [
    ...theatre.position_history,
    {
      t: Date.now(),
      p: theatre.current_position,
      evidence: bundle.bundle_id,
      reason: `Kp=${kp} — crossing_prob=${crossingProb.toFixed(3)}, peak=${theatre.peak_kp_observed}`,
    },
  ];

  return theatre;
}

/**
 * Process solar wind conditions as storm precursor.
 *
 * Strong southward Bz (-10+ nT) with elevated speed (>400 km/s)
 * is a 15-30 minute leading indicator of Kp increase.
 */
function processSolarWindSignal(theatre, bundle) {
  const indicators = bundle.payload.indicators;
  if (!indicators) return theatre;

  let newPosition = theatre.current_position;
  let reason;

  if (indicators.storm_conditions) {
    // Strong southward Bz + high speed → significant uplift
    newPosition = theatre.current_position + (0.85 - theatre.current_position) * 0.25;
    reason = 'Storm conditions: Bz<-10nT + speed>400km/s';
  } else if (indicators.southward_bz) {
    // Southward Bz alone
    newPosition = theatre.current_position + (0.6 - theatre.current_position) * 0.1;
    reason = 'Southward Bz detected';
  } else if (indicators.high_speed) {
    // High speed stream
    newPosition = theatre.current_position * 1.05;
    reason = 'High speed stream (>500 km/s)';
  } else {
    // Quiet conditions — mild decay
    newPosition = theatre.current_position * 0.98;
    reason = 'Quiet solar wind conditions';
  }

  newPosition = Math.max(0.01, Math.min(0.99, newPosition));
  theatre.current_position = Math.round(newPosition * 1000) / 1000;
  theatre.position_history = [
    ...theatre.position_history,
    {
      t: Date.now(),
      p: theatre.current_position,
      evidence: bundle.bundle_id,
      reason,
    },
  ];

  return theatre;
}

/**
 * Process CME arrival prediction.
 *
 * An Earth-directed CME with predicted arrival within our window
 * is a strong leading indicator for geomagnetic storms.
 */
function processCMEArrival(theatre, bundle) {
  const earthArrival = bundle.payload.earth_arrival;
  if (!earthArrival) return theatre;

  const estimatedArrival = earthArrival.estimated_arrival;
  if (!estimatedArrival) return theatre;

  // Check if CME arrival falls within theatre window
  const arrivalInWindow = estimatedArrival >= theatre.opens_at && estimatedArrival <= theatre.closes_at;
  if (!arrivalInWindow) return theatre;

  // Track pending CME
  theatre.pending_cmes = [
    ...theatre.pending_cmes,
    {
      activity_id: bundle.payload.event_id,
      estimated_arrival: estimatedArrival,
      speed: bundle.payload.cme?.speed,
      is_glancing_blow: earthArrival.is_glancing_blow,
      predicted_kp: Math.max(
        earthArrival.kp_18 ?? 0,
        earthArrival.kp_90 ?? 0,
        earthArrival.kp_135 ?? 0,
        earthArrival.kp_180 ?? 0
      ),
    },
  ];

  // Position update based on predicted Kp from WSA-Enlil
  const predictedKp = theatre.pending_cmes[theatre.pending_cmes.length - 1].predicted_kp;
  const meetsThreshold = predictedKp >= theatre.kp_threshold;

  let newPosition;
  let reason;

  if (meetsThreshold && !earthArrival.is_glancing_blow) {
    // Direct hit with threshold-crossing Kp prediction
    newPosition = theatre.current_position + (0.75 - theatre.current_position) * 0.4;
    reason = `CME predicted Kp=${predictedKp} (direct hit) — arrival in window`;
  } else if (meetsThreshold) {
    // Glancing blow — less certain
    newPosition = theatre.current_position + (0.5 - theatre.current_position) * 0.2;
    reason = `CME predicted Kp=${predictedKp} (glancing blow) — arrival in window`;
  } else {
    // CME arrives but Kp prediction below threshold
    newPosition = theatre.current_position * 1.1;
    reason = `CME arriving but predicted Kp=${predictedKp} below threshold`;
  }

  newPosition = Math.max(0.01, Math.min(0.99, newPosition));
  theatre.current_position = Math.round(newPosition * 1000) / 1000;
  theatre.position_history = [
    ...theatre.position_history,
    {
      t: Date.now(),
      p: theatre.current_position,
      evidence: bundle.bundle_id,
      reason,
    },
  ];

  return theatre;
}

/**
 * Process DONKI geomagnetic storm event.
 */
function processGSTEvent(theatre, bundle) {
  const maxKp = bundle.payload.storm?.max_kp ?? 0;

  if (maxKp >= theatre.kp_threshold && bundle.evidence_class === 'ground_truth') {
    theatre.state = 'resolved';
    theatre.outcome = true;
    theatre.resolving_bundle_id = bundle.bundle_id;
    theatre.resolved_at = Date.now();
    theatre.current_position = 1.0;
    theatre.position_history = [
      ...theatre.position_history,
      {
        t: Date.now(),
        p: 1.0,
        evidence: bundle.bundle_id,
        reason: `DONKI GST: max Kp=${maxKp} — threshold crossed`,
      },
    ];
    return theatre;
  }

  return theatre;
}

/**
 * Expire a Geomagnetic Storm Gate.
 */
export function expireGeomagneticStormGate(theatre) {
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
        reason: `Theatre expired — peak Kp observed: ${theatre.peak_kp_observed}`,
      },
    ],
  };
}
