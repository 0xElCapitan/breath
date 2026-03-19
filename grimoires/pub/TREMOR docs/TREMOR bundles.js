/**
 * Evidence bundle construction.
 *
 * Converts a USGS GeoJSON feature into an Echelon-compatible evidence
 * bundle by composing quality scoring, magnitude uncertainty, settlement
 * assessment, and theatre matching.
 */

import { computeQuality } from './quality.js';
import { buildMagnitudeUncertainty } from './magnitude.js';
import { assessStatusFlip } from './settlement.js';

/**
 * Ingest a USGS feature and produce an evidence bundle.
 *
 * @param {object} feature - USGS GeoJSON feature
 * @param {object} config - { activeTheatres, revisionHistories, crossValidation }
 * @returns {object|null} Evidence bundle, or null if feature should be skipped
 */
export function buildBundle(feature, config = {}) {
  const { activeTheatres = [], revisionHistories = new Map() } = config;

  // Skip non-earthquakes and deleted/null-magnitude events
  if (feature.properties.type !== 'earthquake') return null;
  if (feature.properties.status === 'deleted') return null;
  if (feature.properties.mag === null) return null;

  const [lon, lat, depth] = feature.geometry.coordinates;
  const now = Date.now();
  const eventAge = (now - feature.properties.time) / 1000;

  // Build quality score (includes density normalization)
  const quality = computeQuality(feature);

  // Build magnitude uncertainty (includes doubt pricing)
  const magnitude = buildMagnitudeUncertainty(feature);

  // Cross-validation placeholder (populated async by EMSC oracle)
  const crossValidation = config.crossValidation ?? null;
  const crossValidated =
    crossValidation !== null &&
    crossValidation.sources_checked.length > 0;

  // Match active theatres
  const theatreRefs = matchTheatres(feature, activeTheatres);

  // Find earliest expiring matched theatre
  const earliestExpiry = theatreRefs.length > 0
    ? Math.min(
        ...activeTheatres
          .filter((t) => theatreRefs.includes(t.id))
          .map((t) => t.closes_at)
      )
    : null;

  // Assess settlement eligibility
  const revisionHistory = revisionHistories.get(feature.id) ?? [];
  const settlement = assessStatusFlip(
    feature,
    quality,
    revisionHistory,
    crossValidated,
    earliestExpiry,
  );

  // Determine evidence class
  let evidenceClass = settlement.evidence_class;

  // Upgrade to cross_validated if confirmed by 2+ networks with low divergence
  if (
    evidenceClass === 'provisional' &&
    crossValidation &&
    crossValidation.sources_checked.length >= 2 &&
    crossValidation.max_divergence < 0.2
  ) {
    evidenceClass = 'cross_validated';
  }

  // Downgrade if sparse network + high uncertainty
  if (
    quality.components.network_density_norm < 0.5 &&
    magnitude.doubt_price > 0.6
  ) {
    evidenceClass = 'degraded';
  }

  const revision = revisionHistory.length;

  return {
    bundle_id: `tremor-usgs-${feature.id}-r${revision}`,
    construct: 'TREMOR',
    source: 'USGS_NEIC',
    ingestion_ts: now,
    evidence_class: evidenceClass,

    payload: {
      event_id: feature.id,
      event_url: feature.properties.url,
      magnitude,
      location: {
        longitude: lon,
        latitude: lat,
        depth_km: depth,
        horizontal_error_km: feature.properties.horizontalError ?? null,
        depth_error_km: feature.properties.depthError ?? null,
        region_label: feature.properties.place ?? 'Unknown',
      },
      event_time: feature.properties.time,
      updated_time: feature.properties.updated,
      age_seconds: Math.round(eventAge),
      significance: feature.properties.sig,
      tsunami_flag: feature.properties.tsunami === 1,
      pager_alert: feature.properties.alert,
      shaking_intensity: feature.properties.mmi,
      felt_reports: feature.properties.felt,
      quality,
    },

    cross_validation: crossValidation,
    theatre_refs: theatreRefs,

    resolution: {
      eligible: settlement.resolution_eligible,
      ineligible_reason: settlement.ineligible_reason,
      recommended_state: settlement.recommended_state,
      brier_discount: settlement.brier_discount,
    },
  };
}

/**
 * Match a feature against active theatres.
 */
function matchTheatres(feature, theatres) {
  const [lon, lat] = feature.geometry.coordinates;
  const mag = feature.properties.mag ?? 0;
  const eventTime = feature.properties.time;

  return theatres
    .filter((theatre) => {
      if (theatre.state !== 'open' && theatre.state !== 'provisional_hold') {
        return false;
      }
      if (eventTime < theatre.opens_at || eventTime > theatre.closes_at) {
        return false;
      }
      const [minLon, minLat, maxLon, maxLat] = theatre.region_bbox;
      if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) {
        return false;
      }
      if (theatre.template === 'depth_regime' && mag < theatre.magnitude_threshold) {
        return false;
      }
      if (theatre.template === 'oracle_divergence' && feature.properties.status !== 'automatic') {
        return false;
      }
      return true;
    })
    .map((t) => t.id);
}
