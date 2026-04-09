/**
 * EPA AirNow Oracle
 *
 * Polls the EPA AirNow latLong/current API for current AQI observations.
 * Returns settlement-authority evidence bundles.
 *
 * Key constraints:
 *  - Called at most once per 60 minutes per region (cadence enforced by caller)
 *  - Zero production dependencies — built-in fetch only
 *  - AirNow bundles are ALWAYS data_tier: 'settlement_authority', evidence_class: 'ground_truth'
 *  - DateObserved has a trailing space — trim before parsing (EPA API quirk)
 *  - Unknown timezone abbreviations are logged and skipped (no throw)
 *
 * Rate limit: 1000 calls/day on the free tier. With 24 calls/region/day and
 * up to ~10 regions, we stay well under the limit.
 */

import {
  computeAirNowQuality,
} from '../processor/quality.js';
import {
  buildAirNowUncertainty,
} from '../processor/uncertainty.js';
import {
  assessAirNowSettlement,
} from '../processor/settlement.js';
import {
  buildAirNowBundle,
} from '../processor/bundles.js';

// ---------------------------------------------------------------------------
// Timezone table
// ---------------------------------------------------------------------------

/**
 * US timezone abbreviations → UTC offset hours.
 * AirNow API uses these abbreviations in the LocalTimeZone field.
 * Only US timezones are expected in the MVP (EPA primary coverage is US).
 */
export const AIRNOW_TZ_OFFSETS = {
  // Eastern
  EST:  -5,
  EDT:  -4,
  // Central
  CST:  -6,
  CDT:  -5,
  // Mountain
  MST:  -7,
  MDT:  -6,
  // Pacific
  PST:  -8,
  PDT:  -7,
  // Alaska
  AKST: -9,
  AKDT: -8,
  // Hawaii
  HST:  -10,
  HAST: -10,
  // Arizona (no DST)
  AZT:  -7,
};

// ---------------------------------------------------------------------------
// Time parsing
// ---------------------------------------------------------------------------

/**
 * Parse an AirNow observation time into epoch milliseconds.
 *
 * AirNow API quirk: DateObserved has a trailing space (e.g. "2026-03-19 ").
 * HourObserved is an integer 0–23 in local time.
 * LocalTimeZone is a US timezone abbreviation (e.g. "PST").
 *
 * @param {object} obs - AirNow observation object
 *   @param {string} obs.DateObserved  - "YYYY-MM-DD " (note trailing space)
 *   @param {number} obs.HourObserved  - Hour in local time (0–23)
 *   @param {string} obs.LocalTimeZone - US timezone abbreviation
 * @returns {{ observation_time: number, publication_time: number, ingest_time: number, averaging_basis: string }|null}
 *   Returns null if timezone is unknown.
 */
export function parseAirNowObservationTime(obs) {
  const tzOffset = AIRNOW_TZ_OFFSETS[obs.LocalTimeZone];
  if (tzOffset === undefined) {
    console.warn(
      `[BREATH:AirNow] Unknown timezone abbreviation: "${obs.LocalTimeZone}" — skipping observation`,
    );
    return null;
  }

  const dateStr = (obs.DateObserved ?? '').trim(); // Remove trailing space
  const hour    = obs.HourObserved ?? 0;

  // Parse: "YYYY-MM-DD" + hour in local time → UTC epoch ms
  // UTC = local time − tzOffset (tzOffset is negative for US west of UTC)
  const localMs = Date.parse(`${dateStr}T${String(hour).padStart(2, '0')}:00:00Z`);
  if (isNaN(localMs)) return null;

  // Shift from UTC-as-parsed to true UTC: subtract the timezone's offset in ms.
  // e.g. PST is UTC-8, so local 14:00 PST = 22:00 UTC → add 8h to local.
  const observation_time = localMs - tzOffset * 3_600_000;
  const now = Date.now();

  return {
    observation_time,
    // AirNow API does not expose a publication timestamp — use ingest time.
    publication_time: now,
    ingest_time: now,
    // AirNow PM2.5 uses NowCast; other pollutants use hourly averages.
    // All AirNow observations are labelled 'nowcast' per SDD convention.
    averaging_basis: 'nowcast',
  };
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

const AIRNOW_API_BASE = 'https://www.airnowapi.org/aq/observation/latLong/current/';

/**
 * Poll EPA AirNow for current observations at each configured region.
 *
 * @param {object} config
 *   @param {string} config.apiKey - AirNow API key
 *   @param {object[]} config.regions - Array of { lat, lon, radius_miles, label }
 * @param {object[]} [activeTheatres=[]] - For theatre_refs matching
 * @returns {Promise<{ bundles: object[], observations: object[] }>}
 */
export async function pollAirNow(config, activeTheatres = []) {
  const bundles      = [];
  const observations = [];

  const apiKey  = config?.apiKey ?? process.env.AIRNOW_API_KEY;
  const regions = config?.regions ?? [];

  for (const region of regions) {
    const url = new URL(AIRNOW_API_BASE);
    url.searchParams.set('format', 'application/json');
    url.searchParams.set('latitude',  region.lat);
    url.searchParams.set('longitude', region.lon);
    url.searchParams.set('distance',  region.radius_miles ?? 25);
    url.searchParams.set('API_KEY',   apiKey);

    let obsArray;
    try {
      const res = await fetch(url.toString());

      if (res.status === 401) {
        console.error(`[BREATH:AirNow] CRITICAL: 401 Unauthorized — check AIRNOW_API_KEY`);
        continue;
      }
      if (!res.ok) {
        console.warn(`[BREATH:AirNow] HTTP ${res.status} for region ${region.label ?? region.lat}`);
        continue;
      }

      obsArray = await res.json();
    } catch (err) {
      console.error(`[BREATH:AirNow] Network error for region ${region.label ?? region.lat}:`, err.message);
      continue;
    }

    if (!Array.isArray(obsArray)) continue;

    for (const obs of obsArray) {
      // B5/B11: Validate required fields — prevents NaN propagation and silent failures
      if (typeof obs.AQI !== 'number') {
        console.warn(`[BREATH:AirNow] Dropping observation with missing AQI in ${region.label ?? region.lat}`);
        continue;
      }
      if (typeof obs.Latitude !== 'number' || !isFinite(obs.Latitude) ||
          typeof obs.Longitude !== 'number' || !isFinite(obs.Longitude)) {
        console.warn(`[BREATH:AirNow] Dropping observation with invalid coordinates in ${region.label ?? region.lat}`);
        continue;
      }
      const times = parseAirNowObservationTime(obs);
      if (!times) continue; // Unknown timezone — skip

      // Attach parsed times to the observation object (read by buildAirNowBundle via _observation_time)
      obs._observation_time = times.observation_time;

      const quality     = computeAirNowQuality();
      const uncertainty = buildAirNowUncertainty(null, obs.AQI);
      const settlement  = assessAirNowSettlement();

      bundles.push(buildAirNowBundle(obs, quality, uncertainty, settlement, activeTheatres));
      observations.push(obs);
    }
  }

  return { bundles, observations };
}

// ---------------------------------------------------------------------------
// Standalone script
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && new URL(process.argv[1], 'file://').href ===
  new URL(import.meta.url).href;

if (isMain) {
  const config = {
    apiKey: process.env.AIRNOW_API_KEY,
    regions: [
      { label: 'San Francisco, CA', lat: 37.77, lon: -122.42, radius_miles: 25 },
    ],
  };
  const { bundles, observations } = await pollAirNow(config, []);
  console.log(`AirNow poll: ${bundles.length} bundles, ${observations.length} observations`);
  for (const obs of observations) {
    console.log(`  ${obs.ReportingArea}: AQI ${obs.AQI} (${obs.Category?.Name}) — ${obs.ParameterName}`);
  }
}
