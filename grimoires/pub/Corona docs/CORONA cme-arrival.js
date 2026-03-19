/**
 * CME Arrival Theatre
 *
 * Binary market: "Will CME [ID] arrive at Earth within the DONKI-predicted
 * window ±6h?"
 *
 * This is the highest-uncertainty theatre — WSA-Enlil model predictions
 * have typical MAE of ~10 hours. The construct's edge comes from:
 *   1. Tracking real-time solar wind for early arrival signatures
 *   2. Cross-referencing multiple CME analyses
 *   3. Using DSCOVR/ACE L1 data as ~30-min lead time confirmation
 *
 * Resolution:
 *   - YES: Interplanetary shock (IPS) or sudden storm commencement (SSC)
 *          detected within predicted_arrival ± tolerance_hours
 *   - NO: Window closes with no arrival signature
 *
 * Key calibration: glancing blows are harder to detect and may produce
 * ambiguous signatures. The doubt_price on the CME arrival uncertainty
 * handles this via wider sigma for glancing blow predictions.
 */

import { cmeArrivalWindowProbability } from '../processor/uncertainty.js';

/**
 * Create a CME Arrival theatre.
 *
 * @param {object} params
 * @param {object} params.cmeBundle - Evidence bundle for the triggering CME detection
 * @param {number} [params.tolerance_hours] - Arrival window tolerance (default ±6h)
 * @param {number} [params.theatre_padding_hours] - Extra time beyond window end (default 12h)
 * @returns {object|null} Theatre definition, or null if no Earth arrival predicted
 */
export function createCMEArrival({
  cmeBundle,
  tolerance_hours = 6,
  theatre_padding_hours = 12,
}) {
  const cme = cmeBundle.payload;
  const earthArrival = cme.earth_arrival;
  if (!earthArrival || !earthArrival.estimated_arrival) return null;

  const now = Date.now();
  const estimatedArrival = earthArrival.estimated_arrival;
  const toleranceMs = tolerance_hours * 3600_000;
  const windowStart = estimatedArrival - toleranceMs;
  const windowEnd = estimatedArrival + toleranceMs;

  // Theatre stays open until window_end + padding
  const closesAt = windowEnd + theatre_padding_hours * 3600_000;

  // Initial position from arrival uncertainty model
  const arrivalUncertainty = cme.arrival_uncertainty;
  const initialProb = arrivalUncertainty
    ? cmeArrivalWindowProbability(arrivalUncertainty, windowStart, windowEnd)
    : 0.5;

  const cmeSpeed = cme.cme?.speed ?? null;
  const isGlancingBlow = earthArrival.is_glancing_blow ?? false;

  return {
    id: `T3-CME-ARRIVAL-${cme.event_id}-${now}`,
    template: 'cme_arrival',
    question: `Will CME ${cme.event_id} arrive within ${tolerance_hours}h of predicted time?`,

    cme_reference: {
      activity_id: cme.event_id,
      start_time: cme.cme?.start_time,
      speed: cmeSpeed,
      type: cme.cme?.type,
      source_location: cme.cme?.source_location,
      is_glancing_blow: isGlancingBlow,
    },

    predicted_arrival: estimatedArrival,
    tolerance_hours,
    arrival_window: {
      start: windowStart,
      end: windowEnd,
    },

    opens_at: now,
    closes_at: closesAt,
    state: 'open',
    outcome: null,

    // Track solar wind for arrival signatures
    solar_wind_history: [],
    arrival_detected: false,
    arrival_time: null,

    position_history: [
      {
        t: now,
        p: initialProb,
        evidence: cmeBundle.bundle_id,
        reason: `WSA-Enlil prediction: arrival ${new Date(estimatedArrival).toISOString()}, `
          + `speed=${cmeSpeed ?? '?'}km/s, glancing=${isGlancingBlow}, `
          + `P(within ±${tolerance_hours}h)=${initialProb.toFixed(3)}`,
      },
    ],
    current_position: initialProb,
    evidence_bundles: [cmeBundle.bundle_id],
    resolving_bundle_id: null,
    resolved_at: null,
  };
}

/**
 * Process evidence against a CME Arrival theatre.
 *
 * Key signals:
 *   1. Interplanetary shock detected at L1 (DSCOVR/ACE) → near-certain arrival
 *   2. Sudden Bz southward turning + density spike → shock signature
 *   3. DONKI IPS event → authoritative detection
 *   4. Approaching predicted time with no signal → confidence decay
 *   5. Past predicted window with no signal → strong decay
 */
export function processCMEArrival(theatre, bundle) {
  if (theatre.state === 'resolved' || theatre.state === 'expired') return theatre;

  const updated = { ...theatre };
  updated.evidence_bundles = [...theatre.evidence_bundles, bundle.bundle_id];
  const payload = bundle.payload;

  // --- Solar wind: check for shock signature ---
  if (payload.event_type === 'solar_wind') {
    return processSolarWindForArrival(updated, bundle);
  }

  // --- DONKI geomagnetic storm → arrival confirmed ---
  if (payload.event_type === 'geomagnetic_storm') {
    return processStormAsArrival(updated, bundle);
  }

  // --- Updated CME analysis (revised prediction) ---
  if (payload.event_type === 'cme') {
    return processRevisedCME(updated, bundle);
  }

  return updated;
}

/**
 * Detect CME arrival from solar wind signatures.
 *
 * Shock signature at L1:
 *   - Sudden speed jump (>100 km/s increase)
 *   - Density spike (>2× background)
 *   - Magnetic field jump (Bt increase)
 *   - Bz southward turning
 *
 * These signatures at DSCOVR/ACE give ~30 minutes lead time
 * before geomagnetic effects.
 */
function processSolarWindForArrival(theatre, bundle) {
  const now = Date.now();
  const payload = bundle.payload;
  const plasma = payload.plasma;
  const mag = payload.magnetic_field;

  if (!plasma && !mag) return theatre;

  // Record solar wind state
  theatre.solar_wind_history = [
    ...theatre.solar_wind_history.slice(-100), // Keep last 100 readings
    {
      time: payload.event_time ?? now,
      speed: plasma?.speed,
      density: plasma?.density,
      bz: mag?.bz_gsm,
      bt: mag?.bt,
    },
  ];

  // Check for shock signature
  const history = theatre.solar_wind_history;
  const isShock = detectShockSignature(history);

  const withinWindow = now >= theatre.arrival_window.start && now <= theatre.arrival_window.end;
  const pastWindow = now > theatre.arrival_window.end;
  const beforeWindow = now < theatre.arrival_window.start;

  let newPosition = theatre.current_position;
  let reason;

  if (isShock && withinWindow) {
    // Shock detected within arrival window → strong confirmation
    newPosition = Math.min(0.95, theatre.current_position + (1 - theatre.current_position) * 0.7);
    theatre.arrival_detected = true;
    theatre.arrival_time = now;
    reason = `Shock signature detected within arrival window — speed jump + Bt increase`;
  } else if (isShock && !withinWindow) {
    // Shock detected outside window — arrived early/late
    newPosition = Math.max(0.05, theatre.current_position * 0.3);
    theatre.arrival_detected = true;
    theatre.arrival_time = now;
    reason = `Shock detected ${pastWindow ? 'after' : 'before'} predicted window`;
  } else if (withinWindow) {
    // Inside window, no shock yet — mild decay as time passes
    const windowFraction = (now - theatre.arrival_window.start) /
      (theatre.arrival_window.end - theatre.arrival_window.start);
    newPosition = theatre.current_position * (1 - 0.1 * windowFraction);
    reason = `Within window (${(windowFraction * 100).toFixed(0)}% elapsed), no shock detected`;
  } else if (pastWindow && !theatre.arrival_detected) {
    // Past window with no detection — strong decay
    const hoursLate = (now - theatre.arrival_window.end) / 3600_000;
    newPosition = theatre.current_position * Math.exp(-0.2 * hoursLate);
    reason = `Past window by ${hoursLate.toFixed(1)}h, no arrival detected`;
  } else if (beforeWindow) {
    // Before window — check for storm conditions as precursor
    if (payload.indicators?.storm_conditions) {
      newPosition = theatre.current_position * 1.05;
      reason = 'Storm conditions building ahead of arrival window';
    } else {
      reason = 'Before arrival window — monitoring';
    }
  }

  newPosition = Math.max(0.01, Math.min(0.99, newPosition));
  theatre.current_position = Math.round(newPosition * 1000) / 1000;
  theatre.position_history = [
    ...theatre.position_history,
    {
      t: now,
      p: theatre.current_position,
      evidence: bundle.bundle_id,
      reason,
    },
  ];

  return theatre;
}

/**
 * Detect interplanetary shock from solar wind time series.
 *
 * Simple heuristic: speed increases >80 km/s and Bt increases >5 nT
 * within last 3 readings compared to 5-reading baseline.
 */
function detectShockSignature(history) {
  if (history.length < 8) return false;

  const recent = history.slice(-3);
  const baseline = history.slice(-8, -3);

  const recentSpeed = median(recent.map((h) => h.speed).filter(Boolean));
  const baselineSpeed = median(baseline.map((h) => h.speed).filter(Boolean));
  const recentBt = median(recent.map((h) => h.bt).filter(Boolean));
  const baselineBt = median(baseline.map((h) => h.bt).filter(Boolean));

  if (recentSpeed == null || baselineSpeed == null) return false;

  const speedJump = recentSpeed - baselineSpeed;
  const btJump = (recentBt ?? 0) - (baselineBt ?? 0);

  return speedJump > 80 && btJump > 5;
}

/**
 * Process DONKI geomagnetic storm as arrival confirmation.
 */
function processStormAsArrival(theatre, bundle) {
  const stormStart = bundle.payload.storm?.start_time;
  if (!stormStart) return theatre;

  const withinWindow = stormStart >= theatre.arrival_window.start &&
    stormStart <= theatre.arrival_window.end;

  // Allow 6h grace after window for delayed geomagnetic response
  const graceEnd = theatre.arrival_window.end + 6 * 3600_000;
  const withinGrace = stormStart > theatre.arrival_window.end && stormStart <= graceEnd;

  if (withinWindow && bundle.evidence_class === 'ground_truth') {
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
        reason: 'DONKI GST confirms CME arrival within window',
      },
    ];
  } else if (withinGrace) {
    // Near miss — arrived slightly late
    theatre.current_position = Math.round(Math.max(0.05, theatre.current_position * 0.4) * 1000) / 1000;
    theatre.position_history = [
      ...theatre.position_history,
      {
        t: Date.now(),
        p: theatre.current_position,
        evidence: bundle.bundle_id,
        reason: 'DONKI GST detected but outside ± tolerance window (grace period)',
      },
    ];
  }

  return theatre;
}

/**
 * Process a revised CME analysis (updated arrival prediction).
 */
function processRevisedCME(theatre, bundle) {
  const newArrival = bundle.payload.earth_arrival;
  if (!newArrival?.estimated_arrival) return theatre;

  const withinWindow = newArrival.estimated_arrival >= theatre.arrival_window.start &&
    newArrival.estimated_arrival <= theatre.arrival_window.end;

  let newPosition;
  let reason;

  if (withinWindow) {
    // Revised prediction still within window — confidence boost
    newPosition = theatre.current_position + (0.7 - theatre.current_position) * 0.15;
    reason = `Revised CME prediction still within window — speed=${bundle.payload.cme?.speed ?? '?'}km/s`;
  } else {
    // Revised prediction outside window — confidence drop
    const hoursDelta = Math.abs(newArrival.estimated_arrival - theatre.predicted_arrival) / 3600_000;
    newPosition = theatre.current_position * Math.max(0.3, 1 - hoursDelta * 0.03);
    reason = `Revised CME prediction shifted ${hoursDelta.toFixed(1)}h from original`;
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
 * Expire a CME Arrival theatre.
 */
export function expireCMEArrival(theatre) {
  if (theatre.state === 'resolved') return theatre;

  const arrivalDetected = theatre.arrival_detected;
  const withinWindow = arrivalDetected &&
    theatre.arrival_time >= theatre.arrival_window.start &&
    theatre.arrival_time <= theatre.arrival_window.end;

  return {
    ...theatre,
    state: 'resolved',
    outcome: withinWindow,
    resolved_at: Date.now(),
    position_history: [
      ...theatre.position_history,
      {
        t: Date.now(),
        p: theatre.current_position,
        evidence: null,
        reason: arrivalDetected
          ? `Theatre closed — arrival ${withinWindow ? 'within' : 'outside'} window`
          : 'Theatre closed — no CME arrival detected',
      },
    ],
  };
}

// =========================================================================
// Helpers
// =========================================================================

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
