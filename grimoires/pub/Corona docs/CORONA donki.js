/**
 * NASA DONKI (Space Weather Database Of Notifications, Knowledge, Information)
 *
 * Provides cause-and-effect linked space weather events:
 *   - Solar flares (FLR) with GOES class, location, linked CMEs
 *   - Coronal mass ejections (CME) with speed, direction, predicted arrival
 *   - Geomagnetic storms (GST) with Kp index, linked CMEs
 *   - Interplanetary shocks (IPS) with observed location
 *
 * API: https://api.nasa.gov/DONKI/
 * Auth: API key (DEMO_KEY for development, rate-limited)
 * Format: JSON arrays with linked event IDs
 */

import { buildBundle } from '../processor/bundles.js';

const DONKI_BASE = 'https://api.nasa.gov/DONKI';

/**
 * Get NASA API key from environment or use DEMO_KEY.
 */
function getApiKey() {
  return process.env.NASA_API_KEY ?? process.env.DONKI_API_KEY ?? 'DEMO_KEY';
}

/**
 * Format date as YYYY-MM-DD for DONKI API.
 */
function formatDate(date) {
  const d = new Date(date);
  return d.toISOString().slice(0, 10);
}

// =========================================================================
// DONKI endpoints
// =========================================================================

/**
 * Fetch solar flares from DONKI.
 *
 * Response shape (array):
 * {
 *   flrID: "2025-01-15T12:30:00-FLR-001",
 *   instruments: [{ displayName: "GOES-16: EXIS 1.0-8.0A" }],
 *   beginTime: "2025-01-15T12:30Z",
 *   peakTime: "2025-01-15T12:45Z",
 *   endTime: "2025-01-15T13:15Z",
 *   classType: "M2.5",
 *   sourceLocation: "N15E33",
 *   activeRegionNum: 3456,
 *   linkedEvents: [{ activityID: "2025-01-15T13:00:00-CME-001" }],
 *   link: "https://kauai.ccmc.gsfc.nasa.gov/DONKI/view/FLR/..."
 * }
 */
export async function fetchFlares(startDate, endDate) {
  const start = formatDate(startDate ?? Date.now() - 7 * 86400_000);
  const end = formatDate(endDate ?? Date.now());
  const url = `${DONKI_BASE}/FLR?startDate=${start}&endDate=${end}&api_key=${getApiKey()}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`DONKI FLR error: ${response.status}`);
  return response.json();
}

/**
 * Fetch coronal mass ejections from DONKI.
 *
 * Response shape (array):
 * {
 *   activityID: "2025-01-15T13:00:00-CME-001",
 *   startTime: "2025-01-15T13:00Z",
 *   sourceLocation: "N15E33",
 *   activeRegionNum: 3456,
 *   instruments: [{ displayName: "SOHO: LASCO/C2" }],
 *   cmeAnalyses: [{
 *     time21_5: "2025-01-15T14:30Z",
 *     latitude: 15,
 *     longitude: 33,
 *     halfAngle: 45,
 *     speed: 1200,
 *     type: "S",   // S=full halo, O=partial halo, C=common
 *     isMostAccurate: true,
 *     enlilList: [{
 *       modelCompletionTime: "...",
 *       estimatedShockArrivalTime: "2025-01-17T08:00Z",
 *       estimatedDuration: null,
 *       isEarthGB: true,
 *       kp_18: 7, kp_90: 8, kp_135: 6, kp_180: 5,
 *       impactList: [{ isGlancingBlow: false, location: "Earth", arrivalTime: "..." }]
 *     }]
 *   }],
 *   linkedEvents: [{ activityID: "2025-01-15T12:30:00-FLR-001" }]
 * }
 */
export async function fetchCMEs(startDate, endDate) {
  const start = formatDate(startDate ?? Date.now() - 30 * 86400_000);
  const end = formatDate(endDate ?? Date.now());
  const url = `${DONKI_BASE}/CME?startDate=${start}&endDate=${end}&api_key=${getApiKey()}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`DONKI CME error: ${response.status}`);
  return response.json();
}

/**
 * Fetch geomagnetic storms from DONKI.
 *
 * Response shape (array):
 * {
 *   gstID: "2025-01-17T06:00:00-GST-001",
 *   startTime: "2025-01-17T06:00Z",
 *   allKpIndex: [{ observedTime: "...", kpIndex: 7, source: "NOAA" }],
 *   linkedEvents: [{ activityID: "2025-01-15T13:00:00-CME-001" }]
 * }
 */
export async function fetchGeomagneticStorms(startDate, endDate) {
  const start = formatDate(startDate ?? Date.now() - 30 * 86400_000);
  const end = formatDate(endDate ?? Date.now());
  const url = `${DONKI_BASE}/GST?startDate=${start}&endDate=${end}&api_key=${getApiKey()}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`DONKI GST error: ${response.status}`);
  return response.json();
}

/**
 * Fetch interplanetary shocks from DONKI.
 *
 * Response shape (array):
 * {
 *   activityID: "2025-01-17T05:30:00-IPS-001",
 *   catalog: "M2M_CATALOG",
 *   eventTime: "2025-01-17T05:30Z",
 *   location: "Earth",
 *   instruments: [{ displayName: "DSCOVR: PLASMAG" }],
 *   linkedEvents: [{ activityID: "2025-01-15T13:00:00-CME-001" }]
 * }
 */
export async function fetchInterplanetaryShocks(startDate, endDate) {
  const start = formatDate(startDate ?? Date.now() - 30 * 86400_000);
  const end = formatDate(endDate ?? Date.now());
  const url = `${DONKI_BASE}/IPS?startDate=${start}&endDate=${end}&api_key=${getApiKey()}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`DONKI IPS error: ${response.status}`);
  return response.json();
}

/**
 * Fetch solar energetic particle events from DONKI.
 */
export async function fetchSEPEvents(startDate, endDate) {
  const start = formatDate(startDate ?? Date.now() - 30 * 86400_000);
  const end = formatDate(endDate ?? Date.now());
  const url = `${DONKI_BASE}/SEP?startDate=${start}&endDate=${end}&api_key=${getApiKey()}`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`DONKI SEP error: ${response.status}`);
  return response.json();
}

// =========================================================================
// DONKI event normalization
// =========================================================================

/**
 * Parse solar location string (e.g. "N15E33") to lat/lon.
 */
export function parseSourceLocation(locStr) {
  if (!locStr) return null;
  const match = locStr.match(/([NS])(\d+)([EW])(\d+)/i);
  if (!match) return null;
  const lat = parseInt(match[2]) * (match[1].toUpperCase() === 'N' ? 1 : -1);
  const lon = parseInt(match[4]) * (match[3].toUpperCase() === 'E' ? 1 : -1);
  return { latitude: lat, longitude: lon, raw: locStr };
}

/**
 * Extract the most accurate CME analysis from a CME event.
 */
export function getBestCMEAnalysis(cmeEvent) {
  if (!cmeEvent.cmeAnalyses || cmeEvent.cmeAnalyses.length === 0) return null;

  // Prefer the one flagged as most accurate
  const best = cmeEvent.cmeAnalyses.find((a) => a.isMostAccurate);
  return best ?? cmeEvent.cmeAnalyses[cmeEvent.cmeAnalyses.length - 1];
}

/**
 * Extract Earth-directed CME arrival prediction.
 */
export function getEarthArrival(cmeEvent) {
  const analysis = getBestCMEAnalysis(cmeEvent);
  if (!analysis || !analysis.enlilList) return null;

  for (const enlil of analysis.enlilList) {
    if (!enlil.impactList) continue;
    const earthImpact = enlil.impactList.find(
      (imp) => imp.location === 'Earth'
    );
    if (earthImpact) {
      return {
        estimated_arrival: new Date(earthImpact.arrivalTime).getTime(),
        is_glancing_blow: earthImpact.isGlancingBlow ?? false,
        estimated_shock_arrival: enlil.estimatedShockArrivalTime
          ? new Date(enlil.estimatedShockArrivalTime).getTime()
          : null,
        kp_18: enlil.kp_18 ?? null,
        kp_90: enlil.kp_90 ?? null,
        kp_135: enlil.kp_135 ?? null,
        kp_180: enlil.kp_180 ?? null,
        model_completion: enlil.modelCompletionTime ?? null,
        is_earth_gb: enlil.isEarthGB ?? false,
      };
    }
  }
  return null;
}

// =========================================================================
// Polling orchestrator
// =========================================================================

/**
 * Poll DONKI for recent events and build evidence bundles.
 *
 * DONKI data has slower cadence than SWPC (event-based, not continuous).
 * Default lookback: 7 days for flares, 30 days for CMEs/storms.
 *
 * @param {object} config - { activeTheatres, revisionHistories }
 * @param {Set} processedEvents - Dedup keys
 * @returns {object} Poll result
 */
export async function pollAndIngest(config, processedEvents) {
  const polledAt = Date.now();
  const bundles = [];
  let skipped = 0;
  const errors = [];

  // --- DONKI Flares (7-day lookback) ---
  try {
    const flares = await fetchFlares();
    for (const flare of flares) {
      const dedupKey = `donki-flr-${flare.flrID}`;
      if (processedEvents.has(dedupKey)) continue;

      const bundle = buildBundle({
        type: 'donki_flare',
        data: {
          flr_id: flare.flrID,
          begin_time: flare.beginTime ? new Date(flare.beginTime).getTime() : null,
          peak_time: flare.peakTime ? new Date(flare.peakTime).getTime() : null,
          end_time: flare.endTime ? new Date(flare.endTime).getTime() : null,
          class_type: flare.classType,
          source_location: parseSourceLocation(flare.sourceLocation),
          active_region: flare.activeRegionNum,
          instruments: (flare.instruments ?? []).map((i) => i.displayName),
          linked_events: (flare.linkedEvents ?? []).map((e) => e.activityID),
          link: flare.link,
        },
        polledAt,
      }, config);

      if (bundle) {
        bundles.push(bundle);
        processedEvents.add(dedupKey);
      } else {
        skipped++;
      }
    }
  } catch (err) {
    errors.push({ feed: 'donki_flares', error: err.message });
  }

  // --- DONKI CMEs (30-day lookback) ---
  try {
    const cmes = await fetchCMEs();
    for (const cme of cmes) {
      const dedupKey = `donki-cme-${cme.activityID}`;
      if (processedEvents.has(dedupKey)) continue;

      const analysis = getBestCMEAnalysis(cme);
      const earthArrival = getEarthArrival(cme);

      const bundle = buildBundle({
        type: 'donki_cme',
        data: {
          activity_id: cme.activityID,
          start_time: cme.startTime ? new Date(cme.startTime).getTime() : null,
          source_location: parseSourceLocation(cme.sourceLocation),
          active_region: cme.activeRegionNum,
          instruments: (cme.instruments ?? []).map((i) => i.displayName),
          analysis: analysis ? {
            speed: analysis.speed,
            half_angle: analysis.halfAngle,
            latitude: analysis.latitude,
            longitude: analysis.longitude,
            type: analysis.type,
            is_most_accurate: analysis.isMostAccurate,
          } : null,
          earth_arrival: earthArrival,
          linked_events: (cme.linkedEvents ?? []).map((e) => e.activityID),
        },
        polledAt,
      }, config);

      if (bundle) {
        bundles.push(bundle);
        processedEvents.add(dedupKey);
      } else {
        skipped++;
      }
    }
  } catch (err) {
    errors.push({ feed: 'donki_cmes', error: err.message });
  }

  // --- DONKI Geomagnetic Storms (30-day lookback) ---
  try {
    const storms = await fetchGeomagneticStorms();
    for (const storm of storms) {
      const dedupKey = `donki-gst-${storm.gstID}`;
      if (processedEvents.has(dedupKey)) continue;

      const maxKp = (storm.allKpIndex ?? []).reduce(
        (max, entry) => Math.max(max, entry.kpIndex ?? 0), 0
      );

      const bundle = buildBundle({
        type: 'donki_geomagnetic_storm',
        data: {
          gst_id: storm.gstID,
          start_time: storm.startTime ? new Date(storm.startTime).getTime() : null,
          kp_indices: (storm.allKpIndex ?? []).map((k) => ({
            time: k.observedTime,
            kp: k.kpIndex,
            source: k.source,
          })),
          max_kp: maxKp,
          linked_events: (storm.linkedEvents ?? []).map((e) => e.activityID),
        },
        polledAt,
      }, config);

      if (bundle) {
        bundles.push(bundle);
        processedEvents.add(dedupKey);
      } else {
        skipped++;
      }
    }
  } catch (err) {
    errors.push({ feed: 'donki_storms', error: err.message });
  }

  return { bundles, skipped, errors, polled_at: polledAt };
}

// --- CLI entrypoint ---
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''));
if (isMain) {
  console.log('[CORONA] Polling NASA DONKI...');
  const config = { activeTheatres: [], revisionHistories: new Map() };
  const processed = new Set();

  try {
    const result = await pollAndIngest(config, processed);
    console.log('[CORONA] DONKI poll complete:', {
      bundles: result.bundles.length,
      skipped: result.skipped,
      errors: result.errors.length,
    });
    if (result.bundles.length > 0) {
      console.log('\n[CORONA] Example bundle:');
      console.log(JSON.stringify(result.bundles[0], null, 2));
    }
  } catch (err) {
    console.error('[CORONA] DONKI poll error:', err.message);
    process.exit(1);
  }
}
