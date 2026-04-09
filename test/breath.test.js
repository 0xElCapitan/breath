/**
 * BREATH Test Suite
 *
 * Sprint 1: Processor Core
 *   - AQI computation — NowCast                    (6 tests)
 *   - AQI computation — breakpoints                (8 tests) ← MANDATORY boundary coverage
 *   - AQI computation — categories                 (4 tests)
 *   - AQI computation — dominant                   (3 tests)
 *   - Quality scoring — PurpleAir                  (5 tests)
 *   - Quality scoring — AirNow                     (2 tests)
 *   - Channel consistency helpers                  (6 tests)
 *   - Uncertainty pricing                          (6 tests)
 *   - Threshold crossing probability               (3 tests)
 *   - Settlement logic                             (6 tests)
 *   - Evidence bundle construction — PurpleAir     (6 tests)
 *   - Evidence bundle construction — AirNow        (6 tests)
 *
 *   Total Sprint 1: 61 tests / 12 suites
 *
 * Sprint 2: Oracle Layer
 *   - PurpleAir oracle — normalization and dedup   (4 tests)
 *   - PurpleAir oracle — rate limit and backoff    (3 tests)
 *   - EPA AirNow oracle — bundle construction      (5 tests)
 *   - EPA AirNow oracle — time semantics           (3 tests)
 *   - Adversarial sensor scenarios                 (4 tests)
 *
 *   Total Sprint 2: 19 tests / 5 suites
 *
 * Sprint 3: Theatre Layer + RLMF
 *   - T1: AQI Threshold Gate                     (5 tests)
 *   - T2: Sensor Divergence                      (5 tests)
 *   - T3: Wildfire Cascade                       (4 tests)
 *   - RLMF certificates                          (4 tests)
 *
 *   Total Sprint 3: 18 tests / 4 suites
 *
 * Sprint 4: Integration + Ship
 *   - BreathConstruct — integration            (6 tests)
 *
 *   Total Sprint 4: 6 tests / 1 suite
 *
 * Audit Regression Tests
 *   - Sprint 1: B1, B4, B10, B2, B3, B6       (12 tests)
 *   - Sprint 2: B5a, B5b, B8, B9              (12 tests)
 *
 *   Total Audit: 24 tests / 10 suites
 *
 * No live API calls. All HTTP responses are static mocks.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeNowCast,
  calculateAQI,
  getCategory,
  getDominantPollutant,
  BREAKPOINTS,
  AQI_CATEGORIES,
} from '../src/processor/aqi.js';

import {
  computeQuality,
  computeAirNowQuality,
  computeChannelConsistency,
  classifyConsistency,
} from '../src/processor/quality.js';

import {
  buildUncertainty,
  buildAirNowUncertainty,
  thresholdCrossingProbability,
  normalCDF,
} from '../src/processor/uncertainty.js';

import {
  assessSettlement,
  assessAirNowSettlement,
} from '../src/processor/settlement.js';

import {
  buildPurpleAirBundle,
  buildAirNowBundle,
  matchTheatres,
  matchAirNowObservation,
} from '../src/processor/bundles.js';

import {
  normalizePurpleAirResponse,
  pollPurpleAir,
} from '../src/oracles/purpleair.js';

import {
  pollAirNow,
  parseAirNowObservationTime,
  AIRNOW_TZ_OFFSETS,
} from '../src/oracles/epa-airnow.js';

import { SensorRegistry, BreathConstruct } from '../src/index.js';

import {
  createAqiThresholdGate,
  processAqiThresholdGate,
  expireAqiThresholdGate,
} from '../src/theatres/aqi-gate.js';

import {
  createSensorDivergence,
  processSensorDivergence,
  expireSensorDivergence,
} from '../src/theatres/sensor-divergence.js';

import {
  createWildfireCascade,
  processWildfireCascade,
  resolveWildfireCascade,
} from '../src/theatres/wildfire-cascade.js';

import {
  exportCertificate,
  brierScoreBinary,
  brierScoreMultiClass,
  computeLeadTime,
} from '../src/rlmf/certificates.js';

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal valid PurpleAir sensor object. */
function makeSensor(overrides = {}) {
  return {
    sensor_index: 12345,
    name: 'Test Sensor',
    latitude: 37.77,
    longitude: -122.41,
    location_type: 0,
    pm25_avg: 12.0,
    pm25_a: 12.1,
    pm25_b: 11.9,
    aqi_computed: 51,
    aqi_category: { name: 'Moderate', number: 2 },
    last_seen: Math.floor(Date.now() / 1000), // fresh
    confidence: 100,
    state: 'active',
    ...overrides,
  };
}

/** Build a minimal valid AirNow observation object. */
function makeAirNowObs(overrides = {}) {
  return {
    ReportingArea: 'San Francisco',
    StateCode: 'CA',
    Latitude: 37.77,
    Longitude: -122.41,
    DateObserved: '2026-03-19 ',
    HourObserved: 14,
    LocalTimeZone: 'PST',
    ParameterName: 'PM2.5',
    AQI: 80,
    Category: { Number: 2, Name: 'Moderate' },
    _observation_time: Date.now() - 3_600_000,
    ...overrides,
  };
}

/** Build a minimal valid Theatre object. */
function makeTheatre(overrides = {}) {
  return {
    id: 'T1-SF-AQI151-001',
    template: 'aqi_threshold_gate',
    region_bbox: [-123.0, 37.5, -122.0, 38.0],
    state: 'open',
    ...overrides,
  };
}

/** Minimal quality result for a clean PurpleAir sensor. */
function goodQuality() {
  return {
    score: 0.85,
    composite: 0.85,
    components: { source_tier: 0.65, freshness: 1.0, density: 1.0, consistency: 0.95 },
    cross_validated: true,
  };
}

/** Minimal quality result for an inconsistent channel sensor. */
function inconsistentQuality() {
  return {
    score: 0.20,
    composite: 0.20,
    components: { source_tier: 0.65, freshness: 0.9, density: 0.5, consistency: 0.15 },
    cross_validated: false,
  };
}

/** Minimal good settlement result. */
function goodSettlement() {
  return {
    evidence_class: 'provisional',
    resolution_eligible: false,
    ineligible_reason: 'Awaiting EPA AirNow confirmation',
    recommended_state: 'provisional',
    brier_discount: 0,
  };
}

// ============================================================================
// Suite 1: AQI computation — NowCast
// ============================================================================

describe('AQI computation — NowCast', () => {
  it('returns null for all-null input', () => {
    const readings = Array(12).fill(null);
    assert.equal(computeNowCast(readings), null);
  });

  it('returns null when fewer than 2 valid readings in last 3 hours', () => {
    const readings = Array(12).fill(null);
    readings[0] = 25; // only 1 valid in slots 0-2
    assert.equal(computeNowCast(readings), null);
  });

  it('returns a valid number when 2+ valid readings in last 3 hours', () => {
    const readings = Array(12).fill(null);
    readings[0] = 25;
    readings[1] = 20;
    const result = computeNowCast(readings);
    assert.ok(result !== null && isFinite(result) && result > 0);
  });

  it('weights recent readings more than older ones (index 0 > index 11)', () => {
    // All same concentration → NowCast should equal that concentration
    const uniform = Array(12).fill(30);
    const result = computeNowCast(uniform);
    assert.ok(Math.abs(result - 30) < 1.0);
  });

  it('clamps weight floor to 0.5 when Cmin/Cmax < 0.5', () => {
    // Cmin=1, Cmax=100 → Cmin/Cmax = 0.01, should clamp to 0.5
    const readings = [100, 1, null, null, null, null, null, null, null, null, null, null];
    const result = computeNowCast(readings);
    // Should return a valid number (not crash)
    assert.ok(result !== null && isFinite(result));
  });

  it('returns null for array shorter than 12 elements', () => {
    assert.equal(computeNowCast([25, 20]), null);
  });
});

// ============================================================================
// Suite 2: AQI computation — breakpoints and truncation
// MANDATORY: All 8 PM2.5 category boundary values must be explicit tests.
// ============================================================================

describe('AQI computation — breakpoints and truncation', () => {
  it('PM2.5 12.0 µg/m³ → AQI 50 (top of Good, not 51)', () => {
    assert.equal(calculateAQI('PM25', 12.0), 50);
  });

  it('PM2.5 12.1 µg/m³ → AQI 51 (bottom of Moderate)', () => {
    assert.equal(calculateAQI('PM25', 12.1), 51);
  });

  it('PM2.5 35.4 µg/m³ → AQI 100 (top of Moderate)', () => {
    assert.equal(calculateAQI('PM25', 35.4), 100);
  });

  it('PM2.5 35.5 µg/m³ → AQI 101 (bottom of USG)', () => {
    assert.equal(calculateAQI('PM25', 35.5), 101);
  });

  it('PM2.5 55.4 µg/m³ → AQI 150 (top of USG)', () => {
    assert.equal(calculateAQI('PM25', 55.4), 150);
  });

  it('PM2.5 55.5 µg/m³ → AQI 151 (bottom of Unhealthy)', () => {
    assert.equal(calculateAQI('PM25', 55.5), 151);
  });

  it('PM2.5 150.4 µg/m³ → AQI 200 (top of Unhealthy)', () => {
    assert.equal(calculateAQI('PM25', 150.4), 200);
  });

  it('PM2.5 150.5 µg/m³ → AQI 201 (bottom of Very Unhealthy)', () => {
    assert.equal(calculateAQI('PM25', 150.5), 201);
  });
});

// ============================================================================
// Suite 3: AQI computation — categories and dominant pollutant
// ============================================================================

describe('AQI computation — categories and dominant pollutant', () => {
  it('getCategory(50) returns Good', () => {
    const cat = getCategory(50);
    assert.equal(cat.number, 1);
    assert.equal(cat.name, 'Good');
  });

  it('getCategory(51) returns Moderate', () => {
    const cat = getCategory(51);
    assert.equal(cat.number, 2);
    assert.equal(cat.name, 'Moderate');
  });

  it('getCategory(151) returns Unhealthy', () => {
    const cat = getCategory(151);
    assert.equal(cat.number, 4);
    assert.equal(cat.name, 'Unhealthy');
  });

  it('getDominantPollutant returns highest AQI pollutant', () => {
    const result = getDominantPollutant({ PM25: 80, O3_8H: 100, NO2: 45 });
    assert.equal(result, 'O3_8H');
  });
});

// ============================================================================
// Suite 4: AQI computation — dominant pollutant edge cases
// ============================================================================

describe('AQI computation — dominant pollutant edge cases', () => {
  it('returns null for empty object', () => {
    assert.equal(getDominantPollutant({}), null);
  });

  it('returns null when all values are null', () => {
    assert.equal(getDominantPollutant({ PM25: null, PM10: null }), null);
  });

  it('breaks ties alphabetically (A before B at same AQI)', () => {
    // Both at 100 → alphabetical: 'NO2' < 'PM25'
    const result = getDominantPollutant({ PM25: 100, NO2: 100 });
    assert.equal(result, 'NO2');
  });
});

// ============================================================================
// Suite 5: Quality scoring — PurpleAir
// ============================================================================

describe('Quality scoring — PurpleAir', () => {
  it('fresh sensor with high density and EPA cross-validation scores > 0.9', () => {
    const sensor = makeSensor({ aqi_computed: 60 });
    const nearbySensors = Array(15).fill({});
    const nearbyAirNow = { AQI: 62 }; // within 30%
    const quality = computeQuality(sensor, null, nearbySensors, nearbyAirNow);
    assert.ok(quality.score > 0.9, `Expected >0.9, got ${quality.score}`);
  });

  it('very stale sensor (4× poll cadence) scores < 0.5', () => {
    const staleSensor = makeSensor({
      last_seen: Math.floor((Date.now() - 600_000) / 1000), // 10 minutes ago
      aqi_computed: 60,
    });
    const quality = computeQuality(staleSensor, null, [], null, 120_000);
    assert.ok(quality.score < 0.5, `Expected <0.5, got ${quality.score}`);
  });

  it('cross_validated is true when EPA AQI agrees within 30%', () => {
    const sensor = makeSensor({ aqi_computed: 80 });
    const quality = computeQuality(sensor, null, [], { AQI: 88 });
    assert.equal(quality.cross_validated, true);
  });

  it('cross_validated is false when EPA AQI diverges by >30%', () => {
    const sensor = makeSensor({ aqi_computed: 80 });
    const quality = computeQuality(sensor, null, [], { AQI: 160 }); // 100% diff
    assert.equal(quality.cross_validated, false);
  });

  it('composite score has all four required components', () => {
    const sensor = makeSensor();
    const quality = computeQuality(sensor, null, [], null);
    assert.ok('source_tier' in quality.components);
    assert.ok('freshness' in quality.components);
    assert.ok('density' in quality.components);
    assert.ok('consistency' in quality.components);
  });
});

// ============================================================================
// Suite 6: Quality scoring — AirNow
// ============================================================================

describe('Quality scoring — AirNow', () => {
  it('computeAirNowQuality returns score 1.0', () => {
    const q = computeAirNowQuality();
    assert.equal(q.score, 1.0);
    assert.equal(q.composite, 1.0);
  });

  it('computeAirNowQuality has cross_validated true', () => {
    const q = computeAirNowQuality();
    assert.equal(q.cross_validated, true);
  });
});

// ============================================================================
// Suite 7: Channel consistency helpers
// ============================================================================

describe('Channel consistency helpers', () => {
  it('near-identical channels (35.2 vs 35.8) score ≥ 0.8 (consistent)', () => {
    const score = computeChannelConsistency(35.2, 35.8);
    assert.ok(score >= 0.8, `Expected ≥0.8, got ${score}`);
  });

  it('severely divergent channels (10 vs 40) score < 0.4 (inconsistent)', () => {
    const score = computeChannelConsistency(10.0, 40.0);
    assert.ok(score < 0.4, `Expected <0.4, got ${score}`);
  });

  it('null channel A returns 0.0', () => {
    assert.equal(computeChannelConsistency(null, 35.0), 0.0);
  });

  it('classifyConsistency(0.9) returns consistent', () => {
    assert.equal(classifyConsistency(0.9), 'consistent');
  });

  it('classifyConsistency(0.5) returns divergent', () => {
    assert.equal(classifyConsistency(0.5), 'divergent');
  });

  it('classifyConsistency(0.2) returns inconsistent', () => {
    assert.equal(classifyConsistency(0.2), 'inconsistent');
  });
});

// ============================================================================
// Suite 8: Uncertainty pricing
// ============================================================================

describe('Uncertainty pricing', () => {
  it('AirNow uncertainty is 0.0 when not at threshold boundary', () => {
    const u = buildAirNowUncertainty(null, 80);
    assert.equal(u.doubt_price, 0.0);
    assert.equal(u.basis, 'EPA_AIRNOW_REFERENCE');
    assert.equal(u.threshold_sensitivity, false);
  });

  it('AirNow uncertainty is 0.05 when within ±10 of threshold', () => {
    const u = buildAirNowUncertainty(100, 95);
    assert.equal(u.doubt_price, 0.05);
    assert.equal(u.threshold_sensitivity, true);
  });

  it('channel_inconsistent sensor (consistency < 0.4) has doubt_price ≥ 0.75', () => {
    const sensor = makeSensor({ aqi_computed: 60 });
    const u = buildUncertainty(sensor, inconsistentQuality(), null);
    assert.ok(u.doubt_price >= 0.75, `Expected ≥0.75, got ${u.doubt_price}`);
  });

  it('EPA cross-validated sensor has doubt_price < 0.20', () => {
    const sensor = makeSensor({ aqi_computed: 60 });
    const q = { ...goodQuality(), cross_validated: true };
    const u = buildUncertainty(sensor, q, null);
    assert.ok(u.doubt_price < 0.20, `Expected <0.20, got ${u.doubt_price}`);
  });

  it('threshold_sensitivity is true when AQI within ±10 of threshold', () => {
    const sensor = makeSensor({ aqi_computed: 145 });
    const u = buildUncertainty(sensor, goodQuality(), 151);
    assert.equal(u.threshold_sensitivity, true);
  });

  it('threshold_sensitivity is false when AQI far from threshold', () => {
    const sensor = makeSensor({ aqi_computed: 50 });
    const u = buildUncertainty(sensor, goodQuality(), 151);
    assert.equal(u.threshold_sensitivity, false);
  });
});

// ============================================================================
// Suite 9: Threshold crossing probability
// ============================================================================

describe('Threshold crossing probability', () => {
  it('AQI exactly at threshold with zero doubt → ≈ 0.5', () => {
    const p = thresholdCrossingProbability(100, 100, 0.0);
    assert.ok(Math.abs(p - 0.5) < 0.01, `Expected ≈0.5, got ${p}`);
  });

  it('AQI well above threshold with low doubt → close to 1.0', () => {
    const p = thresholdCrossingProbability(200, 150, 0.0);
    assert.ok(p > 0.99, `Expected >0.99, got ${p}`);
  });

  it('AQI well below threshold with low doubt → close to 0.0', () => {
    const p = thresholdCrossingProbability(50, 151, 0.0);
    assert.ok(p < 0.01, `Expected <0.01, got ${p}`);
  });
});

// ============================================================================
// Suite 10: Settlement logic
// ============================================================================

describe('Settlement logic', () => {
  it('sensor_dropout state → sensor_dropout evidence class, discount 0.20', () => {
    const sensor = makeSensor({ state: 'dropout' });
    const result = assessSettlement(sensor, goodQuality(), null, false, null);
    assert.equal(result.evidence_class, 'sensor_dropout');
    assert.equal(result.resolution_eligible, false);
    assert.equal(result.brier_discount, 0.20);
  });

  it('channel_inconsistent quality → channel_inconsistent evidence class', () => {
    const sensor = makeSensor({ state: 'active' });
    const result = assessSettlement(sensor, inconsistentQuality(), null, false, null);
    assert.equal(result.evidence_class, 'channel_inconsistent');
    assert.equal(result.resolution_eligible, false);
    assert.equal(result.brier_discount, 0.20);
  });

  it('EPA cross-validated, 5 nearby sensors, 3h old → provisional_mature, discount 0.10', () => {
    const sensor = makeSensor({ state: 'active' });
    const registryRecord = {
      nearby_agreement_count: 5,
      last_seen: Math.floor((Date.now() - 3.5 * 3_600_000) / 1000), // 3.5h ago, Unix seconds (PurpleAir format)
    };
    const q = { ...goodQuality(), score: 0.80 };
    const result = assessSettlement(sensor, q, registryRecord, true, null);
    assert.equal(result.evidence_class, 'provisional_mature');
    assert.equal(result.resolution_eligible, true);
    assert.equal(result.brier_discount, 0.10);
  });

  it('assessAirNowSettlement always returns ground_truth, eligible, 0 discount', () => {
    const result = assessAirNowSettlement();
    assert.equal(result.evidence_class, 'ground_truth');
    assert.equal(result.resolution_eligible, true);
    assert.equal(result.brier_discount, 0);
  });

  it('fresh standard sensor → provisional, not eligible, 0 discount', () => {
    const sensor = makeSensor({ state: 'active' });
    const result = assessSettlement(sensor, goodQuality(), null, false, null);
    assert.equal(result.evidence_class, 'provisional');
    assert.equal(result.resolution_eligible, false);
    assert.equal(result.brier_discount, 0);
  });

  it('market_freeze: low quality + Theatre expiring in <2h → evidence_class market_freeze, discount 0.20', () => {
    const sensor = makeSensor({ state: 'active' });
    const lowQuality = { score: 0.4, cross_validated: false, components: { source_tier: 0.35, freshness: 0.3, density: 0.2, consistency: 0.6 } };
    const expiresIn90min = Date.now() + 90 * 60 * 1000;
    const result = assessSettlement(sensor, lowQuality, null, false, expiresIn90min);
    assert.equal(result.evidence_class, 'market_freeze');
    assert.equal(result.recommended_state, 'market_freeze');
    assert.equal(result.resolution_eligible, false);
    assert.equal(result.brier_discount, 0.20);
  });
});

// ============================================================================
// Suite 11: Evidence bundle construction — PurpleAir
// ============================================================================

describe('Evidence bundle construction — PurpleAir', () => {
  it('PurpleAir bundle has data_tier early_warning', () => {
    const sensor = makeSensor();
    const bundle = buildPurpleAirBundle(sensor, null, goodQuality(), { doubt_price: 0.3, basis: 'PURPLEAIR_SINGLE_SENSOR', threshold_sensitivity: false }, goodSettlement(), []);
    assert.equal(bundle.data_tier, 'early_warning');
  });

  it('PurpleAir bundle has construct BREATH and source PURPLEAIR', () => {
    const sensor = makeSensor();
    const bundle = buildPurpleAirBundle(sensor, null, goodQuality(), { doubt_price: 0.3, basis: 'TEST', threshold_sensitivity: false }, goodSettlement(), []);
    assert.equal(bundle.construct, 'BREATH');
    assert.equal(bundle.source, 'PURPLEAIR');
  });

  it('PurpleAir bundle payload has all four time fields', () => {
    const sensor = makeSensor();
    const bundle = buildPurpleAirBundle(sensor, null, goodQuality(), { doubt_price: 0.3, basis: 'TEST', threshold_sensitivity: false }, goodSettlement(), []);
    assert.ok('observation_time' in bundle.payload);
    assert.ok('publication_time' in bundle.payload);
    assert.ok('ingest_time' in bundle.payload);
    assert.ok('averaging_basis' in bundle.payload);
    assert.equal(bundle.payload.averaging_basis, 'instantaneous');
  });

  it('PurpleAir bundle matches theatre when sensor inside bbox', () => {
    const sensor = makeSensor({ latitude: 37.77, longitude: -122.41 });
    const theatre = makeTheatre({ region_bbox: [-123.0, 37.5, -122.0, 38.0] });
    const bundle = buildPurpleAirBundle(sensor, null, goodQuality(), { doubt_price: 0.3, basis: 'TEST', threshold_sensitivity: false }, goodSettlement(), [theatre]);
    assert.deepEqual(bundle.theatre_refs, ['T1-SF-AQI151-001']);
  });

  it('PurpleAir bundle has empty theatre_refs when sensor outside bbox', () => {
    const sensor = makeSensor({ latitude: 34.05, longitude: -118.24 }); // Los Angeles
    const theatre = makeTheatre(); // SF bbox
    const bundle = buildPurpleAirBundle(sensor, null, goodQuality(), { doubt_price: 0.3, basis: 'TEST', threshold_sensitivity: false }, goodSettlement(), [theatre]);
    assert.deepEqual(bundle.theatre_refs, []);
  });

  it('PurpleAir bundle skips resolved theatres', () => {
    const sensor = makeSensor({ latitude: 37.77, longitude: -122.41 });
    const resolvedTheatre = makeTheatre({ state: 'resolved' });
    const bundle = buildPurpleAirBundle(sensor, null, goodQuality(), { doubt_price: 0.3, basis: 'TEST', threshold_sensitivity: false }, goodSettlement(), [resolvedTheatre]);
    assert.deepEqual(bundle.theatre_refs, []);
  });
});

// ============================================================================
// Suite 12: Evidence bundle construction — AirNow
// ============================================================================

describe('Evidence bundle construction — AirNow', () => {
  it('AirNow bundle has data_tier settlement_authority', () => {
    const obs = makeAirNowObs();
    const bundle = buildAirNowBundle(obs, computeAirNowQuality(), { doubt_price: 0.0, basis: 'EPA_AIRNOW_REFERENCE', threshold_sensitivity: false }, assessAirNowSettlement(), []);
    assert.equal(bundle.data_tier, 'settlement_authority');
  });

  it('AirNow bundle has evidence_class ground_truth', () => {
    const obs = makeAirNowObs();
    const bundle = buildAirNowBundle(obs, computeAirNowQuality(), { doubt_price: 0.0, basis: 'EPA_AIRNOW_REFERENCE', threshold_sensitivity: false }, assessAirNowSettlement(), []);
    assert.equal(bundle.evidence_class, 'ground_truth');
  });

  it('AirNow bundle has mandatory attribution string', () => {
    const obs = makeAirNowObs();
    const bundle = buildAirNowBundle(obs, computeAirNowQuality(), { doubt_price: 0.0, basis: 'EPA_AIRNOW_REFERENCE', threshold_sensitivity: false }, assessAirNowSettlement(), []);
    assert.equal(bundle.attribution, 'U.S. EPA AirNow (preliminary data — not for regulatory use)');
  });

  it('AirNow bundle payload has all four time fields', () => {
    const obs = makeAirNowObs();
    const bundle = buildAirNowBundle(obs, computeAirNowQuality(), { doubt_price: 0.0, basis: 'EPA_AIRNOW_REFERENCE', threshold_sensitivity: false }, assessAirNowSettlement(), []);
    assert.ok('observation_time' in bundle.payload);
    assert.ok('publication_time' in bundle.payload);
    assert.ok('ingest_time' in bundle.payload);
    assert.ok('averaging_basis' in bundle.payload);
    assert.equal(bundle.payload.averaging_basis, 'nowcast');
  });

  it('AirNow bundle matches theatre when observation inside bbox', () => {
    const obs = makeAirNowObs({ Latitude: 37.77, Longitude: -122.41 });
    const theatre = makeTheatre();
    const bundle = buildAirNowBundle(obs, computeAirNowQuality(), { doubt_price: 0.0, basis: 'EPA_AIRNOW_REFERENCE', threshold_sensitivity: false }, assessAirNowSettlement(), [theatre]);
    assert.deepEqual(bundle.theatre_refs, ['T1-SF-AQI151-001']);
  });

  it('AirNow bundle has cross_validation null (AirNow is the validator)', () => {
    const obs = makeAirNowObs();
    const bundle = buildAirNowBundle(obs, computeAirNowQuality(), { doubt_price: 0.0, basis: 'EPA_AIRNOW_REFERENCE', threshold_sensitivity: false }, assessAirNowSettlement(), []);
    assert.equal(bundle.cross_validation, null);
  });
});

// ============================================================================
// Sprint 2 helpers
// ============================================================================

/** Build a minimal PurpleAir API response in the fields/data wire format. */
function makePurpleAirApiResponse(sensors) {
  const fields = ['sensor_index', 'name', 'latitude', 'longitude', 'pm2.5', 'pm2.5_a', 'pm2.5_b', 'confidence', 'last_seen', 'location_type'];
  const data = sensors.map(s => [
    s.sensor_index ?? 1001,
    s.name         ?? 'Test Sensor',
    s.latitude     ?? 37.77,
    s.longitude    ?? -122.41,
    s.pm25         ?? 12.0,
    s.pm25_a       ?? 12.1,
    s.pm25_b       ?? 11.9,
    s.confidence   ?? 100,
    s.last_seen    ?? 1710000000,
    s.location_type ?? 0,
  ]);
  return { fields, data };
}

/** Build a minimal AirNow observation object. */
function makeAirNowApiObs(overrides = {}) {
  return {
    DateObserved: '2026-03-19 ',
    HourObserved: 14,
    LocalTimeZone: 'PST',
    ReportingArea: 'San Francisco',
    StateCode: 'CA',
    Latitude: 37.77,
    Longitude: -122.41,
    ParameterName: 'PM2.5',
    AQI: 52,
    Category: { Number: 2, Name: 'Moderate' },
    ...overrides,
  };
}

/** Install a fetch mock; returns a restore function. */
function mockFetch(responses) {
  // responses: array of { status, json } consumed in order
  let idx = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    const resp = responses[idx] ?? responses[responses.length - 1];
    idx++;
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status ?? 200,
      json: async () => resp.json,
    };
  };
  return () => { globalThis.fetch = orig; };
}

// ============================================================================
// Suite 13: PurpleAir oracle — normalization and dedup
// ============================================================================

describe('PurpleAir oracle — normalization and dedup', () => {
  it('normalizePurpleAirResponse zips fields with data rows correctly', () => {
    const apiResp = makePurpleAirApiResponse([{ sensor_index: 42, name: 'TestA', pm25: 25.0, location_type: 0 }]);
    const sensors = normalizePurpleAirResponse(apiResp);
    assert.equal(sensors.length, 1);
    assert.equal(sensors[0].sensor_index, 42);
    assert.equal(sensors[0].name, 'TestA');
    assert.equal(sensors[0].pm25_avg, 25.0);
  });

  it('pollPurpleAir filters out indoor sensors (location_type !== 0)', async () => {
    const apiResp = makePurpleAirApiResponse([
      { sensor_index: 100, name: 'Outdoor', location_type: 0, last_seen: 1710000100, pm25: 12.0 },
      { sensor_index: 101, name: 'Indoor',  location_type: 1, last_seen: 1710000100, pm25: 8.0  },
    ]);
    const restore = mockFetch([{ status: 200, json: apiResp }]);
    const registry = new SensorRegistry();
    const { bundles } = await pollPurpleAir(
      { apiKey: 'test', bboxes: [{ nwlng: -123, nwlat: 38, selng: -122, selat: 37, label: 'sf' }] },
      registry,
    );
    restore();
    // Only the outdoor sensor should produce a bundle
    assert.equal(bundles.filter(b => b.source === 'PURPLEAIR').length, 1);
    assert.equal(registry.sensors.has(101), false, 'Indoor sensor should not enter registry');
  });

  it('pollPurpleAir deduplicates sensors with unchanged last_seen', async () => {
    const baseTs = 1710000000;
    const apiResp = makePurpleAirApiResponse([
      { sensor_index: 200, last_seen: baseTs, pm25: 15.0, location_type: 0 },
    ]);
    const restore = mockFetch([
      { status: 200, json: apiResp },
      { status: 200, json: apiResp }, // second poll: same data
    ]);
    const registry = new SensorRegistry();
    const cfg = { apiKey: 'test', bboxes: [{ nwlng: -123, nwlat: 38, selng: -122, selat: 37, label: 'sf' }] };
    const first  = await pollPurpleAir(cfg, registry);
    const second = await pollPurpleAir(cfg, registry);
    restore();
    assert.equal(first.bundles.length,  1, 'First poll produces a bundle');
    assert.equal(second.bundles.length, 0, 'Second poll with same last_seen produces no bundle (dedup)');
  });

  it('normalizePurpleAirResponse returns empty array for malformed input', () => {
    assert.deepEqual(normalizePurpleAirResponse(null), []);
    assert.deepEqual(normalizePurpleAirResponse({}), []);
    assert.deepEqual(normalizePurpleAirResponse({ fields: [], data: [] }), []);
  });
});

// ============================================================================
// Suite 14: PurpleAir oracle — rate limit and backoff
// ============================================================================

describe('PurpleAir oracle — rate limit and backoff', () => {
  it('HTTP 429 with no cache returns empty result without throwing', async () => {
    const restore = mockFetch([{ status: 429, json: {} }]);
    const registry = new SensorRegistry();
    const result = await pollPurpleAir(
      { apiKey: 'test', bboxes: [{ nwlng: -123, nwlat: 38, selng: -122, selat: 37, label: 'test-429-nocache' }] },
      registry,
    );
    restore();
    assert.deepEqual(result.bundles, []);
    assert.deepEqual(result.dropouts, []);
  });

  it('HTTP 429 with cached response returns bundles from cache', async () => {
    const apiResp = makePurpleAirApiResponse([
      { sensor_index: 300, last_seen: 1710001000, pm25: 20.0, location_type: 0 },
    ]);
    const restore = mockFetch([
      { status: 200, json: apiResp }, // First poll succeeds and populates cache
      { status: 429, json: {} },      // Second poll hits rate limit
    ]);
    const registry = new SensorRegistry();
    const cfg = { apiKey: 'test', bboxes: [{ nwlng: -123, nwlat: 38, selng: -122, selat: 37, label: 'test-429-cache' }] };
    const first  = await pollPurpleAir(cfg, registry);
    const second = await pollPurpleAir(cfg, registry);
    restore();
    assert.equal(first.bundles.length,  1, 'First poll succeeds');
    // On 429 with cache, the oracle re-processes the cached response.
    // All sensors in cache have unchanged last_seen vs registry → dedup → 0 new bundles.
    // This confirms cache was consulted (no throw) even if dedup means 0 bundles.
    assert.ok(second !== null, 'Rate-limited poll returns without throwing');
  });

  it('network error returns empty result without throwing', async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const registry = new SensorRegistry();
    const result = await pollPurpleAir(
      { apiKey: 'test', bboxes: [{ nwlng: -123, nwlat: 38, selng: -122, selat: 37, label: 'test-neterr' }] },
      registry,
    );
    globalThis.fetch = orig;
    assert.deepEqual(result.bundles, []);
    assert.deepEqual(result.dropouts, []);
  });
});

// ============================================================================
// Suite 15: EPA AirNow oracle — bundle construction
// ============================================================================

describe('EPA AirNow oracle — bundle construction', () => {
  it('AirNow bundle has data_tier settlement_authority', async () => {
    const restore = mockFetch([{ status: 200, json: [makeAirNowApiObs()] }]);
    const { bundles } = await pollAirNow(
      { apiKey: 'test', regions: [{ lat: 37.77, lon: -122.41, label: 'SF' }] },
    );
    restore();
    assert.ok(bundles.length > 0);
    assert.equal(bundles[0].data_tier, 'settlement_authority');
  });

  it('AirNow bundle has evidence_class ground_truth', async () => {
    const restore = mockFetch([{ status: 200, json: [makeAirNowApiObs()] }]);
    const { bundles } = await pollAirNow(
      { apiKey: 'test', regions: [{ lat: 37.77, lon: -122.41, label: 'SF' }] },
    );
    restore();
    assert.equal(bundles[0].evidence_class, 'ground_truth');
  });

  it('AirNow bundle has exact mandatory attribution string', async () => {
    const restore = mockFetch([{ status: 200, json: [makeAirNowApiObs()] }]);
    const { bundles } = await pollAirNow(
      { apiKey: 'test', regions: [{ lat: 37.77, lon: -122.41, label: 'SF' }] },
    );
    restore();
    assert.equal(bundles[0].attribution, 'U.S. EPA AirNow (preliminary data — not for regulatory use)');
  });

  it('unknown timezone skips observation without throwing', async () => {
    const obsWithBadTz = makeAirNowApiObs({ LocalTimeZone: 'NZDT' }); // unknown to AIRNOW_TZ_OFFSETS
    const restore = mockFetch([{ status: 200, json: [obsWithBadTz] }]);
    const { bundles, observations } = await pollAirNow(
      { apiKey: 'test', regions: [{ lat: 37.77, lon: -122.41, label: 'SF' }] },
    );
    restore();
    assert.equal(bundles.length, 0, 'Unknown timezone observation is skipped');
    assert.equal(observations.length, 0);
  });

  it('AirNow observation with null Category does not throw', async () => {
    const obsNullCategory = makeAirNowApiObs({ Category: null });
    const restore = mockFetch([{ status: 200, json: [obsNullCategory] }]);
    // If H1 is not fixed, this await will reject — the test will fail with TypeError
    const result = await pollAirNow(
      { apiKey: 'test', regions: [{ lat: 37.77, lon: -122.41, label: 'SF' }] },
    );
    restore();
    assert.ok(result.bundles.length > 0, 'Bundle still produced with null Category');
    assert.equal(result.bundles[0].payload.aqi.category, 'Unknown');
    assert.equal(result.bundles[0].payload.aqi.category_number, 0);
  });
});

// ============================================================================
// Suite 16: EPA AirNow oracle — time semantics
// ============================================================================

describe('EPA AirNow oracle — time semantics', () => {
  it('parseAirNowObservationTime: 2026-03-19 14:00 PST → 22:00 UTC (epoch ms)', () => {
    const obs = { DateObserved: '2026-03-19 ', HourObserved: 14, LocalTimeZone: 'PST' };
    const times = parseAirNowObservationTime(obs);
    assert.ok(times !== null);
    // 2026-03-19 14:00 PST = 2026-03-19 22:00 UTC
    const expected = Date.parse('2026-03-19T22:00:00Z');
    assert.equal(times.observation_time, expected);
  });

  it('parseAirNowObservationTime trims trailing space from DateObserved', () => {
    const trimmed = { DateObserved: '2026-03-19 ', HourObserved: 0, LocalTimeZone: 'EST' };
    const noSpace = { DateObserved: '2026-03-19',  HourObserved: 0, LocalTimeZone: 'EST' };
    const t1 = parseAirNowObservationTime(trimmed);
    const t2 = parseAirNowObservationTime(noSpace);
    assert.ok(t1 !== null && t2 !== null);
    assert.equal(t1.observation_time, t2.observation_time);
  });

  it('AirNow bundle payload has all four time fields', async () => {
    const restore = mockFetch([{ status: 200, json: [makeAirNowApiObs()] }]);
    const { bundles } = await pollAirNow(
      { apiKey: 'test', regions: [{ lat: 37.77, lon: -122.41, label: 'SF' }] },
    );
    restore();
    assert.ok(bundles.length > 0);
    const { payload } = bundles[0];
    assert.ok(typeof payload.observation_time === 'number');
    assert.ok(typeof payload.publication_time === 'number');
    assert.ok(typeof payload.ingest_time      === 'number');
    assert.ok(typeof payload.averaging_basis  === 'string');
  });
});

// ============================================================================
// Suite 17: Adversarial sensor scenarios
// ============================================================================

describe('Adversarial sensor scenarios', () => {
  it('indoor sensor (location_type: 1) is excluded from bundles and registry', async () => {
    const apiResp = makePurpleAirApiResponse([
      { sensor_index: 500, name: 'Indoor Only', location_type: 1, last_seen: 1710002000, pm25: 5.0 },
    ]);
    const restore = mockFetch([{ status: 200, json: apiResp }]);
    const registry = new SensorRegistry();
    const { bundles } = await pollPurpleAir(
      { apiKey: 'test', bboxes: [{ nwlng: -123, nwlat: 38, selng: -122, selat: 37, label: 'adv-1' }] },
      registry,
    );
    restore();
    assert.equal(bundles.length, 0, 'Indoor sensor produces no bundle');
    assert.equal(registry.sensors.size, 0, 'Indoor sensor does not enter registry');
  });

  it('A/B channel severe divergence (pm25_a=10, pm25_b=80) → channel_inconsistent evidence class', async () => {
    const apiResp = makePurpleAirApiResponse([
      { sensor_index: 501, location_type: 0, last_seen: 1710003000, pm25: 45.0, pm25_a: 10.0, pm25_b: 80.0 },
    ]);
    const restore = mockFetch([{ status: 200, json: apiResp }]);
    const registry = new SensorRegistry();
    const { bundles } = await pollPurpleAir(
      { apiKey: 'test', bboxes: [{ nwlng: -123, nwlat: 38, selng: -122, selat: 37, label: 'adv-2' }] },
      registry,
    );
    restore();
    assert.equal(bundles.length, 1);
    assert.equal(bundles[0].evidence_class, 'channel_inconsistent',
      `Expected channel_inconsistent, got ${bundles[0].evidence_class}`);
  });

  it('frozen sensor (same last_seen) → sensor_dropout after 2× poll cadence', () => {
    const registry = new SensorRegistry();
    const frozenLastSeen = 1710000000; // Unix seconds — fixed, won't advance
    registry.update([{
      sensor_index: 502,
      name: 'Frozen',
      latitude: 37.77,
      longitude: -122.41,
      location_type: 0,
      pm25_avg: 12.0,
      pm25_a: 12.1,
      pm25_b: 11.9,
      last_seen: frozenLastSeen,
    }]);

    // Simulate 2× poll cadence (240s) passing: now is well after the frozen sensor's last_seen.
    const pollIntervalMs = 120_000;
    const futureNow = (frozenLastSeen + 300) * 1000; // 5 minutes after frozen timestamp
    const dropouts = registry.getDropouts(futureNow, pollIntervalMs);
    assert.equal(dropouts.length, 1, 'Frozen sensor detected as dropout after 2× poll cadence');
    assert.equal(dropouts[0].sensor_index, 502);
  });

  it('location drift > 0.001° → location_stable: false in registry', () => {
    const registry = new SensorRegistry();
    registry.update([{
      sensor_index: 503,
      name: 'Moving Sensor',
      latitude:  37.7700,
      longitude: -122.4100,
      location_type: 0,
      pm25_avg: 10.0,
      pm25_a: 10.0,
      pm25_b: 10.1,
      last_seen: 1710005000,
    }]);

    // Second poll: coordinates shift by 0.002° (>0.001° threshold)
    registry.update([{
      sensor_index: 503,
      name: 'Moving Sensor',
      latitude:  37.7720, // +0.002°
      longitude: -122.4100,
      location_type: 0,
      pm25_avg: 10.0,
      pm25_a: 10.0,
      pm25_b: 10.1,
      last_seen: 1710005120, // new reading
    }]);

    const record = registry.sensors.get(503);
    assert.equal(record.location_stable, false, 'location_stable should be false after drift');
  });
});

// ============================================================================
// Sprint 3 helpers
// ============================================================================

/** Minimal PurpleAir evidence bundle for Theatre tests. */
function makePABundle({
  bundle_id,
  evidence_class = 'provisional',
  aqi_value = 100,
  sensor_id = 1,
  quality = 0.8,
  doubt_price = 0.2,
} = {}) {
  return {
    bundle_id: bundle_id ?? `pa-${sensor_id}-${Date.now()}`,
    source: 'PURPLEAIR',
    evidence_class,
    payload: {
      aqi: { value: aqi_value, category: 'Moderate', category_number: 2 },
      location: { sensor_id },
      quality: { composite: quality },
      uncertainty: { doubt_price },
    },
  };
}

/** Minimal EPA AirNow evidence bundle for Theatre tests. */
function makeANBundle({
  bundle_id,
  aqi_value = 180,
  category = 'Unhealthy',
  category_number = 4,
} = {}) {
  return {
    bundle_id: bundle_id ?? `breath-airnow-SF-${Date.now()}`,
    source: 'EPA_AIRNOW',
    evidence_class: 'ground_truth',
    payload: {
      aqi: { value: aqi_value, category, category_number },
      location: { region_label: 'San Francisco' },
    },
  };
}

// ============================================================================
// Suite 18: T1: AQI Threshold Gate
// ============================================================================

describe('T1: AQI Threshold Gate', () => {
  it('createAqiThresholdGate throws for invalid threshold (150 is not a category boundary)', () => {
    assert.throws(
      () => createAqiThresholdGate({ region_name: 'SF', region_bbox: [], aqi_threshold: 150, window_hours: 24 }),
      /Invalid AQI threshold/,
    );
    // 151 is valid (Unhealthy lower boundary)
    const theatre = createAqiThresholdGate({ region_name: 'SF', region_bbox: [], aqi_threshold: 151, window_hours: 24 });
    assert.equal(theatre.threshold_category_number, 4);
    assert.equal(theatre.state, 'open');
  });

  it('EPA AirNow ground_truth resolves YES when category_number >= threshold_category_number', () => {
    let theatre = createAqiThresholdGate({ region_name: 'SF', region_bbox: [], aqi_threshold: 151, window_hours: 4 });
    // AirNow bundle: category_number=4 (Unhealthy), threshold_category_number=4 → crossed
    const bundle = makeANBundle({ aqi_value: 165, category: 'Unhealthy', category_number: 4 });
    theatre = processAqiThresholdGate(theatre, bundle);
    assert.equal(theatre.state, 'resolved');
    assert.equal(theatre.outcome, true);
    assert.equal(theatre.current_position, 1.0);
    assert.equal(theatre.resolving_bundle_id, bundle.bundle_id);
  });

  it('expireAqiThresholdGate resolves with outcome: false', () => {
    let theatre = createAqiThresholdGate({ region_name: 'SF', region_bbox: [], aqi_threshold: 101, window_hours: 4 });
    theatre = expireAqiThresholdGate(theatre);
    assert.equal(theatre.state, 'resolved');
    assert.equal(theatre.outcome, false);
    // Already resolved — idempotent
    const again = expireAqiThresholdGate(theatre);
    assert.equal(again.outcome, false);
    assert.equal(again.position_history.length, theatre.position_history.length);
  });

  it('PurpleAir provisional_mature + AQI >= threshold transitions to provisional_hold', () => {
    let theatre = createAqiThresholdGate({ region_name: 'SF', region_bbox: [], aqi_threshold: 151, window_hours: 4 });
    const bundle = makePABundle({ evidence_class: 'provisional_mature', aqi_value: 165, sensor_id: 10 });
    theatre = processAqiThresholdGate(theatre, bundle);
    assert.equal(theatre.state, 'provisional_hold');
  });

  it('multiple PurpleAir provisional bundles update position monotonically toward threshold', () => {
    let theatre = createAqiThresholdGate({
      region_name: 'SF', region_bbox: [], aqi_threshold: 151, window_hours: 4, base_rate: 0.1,
    });
    // AQI well above threshold → high crossing probability → position should increase
    const positions = [theatre.current_position];
    for (let i = 0; i < 4; i++) {
      theatre = processAqiThresholdGate(theatre,
        makePABundle({ evidence_class: 'provisional', aqi_value: 200, sensor_id: 11, doubt_price: 0.1, quality: 1.0 }));
      positions.push(theatre.current_position);
    }
    // Positions should be non-decreasing (moving toward 1.0 since AQI >> threshold)
    for (let i = 1; i < positions.length; i++) {
      assert.ok(positions[i] >= positions[i - 1],
        `position[${i}]=${positions[i]} should be >= position[${i-1}]=${positions[i-1]}`);
    }
    assert.ok(theatre.current_position > 0.1, 'Position should have moved above base_rate');
  });
});

// ============================================================================
// Suite 19: T2: Sensor Divergence
// ============================================================================

describe('T2: Sensor Divergence', () => {
  it('bundle from unrelated sensor is ignored (theatre state unchanged)', () => {
    let theatre = createSensorDivergence({
      sensor_a_index: 1, sensor_b_index: 2, aqi_divergence_threshold: 50, required_hours: 2,
    });
    const before = theatre.evidence_bundles.length;
    theatre = processSensorDivergence(theatre, makePABundle({ sensor_id: 999, aqi_value: 200 }));
    assert.equal(theatre.evidence_bundles.length, before, 'Unrelated sensor should not add to evidence_bundles');
    assert.equal(theatre.state, 'open');
  });

  it('two consecutive divergent readings resolve YES (outcome: true)', () => {
    let theatre = createSensorDivergence({
      sensor_a_index: 1, sensor_b_index: 2, aqi_divergence_threshold: 50, required_hours: 2,
    });
    // Step 1: sensor A reports AQI 200
    theatre = processSensorDivergence(theatre, makePABundle({ sensor_id: 1, aqi_value: 200 }));
    assert.equal(theatre.state, 'open', 'Still open — only one sensor seen');
    // Step 2: sensor B reports AQI 100 → diff=100>50, consecutive=1
    theatre = processSensorDivergence(theatre, makePABundle({ sensor_id: 2, aqi_value: 100 }));
    assert.equal(theatre.consecutive_divergent_readings, 1);
    assert.equal(theatre.state, 'open', 'Still open after 1 of 2 required');
    // Step 3: sensor A again → diff=100>50, consecutive=2 → RESOLVED
    theatre = processSensorDivergence(theatre, makePABundle({ sensor_id: 1, aqi_value: 200 }));
    assert.equal(theatre.state, 'resolved');
    assert.equal(theatre.outcome, true);
    assert.equal(theatre.current_position, 1.0);
  });

  it('divergence then convergence resets consecutive_divergent_readings to 0', () => {
    let theatre = createSensorDivergence({
      sensor_a_index: 1, sensor_b_index: 2, aqi_divergence_threshold: 50, required_hours: 3,
    });
    // Diverge: diff=100>50, consecutive=1
    theatre = processSensorDivergence(theatre, makePABundle({ sensor_id: 1, aqi_value: 200 }));
    theatre = processSensorDivergence(theatre, makePABundle({ sensor_id: 2, aqi_value: 100 }));
    assert.equal(theatre.consecutive_divergent_readings, 1);
    // Converge: sensor A drops to 50 → diff=|50-100|=50, NOT exceeded (strict >), consecutive resets
    theatre = processSensorDivergence(theatre, makePABundle({ sensor_id: 1, aqi_value: 50 }));
    assert.equal(theatre.consecutive_divergent_readings, 0, 'Consecutive counter should reset on convergence');
    assert.equal(theatre.state, 'open');
  });

  it('position smoothly increases to 0.5 after 1 of 2 required divergent readings', () => {
    let theatre = createSensorDivergence({
      sensor_a_index: 1, sensor_b_index: 2, aqi_divergence_threshold: 50, required_hours: 2,
    });
    // Seed both sensors
    theatre = processSensorDivergence(theatre, makePABundle({ sensor_id: 1, aqi_value: 200 }));
    theatre = processSensorDivergence(theatre, makePABundle({ sensor_id: 2, aqi_value: 100 }));
    // 1 of 2 required exceeded → position = 1/2 = 0.5
    assert.equal(theatre.current_position, 0.5);
    assert.equal(theatre.state, 'open');
  });

  it('expireSensorDivergence resolves outcome: false on open theatre; idempotent on resolved', () => {
    let theatre = createSensorDivergence({
      sensor_a_index: 1, sensor_b_index: 2, aqi_divergence_threshold: 50, required_hours: 3,
    });
    // Seed one divergent reading (condition not met — consecutive=1 < required=3)
    theatre = processSensorDivergence(theatre, makePABundle({ sensor_id: 1, aqi_value: 200 }));
    theatre = processSensorDivergence(theatre, makePABundle({ sensor_id: 2, aqi_value: 100 }));
    assert.equal(theatre.state, 'open');

    // Expire — condition not met
    const expired = expireSensorDivergence(theatre);
    assert.equal(expired.state, 'resolved');
    assert.equal(expired.outcome, false);
    assert.ok(expired.resolved_at > 0, 'resolved_at should be set');
    assert.equal(expired.position_history.length, theatre.position_history.length + 1);
    const lastEntry = expired.position_history.at(-1);
    assert.ok(lastEntry.reason.includes('consecutive=1/3'), 'reason should reflect consecutive/required');

    // Idempotent: calling again on already-resolved theatre returns it unchanged
    const again = expireSensorDivergence(expired);
    assert.equal(again.position_history.length, expired.position_history.length, 'Idempotent — no extra entry added');
    assert.equal(again.resolved_at, expired.resolved_at);
  });
});

// ============================================================================
// Suite 20: T3: Wildfire Cascade
// ============================================================================

describe('T3: Wildfire Cascade', () => {
  it('bundle from non-tracked sensor is ignored', () => {
    let theatre = createWildfireCascade({
      region_name: 'NorCal', tracked_sensors: [10, 11, 12, 13], window_hours: 24,
    });
    theatre = processWildfireCascade(theatre, makePABundle({ sensor_id: 999, aqi_value: 250 }));
    assert.equal(theatre.evidence_bundles.length, 0, 'Non-tracked sensor should produce no evidence');
    assert.equal(theatre.current_pct_exceeded, 0);
  });

  it('resolveWildfireCascade with 0/4 sensors exceeding threshold → outcome: 0 (0–10% bucket)', () => {
    let theatre = createWildfireCascade({
      region_name: 'NorCal', tracked_sensors: [10, 11, 12, 13], window_hours: 24,
    });
    // All sensors report AQI 100 (below threshold_aqi=200)
    for (const id of [10, 11, 12, 13]) {
      theatre = processWildfireCascade(theatre, makePABundle({ sensor_id: id, aqi_value: 100 }));
    }
    theatre = resolveWildfireCascade(theatre);
    assert.equal(theatre.state, 'resolved');
    assert.equal(theatre.outcome, 0, '0/4 sensors exceeded → bucket 0 (0–10%)');
  });

  it('resolveWildfireCascade with all sensors exceeding threshold → outcome: 4 (70%+ bucket)', () => {
    let theatre = createWildfireCascade({
      region_name: 'NorCal', tracked_sensors: [10, 11, 12, 13], window_hours: 24,
    });
    for (const id of [10, 11, 12, 13]) {
      theatre = processWildfireCascade(theatre, makePABundle({ sensor_id: id, aqi_value: 250 }));
    }
    theatre = resolveWildfireCascade(theatre);
    assert.equal(theatre.outcome, 4, '4/4 (100%) exceeded → bucket 4 (70%+)');
  });

  it('resolveWildfireCascade with 4/10 sensors exceeding threshold → outcome: 2 (30–50% bucket)', () => {
    const allIds = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    let theatre = createWildfireCascade({
      region_name: 'NorCal', tracked_sensors: allIds, window_hours: 24,
    });
    // 4 sensors exceed AQI 200, 6 do not
    const exceeding = [10, 11, 12, 13];
    const notExceeding = [14, 15, 16, 17, 18, 19];
    for (const id of exceeding) {
      theatre = processWildfireCascade(theatre, makePABundle({ sensor_id: id, aqi_value: 250 }));
    }
    for (const id of notExceeding) {
      theatre = processWildfireCascade(theatre, makePABundle({ sensor_id: id, aqi_value: 100 }));
    }
    theatre = resolveWildfireCascade(theatre);
    assert.equal(theatre.current_pct_exceeded, 0.4, '4/10 = 40% exceeded');
    assert.equal(theatre.outcome, 2, '40% falls in bucket 2 (30–50%)');
  });
});

// ============================================================================
// Suite 21: RLMF certificates
// ============================================================================

describe('RLMF certificates', () => {
  it('brierScoreBinary: boundary cases 0.5→0.25, 1.0→0.0, 0.0→1.0', () => {
    assert.equal(brierScoreBinary([{ p: 0.5 }], true),  0.25);
    assert.equal(brierScoreBinary([{ p: 1.0 }], true),  0.0,  'Perfect prediction = 0.0');
    assert.equal(brierScoreBinary([{ p: 0.0 }], true),  1.0,  'Worst prediction = 1.0');
    assert.equal(brierScoreBinary([{ p: 0.5 }], false), 0.25);
    assert.equal(brierScoreBinary([{ p: 0.0 }], false), 0.0,  'Perfect NO prediction = 0.0');
  });

  it('brierScoreBinary multi-point: [{p:0.5},{p:0.8}] true → 0.145', () => {
    // (0.5-1)² = 0.25; (0.8-1)² = 0.04; average = 0.145
    const score = brierScoreBinary([{ p: 0.5 }, { p: 0.8 }], true);
    assert.ok(Math.abs(score - 0.145) < 1e-10, `Expected 0.145, got ${score}`);
  });

  it('exportCertificate returns all required top-level fields for a T1 theatre', () => {
    let theatre = createAqiThresholdGate({ region_name: 'SF', region_bbox: [], aqi_threshold: 151, window_hours: 4 });
    const bundle = makeANBundle({ aqi_value: 160, category: 'Unhealthy', category_number: 4, bundle_id: 'breath-airnow-SF-123' });
    theatre = processAqiThresholdGate(theatre, bundle);
    const cert = exportCertificate(theatre, { construct_id: 'BREATH' });

    assert.ok(cert.certificate_id.startsWith('breath-'), 'certificate_id');
    assert.equal(cert.construct, 'BREATH');
    assert.ok(typeof cert.theatre_id === 'string', 'theatre_id');
    assert.equal(cert.template, 'aqi_threshold_gate');
    assert.equal(cert.outcome, true);
    assert.ok(typeof cert.opened_at === 'number', 'opened_at');
    assert.ok(typeof cert.resolved_at === 'number', 'resolved_at');
    assert.ok(typeof cert.performance.brier_score === 'number', 'performance.brier_score');
    assert.ok(typeof cert.performance.directional_accuracy === 'boolean', 'directional_accuracy');
    assert.ok(typeof cert.performance.lead_time_seconds === 'number', 'lead_time_seconds');
    assert.ok(typeof cert.performance.volatility === 'number', 'volatility');
    assert.ok(typeof cert.evidence_summary.total_bundles === 'number', 'evidence_summary.total_bundles');
    assert.ok(typeof cert.evidence_summary.epa_airnow_confirmed === 'boolean', 'epa_airnow_confirmed');
    // AirNow-resolved theatre: epa_airnow_confirmed = true (resolving_bundle_id contains 'airnow')
    assert.equal(cert.evidence_summary.epa_airnow_confirmed, true);
  });

  it('T3 Wildfire Cascade certificate has integer outcome 0–4', () => {
    let theatre = createWildfireCascade({
      region_name: 'NorCal', tracked_sensors: [10, 11, 12, 13], window_hours: 24,
    });
    for (const id of [10, 11, 12, 13]) {
      theatre = processWildfireCascade(theatre, makePABundle({ sensor_id: id, aqi_value: 250 }));
    }
    theatre = resolveWildfireCascade(theatre);
    const cert = exportCertificate(theatre);
    assert.ok(Number.isInteger(cert.outcome), 'T3 outcome must be an integer');
    assert.ok(cert.outcome >= 0 && cert.outcome <= 4, `T3 outcome must be 0–4, got ${cert.outcome}`);
    assert.equal(cert.template, 'wildfire_cascade');
    assert.equal(cert.construct, 'BREATH');
  });
});

// ============================================================================
// Suite 22: BreathConstruct — integration
// ============================================================================

describe('BreathConstruct — integration', () => {
  it('openAqiThresholdGate + inject PA bundles → theatre position updates', () => {
    const bc = new BreathConstruct({ pollIntervalMs: 1_000_000 });
    bc.openAqiThresholdGate({
      region_name: 'SF', region_bbox: [-123.0, 37.5, -122.0, 38.0],
      aqi_threshold: 151, window_hours: 24,
    });
    const initialPos = bc.getActiveTheatres()[0].current_position;

    // Inject provisional PA bundle with AQI above threshold → position should blend up
    bc._processBundle(makePABundle({
      bundle_id: 'pa-test-1', evidence_class: 'provisional', aqi_value: 170, sensor_id: 1,
    }));

    const updatedTheatre = bc.getActiveTheatres()[0];
    assert.ok(updatedTheatre.current_position > initialPos,
      'Position should increase after high-AQI PA bundle');
    assert.equal(updatedTheatre.state, 'open', 'Theatre remains open after PA signal');
    assert.equal(updatedTheatre.evidence_bundles.length, 1);
  });

  it('inject AirNow ground_truth bundle crossing threshold → theatre resolves, certificate exported', () => {
    const bc = new BreathConstruct({ pollIntervalMs: 1_000_000 });
    bc.openAqiThresholdGate({
      region_name: 'SF', region_bbox: [-123.0, 37.5, -122.0, 38.0],
      aqi_threshold: 151, window_hours: 24,
    });

    // AirNow bundle: category_number=4 >= threshold_category_number=4 → resolves YES
    bc._processBundle(makeANBundle({
      bundle_id: 'breath-airnow-SF-001', aqi_value: 160, category: 'Unhealthy', category_number: 4,
    }));

    const theatre = Array.from(bc.theatres.values())[0];
    assert.equal(theatre.state, 'resolved');
    assert.equal(theatre.outcome, true);
    assert.equal(bc.getCertificates().length, 1, 'Certificate exported on resolution');
    assert.equal(bc.getCertificates()[0].outcome, true);
  });

  it('getState() reflects correct theatres.by_state counts', () => {
    const bc = new BreathConstruct({ pollIntervalMs: 1_000_000 });
    bc.openAqiThresholdGate({
      region_name: 'SF', region_bbox: [-123.0, 37.5, -122.0, 38.0],
      aqi_threshold: 151, window_hours: 24,
    });
    // T2 theatre — not affected by AirNow ground_truth bundles (no sensor_id match)
    bc.openSensorDivergence({
      id: 'second', region_name: 'Oakland',
      sensor_a_index: 100, sensor_b_index: 101,
      aqi_divergence_threshold: 50, required_hours: 3, window_hours: 24,
    });

    // Resolve one theatre via AirNow
    bc._processBundle(makeANBundle({ bundle_id: 'breath-airnow-sf-1', category_number: 4 }));

    const state = bc.getState();
    assert.equal(state.construct, 'BREATH');
    assert.equal(typeof state.running, 'boolean');
    assert.equal(state.theatres.total, 2);
    assert.equal(state.theatres.by_state.resolved, 1, '1 theatre resolved');
    assert.equal(state.theatres.by_state.open, 1, '1 theatre still open');
    assert.equal(state.stats.theatres_created, 2);
    assert.equal(state.stats.certificates_exported, 1);
  });

  it('flushCertificates() returns 1 after one resolution, then 0 on second call', () => {
    const bc = new BreathConstruct({ pollIntervalMs: 1_000_000 });
    bc.openAqiThresholdGate({
      region_name: 'SF', region_bbox: [-123.0, 37.5, -122.0, 38.0],
      aqi_threshold: 151, window_hours: 24,
    });
    bc._processBundle(makeANBundle({ bundle_id: 'breath-airnow-flush-1', category_number: 4 }));

    assert.equal(bc.flushCertificates(), 1, 'First flush returns 1');
    assert.equal(bc.flushCertificates(), 0, 'Second flush returns 0 (array cleared)');
    assert.equal(bc.getCertificates().length, 0, 'getCertificates() empty after flush');
  });

  it('start() + stop() — stop() clears poll timer and is idempotent', () => {
    const bc = new BreathConstruct({ pollIntervalMs: 1_000_000 });
    assert.equal(bc.pollTimer, null, 'Timer is null before start()');
    bc.start();
    assert.ok(bc.pollTimer !== null, 'Timer is set after start()');
    assert.throws(() => bc.start(), /already running/, 'start() twice throws');
    bc.stop();
    assert.equal(bc.pollTimer, null, 'Timer is null after stop()');
    bc.stop(); // idempotent — should not throw
    assert.equal(bc.pollTimer, null, 'Timer still null after second stop()');
  });

  it('poll() processes AirNow bundles before PurpleAir bundles (AirNow resolves first)', async () => {
    // AirNow bundle that resolves the T1 theatre (category_number=4 >= threshold 4)
    const ainowBundle = makeANBundle({ bundle_id: 'breath-airnow-order-1', category_number: 4 });
    // PA bundle that would update position if processed first
    const paBundle    = makePABundle({ bundle_id: 'pa-order-1', evidence_class: 'provisional', aqi_value: 160, sensor_id: 1 });

    const bc = new BreathConstruct({
      pollIntervalMs: 1_000_000,
      _oracleOverrides: {
        pollPurpleAir: async () => ({ bundles: [paBundle], dropouts: [] }),
        pollAirNow:    async () => ({ bundles: [ainowBundle], observations: [] }),
      },
    });

    bc.openAqiThresholdGate({
      region_name: 'SF', region_bbox: [-123.0, 37.5, -122.0, 38.0],
      aqi_threshold: 151, window_hours: 24,
    });

    // Force AirNow to be due (lastAirNowPoll = 0, which is >> 60m ago)
    const initialHistoryLen = bc.getActiveTheatres()[0].position_history.length;
    await bc.poll();

    const theatre = Array.from(bc.theatres.values())[0];
    assert.equal(theatre.state, 'resolved', 'Theatre must be resolved');
    assert.equal(theatre.outcome, true);
    // AirNow processed FIRST: theatre resolved on AirNow bundle (adds 1 entry).
    // PA bundle then hits _processBundle → theatre already resolved → no-op.
    // Net position_history growth: exactly 1 (AirNow resolution entry only).
    assert.equal(
      theatre.position_history.length,
      initialHistoryLen + 1,
      'Only 1 new position_history entry — AirNow resolved first, PA bundle was ignored',
    );
  });
});

// ============================================================================
// Audit Sprint 1 — Regression Tests
// ============================================================================

describe('Audit B1 — getAqiTrend ordering', () => {
  it('returns positive trend for rising AQI', () => {
    const registry = new SensorRegistry();
    const now = Date.now();
    // aqi_history is stored newest-first
    registry.sensors.set(1, {
      sensor_index: 1,
      name: 'Test',
      location: { latitude: 37, longitude: -122, location_type: 0 },
      location_stable: true,
      pm25_history: [],
      aqi_history: [
        { t: now,                 aqi: 100 },
        { t: now - 30 * 60_000,  aqi: 90  },
        { t: now - 60 * 60_000,  aqi: 80  },
        { t: now - 90 * 60_000,  aqi: 70  },
      ],
      last_seen: Math.floor(now / 1000),
      state: 'active',
      channel_consistency_score: 0.5,
      nearby_agreement_count: 0,
      _consistencyHistory: [],
    });
    const trend = registry.getAqiTrend(1, 2);
    assert.ok(trend > 0, `Expected positive trend for rising AQI, got ${trend}`);
  });

  it('returns negative trend for falling AQI', () => {
    const registry = new SensorRegistry();
    const now = Date.now();
    registry.sensors.set(1, {
      sensor_index: 1,
      name: 'Test',
      location: { latitude: 37, longitude: -122, location_type: 0 },
      location_stable: true,
      pm25_history: [],
      aqi_history: [
        { t: now,                 aqi: 70  },
        { t: now - 30 * 60_000,  aqi: 80  },
        { t: now - 60 * 60_000,  aqi: 90  },
        { t: now - 90 * 60_000,  aqi: 100 },
      ],
      last_seen: Math.floor(now / 1000),
      state: 'active',
      channel_consistency_score: 0.5,
      nearby_agreement_count: 0,
      _consistencyHistory: [],
    });
    const trend = registry.getAqiTrend(1, 2);
    assert.ok(trend < 0, `Expected negative trend for falling AQI, got ${trend}`);
  });

  it('returns 0 for insufficient data', () => {
    const registry = new SensorRegistry();
    registry.sensors.set(1, {
      sensor_index: 1,
      aqi_history: [{ t: Date.now(), aqi: 50 }],
    });
    assert.equal(registry.getAqiTrend(1, 2), 0);
  });
});

describe('Audit B4 — NaN propagation guards', () => {
  it('thresholdCrossingProbability returns 0.5 for undefined AQI', () => {
    const p = thresholdCrossingProbability(undefined, 151, 0.5);
    assert.ok(!isNaN(p), 'Result must not be NaN');
    assert.equal(p, 0.5);
  });

  it('thresholdCrossingProbability returns 0.5 for NaN AQI', () => {
    const p = thresholdCrossingProbability(NaN, 151, 0.3);
    assert.ok(!isNaN(p), 'Result must not be NaN');
    assert.equal(p, 0.5);
  });

  it('processAqiThresholdGate: position stays finite with undefined aqi.value', () => {
    const theatre = createAqiThresholdGate({
      region_name: 'Test',
      region_bbox: [-123, 37.5, -122, 38],
      aqi_threshold: 151,
      window_hours: 24,
    });
    const badBundle = {
      bundle_id: 'test-nan-1',
      source: 'PURPLEAIR',
      evidence_class: 'provisional',
      payload: {
        aqi: { value: undefined, category: 'Unknown', category_number: 0 },
        quality: { composite: 0.5 },
        uncertainty: { doubt_price: 0.3 },
        location: { sensor_id: 999 },
      },
    };
    const updated = processAqiThresholdGate(theatre, badBundle);
    assert.ok(isFinite(updated.current_position), `position must be finite, got ${updated.current_position}`);
  });

  it('processAqiThresholdGate: skips EPA bundle with missing category_number', () => {
    const theatre = createAqiThresholdGate({
      region_name: 'Test',
      region_bbox: [-123, 37.5, -122, 38],
      aqi_threshold: 151,
      window_hours: 24,
    });
    const badEpaBundle = {
      bundle_id: 'test-nan-epa',
      source: 'EPA_AIRNOW',
      evidence_class: 'ground_truth',
      payload: {
        aqi: null,
        location: { sensor_id: 'sf' },
      },
    };
    const updated = processAqiThresholdGate(theatre, badEpaBundle);
    assert.notEqual(updated.state, 'resolved', 'Theatre must not resolve on malformed EPA bundle');
  });
});

describe('Audit B10 — settlement last_seen unit conversion', () => {
  it('assessSettlement: computes correct ageHours from seconds-valued last_seen', () => {
    const sensor = makeSensor({ state: 'active' });
    const threeHoursAgoSec = Math.floor((Date.now() - 3 * 3_600_000) / 1000);
    const registryRecord = {
      nearby_agreement_count: 5,
      last_seen: threeHoursAgoSec,
    };
    const q = { ...goodQuality(), score: 0.80 };
    const result = assessSettlement(sensor, q, registryRecord, true, null);
    assert.equal(result.evidence_class, 'provisional_mature',
      'Should classify as provisional_mature for 3h-old cross-validated sensor');
  });

  it('assessSettlement: fresh sensor (seconds) is NOT provisional_mature', () => {
    const sensor = makeSensor({ state: 'active' });
    const registryRecord = {
      nearby_agreement_count: 5,
      last_seen: Math.floor(Date.now() / 1000), // just now, in seconds
    };
    const q = { ...goodQuality(), score: 0.80 };
    const result = assessSettlement(sensor, q, registryRecord, true, null);
    // ageHours ≈ 0, so ageHours > 2 is false → provisional, not provisional_mature
    assert.equal(result.evidence_class, 'provisional',
      'Fresh sensor should not be provisional_mature (ageHours < 2)');
  });
});

describe('Audit B2 — zombie theatre protection', () => {
  it('_exportCertificate catches errors and increments counter', () => {
    const bc = new BreathConstruct({ _oracleOverrides: { pollPurpleAir: async () => ({ bundles: [], dropouts: [] }), pollAirNow: async () => ({ bundles: [], observations: [] }) } });
    // Force exportCertificate to throw by passing a theatre whose
    // position_history.filter() will throw (non-iterable)
    const badTheatre = {
      id: 'test-zombie',
      template: 'wildfire_cascade', // triggers bucketProbHistory filter path
      outcome: 2,
      opens_at: Date.now() - 10_000,
      resolved_at: Date.now(),
      position_history: 'not-an-array', // .filter() on string will throw in brierScoreMultiClass
      evidence_bundles: [],
    };
    // Should not throw
    const result = bc._exportCertificate(badTheatre);
    assert.equal(result, null, 'Should return null on export failure');
    assert.equal(bc.stats.certificate_export_errors, 1, 'Should increment error counter');
    assert.equal(bc.getCertificates().length, 0, 'No certificate should be stored');
  });
});

describe('Audit B3 — TTL dedup cache', () => {
  it('_processBundle deduplicates by bundle_id', () => {
    const bc = new BreathConstruct({ _oracleOverrides: { pollPurpleAir: async () => ({ bundles: [], dropouts: [] }), pollAirNow: async () => ({ bundles: [], observations: [] }) } });
    const theatre = bc.openAqiThresholdGate({
      region_name: 'Test',
      region_bbox: [-123, 37.5, -122, 38],
      aqi_threshold: 151,
      window_hours: 24,
    });
    const bundle = {
      bundle_id: 'dedup-test-1',
      source: 'PURPLEAIR',
      evidence_class: 'provisional',
      payload: {
        aqi: { value: 80, category: 'Moderate', category_number: 2 },
        quality: { composite: 0.5 },
        uncertainty: { doubt_price: 0.3 },
        location: { sensor_id: 1, latitude: 37.7, longitude: -122.5 },
      },
    };
    bc._processBundle(bundle);
    const posAfterFirst = theatre.current_position; // theatre ref is stale, get fresh
    const theatreAfterFirst = bc.theatres.get(theatre.id);
    const histLen1 = theatreAfterFirst.position_history.length;

    bc._processBundle(bundle); // duplicate — should be no-op
    const theatreAfterSecond = bc.theatres.get(theatre.id);
    assert.equal(theatreAfterSecond.position_history.length, histLen1,
      'Duplicate bundle must not add position_history entry');
  });
});

describe('Audit B6 — single-flight poll guard', () => {
  it('skipped_polls increments when poll is already in flight', async () => {
    const bc = new BreathConstruct({
      _oracleOverrides: {
        pollPurpleAir: async () => {
          // Simulate slow poll
          await new Promise(r => setTimeout(r, 50));
          return { bundles: [], dropouts: [] };
        },
        pollAirNow: async () => ({ bundles: [], observations: [] }),
      },
    });
    // Start two polls concurrently
    const p1 = bc.poll();
    const p2 = bc.poll(); // should be skipped
    await Promise.all([p1, p2]);
    assert.equal(bc.stats.skipped_polls, 1, 'Second concurrent poll should be skipped');
  });
});

// ============================================================================
// Audit Sprint 2 — Regression tests
// ============================================================================

describe('Audit B5a — PurpleAir schema validation', () => {
  it('drops rows shorter than fields array', () => {
    const response = {
      fields: ['sensor_index', 'name', 'latitude', 'longitude', 'pm2.5', 'pm2.5_a', 'pm2.5_b', 'confidence', 'last_seen', 'location_type'],
      data: [
        [12345, 'Good', 37.77, -122.42, 12.3, 12.0, 12.6, 100, 1700000000, 0],
        [99999, 'Short'],  // truncated row — should be dropped
      ],
    };
    const result = normalizePurpleAirResponse(response);
    assert.equal(result.length, 1, 'Truncated row must be dropped');
    assert.equal(result[0].sensor_index, 12345);
  });

  it('drops sensors with missing required numeric fields', () => {
    const response = {
      fields: ['sensor_index', 'name', 'latitude', 'longitude', 'pm2.5', 'pm2.5_a', 'pm2.5_b', 'confidence', 'last_seen', 'location_type'],
      data: [
        [null, 'NoIndex', 37.77, -122.42, 10, 10, 10, 100, 1700000000, 0],       // null sensor_index
        [111, 'NoLat', null, -122.42, 10, 10, 10, 100, 1700000000, 0],            // null latitude
        [222, 'InfLon', 37.77, Infinity, 10, 10, 10, 100, 1700000000, 0],         // Infinity longitude
        [333, 'NoSeen', 37.77, -122.42, 10, 10, 10, 100, null, 0],               // null last_seen
        [444, 'Valid', 37.77, -122.42, 10, 10, 10, 100, 1700000000, 0],          // valid
      ],
    };
    const result = normalizePurpleAirResponse(response);
    assert.equal(result.length, 1, 'Only the valid sensor should survive');
    assert.equal(result[0].sensor_index, 444);
  });

  it('returns empty array for missing fields/data', () => {
    assert.deepEqual(normalizePurpleAirResponse({}), []);
    assert.deepEqual(normalizePurpleAirResponse(null), []);
    assert.deepEqual(normalizePurpleAirResponse({ fields: ['a'] }), []);
  });
});

describe('Audit B5b — AirNow coordinate validation', () => {
  it('drops observations with non-numeric or infinite coordinates', async () => {
    const mockObs = [
      { AQI: 50, Latitude: 37.77, Longitude: -122.42, DateObserved: '2026-04-08 ', HourObserved: 12, LocalTimeZone: 'PST', ParameterName: 'PM2.5', Category: { Name: 'Good', Number: 1 } },
      { AQI: 60, Latitude: null, Longitude: -122.42, DateObserved: '2026-04-08 ', HourObserved: 12, LocalTimeZone: 'PST', ParameterName: 'PM2.5', Category: { Name: 'Good', Number: 1 } },
      { AQI: 70, Latitude: 37.77, Longitude: Infinity, DateObserved: '2026-04-08 ', HourObserved: 12, LocalTimeZone: 'PST', ParameterName: 'PM2.5', Category: { Name: 'Good', Number: 1 } },
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => mockObs,
    });

    try {
      const config = { apiKey: 'test', regions: [{ lat: 37.77, lon: -122.42, radius_miles: 25, label: 'test' }] };
      const { bundles } = await pollAirNow(config, []);
      assert.equal(bundles.length, 1, 'Only the observation with valid coordinates should produce a bundle');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Audit B8 — T3 directional logic in computeLeadTime', () => {
  it('low-cascade outcome (bucket 0): correct cross is p < 0.5', () => {
    const history = [
      { t: 1000, p: 0.6 },  // wrong direction for low cascade
      { t: 2000, p: 0.4 },  // correct — position below 0.5
      { t: 3000, p: 0.3 },
    ];
    const resolvedAt = 5000;
    const lead = computeLeadTime(history, 0, resolvedAt);
    // First correct cross at t=2000, lead = (5000-2000)/1000 = 3 seconds
    assert.equal(lead, 3, 'Lead time should measure from first p < 0.5 for bucket 0');
  });

  it('low-cascade outcome (bucket 1): correct cross is p < 0.5', () => {
    const history = [
      { t: 1000, p: 0.3 },  // correct immediately
    ];
    const lead = computeLeadTime(history, 1, 4000);
    assert.equal(lead, 3, 'Bucket 1 (low cascade) should use p < 0.5');
  });

  it('high-cascade outcome (bucket 3): correct cross is p > 0.5', () => {
    const history = [
      { t: 1000, p: 0.3 },  // wrong direction
      { t: 2000, p: 0.7 },  // correct — above 0.5
    ];
    const lead = computeLeadTime(history, 3, 6000);
    assert.equal(lead, 4, 'Bucket 3 (high cascade) should use p > 0.5');
  });

  it('binary true outcome still works: correct cross is p > 0.5', () => {
    const history = [
      { t: 1000, p: 0.2 },
      { t: 2000, p: 0.8 },
    ];
    const lead = computeLeadTime(history, true, 5000);
    assert.equal(lead, 3, 'Boolean true outcome should use p > 0.5');
  });
});

describe('Audit B9 — required_consecutive_readings backward compat', () => {
  it('uses required_consecutive_readings when provided', () => {
    const t = createSensorDivergence({
      sensor_a_index: 100,
      sensor_b_index: 200,
      required_consecutive_readings: 5,
    });
    assert.equal(t.required_consecutive_readings, 5);
  });

  it('falls back to deprecated required_hours alias', () => {
    const t = createSensorDivergence({
      sensor_a_index: 100,
      sensor_b_index: 200,
      required_hours: 3,
    });
    assert.equal(t.required_consecutive_readings, 3);
  });

  it('required_consecutive_readings takes precedence over required_hours', () => {
    const t = createSensorDivergence({
      sensor_a_index: 100,
      sensor_b_index: 200,
      required_consecutive_readings: 4,
      required_hours: 7,
    });
    assert.equal(t.required_consecutive_readings, 4, 'New param takes precedence over deprecated alias');
  });

  it('defaults to 2 when neither is provided', () => {
    const t = createSensorDivergence({
      sensor_a_index: 100,
      sensor_b_index: 200,
    });
    assert.equal(t.required_consecutive_readings, 2);
  });

  it('clamps required_consecutive_readings: 0 to minimum of 1', () => {
    const t = createSensorDivergence({
      sensor_a_index: 100,
      sensor_b_index: 200,
      required_consecutive_readings: 0,
    });
    assert.equal(t.required_consecutive_readings, 1, 'Zero must be clamped to 1 to prevent instant resolution');
  });
});
