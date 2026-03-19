/**
 * Quality scoring for space weather evidence.
 *
 * Analogous to TREMOR's seismic quality scoring, but adapted for
 * space weather data sources. Scores range [0, 1] with higher = more reliable.
 *
 * Quality components:
 *   - Source reliability (GOES primary vs secondary, DONKI vs SWPC)
 *   - Data freshness (age of observation)
 *   - Instrument status (primary/secondary satellite, eclipse season)
 *   - Multi-source confirmation (SWPC + DONKI agreement)
 *   - Measurement completeness (all fields populated)
 */

/**
 * Source reliability scores.
 *
 * GOES primary satellite data is the gold standard for X-ray and proton flux.
 * DONKI provides curated event-level data with cause-effect linkages.
 * DSCOVR solar wind is authoritative when operating nominally.
 */
const SOURCE_RELIABILITY = {
  SWPC_GOES: 0.95,        // GOES primary satellite, real-time
  SWPC_GOES_SECONDARY: 0.85, // GOES secondary (backup)
  SWPC_DSCOVR: 0.90,      // DSCOVR solar wind
  SWPC_ACE: 0.85,         // ACE fallback
  DONKI: 0.90,            // NASA DONKI curated events
  GFZ: 0.95,              // GFZ definitive Kp
  SWPC_KP: 0.80,          // SWPC preliminary Kp
};

/**
 * Flare class reliability.
 *
 * Larger flares have more definitive classifications.
 * C-class flares near background can be ambiguous.
 */
const CLASS_RELIABILITY = {
  X: 0.95,
  M: 0.90,
  C: 0.75,
  B: 0.60,
  A: 0.40,
};

/**
 * Compute quality score for a solar flare event.
 */
export function scoreFlare(event) {
  const components = {};

  // Source reliability
  const sourceKey = event.source ?? 'SWPC_GOES';
  components.source_reliability = SOURCE_RELIABILITY[sourceKey] ?? 0.7;

  // Class definiteness — larger flares are clearer
  const classLetter = (event.max_class ?? event.class_type ?? 'C')[0].toUpperCase();
  components.class_reliability = CLASS_RELIABILITY[classLetter] ?? 0.5;

  // Status — complete events > in-progress
  if (event.status === 'complete' || event.end_time) {
    components.status_score = 1.0;
  } else if (event.status === 'eventInProgress') {
    components.status_score = 0.5;
  } else {
    components.status_score = 0.3;
  }

  // Data completeness — how many fields are populated
  const fields = ['begin_time', 'max_time', 'end_time', 'max_class', 'max_xray_flux'];
  const populated = fields.filter((f) => event[f] != null).length;
  components.completeness = populated / fields.length;

  // Age penalty — older automatic data is less reliable if not yet confirmed
  if (event.begin_time) {
    const ageHours = (Date.now() - event.begin_time) / 3600_000;
    if (event.status === 'complete') {
      components.freshness = 1.0; // Complete events don't degrade
    } else {
      // In-progress events: higher quality early (fresh data), degrades if stuck
      components.freshness = ageHours < 1 ? 0.9 : Math.max(0.3, 1 - ageHours * 0.05);
    }
  } else {
    components.freshness = 0.5;
  }

  // Composite: weighted average
  const composite =
    components.source_reliability * 0.25 +
    components.class_reliability * 0.25 +
    components.status_score * 0.20 +
    components.completeness * 0.15 +
    components.freshness * 0.15;

  return {
    composite: Math.round(composite * 1000) / 1000,
    components,
    data_type: 'solar_flare',
  };
}

/**
 * Compute quality score for a Kp index reading.
 */
export function scoreKpIndex(event) {
  const components = {};

  // Source — GFZ definitive > SWPC preliminary
  components.source_reliability = event.source === 'GFZ'
    ? SOURCE_RELIABILITY.GFZ
    : SOURCE_RELIABILITY.SWPC_KP;

  // Station count — more magnetometer stations = better
  const stations = event.station_count ?? 0;
  components.station_coverage = stations >= 10 ? 1.0 :
    stations >= 6 ? 0.8 :
    stations >= 3 ? 0.6 : 0.4;

  // Kp value definiteness — extreme values are unambiguous
  const kp = event.kp ?? 0;
  components.value_definiteness = kp >= 7 ? 0.95 :
    kp >= 5 ? 0.85 :
    kp >= 3 ? 0.75 : 0.65;

  // Freshness — Kp is 3-hour cadence, degrade if stale
  if (event.time) {
    const ageHours = (Date.now() - event.time) / 3600_000;
    components.freshness = ageHours < 3 ? 1.0 :
      ageHours < 6 ? 0.8 :
      ageHours < 12 ? 0.6 : 0.4;
  } else {
    components.freshness = 0.5;
  }

  const composite =
    components.source_reliability * 0.30 +
    components.station_coverage * 0.25 +
    components.value_definiteness * 0.20 +
    components.freshness * 0.25;

  return {
    composite: Math.round(composite * 1000) / 1000,
    components,
    data_type: 'kp_index',
  };
}

/**
 * Compute quality score for proton flux reading.
 */
export function scoreProtonFlux(event) {
  const components = {};

  components.source_reliability = SOURCE_RELIABILITY.SWPC_GOES;

  // Energy channel — ≥10 MeV is the standard S-scale channel
  components.channel_relevance = (event.energy ?? '').includes('10') ? 1.0 : 0.7;

  // Flux level — above S1 threshold (10 pfu) is unambiguous
  const flux = event.flux ?? 0;
  components.signal_strength = flux >= 100 ? 1.0 :
    flux >= 10 ? 0.9 :
    flux >= 1 ? 0.7 : 0.5;

  if (event.time) {
    const ageMin = (Date.now() - event.time) / 60_000;
    components.freshness = ageMin < 5 ? 1.0 :
      ageMin < 30 ? 0.9 :
      ageMin < 120 ? 0.7 : 0.5;
  } else {
    components.freshness = 0.5;
  }

  const composite =
    components.source_reliability * 0.30 +
    components.channel_relevance * 0.20 +
    components.signal_strength * 0.25 +
    components.freshness * 0.25;

  return {
    composite: Math.round(composite * 1000) / 1000,
    components,
    data_type: 'proton_flux',
  };
}

/**
 * Compute quality score for solar wind reading.
 */
export function scoreSolarWind(event) {
  const components = {};

  const mag = event.mag;
  const plasma = event.plasma;

  // Data availability — both mag and plasma preferred
  components.completeness = (mag && plasma) ? 1.0 : 0.6;

  // Source
  components.source_reliability = SOURCE_RELIABILITY.SWPC_DSCOVR;

  // Data quality — null values in DSCOVR during outages
  let nullCount = 0;
  let totalFields = 0;
  if (mag) {
    totalFields += 3;
    if (mag.bz_gsm == null) nullCount++;
    if (mag.bt == null) nullCount++;
    if (mag.bx_gsm == null) nullCount++;
  }
  if (plasma) {
    totalFields += 3;
    if (plasma.speed == null) nullCount++;
    if (plasma.density == null) nullCount++;
    if (plasma.temperature == null) nullCount++;
  }
  components.field_completeness = totalFields > 0
    ? (totalFields - nullCount) / totalFields
    : 0;

  if (event.time) {
    const ageMin = (Date.now() - event.time) / 60_000;
    components.freshness = ageMin < 5 ? 1.0 :
      ageMin < 30 ? 0.9 :
      ageMin < 120 ? 0.7 : 0.5;
  } else {
    components.freshness = 0.5;
  }

  const composite =
    components.completeness * 0.25 +
    components.source_reliability * 0.25 +
    components.field_completeness * 0.25 +
    components.freshness * 0.25;

  return {
    composite: Math.round(composite * 1000) / 1000,
    components,
    data_type: 'solar_wind',
  };
}

/**
 * Compute quality score for any event type.
 */
export function computeQuality(event) {
  const type = event.type ?? event.data_type;
  switch (type) {
    case 'solar_flare':
    case 'donki_flare':
      return scoreFlare(event.data ?? event);
    case 'kp_index':
      return scoreKpIndex(event.data ?? event);
    case 'proton_flux':
      return scoreProtonFlux(event.data ?? event);
    case 'solar_wind':
      return scoreSolarWind(event.data ?? event);
    default:
      return { composite: 0.5, components: {}, data_type: type };
  }
}
