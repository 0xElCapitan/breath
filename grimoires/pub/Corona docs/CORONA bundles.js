/**
 * Evidence bundle construction for space weather events.
 *
 * Converts raw SWPC/DONKI data into Echelon-compatible evidence bundles
 * by composing quality scoring, uncertainty pricing, settlement assessment,
 * and theatre matching.
 */

import { computeQuality } from './quality.js';
import { buildFlareUncertainty, buildKpUncertainty, buildCMEArrivalUncertainty } from './uncertainty.js';
import { assessSettlement } from './settlement.js';

/**
 * Build an evidence bundle from a raw space weather event.
 *
 * @param {object} event - { type, data, polledAt }
 * @param {object} config - { activeTheatres, revisionHistories }
 * @returns {object|null} Evidence bundle, or null if event should be skipped
 */
export function buildBundle(event, config = {}) {
  const { activeTheatres = [], revisionHistories = new Map() } = config;
  const { type, data, polledAt = Date.now() } = event;

  if (!type || !data) return null;

  // Quality scoring
  const quality = computeQuality(event);

  // Build type-specific payload
  let payload;
  let uncertainty;

  switch (type) {
    case 'solar_flare':
      if (!data.begin_time) return null;
      uncertainty = buildFlareUncertainty(data);
      payload = buildFlarePayload(data, quality, uncertainty);
      break;

    case 'donki_flare':
      if (!data.begin_time) return null;
      uncertainty = buildFlareUncertainty(data);
      payload = buildDonkiFlarePayload(data, quality, uncertainty);
      break;

    case 'kp_index':
      if (data.kp == null) return null;
      uncertainty = buildKpUncertainty(data);
      payload = buildKpPayload(data, quality, uncertainty);
      break;

    case 'proton_flux':
      if (data.flux == null) return null;
      payload = buildProtonPayload(data, quality);
      break;

    case 'solar_wind':
      payload = buildSolarWindPayload(data, quality);
      break;

    case 'donki_cme':
      if (!data.start_time) return null;
      payload = buildCMEPayload(data, quality);
      break;

    case 'donki_geomagnetic_storm':
      if (!data.start_time) return null;
      payload = buildGSTPayload(data, quality);
      break;

    default:
      return null;
  }

  // Match active theatres
  const theatreRefs = matchTheatres(event, activeTheatres);

  // Earliest expiry of matched theatres
  const earliestExpiry = theatreRefs.length > 0
    ? Math.min(
        ...activeTheatres
          .filter((t) => theatreRefs.includes(t.id))
          .map((t) => t.closes_at)
      )
    : null;

  // Settlement assessment
  const revisionHistory = revisionHistories.get(payload.event_id) ?? [];
  const settlement = assessSettlement(event, quality, revisionHistory, false, earliestExpiry);

  // Evidence class (may be upgraded/downgraded)
  let evidenceClass = settlement.evidence_class;

  // Downgrade if quality is very low
  if (quality.composite < 0.3 && evidenceClass !== 'ground_truth') {
    evidenceClass = 'degraded';
  }

  const revision = revisionHistory.length;

  return {
    bundle_id: `corona-${type.replace('donki_', '')}-${payload.event_id}-r${revision}`,
    construct: 'CORONA',
    source: getSource(type, data),
    ingestion_ts: polledAt,
    evidence_class: evidenceClass,

    payload: {
      ...payload,
      quality,
    },

    theatre_refs: theatreRefs,

    resolution: {
      eligible: settlement.resolution_eligible,
      ineligible_reason: settlement.ineligible_reason,
      recommended_state: settlement.recommended_state,
      brier_discount: settlement.brier_discount,
    },
  };
}

// =========================================================================
// Payload builders
// =========================================================================

function buildFlarePayload(data, quality, uncertainty) {
  return {
    event_id: data.event_id ?? `swpc-flare-${data.begin_time}`,
    event_type: 'solar_flare',
    flare: {
      class_string: uncertainty.class_string,
      flux: uncertainty.value,
      rank: uncertainty.rank,
      uncertainty,
    },
    timing: {
      begin: data.begin_time,
      peak: data.max_time,
      end: data.end_time,
    },
    status: data.status,
    satellite: data.satellite,
    source_oracle: 'SWPC_GOES',
  };
}

function buildDonkiFlarePayload(data, quality, uncertainty) {
  return {
    event_id: data.flr_id ?? `donki-flr-${data.begin_time}`,
    event_type: 'solar_flare',
    flare: {
      class_string: data.class_type,
      flux: uncertainty.value,
      rank: uncertainty.rank,
      uncertainty,
    },
    timing: {
      begin: data.begin_time,
      peak: data.peak_time,
      end: data.end_time,
    },
    source_location: data.source_location,
    active_region: data.active_region,
    linked_events: data.linked_events,
    status: 'confirmed',
    source_oracle: 'DONKI',
  };
}

function buildKpPayload(data, quality, uncertainty) {
  return {
    event_id: `kp-${data.time_tag ?? data.time}`,
    event_type: 'kp_index',
    kp: {
      value: data.kp,
      uncertainty,
    },
    time_tag: data.time_tag,
    event_time: data.time,
    source_oracle: data.source === 'GFZ' ? 'GFZ' : 'SWPC_KP',
  };
}

function buildProtonPayload(data, quality) {
  return {
    event_id: `proton-${data.energy}-${data.time}`,
    event_type: 'proton_flux',
    proton: {
      flux: data.flux,
      energy_channel: data.energy,
      // S-scale threshold: ≥10 MeV protons at ≥10 pfu
      above_s1: data.flux >= 10 && (data.energy ?? '').includes('10'),
    },
    event_time: data.time,
    satellite: data.satellite,
    source_oracle: 'SWPC_GOES',
  };
}

function buildSolarWindPayload(data, quality) {
  const mag = data.mag;
  const plasma = data.plasma;

  return {
    event_id: `sw-${data.time ?? Date.now()}`,
    event_type: 'solar_wind',
    magnetic_field: mag ? {
      bz_gsm: mag.bz_gsm,
      bt: mag.bt,
      bx_gsm: mag.bx_gsm,
      by_gsm: mag.by_gsm,
    } : null,
    plasma: plasma ? {
      speed: plasma.speed,
      density: plasma.density,
      temperature: plasma.temperature,
    } : null,
    // Derived indicators
    indicators: {
      southward_bz: mag?.bz_gsm != null && mag.bz_gsm < -5,
      high_speed: plasma?.speed != null && plasma.speed > 500,
      storm_conditions: (
        mag?.bz_gsm != null && mag.bz_gsm < -10 &&
        plasma?.speed != null && plasma.speed > 400
      ),
    },
    event_time: data.time,
    source_oracle: 'SWPC_DSCOVR',
  };
}

function buildCMEPayload(data, quality) {
  const arrivalUncertainty = buildCMEArrivalUncertainty(data);

  return {
    event_id: data.activity_id ?? `cme-${data.start_time}`,
    event_type: 'cme',
    cme: {
      start_time: data.start_time,
      speed: data.analysis?.speed ?? null,
      half_angle: data.analysis?.half_angle ?? null,
      type: data.analysis?.type ?? null,
      source_location: data.source_location,
      active_region: data.active_region,
    },
    earth_arrival: data.earth_arrival,
    arrival_uncertainty: arrivalUncertainty,
    linked_events: data.linked_events,
    event_time: data.start_time,
    source_oracle: 'DONKI',
  };
}

function buildGSTPayload(data, quality) {
  return {
    event_id: data.gst_id ?? `gst-${data.start_time}`,
    event_type: 'geomagnetic_storm',
    storm: {
      start_time: data.start_time,
      max_kp: data.max_kp,
      kp_indices: data.kp_indices,
    },
    linked_events: data.linked_events,
    event_time: data.start_time,
    source_oracle: 'DONKI',
  };
}

// =========================================================================
// Source determination
// =========================================================================

function getSource(type, data) {
  switch (type) {
    case 'solar_flare': return 'SWPC_GOES';
    case 'donki_flare': return 'DONKI';
    case 'kp_index': return data.source === 'GFZ' ? 'GFZ_POTSDAM' : 'SWPC_NOAA';
    case 'proton_flux': return 'SWPC_GOES';
    case 'solar_wind': return 'SWPC_DSCOVR';
    case 'donki_cme': return 'DONKI';
    case 'donki_geomagnetic_storm': return 'DONKI';
    default: return 'UNKNOWN';
  }
}

// =========================================================================
// Theatre matching
// =========================================================================

/**
 * Match an event against active theatres.
 *
 * Space weather theatres don't have geographic bounding boxes
 * (events are Sun-Earth oriented). Matching is by:
 *   - Event type compatibility
 *   - Temporal window
 *   - Threshold relevance
 */
function matchTheatres(event, theatres) {
  const { type, data } = event;
  const eventTime = data.begin_time ?? data.time ?? data.start_time ?? Date.now();

  return theatres
    .filter((theatre) => {
      if (theatre.state !== 'open' && theatre.state !== 'provisional_hold') return false;
      if (eventTime < theatre.opens_at || eventTime > theatre.closes_at) return false;

      // Template-specific matching
      switch (theatre.template) {
        case 'flare_class_gate':
          return type === 'solar_flare' || type === 'donki_flare';

        case 'geomagnetic_storm_gate':
          return type === 'kp_index' || type === 'donki_geomagnetic_storm' || type === 'solar_wind';

        case 'cme_arrival':
          return type === 'donki_cme' || type === 'solar_wind' || type === 'donki_geomagnetic_storm';

        case 'proton_event_cascade':
          return type === 'solar_flare' || type === 'donki_flare' || type === 'proton_flux';

        case 'solar_wind_divergence':
          return type === 'solar_wind';

        default:
          return false;
      }
    })
    .map((t) => t.id);
}
