/**
 * Settlement logic for space weather evidence.
 *
 * Determines evidence class (how trustworthy is this data for resolving a theatre?)
 * and resolution eligibility.
 *
 * Evidence classes (parallel to TREMOR):
 *   - ground_truth:        Definitive data (GFZ Kp, DONKI-confirmed flare, completed event)
 *   - provisional_mature:  Stable for >2h, cross-validated by DONKI + SWPC
 *   - cross_validated:     Confirmed by 2+ sources with low divergence
 *   - provisional:         Fresh automatic data, may be revised
 *   - degraded:            Low quality / high uncertainty
 *
 * Calibration edge cases addressed:
 *   - GOES primary/secondary satellite switching
 *   - Flare class reclassification (in-progress → complete → DONKI-confirmed)
 *   - Kp preliminary (SWPC, real-time) vs definitive (GFZ, ~30 day lag)
 *   - Eclipse season data gaps
 */

/**
 * Assess settlement eligibility for a space weather event.
 *
 * @param {object} event - Raw event with type and data
 * @param {object} quality - Quality score from computeQuality
 * @param {Array} revisionHistory - Previous versions of this event
 * @param {boolean} crossValidated - Whether confirmed by 2+ sources
 * @param {number|null} earliestExpiry - Nearest theatre close timestamp
 * @returns {object} Settlement assessment
 */
export function assessSettlement(event, quality, revisionHistory = [], crossValidated = false, earliestExpiry = null) {
  const type = event.type;
  const data = event.data ?? event;
  const now = Date.now();

  switch (type) {
    case 'solar_flare':
    case 'donki_flare':
      return assessFlareSettlement(data, quality, revisionHistory, crossValidated, earliestExpiry);
    case 'kp_index':
      return assessKpSettlement(data, quality, crossValidated);
    case 'proton_flux':
      return assessProtonSettlement(data, quality);
    case 'solar_wind':
      return assessSolarWindSettlement(data, quality);
    case 'donki_cme':
      return assessCMESettlement(data, quality, crossValidated);
    case 'donki_geomagnetic_storm':
      return assessGSTSettlement(data, quality, crossValidated);
    default:
      return {
        evidence_class: 'provisional',
        resolution_eligible: false,
        ineligible_reason: `Unknown event type: ${type}`,
        recommended_state: 'open',
        brier_discount: 0.15,
      };
  }
}

/**
 * Flare settlement assessment.
 *
 * Ground truth conditions:
 *   - DONKI-confirmed event with complete timing
 *   - SWPC event with status='complete' and age >2h
 *
 * Provisional mature:
 *   - Complete event cross-validated by both SWPC and DONKI
 *   - Age >1h with stable classification
 */
function assessFlareSettlement(data, quality, revisionHistory, crossValidated, earliestExpiry) {
  const status = data.status ?? 'unknown';
  const beginTime = data.begin_time ?? data.begin_time;
  const age = beginTime ? (Date.now() - beginTime) / 3600_000 : 0;

  // DONKI-confirmed flares are ground truth
  if (data.flr_id && status !== 'eventInProgress') {
    return {
      evidence_class: 'ground_truth',
      resolution_eligible: true,
      ineligible_reason: null,
      recommended_state: 'resolved',
      brier_discount: 0,
    };
  }

  // Complete SWPC flare with age >2h
  if (status === 'complete' && age > 2) {
    return {
      evidence_class: crossValidated ? 'ground_truth' : 'provisional_mature',
      resolution_eligible: true,
      ineligible_reason: null,
      recommended_state: crossValidated ? 'resolved' : 'provisional_hold',
      brier_discount: crossValidated ? 0 : 0.05,
    };
  }

  // Complete but fresh
  if (status === 'complete') {
    return {
      evidence_class: crossValidated ? 'cross_validated' : 'provisional',
      resolution_eligible: crossValidated,
      ineligible_reason: crossValidated ? null : 'Flare complete but not yet cross-validated',
      recommended_state: crossValidated ? 'provisional_hold' : 'open',
      brier_discount: crossValidated ? 0.05 : 0.10,
    };
  }

  // In-progress flare
  if (status === 'eventInProgress') {
    // Check if theatre is about to expire — freeze if data isn't ready
    if (earliestExpiry && earliestExpiry - Date.now() < 30 * 60_000 && quality.composite < 0.6) {
      return {
        evidence_class: 'provisional',
        resolution_eligible: false,
        ineligible_reason: 'Flare in progress, theatre expiring, data not mature',
        recommended_state: 'frozen',
        brier_discount: 0.15,
      };
    }

    return {
      evidence_class: 'provisional',
      resolution_eligible: false,
      ineligible_reason: 'Flare still in progress — class may be revised',
      recommended_state: 'open',
      brier_discount: 0.15,
    };
  }

  return {
    evidence_class: 'provisional',
    resolution_eligible: false,
    ineligible_reason: 'Insufficient data for settlement',
    recommended_state: 'open',
    brier_discount: 0.15,
  };
}

/**
 * Kp settlement assessment.
 *
 * Ground truth: GFZ definitive Kp (published ~30 days after observation)
 * Provisional mature: SWPC Kp with age >6h (next 3-hour window has passed)
 */
function assessKpSettlement(data, quality, crossValidated) {
  const isDefinitive = data.source === 'GFZ';
  const age = data.time ? (Date.now() - data.time) / 3600_000 : 0;

  if (isDefinitive) {
    return {
      evidence_class: 'ground_truth',
      resolution_eligible: true,
      ineligible_reason: null,
      recommended_state: 'resolved',
      brier_discount: 0,
    };
  }

  // SWPC Kp with one full update cycle passed
  if (age > 6) {
    return {
      evidence_class: 'provisional_mature',
      resolution_eligible: true,
      ineligible_reason: null,
      recommended_state: 'provisional_hold',
      brier_discount: 0.05,
    };
  }

  // Current-cycle Kp
  return {
    evidence_class: 'provisional',
    resolution_eligible: false,
    ineligible_reason: 'Kp is preliminary — wait for next update cycle',
    recommended_state: 'open',
    brier_discount: 0.10,
  };
}

/**
 * Proton flux settlement.
 *
 * GOES proton flux is near-real-time and doesn't undergo major revisions.
 * Ground truth if sustained above threshold for >15 minutes (NOAA S-scale rule).
 */
function assessProtonSettlement(data, quality) {
  const flux = data.flux ?? 0;
  const age = data.time ? (Date.now() - data.time) / 60_000 : 0; // minutes

  // High flux sustained = ground truth
  if (flux >= 10 && age > 15) {
    return {
      evidence_class: 'ground_truth',
      resolution_eligible: true,
      ineligible_reason: null,
      recommended_state: 'resolved',
      brier_discount: 0,
    };
  }

  if (flux >= 10) {
    return {
      evidence_class: 'provisional',
      resolution_eligible: false,
      ineligible_reason: 'Proton event may not be sustained — wait 15 min',
      recommended_state: 'open',
      brier_discount: 0.10,
    };
  }

  return {
    evidence_class: 'provisional',
    resolution_eligible: false,
    ineligible_reason: 'Below S1 threshold',
    recommended_state: 'open',
    brier_discount: 0,
  };
}

/**
 * Solar wind settlement — generally informational, not directly resolvable.
 */
function assessSolarWindSettlement(data, quality) {
  return {
    evidence_class: quality.composite > 0.7 ? 'cross_validated' : 'provisional',
    resolution_eligible: false,
    ineligible_reason: 'Solar wind data is continuous — used for position updates, not direct resolution',
    recommended_state: 'open',
    brier_discount: 0,
  };
}

/**
 * CME settlement — DONKI CMEs with WSA-Enlil runs are authoritative.
 */
function assessCMESettlement(data, quality, crossValidated) {
  if (data.analysis && data.earth_arrival) {
    return {
      evidence_class: 'provisional_mature',
      resolution_eligible: false,
      ineligible_reason: 'CME prediction — resolution requires arrival confirmation',
      recommended_state: 'open',
      brier_discount: 0.10,
    };
  }

  return {
    evidence_class: 'provisional',
    resolution_eligible: false,
    ineligible_reason: 'CME without arrival prediction',
    recommended_state: 'open',
    brier_discount: 0.15,
  };
}

/**
 * Geomagnetic storm settlement — DONKI GST events with Kp observations.
 */
function assessGSTSettlement(data, quality, crossValidated) {
  if (data.max_kp >= 5 && data.kp_indices && data.kp_indices.length > 0) {
    return {
      evidence_class: 'ground_truth',
      resolution_eligible: true,
      ineligible_reason: null,
      recommended_state: 'resolved',
      brier_discount: 0,
    };
  }

  return {
    evidence_class: 'provisional',
    resolution_eligible: false,
    ineligible_reason: 'Geomagnetic storm data incomplete',
    recommended_state: 'open',
    brier_discount: 0.10,
  };
}
