/**
 * BREATH — Air Quality Intelligence Construct
 *
 * Construct entrypoint + SensorRegistry.
 * BreathConstruct: Sprint 4, Task 4.1.
 */

import { computeChannelConsistency } from './processor/quality.js';
import { AQI_CATEGORIES } from './processor/aqi.js';
import {
  createAqiThresholdGate,
  processAqiThresholdGate,
  expireAqiThresholdGate,
} from './theatres/aqi-gate.js';
import {
  createSensorDivergence,
  processSensorDivergence,
  expireSensorDivergence,
} from './theatres/sensor-divergence.js';
import {
  createWildfireCascade,
  processWildfireCascade,
  resolveWildfireCascade,
} from './theatres/wildfire-cascade.js';
import { exportCertificate } from './rlmf/certificates.js';

// Re-export all modules for granular use (TREMOR/CORONA pattern)
export { computeNowCast, calculateAQI, getCategory, getDominantPollutant, BREAKPOINTS, AQI_CATEGORIES } from './processor/aqi.js';
export { computeQuality, computeAirNowQuality, computeChannelConsistency, classifyConsistency } from './processor/quality.js';
export { buildUncertainty, buildAirNowUncertainty, thresholdCrossingProbability } from './processor/uncertainty.js';
export { assessSettlement, assessAirNowSettlement } from './processor/settlement.js';
export { buildPurpleAirBundle, buildAirNowBundle, matchTheatres, matchAirNowObservation } from './processor/bundles.js';
export { createAqiThresholdGate, processAqiThresholdGate, expireAqiThresholdGate } from './theatres/aqi-gate.js';
export { createSensorDivergence, processSensorDivergence, expireSensorDivergence } from './theatres/sensor-divergence.js';
export { createWildfireCascade, processWildfireCascade, resolveWildfireCascade } from './theatres/wildfire-cascade.js';
export { exportCertificate, brierScoreBinary, brierScoreMultiClass } from './rlmf/certificates.js';

// Note: pollPurpleAir and pollAirNow are NOT re-exported at module level to
// avoid a circular dependency: purpleair.js imports SensorRegistry from this file.
// Access them via: import { pollPurpleAir } from './oracles/purpleair.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** AirNow polling cadence: max once per 60 minutes. */
const AIR_NOW_CADENCE_MS = 60 * 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the next valid AQI threshold above currentAQI.
 * Valid thresholds are category lower boundaries: 51, 101, 151, 201, 301.
 *
 * @param {number} currentAQI
 * @returns {number|null} Next threshold, or null if already at max
 */
function getNextThreshold(currentAQI) {
  const validThresholds = AQI_CATEGORIES
    .map(c => c.range[0])
    .filter(t => t > 0) // exclude Good (range[0]=0)
    .sort((a, b) => a - b); // [51, 101, 151, 201, 301]
  return validThresholds.find(t => t > currentAQI) ?? null;
}

// ---------------------------------------------------------------------------
// SensorRegistry
//
// Tracks persistent PurpleAir sensor state across polls. Unlike TREMOR/CORONA,
// which process ephemeral seismic events, BREATH tracks sensors as long-lived
// entities that accumulate history across polling cycles.
//
// Lives in index.js — consistent with TREMOR/CORONA pattern of entrypoint
// as the state container for the construct's primary data structure.
// ---------------------------------------------------------------------------

/**
 * Persistent registry of PurpleAir sensor state across polls.
 *
 * Key responsibilities:
 *  - Accumulate pm25_history for NowCast computation (12-entry rolling window)
 *  - Track channel A/B consistency as a rolling 10-reading average
 *  - Detect sensor dropout (last_seen stale beyond 2× poll cadence)
 *  - Detect location drift (coordinate change > 0.001°)
 *  - Track AQI trend for Theatre auto-spawn triggers
 */
export class SensorRegistry {
  constructor() {
    /** @type {Map<number, SensorRecord>} */
    this.sensors = new Map();
  }

  /**
   * Update registry from a batch of normalized PurpleAir API sensor objects.
   *
   * For existing sensors: updates location, pm25_history (if last_seen changed),
   * and location_stable flag. For new sensors: initialises a fresh record.
   *
   * @param {object[]} apiSensors - Normalized sensor objects from PurpleAir API.
   *   Expected fields: sensor_index, name, latitude, longitude, location_type,
   *   pm25_avg, pm25_a, pm25_b, last_seen (Unix seconds).
   */
  update(apiSensors) {
    for (const sensor of apiSensors) {
      const existing = this.sensors.get(sensor.sensor_index);
      const lastSeenMs = (sensor.last_seen ?? 0) * 1000;

      if (existing) {
        // Location drift: flag if coordinates changed by > 0.001° (≈100m)
        const latDelta = Math.abs(sensor.latitude - existing.location.latitude);
        const lonDelta = Math.abs(sensor.longitude - existing.location.longitude);
        const locationStable = latDelta <= 0.001 && lonDelta <= 0.001;

        // pm25_history: only append if reading is new (last_seen advanced).
        // Cap at 12 entries — computeNowCast accepts exactly 12.
        let pm25_history = existing.pm25_history;
        if (sensor.last_seen !== existing.last_seen) {
          const entry = {
            t: lastSeenMs,
            a: sensor.pm25_a ?? null,
            b: sensor.pm25_b ?? null,
            avg: sensor.pm25_avg,
          };
          pm25_history = [entry, ...existing.pm25_history].slice(0, 12);
        }

        this.sensors.set(sensor.sensor_index, {
          ...existing,
          name: sensor.name,
          location: {
            latitude: sensor.latitude,
            longitude: sensor.longitude,
            location_type: sensor.location_type,
          },
          location_stable: locationStable,
          pm25_history,
          last_seen: sensor.last_seen,
        });
      } else {
        // New sensor — initialise with a single-entry history.
        this.sensors.set(sensor.sensor_index, {
          sensor_index: sensor.sensor_index,
          name: sensor.name,
          location: {
            latitude: sensor.latitude,
            longitude: sensor.longitude,
            location_type: sensor.location_type,
          },
          location_stable: true,
          pm25_history: [{
            t: lastSeenMs,
            a: sensor.pm25_a ?? null,
            b: sensor.pm25_b ?? null,
            avg: sensor.pm25_avg,
          }],
          aqi_history: [],
          last_seen: sensor.last_seen,
          state: 'active',
          channel_consistency_score: 0.5, // Neutral prior until A/B data accumulates
          nearby_agreement_count: 0,
          _consistencyHistory: [],        // Internal — rolling buffer for channel consistency
        });
      }
    }
  }

  /**
   * Update the rolling AQI history for a sensor.
   * Called by the oracle after computing AQI so aqi_history stays current.
   *
   * @param {number} sensorIndex
   * @param {number} t - Epoch ms of the observation
   * @param {number} aqi - Computed AQI value
   */
  updateAqiHistory(sensorIndex, t, aqi) {
    const record = this.sensors.get(sensorIndex);
    if (!record || typeof aqi !== 'number') return;
    const aqi_history = [{ t, aqi }, ...record.aqi_history].slice(0, 12);
    this.sensors.set(sensorIndex, { ...record, aqi_history });
  }

  /**
   * Get sensors whose last_seen is older than 2× pollIntervalMs.
   * Covers both sensors missing from response AND sensors with frozen timestamps.
   *
   * @param {number} now - Current epoch ms
   * @param {number} pollIntervalMs - Poll cadence in ms (e.g. 120_000)
   * @returns {SensorRecord[]}
   */
  getDropouts(now, pollIntervalMs) {
    const threshold = now - 2 * pollIntervalMs;
    const dropouts = [];
    for (const record of this.sensors.values()) {
      // PurpleAir last_seen is Unix seconds — convert to ms for comparison.
      if (record.last_seen * 1000 < threshold) {
        dropouts.push(record);
      }
    }
    return dropouts;
  }

  /**
   * Get all active sensors whose location falls within a bounding box.
   *
   * @param {[number, number, number, number]} bbox - [minLon, minLat, maxLon, maxLat]
   * @returns {SensorRecord[]}
   */
  getSensorsInBbox(bbox) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const result = [];
    for (const record of this.sensors.values()) {
      const { latitude, longitude } = record.location;
      if (
        longitude >= minLon && longitude <= maxLon &&
        latitude  >= minLat && latitude  <= maxLat
      ) {
        result.push(record);
      }
    }
    return result;
  }

  /**
   * Update channel A/B consistency as a rolling 10-reading average.
   *
   * Uses computeChannelConsistency from quality.js — the same function that
   * feeds into the processor quality score. Rolling average smooths over
   * transient spikes and gives the settlement layer stable consistency data.
   *
   * @param {number} sensorIndex
   * @param {number|null} pm25_a - Channel A PM2.5 reading
   * @param {number|null} pm25_b - Channel B PM2.5 reading
   */
  updateChannelConsistency(sensorIndex, pm25_a, pm25_b) {
    const record = this.sensors.get(sensorIndex);
    if (!record) return;

    const score = computeChannelConsistency(pm25_a, pm25_b);
    const history = record._consistencyHistory ?? [];
    const newHistory = [...history, score].slice(-10);
    const rollingAvg = newHistory.reduce((sum, s) => sum + s, 0) / newHistory.length;

    this.sensors.set(sensorIndex, {
      ...record,
      channel_consistency_score: rollingAvg,
      _consistencyHistory: newHistory,
    });
  }

  /**
   * Compute AQI trend over the last N hours.
   *
   * Compares the average AQI in the first half of the window against the
   * second half. A positive return value means AQI is rising; negative means
   * falling; 0 means insufficient data or flat.
   *
   * Used by BreathConstruct for Theatre auto-spawn detection.
   *
   * @param {number} sensorIndex
   * @param {number} hours - Window size in hours
   * @returns {number} Trend: positive = rising, negative = falling, 0 = flat/unknown
   */
  getAqiTrend(sensorIndex, hours) {
    const record = this.sensors.get(sensorIndex);
    if (!record || record.aqi_history.length < 2) return 0;

    const cutoff = Date.now() - hours * 3_600_000;
    const window = record.aqi_history.filter(e => e.t >= cutoff);
    if (window.length < 2) return 0;

    // Split window into old half and new half; compare averages.
    const mid = Math.floor(window.length / 2);
    const oldSlice = window.slice(0, mid);
    const newSlice = window.slice(mid);
    const oldAvg = oldSlice.reduce((s, e) => s + e.aqi, 0) / oldSlice.length;
    const newAvg = newSlice.reduce((s, e) => s + e.aqi, 0) / newSlice.length;

    return newAvg - oldAvg;
  }

  /**
   * Check if a sensor's coordinates have drifted from its registered position.
   *
   * @param {number} sensorIndex
   * @param {number} newLat
   * @param {number} newLon
   * @returns {boolean} true if coordinates changed by > 0.001° on either axis
   */
  hasLocationDrift(sensorIndex, newLat, newLon) {
    const record = this.sensors.get(sensorIndex);
    if (!record) return false;
    return (
      Math.abs(newLat - record.location.latitude) > 0.001 ||
      Math.abs(newLon - record.location.longitude) > 0.001
    );
  }

  /**
   * Set the state of a sensor (active, dropout, degraded).
   *
   * @param {number} sensorIndex
   * @param {'active'|'dropout'|'degraded'} state
   */
  setState(sensorIndex, state) {
    const record = this.sensors.get(sensorIndex);
    if (!record) return;
    this.sensors.set(sensorIndex, { ...record, state });
  }

  /**
   * Update the nearby_agreement_count for a sensor.
   * Called by the oracle after evaluating the full sensor batch for the region.
   *
   * @param {number} sensorIndex
   * @param {number} count
   */
  setNearbyAgreementCount(sensorIndex, count) {
    const record = this.sensors.get(sensorIndex);
    if (!record) return;
    this.sensors.set(sensorIndex, { ...record, nearby_agreement_count: count });
  }
}

// ---------------------------------------------------------------------------
// BreathConstruct
// ---------------------------------------------------------------------------

export class BreathConstruct {
  /**
   * @param {object} [config={}]
   *   @param {string}   [config.constructId='BREATH']
   *   @param {number}   [config.pollIntervalMs=120_000]
   *   @param {object}   [config.apiKeys]
   *     @param {string} [config.apiKeys.purpleair]
   *     @param {string} [config.apiKeys.airnow]
   *   @param {boolean}  [config.enableCrossValidation=true]
   *   @param {object}   [config.purpleair]     - { bboxes: [{nwlng,nwlat,selng,selat,label}] }
   *   @param {object}   [config.airNow]        - { regions: [{lat,lon,radius_miles,label}] }
   *   @param {object}   [config._oracleOverrides] - Testing only: { pollPurpleAir, pollAirNow }
   */
  constructor(config = {}) {
    this.constructId    = config.constructId ?? 'BREATH';
    this.pollIntervalMs = config.pollIntervalMs ?? 120_000;
    this.apiKeys = {
      purpleair: config.apiKeys?.purpleair ?? process.env.PURPLEAIR_API_KEY ?? null,
      airnow:    config.apiKeys?.airnow    ?? process.env.AIRNOW_API_KEY    ?? null,
    };
    this.enableCrossValidation = config.enableCrossValidation ?? true;

    // Oracle configs
    this._paBboxes     = config.purpleair?.bboxes  ?? [];
    this._ainowRegions = config.airNow?.regions     ?? [];

    // Testing hook: override oracle functions to inject static responses
    this._oracleOverrides = config._oracleOverrides ?? null;

    // Warn on missing keys — allow construction without keys for testing
    if (!this.apiKeys.purpleair) {
      console.warn('[BREATH] PURPLEAIR_API_KEY not configured — live polling unavailable');
    }
    if (!this.apiKeys.airnow) {
      console.warn('[BREATH] AIRNOW_API_KEY not configured — live polling unavailable');
    }

    // State
    this.theatres            = new Map();
    this.sensorRegistry      = new SensorRegistry();
    this.lastAirNowPoll      = 0;
    this.processedBundleIds  = new Set();
    this.certificates        = [];

    // Stats
    this.stats = {
      polls:                0,
      purpleair_bundles:    0,
      airnow_bundles:       0,
      theatres_created:     0,
      theatres_resolved:    0,
      certificates_exported: 0,
    };

    this.pollTimer = null;
    this._running  = false;
  }

  // ---------------------------------------------------------------------------
  // Theatre creation
  // ---------------------------------------------------------------------------

  /** Open a T1 AQI Threshold Gate theatre. @returns {object} Theatre */
  openAqiThresholdGate(params) {
    const theatre = createAqiThresholdGate(params);
    this.theatres.set(theatre.id, theatre);
    this.stats.theatres_created++;
    return theatre;
  }

  /** Open a T2 Sensor Divergence theatre. @returns {object} Theatre */
  openSensorDivergence(params) {
    const theatre = createSensorDivergence(params);
    this.theatres.set(theatre.id, theatre);
    this.stats.theatres_created++;
    return theatre;
  }

  /** Open a T3 Wildfire Cascade theatre. @returns {object} Theatre */
  openWildfireCascade(params) {
    const theatre = createWildfireCascade(params);
    this.theatres.set(theatre.id, theatre);
    this.stats.theatres_created++;
    return theatre;
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /** @returns {object[]} Open or provisional_hold theatres */
  getActiveTheatres() {
    return Array.from(this.theatres.values())
      .filter(t => t.state === 'open' || t.state === 'provisional_hold');
  }

  /**
   * Deduplicated bboxes from open/provisional_hold theatres.
   * Used as AirNow query regions and for theatre routing.
   *
   * @returns {Array<[number,number,number,number]>}
   */
  getActiveRegions() {
    const seen    = new Set();
    const regions = [];
    for (const t of this.getActiveTheatres()) {
      if (t.region_bbox) {
        const key = JSON.stringify(t.region_bbox);
        if (!seen.has(key)) {
          seen.add(key);
          regions.push(t.region_bbox);
        }
      }
    }
    return regions;
  }

  /**
   * @returns {{ construct, running, stats, theatres }}
   */
  getState() {
    const allTheatres = Array.from(this.theatres.values());
    const byState = {};
    for (const t of allTheatres) {
      byState[t.state] = (byState[t.state] ?? 0) + 1;
    }
    return {
      construct: this.constructId,
      running:   this._running,
      stats:     { ...this.stats },
      theatres: {
        total:    this.theatres.size,
        by_state: byState,
      },
    };
  }

  /** @returns {object[]} Copy of exported RLMF certificates */
  getCertificates() {
    return [...this.certificates];
  }

  /**
   * Return count of flushed certificates and clear internal array.
   *
   * @returns {number} Count flushed
   */
  flushCertificates() {
    const count = this.certificates.length;
    this.certificates = [];
    return count;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the polling loop.
   * @throws {Error} If already running
   */
  start() {
    if (this._running) {
      throw new Error('BreathConstruct already running. Call stop() first.');
    }
    this._running  = true;
    this.pollTimer = setInterval(() => {
      this.poll().catch(err => console.error('[BREATH] poll() error:', err));
    }, this.pollIntervalMs);
  }

  /**
   * Stop the polling loop. Idempotent — safe to call multiple times.
   */
  stop() {
    if (!this._running) return;
    this._running = false;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Core loop
  // ---------------------------------------------------------------------------

  /**
   * Single poll cycle: dual-oracle coordination, bundle processing, expiry,
   * auto-spawn.
   *
   * Ordering (critical for cross-validation accuracy):
   *   1. Always poll PurpleAir
   *   2. Poll AirNow if ≥60m has elapsed
   *   3. Process AirNow bundles FIRST (settlement authority, resolves theatres)
   *   4. Then process PurpleAir bundles (signal layer, updates position only)
   *   5. Check expiries
   *   6. Check auto-spawn
   */
  async poll() {
    const now = Date.now();
    this.stats.polls++;

    // Lazy-import oracles to avoid circular dependency:
    // purpleair.js imports SensorRegistry from this module (index.js).
    const { pollPurpleAir: defaultPollPA } = await import('./oracles/purpleair.js');
    const { pollAirNow: defaultPollAN }    = await import('./oracles/epa-airnow.js');
    const paFn    = this._oracleOverrides?.pollPurpleAir ?? defaultPollPA;
    const ainowFn = this._oracleOverrides?.pollAirNow    ?? defaultPollAN;

    const activeTheatres = this.getActiveTheatres();

    // Step 1: Always poll PurpleAir
    const paConfig = { apiKey: this.apiKeys.purpleair, bboxes: this._paBboxes };
    let paResult   = { bundles: [], dropouts: [] };
    try {
      paResult = await paFn(paConfig, this.sensorRegistry, activeTheatres);
    } catch (err) {
      console.error('[BREATH] PurpleAir oracle error:', err.message);
    }

    // Step 2: Poll AirNow if ≥60m has elapsed since last call
    let ainowResult = null;
    if (now - this.lastAirNowPoll >= AIR_NOW_CADENCE_MS) {
      const ainowConfig = { apiKey: this.apiKeys.airnow, regions: this._ainowRegions };
      try {
        ainowResult    = await ainowFn(ainowConfig, activeTheatres);
        this.lastAirNowPoll = now;
      } catch (err) {
        console.error('[BREATH] AirNow oracle error:', err.message);
      }
    }

    // Step 3: AirNow bundles first (settlement authority)
    for (const bundle of (ainowResult?.bundles ?? [])) {
      this._processBundle(bundle);
      this.stats.airnow_bundles++;
    }

    // Step 4: PurpleAir bundles second (signal layer)
    for (const bundle of paResult.bundles) {
      this._processBundle(bundle);
      this.stats.purpleair_bundles++;
    }

    // Steps 5–6
    this._checkExpiries();
    this._checkAutoSpawn();
  }

  // ---------------------------------------------------------------------------
  // Internal processing
  // ---------------------------------------------------------------------------

  /**
   * Route a bundle to all active theatres. Each theatre's process function
   * handles its own relevance filtering (sensor_id, evidence_class, etc.).
   * Deduplicates by bundle_id.
   *
   * @param {object} bundle - Evidence bundle from oracle pipeline
   */
  _processBundle(bundle) {
    if (this.processedBundleIds.has(bundle.bundle_id)) return;
    this.processedBundleIds.add(bundle.bundle_id);

    for (const [id, theatre] of this.theatres) {
      if (theatre.state === 'resolved') continue;

      let updated;
      switch (theatre.template) {
        case 'aqi_threshold_gate':
          updated = processAqiThresholdGate(theatre, bundle);
          break;
        case 'sensor_divergence':
          updated = processSensorDivergence(theatre, bundle);
          break;
        case 'wildfire_cascade':
          updated = processWildfireCascade(theatre, bundle);
          break;
        default:
          continue;
      }

      if (updated !== theatre) {
        this.theatres.set(id, updated);
        // Export certificate as soon as theatre resolves
        if (updated.state === 'resolved' && theatre.state !== 'resolved') {
          this._exportCertificate(updated);
        }
      }
    }
  }

  /**
   * Export an RLMF certificate for a resolved theatre and store it.
   *
   * @param {object} theatre - Resolved theatre
   * @returns {object} Exported certificate
   */
  _exportCertificate(theatre) {
    const cert = exportCertificate(theatre, { construct_id: this.constructId });
    this.certificates.push(cert);
    this.stats.theatres_resolved++;
    this.stats.certificates_exported++;
    return cert;
  }

  /**
   * Check all open theatres for window expiry (closes_at reached).
   * Expired theatres are resolved with outcome: false (T1/T2) or outcome bucket (T3).
   */
  _checkExpiries() {
    const now = Date.now();
    for (const [id, theatre] of this.theatres) {
      if (theatre.state === 'resolved') continue;
      if (now < theatre.closes_at) continue;

      let resolved;
      switch (theatre.template) {
        case 'aqi_threshold_gate':
          resolved = expireAqiThresholdGate(theatre);
          break;
        case 'sensor_divergence':
          resolved = expireSensorDivergence(theatre);
          break;
        case 'wildfire_cascade':
          resolved = resolveWildfireCascade(theatre); // T3: resolve at close (not "expire")
          break;
        default:
          continue;
      }

      this.theatres.set(id, resolved);
      if (resolved.state === 'resolved') {
        this._exportCertificate(resolved);
      }
    }
  }

  /**
   * Auto-spawn T1 theatres when AQI trend signals rising air quality risk.
   *
   * Trigger: AQI trend ≥ +20 in the last 2 hours AND no open T1 already
   * tracking the next threshold for that sensor's region.
   */
  _checkAutoSpawn() {
    for (const record of this.sensorRegistry.sensors.values()) {
      if (record.state === 'dropout') continue;

      const trend = this.sensorRegistry.getAqiTrend(record.sensor_index, 2);
      if (trend < 20) continue;

      const latestAqi = record.aqi_history?.[0]?.aqi;
      if (latestAqi == null) continue;

      const nextThreshold = getNextThreshold(latestAqi);
      if (nextThreshold === null) continue;

      // Check if an open T1 already targets this threshold in this sensor's region
      const sensorBbox = this._sensorBbox(record);
      const hasOpenT1  = Array.from(this.theatres.values()).some(t =>
        t.template === 'aqi_threshold_gate' &&
        t.state    !== 'resolved'           &&
        t.aqi_threshold === nextThreshold   &&
        this._bboxContainsSensor(t.region_bbox, record),
      );

      if (!hasOpenT1) {
        this.openAqiThresholdGate({
          region_name:   `auto-${record.sensor_index}`,
          region_bbox:   sensorBbox,
          aqi_threshold: nextThreshold,
          window_hours:  4,
          base_rate:     0.15,
        });
      }
    }
  }

  /** @param {object} record - SensorRecord @returns {boolean} */
  _bboxContainsSensor(bbox, record) {
    if (!bbox) return false;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    return (
      record.location.longitude >= minLon && record.location.longitude <= maxLon &&
      record.location.latitude  >= minLat && record.location.latitude  <= maxLat
    );
  }

  /** Build a small bbox around a sensor for auto-spawned theatres. */
  _sensorBbox(record, padDeg = 0.1) {
    const { latitude: lat, longitude: lon } = record.location;
    return [lon - padDeg, lat - padDeg, lon + padDeg, lat + padDeg];
  }
}

// ---------------------------------------------------------------------------
// Standalone script entry
// ---------------------------------------------------------------------------

const scriptPath = process.argv[1];
const isMain = scriptPath &&
  (scriptPath.endsWith('src/index.js') || scriptPath.endsWith('src\\index.js'));

if (isMain) {
  console.log('BREATH Air Quality Intelligence Construct v0.1.0');
  console.log('');
  console.log('Usage (as library):');
  console.log('  import { BreathConstruct } from \'./src/index.js\'');
  console.log('  const bc = new BreathConstruct({');
  console.log('    apiKeys: { purpleair: \'...\', airnow: \'...\' },');
  console.log('    purpleair: { bboxes: [{ nwlng, nwlat, selng, selat, label }] },');
  console.log('    airNow: { regions: [{ lat, lon, radius_miles, label }] },');
  console.log('  });');
  console.log('  bc.openAqiThresholdGate({ region_name, region_bbox, aqi_threshold: 151, window_hours: 24 });');
  console.log('  bc.start();');
  console.log('');
  console.log('Environment variables: PURPLEAIR_API_KEY, AIRNOW_API_KEY');
}
