/**
 * CORONA test suite.
 *
 * Uses Node.js built-in test runner (node --test).
 * Zero external dependencies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyFlux, classToFlux, flareRank, kpToGScale } from '../src/oracles/swpc.js';
import { parseSourceLocation, getBestCMEAnalysis, getEarthArrival } from '../src/oracles/donki.js';
import { computeQuality } from '../src/processor/quality.js';
import {
  buildFlareUncertainty, flareThresholdProbability,
  buildKpUncertainty, kpThresholdProbability,
  buildCMEArrivalUncertainty, cmeArrivalWindowProbability,
} from '../src/processor/uncertainty.js';
import { assessSettlement } from '../src/processor/settlement.js';
import { buildBundle } from '../src/processor/bundles.js';
import { brierScoreBinary, brierScoreMultiClass, calibrationBucket, exportCertificate } from '../src/rlmf/certificates.js';
import { createFlareClassGate, processFlareClassGate, expireFlareClassGate } from '../src/theatres/flare-gate.js';
import { createGeomagneticStormGate, processGeomagneticStormGate, expireGeomagneticStormGate } from '../src/theatres/geomag-gate.js';
import { createCMEArrival, processCMEArrival, expireCMEArrival } from '../src/theatres/cme-arrival.js';
import { createProtonEventCascade, processProtonEventCascade, resolveProtonEventCascade } from '../src/theatres/proton-cascade.js';
import { createSolarWindDivergence, processSolarWindDivergence, expireSolarWindDivergence } from '../src/theatres/solar-wind-divergence.js';

// =========================================================================
// Test fixtures
// =========================================================================

function makeFlareEvent(overrides = {}) {
  return {
    type: 'solar_flare',
    data: {
      source: 'SWPC_GOES',
      begin_time: Date.now() - 3600_000,
      max_time: Date.now() - 3000_000,
      end_time: Date.now() - 2400_000,
      max_class: 'M2.5',
      current_class: 'M2.5',
      max_xray_flux: 2.5e-5,
      satellite: 16,
      status: 'complete',
      event_id: 'flare-test-001',
      ...overrides,
    },
    polledAt: Date.now(),
  };
}

function makeDonkiFlareEvent(overrides = {}) {
  return {
    type: 'donki_flare',
    data: {
      flr_id: '2026-03-15T12:30:00-FLR-001',
      begin_time: Date.now() - 7200_000,
      peak_time: Date.now() - 6600_000,
      end_time: Date.now() - 6000_000,
      class_type: 'X1.5',
      source_location: { latitude: 15, longitude: 33, raw: 'N15E33' },
      active_region: 4392,
      instruments: ['GOES-16: EXIS 1.0-8.0A'],
      linked_events: ['2026-03-15T13:00:00-CME-001'],
      ...overrides,
    },
    polledAt: Date.now(),
  };
}

function makeKpEvent(overrides = {}) {
  return {
    type: 'kp_index',
    data: {
      time_tag: '2026-03-15 12:00:00.000',
      time: Date.now() - 3600_000,
      kp: 4,
      kp_fraction: 4.33,
      station_count: 8,
      ...overrides,
    },
    polledAt: Date.now(),
  };
}

function makeSolarWindEvent(overrides = {}) {
  return {
    type: 'solar_wind',
    data: {
      mag: { bz_gsm: -8, bt: 12, bx_gsm: 3, by_gsm: -5 },
      plasma: { speed: 450, density: 8, temperature: 150000 },
      time: Date.now() - 60_000,
      ...overrides,
    },
    polledAt: Date.now(),
  };
}

function makeFlareBundle(overrides = {}) {
  const event = makeFlareEvent(overrides);
  return buildBundle(event);
}

// =========================================================================
// Flare classification
// =========================================================================

describe('classifyFlux', () => {
  it('classifies X-class correctly', () => {
    const c = classifyFlux(1.5e-4);
    assert.equal(c.letter, 'X');
    assert.equal(c.number, 1.5);
  });

  it('classifies M-class correctly', () => {
    const c = classifyFlux(2.5e-5);
    assert.equal(c.letter, 'M');
    assert.equal(c.number, 2.5);
  });

  it('classifies C-class correctly', () => {
    const c = classifyFlux(5e-6);
    assert.equal(c.letter, 'C');
    assert.equal(c.number, 5);
  });

  it('handles null flux', () => {
    const c = classifyFlux(null);
    assert.equal(c.letter, 'A');
  });
});

describe('classToFlux', () => {
  it('converts M1.0 to 1e-5', () => {
    assert.equal(classToFlux('M1.0'), 1e-5);
  });

  it('converts X10.0 to 1e-3', () => {
    assert.equal(classToFlux('X10.0'), 1e-3);
  });

  it('returns null for invalid input', () => {
    assert.equal(classToFlux(''), null);
    assert.equal(classToFlux(null), null);
  });
});

describe('flareRank', () => {
  it('ranks X-class higher than M-class', () => {
    assert.ok(flareRank('X1.0') > flareRank('M9.9'));
  });

  it('ranks within same class by number', () => {
    assert.ok(flareRank('M5.0') > flareRank('M1.0'));
  });
});

describe('kpToGScale', () => {
  it('maps Kp 5 to G1', () => {
    const g = kpToGScale(5);
    assert.equal(g.level, 1);
    assert.equal(g.label, 'G1');
  });

  it('maps Kp 9 to G5', () => {
    const g = kpToGScale(9);
    assert.equal(g.level, 5);
  });

  it('maps Kp 3 to G0', () => {
    const g = kpToGScale(3);
    assert.equal(g.level, 0);
  });
});

// =========================================================================
// DONKI helpers
// =========================================================================

describe('parseSourceLocation', () => {
  it('parses N15E33', () => {
    const loc = parseSourceLocation('N15E33');
    assert.deepEqual(loc, { latitude: 15, longitude: 33, raw: 'N15E33' });
  });

  it('parses S20W45', () => {
    const loc = parseSourceLocation('S20W45');
    assert.equal(loc.latitude, -20);
    assert.equal(loc.longitude, -45);
  });

  it('returns null for invalid input', () => {
    assert.equal(parseSourceLocation(null), null);
    assert.equal(parseSourceLocation('invalid'), null);
  });
});

// =========================================================================
// Quality scoring
// =========================================================================

describe('computeQuality', () => {
  it('scores complete flares higher than in-progress', () => {
    const complete = computeQuality(makeFlareEvent({ status: 'complete' }));
    const inProgress = computeQuality(makeFlareEvent({ status: 'eventInProgress' }));
    assert.ok(complete.composite > inProgress.composite);
  });

  it('scores X-class flares higher reliability than C-class', () => {
    const xClass = computeQuality(makeFlareEvent({ max_class: 'X1.0' }));
    const cClass = computeQuality(makeFlareEvent({ max_class: 'C1.0' }));
    assert.ok(xClass.composite > cClass.composite);
  });

  it('scores Kp events', () => {
    const q = computeQuality(makeKpEvent());
    assert.ok(q.composite > 0);
    assert.equal(q.data_type, 'kp_index');
  });
});

// =========================================================================
// Uncertainty pricing
// =========================================================================

describe('buildFlareUncertainty', () => {
  it('returns lower doubt for complete vs in-progress', () => {
    const complete = buildFlareUncertainty({ max_class: 'M2.5', max_xray_flux: 2.5e-5, status: 'complete' });
    const inProg = buildFlareUncertainty({ max_class: 'M2.5', max_xray_flux: 2.5e-5, status: 'eventInProgress' });
    assert.ok(complete.doubt_price < inProg.doubt_price);
  });

  it('produces a 95% confidence interval', () => {
    const u = buildFlareUncertainty({ max_class: 'M2.5', max_xray_flux: 2.5e-5, status: 'complete' });
    assert.ok(u.confidence_interval_95[0] < u.value);
    assert.ok(u.confidence_interval_95[1] > u.value);
  });
});

describe('flareThresholdProbability', () => {
  it('returns high probability for flux well above threshold', () => {
    const u = buildFlareUncertainty({ max_class: 'X5.0', max_xray_flux: 5e-4, status: 'complete' });
    const prob = flareThresholdProbability(u, 'M1.0');
    assert.ok(prob > 0.95);
  });

  it('returns low probability for flux well below threshold', () => {
    const u = buildFlareUncertainty({ max_class: 'C1.0', max_xray_flux: 1e-6, status: 'complete' });
    const prob = flareThresholdProbability(u, 'X1.0');
    assert.ok(prob < 0.01);
  });
});

describe('buildKpUncertainty', () => {
  it('returns lower doubt for GFZ definitive', () => {
    const gfz = buildKpUncertainty({ kp: 5, source: 'GFZ', station_count: 10 });
    const swpc = buildKpUncertainty({ kp: 5, station_count: 10 });
    assert.ok(gfz.doubt_price < swpc.doubt_price);
  });
});

describe('kpThresholdProbability', () => {
  it('returns high probability for Kp well above threshold', () => {
    const u = buildKpUncertainty({ kp: 8, station_count: 10 });
    const prob = kpThresholdProbability(u, 5);
    assert.ok(prob > 0.95);
  });

  it('returns low probability for Kp well below threshold', () => {
    const u = buildKpUncertainty({ kp: 2, station_count: 10 });
    const prob = kpThresholdProbability(u, 7);
    assert.ok(prob < 0.1);
  });
});

// =========================================================================
// Settlement logic
// =========================================================================

describe('assessSettlement', () => {
  it('returns ground_truth for DONKI-confirmed flares', () => {
    const event = makeDonkiFlareEvent();
    const quality = computeQuality(event);
    const result = assessSettlement(event, quality);
    assert.equal(result.evidence_class, 'ground_truth');
    assert.equal(result.resolution_eligible, true);
  });

  it('returns provisional for in-progress flares', () => {
    const event = makeFlareEvent({ status: 'eventInProgress' });
    const quality = computeQuality(event);
    const result = assessSettlement(event, quality);
    assert.equal(result.evidence_class, 'provisional');
    assert.equal(result.resolution_eligible, false);
  });

  it('returns provisional_mature for old complete flares', () => {
    const event = makeFlareEvent({
      status: 'complete',
      begin_time: Date.now() - 10800_000, // 3h ago
    });
    const quality = computeQuality(event);
    const result = assessSettlement(event, quality);
    assert.equal(result.evidence_class, 'provisional_mature');
  });
});

// =========================================================================
// Bundle building
// =========================================================================

describe('buildBundle', () => {
  it('returns null for missing data', () => {
    assert.equal(buildBundle({ type: null, data: null }), null);
  });

  it('returns null for flare without begin_time', () => {
    const event = makeFlareEvent({ begin_time: null });
    assert.equal(buildBundle(event), null);
  });

  it('builds a valid flare bundle', () => {
    const bundle = buildBundle(makeFlareEvent());
    assert.ok(bundle);
    assert.equal(bundle.construct, 'CORONA');
    assert.equal(bundle.source, 'SWPC_GOES');
    assert.ok(bundle.bundle_id.startsWith('corona-'));
    assert.ok(bundle.payload.quality.composite > 0);
  });

  it('builds a valid Kp bundle', () => {
    const bundle = buildBundle(makeKpEvent());
    assert.ok(bundle);
    assert.equal(bundle.payload.event_type, 'kp_index');
    assert.equal(bundle.payload.kp.value, 4);
  });

  it('builds a valid solar wind bundle', () => {
    const bundle = buildBundle(makeSolarWindEvent());
    assert.ok(bundle);
    assert.equal(bundle.payload.event_type, 'solar_wind');
    assert.ok(bundle.payload.indicators);
  });
});

// =========================================================================
// Brier scoring
// =========================================================================

describe('brierScoreBinary', () => {
  it('returns 0 for perfect forecast', () => {
    assert.equal(brierScoreBinary(1.0, true), 0);
    assert.equal(brierScoreBinary(0.0, false), 0);
  });

  it('returns 1 for worst forecast', () => {
    assert.equal(brierScoreBinary(0.0, true), 1);
    assert.equal(brierScoreBinary(1.0, false), 1);
  });

  it('returns 0.25 for coin flip', () => {
    assert.equal(brierScoreBinary(0.5, true), 0.25);
  });
});

describe('brierScoreMultiClass', () => {
  it('returns 0 for perfect multi-class forecast', () => {
    const score = brierScoreMultiClass([0, 0, 1, 0, 0], 2);
    assert.equal(score, 0);
  });
});

describe('calibrationBucket', () => {
  it('assigns correct buckets', () => {
    assert.equal(calibrationBucket(0.15), '0.1-0.2');
    assert.equal(calibrationBucket(0.73), '0.7-0.8');
    assert.equal(calibrationBucket(0.0), '0.0-0.1');
  });

  it('handles array (multi-class) input', () => {
    const bucket = calibrationBucket([0.1, 0.6, 0.2, 0.05, 0.05]);
    assert.equal(bucket, '0.6-0.7');
  });
});

// =========================================================================
// Theatre: Flare Class Gate
// =========================================================================

describe('Flare Class Gate', () => {
  it('creates a theatre with correct structure', () => {
    const t = createFlareClassGate({
      threshold_class: 'M1.0',
      window_hours: 24,
      base_rate: 0.15,
    });
    assert.equal(t.template, 'flare_class_gate');
    assert.equal(t.state, 'open');
    assert.equal(t.current_position, 0.15);
    assert.equal(t.position_history.length, 1);
  });

  it('resolves YES on confirmed threshold-crossing flare', () => {
    const t = createFlareClassGate({
      threshold_class: 'M1.0',
      window_hours: 24,
    });

    const bundle = buildBundle(makeDonkiFlareEvent({ class_type: 'X1.5' }));
    const updated = processFlareClassGate(t, bundle);
    assert.equal(updated.state, 'resolved');
    assert.equal(updated.outcome, true);
    assert.equal(updated.current_position, 1.0);
  });

  it('updates position on provisional sub-threshold activity', () => {
    const t = createFlareClassGate({
      threshold_class: 'X1.0',
      window_hours: 24,
      base_rate: 0.05,
    });

    const bundle = buildBundle(makeFlareEvent({ max_class: 'M5.0', status: 'complete' }));
    const updated = processFlareClassGate(t, bundle);
    // Position should have moved but not resolved
    assert.equal(updated.state, 'open');
    assert.ok(updated.current_position !== t.current_position);
  });

  it('expires as NO when time runs out', () => {
    const t = createFlareClassGate({
      threshold_class: 'X10.0',
      window_hours: 1,
    });

    const expired = expireFlareClassGate(t);
    assert.equal(expired.state, 'resolved');
    assert.equal(expired.outcome, false);
  });
});

// =========================================================================
// Theatre: Geomagnetic Storm Gate
// =========================================================================

describe('Geomagnetic Storm Gate', () => {
  it('creates with G-scale mapping', () => {
    const t = createGeomagneticStormGate({
      kp_threshold: 5,
      window_hours: 72,
      base_rate: 0.10,
    });
    assert.equal(t.template, 'geomagnetic_storm_gate');
    assert.equal(t.g_scale.label, 'G1');
    assert.equal(t.current_position, 0.10);
  });

  it('resolves YES when Kp crosses threshold', () => {
    const t = createGeomagneticStormGate({
      kp_threshold: 5,
      window_hours: 72,
    });

    const bundle = buildBundle(makeKpEvent({
      kp: 6,
      time: Date.now() - 25200_000, // 7h ago (past update cycle)
    }));
    // Force evidence class for test
    bundle.evidence_class = 'provisional_mature';

    const updated = processGeomagneticStormGate(t, bundle);
    assert.equal(updated.state, 'provisional_hold');
    assert.equal(updated.outcome, true);
  });

  it('updates position on solar wind storm conditions', () => {
    const t = createGeomagneticStormGate({
      kp_threshold: 5,
      window_hours: 72,
      base_rate: 0.10,
    });

    const bundle = buildBundle(makeSolarWindEvent({
      mag: { bz_gsm: -15, bt: 20, bx_gsm: 3, by_gsm: -5 },
      plasma: { speed: 550, density: 15, temperature: 300000 },
    }));

    const updated = processGeomagneticStormGate(t, bundle);
    assert.ok(updated.current_position > t.current_position);
  });

  it('expires as NO when quiet', () => {
    const t = createGeomagneticStormGate({
      kp_threshold: 7,
      window_hours: 24,
    });

    const expired = expireGeomagneticStormGate(t);
    assert.equal(expired.state, 'resolved');
    assert.equal(expired.outcome, false);
  });
});

// =========================================================================
// Theatre: CME Arrival
// =========================================================================

describe('CME Arrival', () => {
  function makeCMEBundle() {
    return buildBundle({
      type: 'donki_cme',
      data: {
        activity_id: '2026-03-15T13:00:00-CME-001',
        start_time: Date.now() - 86400_000,
        source_location: { latitude: 15, longitude: 33 },
        active_region: 4392,
        instruments: ['SOHO: LASCO/C2'],
        analysis: {
          speed: 1200,
          half_angle: 45,
          type: 'S',
          is_most_accurate: true,
        },
        earth_arrival: {
          estimated_arrival: Date.now() + 86400_000, // +24h from now
          is_glancing_blow: false,
          kp_18: 7,
          kp_90: 6,
        },
        linked_events: [],
      },
      polledAt: Date.now(),
    });
  }

  it('creates theatre for Earth-directed CME', () => {
    const cmeBundle = makeCMEBundle();
    const t = createCMEArrival({ cmeBundle });
    assert.ok(t);
    assert.equal(t.template, 'cme_arrival');
    assert.ok(t.current_position > 0);
    assert.ok(t.current_position < 1);
  });

  it('returns null for CME without Earth arrival', () => {
    const bundle = buildBundle({
      type: 'donki_cme',
      data: {
        activity_id: 'test',
        start_time: Date.now(),
        earth_arrival: null,
      },
      polledAt: Date.now(),
    });
    const t = createCMEArrival({ cmeBundle: bundle });
    assert.equal(t, null);
  });

  it('expires with outcome based on arrival detection', () => {
    const cmeBundle = makeCMEBundle();
    const t = createCMEArrival({ cmeBundle });
    const expired = expireCMEArrival(t);
    assert.equal(expired.state, 'resolved');
    assert.equal(expired.outcome, false); // No arrival detected
  });
});

// =========================================================================
// Theatre: Proton Event Cascade
// =========================================================================

describe('Proton Event Cascade', () => {
  function makeTriggerBundle() {
    return buildBundle(makeDonkiFlareEvent({ class_type: 'X2.5' }));
  }

  it('creates theatre for M5+ trigger', () => {
    const t = createProtonEventCascade({ triggerBundle: makeTriggerBundle() });
    assert.ok(t);
    assert.equal(t.template, 'proton_event_cascade');
    assert.equal(t.qualifying_event_count, 0);
    assert.equal(t.bucket_labels.length, 5);
    assert.ok(t.productivity.expected_count > 0);
    // Probabilities sum to ~1
    const sum = t.current_position.reduce((s, p) => s + p, 0);
    assert.ok(Math.abs(sum - 1) < 0.01, `Probabilities sum to ${sum}`);
  });

  it('returns null for C-class trigger', () => {
    const weakBundle = buildBundle(makeFlareEvent({ max_class: 'C5.0' }));
    const t = createProtonEventCascade({ triggerBundle: weakBundle });
    assert.equal(t, null);
  });

  it('increments count on qualifying events', () => {
    const t = createProtonEventCascade({ triggerBundle: makeTriggerBundle() });
    const afterFlare = buildBundle(makeDonkiFlareEvent({ class_type: 'M2.0' }));
    const updated = processProtonEventCascade(t, afterFlare);
    assert.equal(updated.qualifying_event_count, 1);
  });

  it('does not count sub-threshold events', () => {
    const t = createProtonEventCascade({ triggerBundle: makeTriggerBundle() });
    const weak = buildBundle(makeFlareEvent({ max_class: 'C5.0' }));
    const updated = processProtonEventCascade(t, weak);
    assert.equal(updated.qualifying_event_count, 0);
  });

  it('resolves to bucket on expiry', () => {
    const t = createProtonEventCascade({ triggerBundle: makeTriggerBundle() });
    const resolved = resolveProtonEventCascade(t);
    assert.equal(resolved.state, 'resolved');
    assert.equal(resolved.outcome, 0); // 0 events → bucket 0
  });
});

// =========================================================================
// Theatre: Solar Wind Divergence
// =========================================================================

describe('Solar Wind Divergence', () => {
  it('creates theatre with correct structure', () => {
    const t = createSolarWindDivergence({
      bz_divergence_threshold: 5,
      sustained_minutes: 30,
      window_hours: 24,
    });
    assert.equal(t.template, 'solar_wind_divergence');
    assert.equal(t.state, 'open');
  });

  it('expires as NO when no sustained divergence', () => {
    const t = createSolarWindDivergence({
      bz_divergence_threshold: 5,
      sustained_minutes: 30,
      window_hours: 24,
    });
    const expired = expireSolarWindDivergence(t);
    assert.equal(expired.state, 'resolved');
    assert.equal(expired.outcome, false);
  });
});

// =========================================================================
// RLMF Certificate export
// =========================================================================

describe('exportCertificate', () => {
  it('exports valid certificate from resolved binary theatre', () => {
    const t = createFlareClassGate({
      threshold_class: 'X1.0',
      window_hours: 24,
      base_rate: 0.05,
    });
    const expired = expireFlareClassGate(t);
    const cert = exportCertificate(expired);

    assert.ok(cert.certificate_id);
    assert.equal(cert.construct, 'CORONA');
    assert.equal(cert.theatre.outcome, false);
    assert.ok(cert.performance.brier_score >= 0);
    assert.ok(cert.performance.brier_score <= 1);
    assert.ok(cert.performance.calibration_bucket);
    assert.ok(cert.temporal.volatility >= 0);
  });

  it('exports valid certificate from multi-class theatre', () => {
    const trigger = buildBundle(makeDonkiFlareEvent({ class_type: 'X2.5' }));
    const t = createProtonEventCascade({ triggerBundle: trigger });
    const resolved = resolveProtonEventCascade(t);
    const cert = exportCertificate(resolved);

    assert.ok(cert.certificate_id);
    assert.equal(cert.construct, 'CORONA');
    assert.equal(typeof cert.theatre.outcome, 'number');
    assert.ok(cert.performance.brier_score >= 0);
  });

  it('throws for unresolved theatres', () => {
    const t = createFlareClassGate({
      threshold_class: 'M1.0',
      window_hours: 24,
    });
    assert.throws(() => exportCertificate(t));
  });
});
