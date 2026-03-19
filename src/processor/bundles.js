/**
 * Evidence Bundle Construction
 *
 * Pure assembly functions. No side effects, no API calls.
 * Combines processor pipeline outputs (quality, uncertainty, settlement)
 * into Echelon-compatible evidence bundles.
 *
 * Two bundle builders:
 *   buildPurpleAirBundle — data_tier: 'early_warning'
 *   buildAirNowBundle    — data_tier: 'settlement_authority'
 *
 * Bundle IDs:
 *   PurpleAir: breath-purpleair-{sensor_index}-{last_seen}
 *   AirNow:    breath-airnow-{ReportingArea_slug}-{observation_time}
 *
 * Attribution is mandatory for AirNow per EPA AirNow exchange guidelines.
 */

import { classifyConsistency } from './quality.js';

// ---------------------------------------------------------------------------
// PurpleAir bundle
// ---------------------------------------------------------------------------

/**
 * Build an evidence bundle from a PurpleAir sensor reading.
 *
 * @param {object} sensor - Normalised PurpleAir sensor
 * @param {object|null} registryRecord - SensorRegistry entry
 * @param {object} qualityResult - From computeQuality()
 * @param {object} uncertaintyResult - From buildUncertainty()
 * @param {object} settlementResult - From assessSettlement()
 * @param {object[]} activeTheatres - For theatre_refs matching
 * @returns {EvidenceBundle}
 */
export function buildPurpleAirBundle(
  sensor,
  registryRecord,
  qualityResult,
  uncertaintyResult,
  settlementResult,
  activeTheatres,
) {
  const now = Date.now();
  const theatreRefs = matchTheatres(sensor, activeTheatres);
  const channelConsistency = classifyConsistency(qualityResult.components.consistency);

  return {
    bundle_id: `breath-purpleair-${sensor.sensor_index}-${sensor.last_seen}`,
    construct: 'BREATH',
    source: 'PURPLEAIR',
    ingestion_ts: now,
    evidence_class: settlementResult.evidence_class,
    data_tier: 'early_warning',
    attribution: 'PurpleAir Community Sensor Network',

    payload: {
      // Time semantics
      // PurpleAir last_seen is Unix epoch seconds — convert to ms.
      // PurpleAir does not publish a separate publication timestamp.
      observation_time: sensor.last_seen * 1000,
      publication_time: sensor.last_seen * 1000,
      ingest_time: now,
      // PurpleAir reports a ~2-minute rolling average, not a 1-hour average.
      // This is equivalent to an instantaneous reading for our purposes.
      // NowCast requires full hourly history (collected in SensorRegistry.pm25_history).
      averaging_basis: 'instantaneous',

      location: {
        latitude: sensor.latitude,
        longitude: sensor.longitude,
        location_type: sensor.location_type, // 0 = outdoor
        region_label: sensor.name,
        sensor_id: sensor.sensor_index,
      },

      aqi: {
        value: sensor.aqi_computed,
        category: sensor.aqi_category.name,
        category_number: sensor.aqi_category.number,
        dominant_pollutant: 'PM25', // PurpleAir is PM2.5 specialist
        calculation_method: 'nowcast_equivalent',
      },

      pollutants: [
        {
          name: 'PM2.5',
          concentration: sensor.pm25_avg,
          unit: 'µg/m³',
          aqi_value: sensor.aqi_computed,
        },
      ],

      quality: qualityResult,
      uncertainty: uncertaintyResult,

      // PurpleAir-specific fields
      channel_a: sensor.pm25_a ?? null,
      channel_b: sensor.pm25_b ?? null,
      channel_consistency: channelConsistency,
      sensor_state: registryRecord?.state ?? 'active',
    },

    cross_validation: qualityResult.cross_validated
      ? { epa_nearby: { agreement: true } }
      : null,

    theatre_refs: theatreRefs,

    resolution: {
      eligible: settlementResult.resolution_eligible,
      ineligible_reason: settlementResult.ineligible_reason,
      recommended_state: settlementResult.recommended_state,
      brier_discount: settlementResult.brier_discount,
    },
  };
}

// ---------------------------------------------------------------------------
// EPA AirNow bundle
// ---------------------------------------------------------------------------

/**
 * Build an evidence bundle from an EPA AirNow observation.
 *
 * AirNow bundles are always:
 *   - data_tier: 'settlement_authority'
 *   - evidence_class: 'ground_truth'
 *   - attribution: 'U.S. EPA AirNow (preliminary data — not for regulatory use)'
 *
 * @param {object} obs - AirNow observation object (from API or normalised)
 *   @param {string} obs.ReportingArea
 *   @param {number} obs.Latitude
 *   @param {number} obs.Longitude
 *   @param {number} obs.AQI
 *   @param {{ Number: number, Name: string }} obs.Category
 *   @param {string} obs.ParameterName
 *   @param {number} obs._observation_time - Epoch ms (pre-parsed by oracle)
 * @param {object} qualityResult - From computeAirNowQuality()
 * @param {object} uncertaintyResult - From buildAirNowUncertainty()
 * @param {object} settlementResult - From assessAirNowSettlement()
 * @param {object[]} activeTheatres - For theatre_refs matching
 * @returns {EvidenceBundle}
 */
export function buildAirNowBundle(
  obs,
  qualityResult,
  uncertaintyResult,
  settlementResult,
  activeTheatres,
) {
  const now = Date.now();
  const observationTime = obs._observation_time ?? now;
  // M3: Guard against null/undefined ReportingArea (malformed AirNow response).
  const reportingArea = obs.ReportingArea ?? '';
  const regionSlug = reportingArea.trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
  const theatreRefs = matchAirNowObservation(obs, activeTheatres);

  return {
    bundle_id: `breath-airnow-${regionSlug}-${observationTime}`,
    construct: 'BREATH',
    source: 'EPA_AIRNOW',
    ingestion_ts: now,
    evidence_class: 'ground_truth', // AirNow is always ground_truth
    data_tier: 'settlement_authority',
    // Required by EPA AirNow exchange guidelines.
    attribution: 'U.S. EPA AirNow (preliminary data — not for regulatory use)',

    payload: {
      // Time semantics (all four fields mandatory per SDD)
      observation_time: observationTime,
      // AirNow API does not expose a separate publication timestamp.
      // Use ingest time as a conservative estimate.
      publication_time: now,
      ingest_time: now,
      // AirNow NowCast for PM2.5; hourly average for other pollutants.
      averaging_basis: 'nowcast',

      location: {
        latitude: obs.Latitude,
        longitude: obs.Longitude,
        location_type: null, // AirNow is region-based, not a point sensor
        region_label: reportingArea.trim(),
        sensor_id: reportingArea.trim(),
      },

      aqi: {
        value: obs.AQI,
        category: obs.Category?.Name ?? 'Unknown',
        category_number: obs.Category?.Number ?? 0,
        dominant_pollutant: obs.ParameterName,
        calculation_method: 'official',
      },

      pollutants: [
        {
          name: obs.ParameterName,
          // AirNow API returns AQI, not raw concentration. Raw concentration
          // is available in the AQS dataset (not used in MVP).
          concentration: null,
          unit: null,
          aqi_value: obs.AQI,
        },
      ],

      quality: qualityResult,
      uncertainty: uncertaintyResult,
    },

    // AirNow IS the cross-validator — no cross-validation field needed.
    cross_validation: null,

    theatre_refs: theatreRefs,

    resolution: {
      eligible: settlementResult.resolution_eligible,
      ineligible_reason: settlementResult.ineligible_reason,
      recommended_state: settlementResult.recommended_state,
      brier_discount: settlementResult.brier_discount,
    },
  };
}

// ---------------------------------------------------------------------------
// Theatre matching helpers
// ---------------------------------------------------------------------------

/**
 * Find active Theatres whose bounding box contains a PurpleAir sensor.
 *
 * @param {object} sensor - { longitude, latitude }
 * @param {object[]} theatres - Array of Theatre objects
 * @returns {string[]} IDs of matching Theatres
 */
export function matchTheatres(sensor, theatres) {
  if (!theatres || theatres.length === 0) return [];

  return theatres
    .filter(t => {
      // Only open or provisional_hold theatres receive evidence
      if (t.state !== 'open' && t.state !== 'provisional_hold') return false;
      // M2: Guard against missing or malformed region_bbox.
      if (!Array.isArray(t.region_bbox) || t.region_bbox.length < 4) return false;

      const [minLon, minLat, maxLon, maxLat] = t.region_bbox;
      return (
        sensor.longitude >= minLon &&
        sensor.longitude <= maxLon &&
        sensor.latitude  >= minLat &&
        sensor.latitude  <= maxLat
      );
    })
    .map(t => t.id);
}

/**
 * Find active Theatres whose bounding box contains an AirNow observation point.
 *
 * @param {object} obs - { Longitude, Latitude }
 * @param {object[]} theatres
 * @returns {string[]}
 */
export function matchAirNowObservation(obs, theatres) {
  if (!theatres || theatres.length === 0) return [];

  return theatres
    .filter(t => {
      if (t.state !== 'open' && t.state !== 'provisional_hold') return false;
      // M2: Guard against missing or malformed region_bbox.
      if (!Array.isArray(t.region_bbox) || t.region_bbox.length < 4) return false;

      const [minLon, minLat, maxLon, maxLat] = t.region_bbox;
      return (
        obs.Longitude >= minLon &&
        obs.Longitude <= maxLon &&
        obs.Latitude  >= minLat &&
        obs.Latitude  <= maxLat
      );
    })
    .map(t => t.id);
}
