/**
 * NOAA SWPC real-time JSON feed poller.
 *
 * Fetches space weather data from NOAA's Space Weather Prediction Center:
 *   - GOES X-ray flux (1-minute averages, 1-8 Angstrom)
 *   - Planetary Kp index (3-hour cadence)
 *   - GOES proton flux (integral energies ≥10 MeV, ≥100 MeV)
 *   - DSCOVR real-time solar wind (speed, density, Bz)
 *   - NOAA Space Weather Scales (current R/S/G levels)
 *
 * All endpoints are free, no auth, JSON.
 * Base URL: https://services.swpc.noaa.gov
 */

import { buildBundle } from '../processor/bundles.js';

// =========================================================================
// Feed URLs
// =========================================================================

const SWPC_BASE = 'https://services.swpc.noaa.gov';

const FEED_URLS = {
  // GOES X-ray flux — primary satellite, 1-minute averages
  xray_1day:    `${SWPC_BASE}/json/goes/primary/xray-flares-latest.json`,
  xray_6hour:   `${SWPC_BASE}/json/goes/primary/xrays-6-hour.json`,
  xray_1min:    `${SWPC_BASE}/json/goes/primary/xrays-1-day.json`,

  // Planetary Kp index — observed and forecast
  kp_observed:  `${SWPC_BASE}/products/noaa-planetary-k-index.json`,
  kp_forecast:  `${SWPC_BASE}/products/noaa-planetary-k-index-forecast.json`,

  // GOES proton flux — integral energies
  proton_6hour: `${SWPC_BASE}/json/goes/primary/integral-protons-6-hour.json`,
  proton_1day:  `${SWPC_BASE}/json/goes/primary/integral-protons-1-day.json`,

  // DSCOVR real-time solar wind (plasma + mag)
  solar_wind_mag_1day:    `${SWPC_BASE}/products/solar-wind/mag-1-day.json`,
  solar_wind_plasma_1day: `${SWPC_BASE}/products/solar-wind/plasma-1-day.json`,

  // NOAA scales — current R/S/G levels
  noaa_scales: `${SWPC_BASE}/products/noaa-scales.json`,

  // Alerts — latest space weather alerts
  alerts: `${SWPC_BASE}/products/alerts.json`,
};

// =========================================================================
// Flare classification
// =========================================================================

/**
 * GOES X-ray flare classification.
 *
 * Flux is in W/m² at 1-8 Angstrom.
 *   A: 1e-8
 *   B: 1e-7
 *   C: 1e-6
 *   M: 1e-5
 *   X: 1e-4
 *
 * Within each class, the number is the multiplier (e.g. M2.5 = 2.5e-5 W/m²).
 */
const FLARE_CLASSES = [
  { letter: 'X', threshold: 1e-4 },
  { letter: 'M', threshold: 1e-5 },
  { letter: 'C', threshold: 1e-6 },
  { letter: 'B', threshold: 1e-7 },
  { letter: 'A', threshold: 1e-8 },
];

export function classifyFlux(flux_wm2) {
  if (flux_wm2 == null || flux_wm2 <= 0) return { letter: 'A', number: 0, class_string: 'A0.0' };
  for (const { letter, threshold } of FLARE_CLASSES) {
    if (flux_wm2 >= threshold) {
      const number = Math.round((flux_wm2 / threshold) * 10) / 10;
      return { letter, number, class_string: `${letter}${number}` };
    }
  }
  return { letter: 'A', number: Math.round((flux_wm2 / 1e-8) * 10) / 10, class_string: `A${Math.round((flux_wm2 / 1e-8) * 10) / 10}` };
}

/**
 * Convert flare class string (e.g. "M2.5") to W/m² flux.
 */
export function classToFlux(classString) {
  if (!classString || classString.length < 2) return null;
  const letter = classString[0].toUpperCase();
  const number = parseFloat(classString.slice(1));
  if (isNaN(number)) return null;
  const base = FLARE_CLASSES.find((f) => f.letter === letter);
  if (!base) return null;
  return base.threshold * number;
}

/**
 * Numeric rank for comparison. Higher = more energetic.
 * X10 = 140, X1 = 50, M5 = 45, M1 = 41, C5 = 35, C1 = 31, etc.
 */
export function flareRank(classString) {
  if (!classString || classString.length < 2) return 0;
  const letter = classString[0].toUpperCase();
  const number = parseFloat(classString.slice(1)) || 1;
  const bases = { X: 50, M: 40, C: 30, B: 20, A: 10 };
  return (bases[letter] ?? 0) + Math.min(number, 10);
}

// =========================================================================
// Kp index helpers
// =========================================================================

/**
 * NOAA Geomagnetic Storm Scale from Kp.
 *   Kp 5 = G1 (Minor)
 *   Kp 6 = G2 (Moderate)
 *   Kp 7 = G3 (Strong)
 *   Kp 8 = G4 (Severe)
 *   Kp 9 = G5 (Extreme)
 */
export function kpToGScale(kp) {
  if (kp >= 9) return { level: 5, label: 'G5', descriptor: 'Extreme' };
  if (kp >= 8) return { level: 4, label: 'G4', descriptor: 'Severe' };
  if (kp >= 7) return { level: 3, label: 'G3', descriptor: 'Strong' };
  if (kp >= 6) return { level: 2, label: 'G2', descriptor: 'Moderate' };
  if (kp >= 5) return { level: 1, label: 'G1', descriptor: 'Minor' };
  return { level: 0, label: 'G0', descriptor: 'None' };
}

// =========================================================================
// Feed fetching
// =========================================================================

/**
 * Fetch a SWPC JSON feed.
 */
export async function fetchFeed(feedKey) {
  const url = FEED_URLS[feedKey];
  if (!url) throw new Error(`Unknown SWPC feed: ${feedKey}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`SWPC feed error: ${response.status} ${response.statusText} (${feedKey})`);
  }
  return response.json();
}

/**
 * Fetch latest X-ray flare events from SWPC.
 *
 * Returns normalized flare events with classification, timing, and satellite info.
 */
export async function fetchFlares() {
  const data = await fetchFeed('xray_1day');

  // The xray-flares-latest.json returns an array of recent flare events
  // Each has: begin_time, max_time, end_time, max_class, current_int_xrlong
  return data.map((entry) => ({
    source: 'SWPC_GOES',
    begin_time: entry.begin_time ? new Date(entry.begin_time + 'Z').getTime() : null,
    max_time: entry.max_time ? new Date(entry.max_time + 'Z').getTime() : null,
    end_time: entry.end_time ? new Date(entry.end_time + 'Z').getTime() : null,
    max_class: entry.max_class ?? null,
    current_class: entry.current_class ?? null,
    begin_class: entry.begin_class ?? null,
    max_xray_flux: entry.max_xrlong ? parseFloat(entry.max_xrlong) : null,
    current_xray_flux: entry.current_int_xrlong ? parseFloat(entry.current_int_xrlong) : null,
    satellite: entry.satellite ?? null,
    status: entry.status ?? 'unknown', // 'eventInProgress', 'complete'
    event_id: entry.id ?? null,
  })).filter((e) => e.begin_time !== null);
}

/**
 * Fetch latest X-ray flux time-series (1-minute averages).
 *
 * Used for continuous flux monitoring and flare detection.
 */
export async function fetchXrayFlux() {
  const data = await fetchFeed('xray_6hour');

  // Array of [{time_tag, satellite, flux}]
  // First row is header metadata
  return data
    .filter((entry) => entry.time_tag && entry.flux !== undefined)
    .map((entry) => ({
      time: new Date(entry.time_tag).getTime(),
      flux: parseFloat(entry.flux),
      satellite: entry.satellite,
      energy: entry.energy, // "0.1-0.8nm" = long channel
    }));
}

/**
 * Fetch current Kp index observations.
 *
 * The SWPC Kp JSON has rows:
 *   [time_tag, Kp, Kp_fraction, a_running, station_count]
 * First row is headers.
 */
export async function fetchKpIndex() {
  const data = await fetchFeed('kp_observed');

  // Skip header row
  return data.slice(1).map((row) => ({
    time_tag: row[0],
    time: new Date(row[0]).getTime(),
    kp: parseFloat(row[1]),
    kp_fraction: parseFloat(row[1]),
    a_running: parseFloat(row[2]) || null,
    station_count: parseInt(row[3]) || null,
  })).filter((e) => !isNaN(e.kp));
}

/**
 * Fetch Kp forecast (predicted values).
 */
export async function fetchKpForecast() {
  const data = await fetchFeed('kp_forecast');
  return data.slice(1).map((row) => ({
    time_tag: row[0],
    time: new Date(row[0]).getTime(),
    kp: parseFloat(row[1]),
    observed: row[2] === 'observed',
    noaa_scale: row[3] ?? null,
  })).filter((e) => !isNaN(e.kp));
}

/**
 * Fetch proton flux data (integral ≥10 MeV and ≥100 MeV).
 */
export async function fetchProtonFlux() {
  const data = await fetchFeed('proton_6hour');

  return data
    .filter((entry) => entry.time_tag && entry.flux !== undefined)
    .map((entry) => ({
      time: new Date(entry.time_tag).getTime(),
      flux: parseFloat(entry.flux),
      energy: entry.energy, // ">=10 MeV" or ">=100 MeV"
      satellite: entry.satellite,
    }));
}

/**
 * Fetch DSCOVR real-time solar wind (magnetic field).
 */
export async function fetchSolarWindMag() {
  const data = await fetchFeed('solar_wind_mag_1day');

  // Skip header row
  return data.slice(1).map((row) => ({
    time_tag: row[0],
    time: new Date(row[0]).getTime(),
    bx_gsm: parseFloat(row[1]) || null,
    by_gsm: parseFloat(row[2]) || null,
    bz_gsm: parseFloat(row[3]) || null,
    lon_gsm: parseFloat(row[4]) || null,
    lat_gsm: parseFloat(row[5]) || null,
    bt: parseFloat(row[6]) || null,
  })).filter((e) => !isNaN(e.time));
}

/**
 * Fetch DSCOVR real-time solar wind (plasma — speed, density, temperature).
 */
export async function fetchSolarWindPlasma() {
  const data = await fetchFeed('solar_wind_plasma_1day');

  return data.slice(1).map((row) => ({
    time_tag: row[0],
    time: new Date(row[0]).getTime(),
    density: parseFloat(row[1]) || null,   // p/cm³
    speed: parseFloat(row[2]) || null,     // km/s
    temperature: parseFloat(row[3]) || null, // K
  })).filter((e) => !isNaN(e.time));
}

/**
 * Fetch current NOAA Space Weather Scales.
 *
 * Returns { R: {Scale, Text}, S: {Scale, Text}, G: {Scale, Text} }
 */
export async function fetchNoaaScales() {
  const data = await fetchFeed('noaa_scales');
  return {
    R: { scale: data['0']?.R?.Scale ?? 0, text: data['0']?.R?.Text ?? '' },
    S: { scale: data['0']?.S?.Scale ?? 0, text: data['0']?.S?.Text ?? '' },
    G: { scale: data['0']?.G?.Scale ?? 0, text: data['0']?.G?.Text ?? '' },
  };
}

// =========================================================================
// Polling orchestrator
// =========================================================================

/**
 * Poll SWPC feeds and ingest new events.
 *
 * This is the primary entry point for the CORONA polling loop.
 * It fetches flares, Kp, proton flux, and solar wind data,
 * then builds evidence bundles for matching theatres.
 *
 * @param {object} config - { activeTheatres, revisionHistories }
 * @param {Set} processedEvents - Dedup keys
 * @returns {object} Poll result with bundles
 */
export async function pollAndIngest(config, processedEvents) {
  const polledAt = Date.now();
  const bundles = [];
  let skipped = 0;
  let errors = [];

  // --- Flare events ---
  try {
    const flares = await fetchFlares();
    for (const flare of flares) {
      const dedupKey = `flare-${flare.event_id ?? flare.begin_time}-${flare.status}`;
      if (processedEvents.has(dedupKey)) continue;

      const bundle = buildBundle({
        type: 'solar_flare',
        data: flare,
        polledAt,
      }, config);

      if (bundle === null) { skipped++; continue; }
      bundles.push(bundle);
      processedEvents.add(dedupKey);
    }
  } catch (err) {
    errors.push({ feed: 'flares', error: err.message });
  }

  // --- Kp index ---
  try {
    const kpData = await fetchKpIndex();
    // Only ingest most recent Kp reading
    if (kpData.length > 0) {
      const latest = kpData[kpData.length - 1];
      const dedupKey = `kp-${latest.time_tag}`;
      if (!processedEvents.has(dedupKey)) {
        const bundle = buildBundle({
          type: 'kp_index',
          data: latest,
          polledAt,
        }, config);
        if (bundle) {
          bundles.push(bundle);
          processedEvents.add(dedupKey);
        }
      }
    }
  } catch (err) {
    errors.push({ feed: 'kp_index', error: err.message });
  }

  // --- Proton flux ---
  try {
    const protons = await fetchProtonFlux();
    // Ingest latest reading per energy channel
    const byEnergy = new Map();
    for (const p of protons) {
      if (!byEnergy.has(p.energy) || p.time > byEnergy.get(p.energy).time) {
        byEnergy.set(p.energy, p);
      }
    }
    for (const [energy, reading] of byEnergy) {
      const dedupKey = `proton-${energy}-${reading.time}`;
      if (processedEvents.has(dedupKey)) continue;

      const bundle = buildBundle({
        type: 'proton_flux',
        data: reading,
        polledAt,
      }, config);
      if (bundle) {
        bundles.push(bundle);
        processedEvents.add(dedupKey);
      }
    }
  } catch (err) {
    errors.push({ feed: 'proton_flux', error: err.message });
  }

  // --- Solar wind (latest snapshot) ---
  try {
    const [magData, plasmaData] = await Promise.all([
      fetchSolarWindMag(),
      fetchSolarWindPlasma(),
    ]);

    const latestMag = magData.length > 0 ? magData[magData.length - 1] : null;
    const latestPlasma = plasmaData.length > 0 ? plasmaData[plasmaData.length - 1] : null;

    if (latestMag || latestPlasma) {
      const refTime = latestMag?.time_tag ?? latestPlasma?.time_tag;
      const dedupKey = `solarwind-${refTime}`;
      if (!processedEvents.has(dedupKey)) {
        const bundle = buildBundle({
          type: 'solar_wind',
          data: {
            mag: latestMag,
            plasma: latestPlasma,
            time: latestMag?.time ?? latestPlasma?.time,
          },
          polledAt,
        }, config);
        if (bundle) {
          bundles.push(bundle);
          processedEvents.add(dedupKey);
        }
      }
    }
  } catch (err) {
    errors.push({ feed: 'solar_wind', error: err.message });
  }

  return {
    bundles,
    skipped,
    errors,
    polled_at: polledAt,
  };
}

// --- CLI entrypoint ---
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''));
if (isMain) {
  console.log('[CORONA] Polling SWPC feeds...');
  const config = { activeTheatres: [], revisionHistories: new Map() };
  const processed = new Set();

  try {
    const result = await pollAndIngest(config, processed);
    console.log('[CORONA] Poll complete:', {
      bundles: result.bundles.length,
      skipped: result.skipped,
      errors: result.errors.length,
    });
    if (result.bundles.length > 0) {
      console.log('\n[CORONA] Example bundle:');
      console.log(JSON.stringify(result.bundles[0], null, 2));
    }
    if (result.errors.length > 0) {
      console.log('\n[CORONA] Errors:', result.errors);
    }
  } catch (err) {
    console.error('[CORONA] Poll error:', err.message);
    process.exit(1);
  }
}
