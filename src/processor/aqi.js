/**
 * AQI Computation Module
 *
 * EPA breakpoint tables, NowCast algorithm, AQI formula, category mapping,
 * and dominant pollutant selection.
 *
 * This is the highest-risk module in BREATH — every other module depends on
 * correct AQI values. All breakpoint boundary tests are mandatory.
 *
 * References:
 *   EPA Technical Assistance Document for the Reporting of Daily Air Quality
 *   AirNow NowCast Algorithm: https://www.airnow.gov/publications/air-quality-index/technical-assistance-document-for-reporting-the-daily-aqi/
 *
 * PurpleAir note: The API `pm2.5` field returns CF=1 (ATM) values by default.
 * No additional correction factor is required — do not apply CF correction.
 */

// ---------------------------------------------------------------------------
// Breakpoint Tables
// Format: [Clow, Chigh, AQIlow, AQIhigh]
// Values are INCLUSIVE at both ends.
// ---------------------------------------------------------------------------

export const BREAKPOINTS = {
  /**
   * PM2.5 24-hour average (µg/m³). Also used for NowCast input.
   * Reflects the 2024 PM2.5 AQI breakpoint revision.
   * Source: https://aqs.epa.gov/aqsweb/documents/codetables/aqi_breakpoints.html
   */
  PM25: [
    [0.0,   9.0,   0,   50],    // Good
    [9.1,   35.4,  51,  100],   // Moderate
    [35.5,  55.4,  101, 150],   // USG
    [55.5,  125.4, 151, 200],   // Unhealthy
    [125.5, 225.4, 201, 300],   // Very Unhealthy
    [225.5, 325.4, 301, 500],   // Hazardous
    [325.5, 99999.9, 501, 999], // Beyond AQI / extreme events
  ],

  /** PM10 24-hour average (µg/m³) */
  PM10: [
    [0,   54,   0,   50],
    [55,  154,  51,  100],
    [155, 254,  101, 150],
    [255, 354,  151, 200],
    [355, 424,  201, 300],
    [425, 504,  301, 400],
    [505, 604,  401, 500],
  ],

  /**
   * Ozone 8-hour average (ppm).
   * Used for AQI 0–300. For AQI > 300, use O3_1H.
   * Note: O3 8-hour AQI is not calculated above 300.
   */
  O3_8H: [
    [0.000, 0.054, 0,   50],
    [0.055, 0.070, 51,  100],
    [0.071, 0.085, 101, 150],
    [0.086, 0.105, 151, 200],
    [0.106, 0.200, 201, 300],
  ],

  /**
   * Ozone 1-hour average (ppm).
   * Only used when AQI > 100 (supplements O3_8H for hazardous range).
   */
  O3_1H: [
    [0.125, 0.164, 101, 150],
    [0.165, 0.204, 151, 200],
    [0.205, 0.404, 201, 300],
    [0.405, 0.504, 301, 400],
    [0.505, 0.604, 401, 500],
  ],

  /** NO2 1-hour average (ppb) */
  NO2: [
    [0,    53,   0,   50],
    [54,   100,  51,  100],
    [101,  360,  101, 150],
    [361,  649,  151, 200],
    [650,  1249, 201, 300],
    [1250, 1649, 301, 400],
    [1650, 2049, 401, 500],
  ],

  /**
   * SO2: 1-hour average (ppb) for AQI 0–200.
   * 24-hour average (ppb) for AQI 201–500.
   */
  SO2: [
    [0,   35,   0,   50],
    [36,  75,   51,  100],
    [76,  185,  101, 150],
    [186, 304,  151, 200],
    [305, 604,  201, 300],
    [605, 804,  301, 400],
    [805, 1004, 401, 500],
  ],

  /** CO 8-hour average (ppm) */
  CO: [
    [0.0,  4.4,  0,   50],
    [4.5,  9.4,  51,  100],
    [9.5,  12.4, 101, 150],
    [12.5, 15.4, 151, 200],
    [15.5, 30.4, 201, 300],
    [30.5, 40.4, 301, 400],
    [40.5, 50.4, 401, 500],
  ],
};

// ---------------------------------------------------------------------------
// AQI Categories
// ---------------------------------------------------------------------------

export const AQI_CATEGORIES = [
  { number: 1, name: 'Good',           range: [0,   50]  },
  { number: 2, name: 'Moderate',       range: [51,  100] },
  { number: 3, name: 'USG',            range: [101, 150] },
  { number: 4, name: 'Unhealthy',      range: [151, 200] },
  { number: 5, name: 'Very Unhealthy', range: [201, 300] },
  { number: 6, name: 'Hazardous',      range: [301, 999] },
];

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Calculate AQI for a single pollutant from its concentration.
 *
 * Uses linear interpolation between EPA breakpoints.
 * Returns an integer using Math.trunc() — NOT Math.round() — per EPA spec.
 *
 * @param {string} pollutant - Key in BREAKPOINTS (e.g. 'PM25', 'PM10', 'O3_8H')
 * @param {number} concentration - Measured concentration in the pollutant's native units
 * @returns {number|null} AQI integer, or null if concentration is out of all breakpoint ranges
 */
export function calculateAQI(pollutant, concentration) {
  const table = BREAKPOINTS[pollutant];
  if (!table) throw new Error(`Unknown pollutant: ${pollutant}`);

  const row = table.find(([Clow, Chigh]) => concentration >= Clow && concentration <= Chigh);
  if (!row) return null; // Out of range (negative or above 500.4)

  const [Clow, Chigh, AQIlow, AQIhigh] = row;

  // EPA linear interpolation formula:
  // AQI = ((AQIhigh - AQIlow) / (Chigh - Clow)) * (Cp - Clow) + AQIlow
  const aqi = ((AQIhigh - AQIlow) / (Chigh - Clow)) * (concentration - Clow) + AQIlow;

  // CRITICAL: truncate, do not round. EPA spec specifies truncation.
  return Math.trunc(aqi);
}

/**
 * Map an AQI integer to its category.
 *
 * @param {number} aqi - AQI integer value
 * @returns {{ number: number, name: string, range: number[] }}
 */
export function getCategory(aqi) {
  const cat = AQI_CATEGORIES.find(c => aqi >= c.range[0] && aqi <= c.range[1]);
  // Fallback for values above 999 (beyond defined category ranges)
  return cat ?? { number: 6, name: 'Hazardous', range: [301, 999] };
}

/**
 * Compute PM2.5 NowCast concentration from the last 12 hours of hourly data.
 *
 * EPA NowCast algorithm:
 *   1. Collect last 12 hourly PM2.5 readings (index 0 = most recent, 11 = 11h ago)
 *   2. Require ≥2 valid readings in the 3 most recent hours
 *   3. weight w = Cmin/Cmax across all valid readings, clamped to max(0.5, w)
 *   4. NowCast = Σ(Ci × w^i) / Σ(w^i) for valid hours only
 *
 * @param {(number|null)[]} hourlyReadings - 12-element array. Index 0 = most recent hour.
 *                                           null = missing/invalid reading.
 * @returns {number|null} NowCast concentration (µg/m³), or null if insufficient data
 */
export function computeNowCast(hourlyReadings) {
  if (!Array.isArray(hourlyReadings) || hourlyReadings.length < 12) return null;
  // M1: NowCast is defined over exactly 12 hours. Reject oversized arrays rather than
  // scanning them — a 10k-element array would indicate a caller bug, not valid data.
  if (hourlyReadings.length > 12) return null;

  // M4: Explicit type check — reject numeric strings and other coercibles.
  const isValidReading = v => typeof v === 'number' && isFinite(v);

  // Step 1: Require ≥2 valid readings in the 3 most recent hours
  const recentValid = hourlyReadings.slice(0, 3).filter(isValidReading).length;
  if (recentValid < 2) return null;

  // Step 2: All valid readings in the 12-hour window
  const validValues = hourlyReadings.filter(isValidReading);
  if (validValues.length === 0) return null;

  const Cmin = Math.min(...validValues);
  const Cmax = Math.max(...validValues);

  // Step 3: Weight factor, clamped to [0.5, 1.0]
  const w = Cmax === 0 ? 1.0 : Math.max(0.5, Cmin / Cmax);

  // Step 4: Weighted sum / sum of weights
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < 12; i++) {
    const v = hourlyReadings[i];
    if (!isValidReading(v)) continue;
    const weight = Math.pow(w, i);
    numerator += v * weight;
    denominator += weight;
  }

  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Find the dominant pollutant from a map of pollutant → AQI values.
 *
 * The dominant pollutant is the one with the highest AQI value.
 * Ties are broken alphabetically (deterministic).
 *
 * @param {object} pollutantAqis - e.g. { PM25: 80, O3_8H: 100, NO2: 45 }
 * @returns {string|null} Pollutant key of the dominant pollutant, or null if empty
 */
export function getDominantPollutant(pollutantAqis) {
  // M4: Explicit type check — reject numeric strings.
  const entries = Object.entries(pollutantAqis).filter(([, v]) => typeof v === 'number' && isFinite(v));
  if (entries.length === 0) return null;

  // Sort: descending AQI, then ascending alphabetical for ties
  entries.sort(([ka, va], [kb, vb]) => {
    if (vb !== va) return vb - va;
    return ka.localeCompare(kb);
  });

  return entries[0][0];
}
