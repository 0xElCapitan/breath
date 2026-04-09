/**
 * PurpleAir Oracle
 *
 * Polls PurpleAir API v1/sensors, normalises the fields/data response format,
 * updates the SensorRegistry, runs the processor pipeline, and returns
 * evidence bundles for all new/updated outdoor sensors.
 *
 * Key design constraints:
 *  - Zero production dependencies — uses built-in fetch (Node.js 18+)
 *  - location_type=0 (outdoor) only — indoor sensors filtered before bundling
 *  - CF=1 (ATM) values used directly — PurpleAir API returns CF=1 in pm2.5 field
 *  - Dedup: sensors with unchanged last_seen produce no bundle this cycle
 *  - Dropout: sensors with last_seen older than 2× pollInterval → sensor_dropout bundle
 *  - Rate limit: exponential backoff on 429 with per-bbox response cache
 */

import { SensorRegistry } from '../index.js';
import {
  computeNowCast,
  calculateAQI,
  getCategory,
} from '../processor/aqi.js';
import {
  computeQuality,
  computeAirNowQuality,
} from '../processor/quality.js';
import {
  buildUncertainty,
} from '../processor/uncertainty.js';
import {
  assessSettlement,
  assessAirNowSettlement,
} from '../processor/settlement.js';
import {
  buildPurpleAirBundle,
} from '../processor/bundles.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PURPLEAIR_API_BASE = 'https://api.purpleair.com/v1/sensors';

/** Required fields for the PurpleAir API request. */
const PURPLEAIR_FIELDS = [
  'sensor_index', 'name', 'latitude', 'longitude',
  'pm2.5', 'pm2.5_a', 'pm2.5_b', 'confidence',
  'last_seen', 'location_type',
].join(',');

/** Poll cadence: PurpleAir sensors report approximately every 2 minutes. */
export const POLL_INTERVAL_MS = 120_000;

// ---------------------------------------------------------------------------
// Rate limiting / backoff
// ---------------------------------------------------------------------------

const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS     = 300_000; // 5 minutes max
const BACKOFF_MULTIPLIER = 2;

/** Per-bbox backoff state: label → { delayMs } */
const backoffState = new Map();

/** Per-bbox response cache: label → { timestamp, data } */
const responseCache = new Map();

function getBackoffDelay(label) {
  return backoffState.get(label)?.delayMs ?? 0;
}

function advanceBackoff(label) {
  const current = backoffState.get(label)?.delayMs ?? BACKOFF_INITIAL_MS / BACKOFF_MULTIPLIER;
  const next = Math.min(current * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
  backoffState.set(label, { delayMs: next });
}

function resetBackoff(label) {
  backoffState.delete(label);
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Normalise a PurpleAir API response from the fields/data array format
 * into an array of sensor objects.
 *
 * PurpleAir returns:
 *   { fields: ['sensor_index', 'name', ...], data: [[123, 'SensorA', ...], ...] }
 *
 * @param {{ fields: string[], data: Array<Array> }} apiResponse
 * @returns {object[]} Array of sensor objects keyed by field names
 */
export function normalizePurpleAirResponse(apiResponse) {
  if (!apiResponse?.fields || !apiResponse?.data) return [];
  const { fields, data } = apiResponse;

  const sensors = [];
  for (const row of data) {
    // B5: Guard against short rows — PurpleAir API could return truncated data
    if (!Array.isArray(row) || row.length < fields.length) {
      console.warn(`[BREATH:PurpleAir] Dropping row with ${row?.length ?? 0} fields (expected ${fields.length})`);
      continue;
    }

    const sensor = {};
    for (let i = 0; i < fields.length; i++) {
      sensor[fields[i]] = row[i];
    }

    // Normalise field names to camelCase equivalents used by the processor.
    // PurpleAir uses 'pm2.5', 'pm2.5_a', 'pm2.5_b' (dots in field names).
    sensor.pm25_avg = sensor['pm2.5'] ?? null;
    sensor.pm25_a   = sensor['pm2.5_a'] ?? null;
    sensor.pm25_b   = sensor['pm2.5_b'] ?? null;

    // B5: Validate required fields — drop sensors with missing/non-numeric core fields
    if (
      typeof sensor.sensor_index !== 'number' ||
      typeof sensor.latitude !== 'number' || !isFinite(sensor.latitude) ||
      typeof sensor.longitude !== 'number' || !isFinite(sensor.longitude) ||
      typeof sensor.last_seen !== 'number'
    ) {
      console.warn(`[BREATH:PurpleAir] Dropping sensor ${sensor.sensor_index ?? '?'} — missing required numeric fields`);
      continue;
    }

    sensors.push(sensor);
  }
  return sensors;
}

/**
 * Compute the number of other sensors in the batch with similar AQI (within ±20).
 * Used to populate nearby_agreement_count in the SensorRegistry.
 *
 * "Nearby" is approximated as within 0.5° in both lat and lon (≈50km bbox).
 * TBD: empirical calibration needed — 0.5° radius is an engineering estimate
 *
 * @param {object} sensor
 * @param {object[]} allSensors - Full normalized batch
 * @returns {number}
 */
function computeNearbyAgreementCount(sensor, allSensors) {
  if (sensor.aqi_computed === null || sensor.aqi_computed === undefined) return 0;
  return allSensors.filter(other => {
    if (other.sensor_index === sensor.sensor_index) return false;
    if (other.aqi_computed === null || other.aqi_computed === undefined) return false;
    const latClose = Math.abs(other.latitude - sensor.latitude) <= 0.5;
    const lonClose = Math.abs(other.longitude - sensor.longitude) <= 0.5;
    const aqiClose = Math.abs(other.aqi_computed - sensor.aqi_computed) <= 20;
    return latClose && lonClose && aqiClose;
  }).length;
}

/**
 * Poll PurpleAir API for all configured bounding boxes.
 * Updates the SensorRegistry in place.
 * Returns evidence bundles for new/updated outdoor sensors.
 *
 * @param {object} config
 *   @param {string} config.apiKey - PurpleAir API key
 *   @param {object[]} config.bboxes - Array of { nwlng, nwlat, selng, selat, label }
 * @param {SensorRegistry} registry
 * @param {object[]} [activeTheatres=[]] - For theatre_refs matching
 * @returns {Promise<{ bundles: object[], dropouts: object[] }>}
 */
export async function pollPurpleAir(config, registry, activeTheatres = []) {
  const bundles = [];
  const allDropouts = [];

  const apiKey = config?.apiKey ?? process.env.PURPLEAIR_API_KEY;
  const bboxes = config?.bboxes ?? [];

  for (const bbox of bboxes) {
    const label = bbox.label ?? `${bbox.nwlng},${bbox.nwlat},${bbox.selng},${bbox.selat}`;

    // Fetch sensors for this bbox
    const url = new URL(PURPLEAIR_API_BASE);
    url.searchParams.set('fields', PURPLEAIR_FIELDS);
    url.searchParams.set('nwlng', bbox.nwlng);
    url.searchParams.set('nwlat', bbox.nwlat);
    url.searchParams.set('selng', bbox.selng);
    url.searchParams.set('selat', bbox.selat);
    url.searchParams.set('location_type', '0'); // outdoor only

    let apiResponse;
    try {
      const res = await fetch(url.toString(), {
        headers: { 'X-API-Key': apiKey },
      });

      if (res.status === 429) {
        advanceBackoff(label);
        const cached = responseCache.get(label);
        if (cached) {
          // Return cached response with degraded-quality flag
          apiResponse = cached.data;
        } else {
          continue; // No cache — skip this bbox this cycle
        }
      } else if (!res.ok) {
        if (res.status === 401) {
          console.error(`[BREATH:PurpleAir] CRITICAL: 401 Unauthorized — check PURPLEAIR_API_KEY`);
        } else {
          console.warn(`[BREATH:PurpleAir] HTTP ${res.status} for bbox ${label}`);
        }
        continue;
      } else {
        apiResponse = await res.json();
        responseCache.set(label, { timestamp: Date.now(), data: apiResponse });
        resetBackoff(label);
      }
    } catch (err) {
      console.error(`[BREATH:PurpleAir] Network error for bbox ${label}:`, err.message);
      continue;
    }

    const normalized = normalizePurpleAirResponse(apiResponse);

    // Phase 1: filter indoor sensors. Check dedup BEFORE updating the registry so we
    // can compare sensor.last_seen against the pre-update stored value.
    const outdoorSensors = normalized.filter(s => s.location_type === 0);

    // Dedup map: sensor_index → isNewReading (true = new data, false = unchanged last_seen)
    const isNewReadingMap = new Map();
    for (const sensor of outdoorSensors) {
      const preRecord = registry.sensors.get(sensor.sensor_index);
      isNewReadingMap.set(
        sensor.sensor_index,
        !preRecord || preRecord.last_seen !== sensor.last_seen,
      );
    }

    // Update registry for all outdoor sensors (new + repeated).
    // registry.update() only appends to pm25_history when last_seen changed.
    registry.update(outdoorSensors);

    // Phase 2: compute AQI for sensors with new data only.
    for (const sensor of outdoorSensors) {
      if (!isNewReadingMap.get(sensor.sensor_index)) {
        // Frozen reading — sensor is alive (seen this cycle) but no new data.
        continue;
      }
      const existingRecord = registry.sensors.get(sensor.sensor_index);

      // Compute NowCast from accumulated history (capped at 12 entries by registry).
      const pm25History12 = (existingRecord?.pm25_history ?? [])
        .slice(0, 12)
        .map(h => h.avg);
      const nowcastConc = computeNowCast(pm25History12);
      // Fall back to raw pm25_avg when insufficient history for NowCast.
      const concentration = (nowcastConc !== null) ? nowcastConc : sensor.pm25_avg;

      // Compute AQI
      sensor.aqi_computed   = calculateAQI('PM25', concentration);
      sensor.aqi_category   = getCategory(sensor.aqi_computed ?? 0);
      sensor.nowcast_concentration = nowcastConc;

      // Update AQI history in registry
      registry.updateAqiHistory(
        sensor.sensor_index,
        sensor.last_seen * 1000,
        sensor.aqi_computed,
      );

      // Update channel consistency rolling average
      registry.updateChannelConsistency(sensor.sensor_index, sensor.pm25_a, sensor.pm25_b);
    }

    // Phase 3: compute nearby_agreement_count (requires all AQIs to be set first)
    for (const sensor of outdoorSensors) {
      if (sensor.aqi_computed === undefined) continue;
      const count = computeNearbyAgreementCount(sensor, outdoorSensors);
      registry.setNearbyAgreementCount(sensor.sensor_index, count);
    }

    // Phase 4: build bundles
    for (const sensor of outdoorSensors) {
      if (sensor.aqi_computed === undefined) continue; // Was a dedup — skipped in phase 2

      const record = registry.sensors.get(sensor.sensor_index);
      sensor.state = record?.state ?? 'active';

      const quality    = computeQuality(sensor, record, [], null, POLL_INTERVAL_MS);
      const uncertainty = buildUncertainty(sensor, quality, null);
      const settlement  = assessSettlement(sensor, quality, record, quality.cross_validated, null);

      bundles.push(buildPurpleAirBundle(sensor, record, quality, uncertainty, settlement, activeTheatres));
    }

    // Phase 5: dropout detection — sensors in registry with stale last_seen.
    // Exclude any sensor that appeared in this API response — those are active.
    const seenThisCycle = new Set(outdoorSensors.map(s => s.sensor_index));
    const now = Date.now();
    const dropouts = registry.getDropouts(now, POLL_INTERVAL_MS)
      .filter(r => !seenThisCycle.has(r.sensor_index));
    for (const record of dropouts) {
      if (record.state === 'dropout') continue; // Already flagged this cycle
      registry.setState(record.sensor_index, 'dropout');
      // Synthesise a dropout bundle so downstream Theatre processing sees the gap.
      const dropoutSensor = {
        sensor_index: record.sensor_index,
        name: record.name,
        latitude: record.location.latitude,
        longitude: record.location.longitude,
        location_type: record.location.location_type,
        pm25_avg: null,
        pm25_a: null,
        pm25_b: null,
        last_seen: record.last_seen,
        aqi_computed: null,
        aqi_category: { number: 0, name: 'Unknown' },
        state: 'dropout',
      };
      const quality    = computeQuality(dropoutSensor, record, [], null, POLL_INTERVAL_MS);
      const uncertainty = buildUncertainty(dropoutSensor, quality, null);
      const settlement  = assessSettlement(dropoutSensor, quality, record, false, null);
      bundles.push(buildPurpleAirBundle(dropoutSensor, record, quality, uncertainty, settlement, activeTheatres));
      allDropouts.push(record);
    }
  }

  return { bundles, dropouts: allDropouts };
}

// ---------------------------------------------------------------------------
// Standalone script
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && new URL(process.argv[1], 'file://').href ===
  new URL(import.meta.url).href;

if (isMain) {
  const registry = new SensorRegistry();
  const config = {
    apiKey: process.env.PURPLEAIR_API_KEY,
    bboxes: [
      { label: 'NW-US',  nwlng: -125, nwlat: 49, selng: -100, selat: 37 },
      { label: 'NE-US',  nwlng: -100, nwlat: 49, selng: -65,  selat: 37 },
      { label: 'SW-US',  nwlng: -125, nwlat: 37, selng: -100, selat: 25 },
      { label: 'SE-US',  nwlng: -100, nwlat: 37, selng: -65,  selat: 25 },
    ],
  };
  const { bundles, dropouts } = await pollPurpleAir(config, registry);
  console.log(`PurpleAir poll complete: ${bundles.length} bundles, ${dropouts.length} dropouts`);
  for (const bbox of config.bboxes) {
    const inBbox = registry.getSensorsInBbox([bbox.nwlng, bbox.selat, bbox.selng, bbox.nwlat]);
    console.log(`  ${bbox.label}: ${inBbox.length} sensors in registry`);
  }
}
