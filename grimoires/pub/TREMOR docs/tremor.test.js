/**
 * TREMOR test suite.
 *
 * Uses Node.js built-in test runner (node --test).
 * No external dependencies required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeQuality } from '../src/processor/quality.js';
import { buildMagnitudeUncertainty, thresholdCrossingProbability } from '../src/processor/magnitude.js';
import { assessStatusFlip } from '../src/processor/settlement.js';
import { findRegion } from '../src/processor/regions.js';
import { buildBundle } from '../src/processor/bundles.js';
import { brierScoreBinary, brierScoreMultiClass, calibrationBucket, exportCertificate } from '../src/rlmf/certificates.js';
import { createMagnitudeGate, processMagnitudeGate, expireMagnitudeGate } from '../src/theatres/mag-gate.js';
import { createOracleDivergence, resolveOracleDivergence } from '../src/theatres/paradox.js';
import { createAftershockCascade, processAftershockCascade, resolveAftershockCascade } from '../src/theatres/aftershock.js';
import { createSwarmWatch, processSwarmWatch, expireSwarmWatch, computeBValue } from '../src/theatres/swarm.js';
import { createDepthRegime, processDepthRegime, expireDepthRegime } from '../src/theatres/depth.js';

// --- Test fixtures ---

function makeFeature(overrides = {}) {
  const defaults = {
    type: 'Feature',
    id: 'us7000test',
    properties: {
      mag: 5.2,
      place: '10km SSW of San Jose, CA',
      time: Date.now() - 3600_000, // 1 hour ago
      updated: Date.now() - 1800_000,
      tz: null,
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000test',
      detail: 'https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=us7000test&format=geojson',
      felt: 200,
      cdi: 4.2,
      mmi: 4.8,
      alert: 'green',
      status: 'automatic',
      tsunami: 0,
      sig: 432,
      net: 'us',
      code: '7000test',
      ids: ',us7000test,',
      sources: ',us,',
      types: ',origin,phase-data,',
      nst: 45,
      dmin: 0.05,
      rms: 0.18,
      gap: 55,
      magType: 'Mw',
      type: 'earthquake',
      title: 'M 5.2 - 10km SSW of San Jose, CA',
      magError: null,
      magNst: null,
      horizontalError: null,
      depthError: null,
    },
    geometry: {
      type: 'Point',
      coordinates: [-121.89, 37.34, 8.2], // San Jose area
    },
  };

  return {
    ...defaults,
    ...overrides,
    properties: { ...defaults.properties, ...overrides.properties },
    geometry: overrides.geometry ?? defaults.geometry,
  };
}

// =========================================================================
// Region detection
// =========================================================================

describe('findRegion', () => {
  it('finds US West Coast for San Jose', () => {
    const region = findRegion(-121.89, 37.34);
    assert.equal(region.name, 'US West Coast');
    assert.equal(region.density_grade, 'dense');
  });

  it('finds Japan for Tokyo', () => {
    const region = findRegion(139.69, 35.69);
    assert.equal(region.name, 'Japan');
  });

  it('returns Global Default for mid-ocean', () => {
    const region = findRegion(0, 0);
    assert.equal(region.name, 'Global Default');
    assert.equal(region.density_grade, 'sparse');
  });
});

// =========================================================================
// Quality scoring
// =========================================================================

describe('computeQuality', () => {
  it('scores reviewed events higher than automatic', () => {
    const auto = computeQuality(makeFeature({ properties: { status: 'automatic' } }));
    const reviewed = computeQuality(makeFeature({ properties: { status: 'reviewed' } }));
    assert.ok(reviewed.composite > auto.composite);
  });

  it('includes region info in output', () => {
    const q = computeQuality(makeFeature());
    assert.equal(q.region.name, 'US West Coast');
    assert.equal(q.region.density_grade, 'dense');
  });

  it('penalizes large azimuthal gaps', () => {
    const small = computeQuality(makeFeature({ properties: { gap: 20 } }));
    const large = computeQuality(makeFeature({ properties: { gap: 200 } }));
    assert.ok(small.composite > large.composite);
  });

  it('normalizes station count against regional baseline', () => {
    const q = computeQuality(makeFeature({ properties: { nst: 120 } }));
    // 120 stations for US West Coast (median 120) should score well
    assert.ok(q.components.station_score > 0.5);
  });
});

// =========================================================================
// Magnitude uncertainty
// =========================================================================

describe('buildMagnitudeUncertainty', () => {
  it('returns lower doubt for Mw than Md', () => {
    const mw = buildMagnitudeUncertainty(makeFeature({ properties: { magType: 'Mw' } }));
    const md = buildMagnitudeUncertainty(makeFeature({ properties: { magType: 'Md' } }));
    assert.ok(mw.doubt_price < md.doubt_price);
  });

  it('returns lower doubt for reviewed events', () => {
    const auto = buildMagnitudeUncertainty(makeFeature({ properties: { status: 'automatic' } }));
    const reviewed = buildMagnitudeUncertainty(makeFeature({ properties: { status: 'reviewed' } }));
    assert.ok(reviewed.doubt_price < auto.doubt_price);
  });

  it('produces a 95% confidence interval', () => {
    const u = buildMagnitudeUncertainty(makeFeature());
    assert.ok(u.confidence_interval_95[0] < u.value);
    assert.ok(u.confidence_interval_95[1] > u.value);
  });
});

describe('thresholdCrossingProbability', () => {
  it('returns ~1.0 for magnitude well above threshold', () => {
    const u = buildMagnitudeUncertainty(makeFeature({ properties: { mag: 6.0 } }));
    const prob = thresholdCrossingProbability(u, 5.0);
    assert.ok(prob > 0.95);
  });

  it('returns ~0.5 for magnitude at threshold', () => {
    const u = buildMagnitudeUncertainty(makeFeature({ properties: { mag: 5.0 } }));
    const prob = thresholdCrossingProbability(u, 5.0);
    assert.ok(prob > 0.3 && prob < 0.7);
  });

  it('returns low probability for magnitude well below threshold', () => {
    const u = buildMagnitudeUncertainty(makeFeature({ properties: { mag: 4.0 } }));
    const prob = thresholdCrossingProbability(u, 5.0);
    assert.ok(prob < 0.2);
  });
});

// =========================================================================
// Settlement logic
// =========================================================================

describe('assessStatusFlip', () => {
  it('returns ground_truth for reviewed events', () => {
    const feature = makeFeature({ properties: { status: 'reviewed' } });
    const quality = computeQuality(feature);
    const result = assessStatusFlip(feature, quality);
    assert.equal(result.evidence_class, 'ground_truth');
    assert.equal(result.resolution_eligible, true);
    assert.equal(result.brier_discount, 0);
  });

  it('returns provisional for fresh automatic events', () => {
    const feature = makeFeature({
      properties: { status: 'automatic', time: Date.now() - 600_000 }, // 10 min ago
    });
    const quality = computeQuality(feature);
    const result = assessStatusFlip(feature, quality);
    assert.equal(result.evidence_class, 'provisional');
    assert.equal(result.resolution_eligible, false);
  });

  it('returns provisional_mature for stable cross-validated events >2h', () => {
    const feature = makeFeature({
      properties: { status: 'automatic', time: Date.now() - 10800_000 }, // 3h ago
    });
    const quality = { composite: 0.6 };
    const result = assessStatusFlip(feature, quality, [], true);
    assert.equal(result.evidence_class, 'provisional_mature');
    assert.equal(result.brier_discount, 0.10);
  });

  it('freezes when theatre expiring but data not ready', () => {
    const feature = makeFeature({
      properties: { status: 'automatic', time: Date.now() - 600_000 },
    });
    const quality = { composite: 0.3 };
    const expiresIn30Min = Date.now() + 30 * 60 * 1000;
    const result = assessStatusFlip(feature, quality, [], false, expiresIn30Min);
    assert.equal(result.recommended_state, 'frozen');
  });
});

// =========================================================================
// Bundle building
// =========================================================================

describe('buildBundle', () => {
  it('returns null for non-earthquake events', () => {
    const feature = makeFeature({ properties: { type: 'quarry blast' } });
    assert.equal(buildBundle(feature), null);
  });

  it('returns null for null magnitude', () => {
    const feature = makeFeature({ properties: { mag: null } });
    assert.equal(buildBundle(feature), null);
  });

  it('builds a valid bundle for a normal earthquake', () => {
    const bundle = buildBundle(makeFeature());
    assert.ok(bundle);
    assert.equal(bundle.construct, 'TREMOR');
    assert.equal(bundle.source, 'USGS_NEIC');
    assert.ok(bundle.bundle_id.startsWith('tremor-usgs-'));
    assert.ok(bundle.payload.magnitude.value === 5.2);
    assert.ok(bundle.payload.quality.composite > 0);
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
    assert.equal(brierScoreBinary(0.5, false), 0.25);
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
});

// =========================================================================
// Theatre: Magnitude Gate
// =========================================================================

describe('Magnitude Gate', () => {
  it('creates a theatre with correct structure', () => {
    const t = createMagnitudeGate({
      region_name: 'Cascadia',
      region_bbox: [-130, 40, -120, 50],
      magnitude_threshold: 5.0,
      window_hours: 24,
      base_rate: 0.12,
    });
    assert.equal(t.template, 'magnitude_gate');
    assert.equal(t.state, 'open');
    assert.equal(t.current_position, 0.12);
    assert.equal(t.position_history.length, 1);
  });

  it('resolves YES on reviewed threshold-crossing event', () => {
    const t = createMagnitudeGate({
      region_name: 'Test',
      region_bbox: [-130, 30, -115, 50],
      magnitude_threshold: 5.0,
      window_hours: 24,
    });

    const bundle = buildBundle(makeFeature({ properties: { status: 'reviewed', mag: 5.5 } }));
    bundle.evidence_class = 'ground_truth';

    const updated = processMagnitudeGate(t, bundle);
    assert.equal(updated.state, 'resolved');
    assert.equal(updated.outcome, true);
    assert.equal(updated.current_position, 1.0);
  });

  it('expires as NO when time runs out', () => {
    const t = createMagnitudeGate({
      region_name: 'Test',
      region_bbox: [-130, 30, -115, 50],
      magnitude_threshold: 7.0,
      window_hours: 1,
    });

    const expired = expireMagnitudeGate(t);
    assert.equal(expired.state, 'resolved');
    assert.equal(expired.outcome, false);
  });
});

// =========================================================================
// Theatre: Oracle Divergence
// =========================================================================

describe('Oracle Divergence', () => {
  it('creates a divergence theatre for M4.5+ automatic events', () => {
    const bundle = buildBundle(makeFeature({
      properties: { mag: 5.0, status: 'automatic' },
    }));
    const t = createOracleDivergence(bundle);
    assert.ok(t);
    assert.equal(t.template, 'oracle_divergence');
    assert.equal(t.automatic_magnitude, 5.0);
  });

  it('resolves YES when reviewed magnitude diverges by ≥0.3', () => {
    const bundle = buildBundle(makeFeature({
      properties: { mag: 5.0, status: 'automatic' },
    }));
    const t = createOracleDivergence(bundle);

    const reviewedBundle = buildBundle(makeFeature({
      properties: { mag: 5.4, status: 'reviewed' },
    }));
    reviewedBundle.evidence_class = 'ground_truth';

    const resolved = resolveOracleDivergence(t, reviewedBundle);
    assert.equal(resolved.state, 'resolved');
    assert.equal(resolved.outcome, true);
    assert.equal(resolved.resolution_detail.divergence, 0.4);
  });

  it('resolves NO when reviewed magnitude is close', () => {
    const bundle = buildBundle(makeFeature({
      properties: { mag: 5.0, status: 'automatic' },
    }));
    const t = createOracleDivergence(bundle);

    const reviewedBundle = buildBundle(makeFeature({
      properties: { mag: 5.1, status: 'reviewed' },
    }));
    reviewedBundle.evidence_class = 'ground_truth';

    const resolved = resolveOracleDivergence(t, reviewedBundle);
    assert.equal(resolved.state, 'resolved');
    assert.equal(resolved.outcome, false);
  });
});

// =========================================================================
// RLMF Certificate export
// =========================================================================

describe('exportCertificate', () => {
  it('exports a valid certificate from a resolved theatre', () => {
    const t = createMagnitudeGate({
      region_name: 'Test',
      region_bbox: [-130, 30, -115, 50],
      magnitude_threshold: 5.0,
      window_hours: 24,
      base_rate: 0.15,
    });
    const expired = expireMagnitudeGate(t);
    const cert = exportCertificate(expired);

    assert.ok(cert.certificate_id);
    assert.equal(cert.construct, 'TREMOR');
    assert.equal(cert.theatre.outcome, false);
    assert.ok(cert.performance.brier_score >= 0);
    assert.ok(cert.performance.brier_score <= 1);
    assert.ok(cert.performance.calibration_bucket);
    assert.ok(cert.temporal.volatility >= 0);
  });

  it('throws for unresolved theatres', () => {
    const t = createMagnitudeGate({
      region_name: 'Test',
      region_bbox: [-130, 30, -115, 50],
      magnitude_threshold: 5.0,
      window_hours: 24,
    });
    assert.throws(() => exportCertificate(t));
  });
});

// =========================================================================
// Theatre: Aftershock Cascade
// =========================================================================

describe('Aftershock Cascade', () => {
  function makeMainshockBundle() {
    const bundle = buildBundle(makeFeature({
      properties: { mag: 6.5, status: 'reviewed', magType: 'Mw' },
      geometry: { type: 'Point', coordinates: [-121.89, 37.34, 12] },
    }));
    bundle.evidence_class = 'ground_truth';
    return bundle;
  }

  it('creates a theatre for M≥6.0 mainshocks', () => {
    const t = createAftershockCascade({ mainshockBundle: makeMainshockBundle() });
    assert.ok(t);
    assert.equal(t.template, 'aftershock_cascade');
    assert.equal(t.aftershock_count, 0);
    assert.equal(t.bucket_labels.length, 5);
    assert.ok(t.omori.expected_count > 0);
    // Probabilities should sum to ~1
    const sum = t.current_position.reduce((s, p) => s + p, 0);
    assert.ok(Math.abs(sum - 1) < 0.01, `Probabilities sum to ${sum}, expected ~1`);
  });

  it('returns null for M<6.0 events', () => {
    const smallBundle = buildBundle(makeFeature({ properties: { mag: 5.5 } }));
    const t = createAftershockCascade({ mainshockBundle: smallBundle });
    assert.equal(t, null);
  });

  it('increments aftershock count on threshold-crossing events', () => {
    const t = createAftershockCascade({ mainshockBundle: makeMainshockBundle() });
    const aftershock = buildBundle(makeFeature({
      properties: { mag: 4.5, status: 'reviewed' },
    }));
    aftershock.evidence_class = 'ground_truth';

    const updated = processAftershockCascade(t, aftershock);
    assert.equal(updated.aftershock_count, 1);
    assert.equal(updated.aftershock_events.length, 1);
  });

  it('does not count sub-threshold events', () => {
    const t = createAftershockCascade({ mainshockBundle: makeMainshockBundle() });
    const small = buildBundle(makeFeature({ properties: { mag: 3.0 } }));

    const updated = processAftershockCascade(t, small);
    assert.equal(updated.aftershock_count, 0);
  });

  it('resolves to a bucket on expiry', () => {
    const t = createAftershockCascade({ mainshockBundle: makeMainshockBundle() });
    const resolved = resolveAftershockCascade(t);
    assert.equal(resolved.state, 'resolved');
    assert.equal(resolved.outcome, 0); // 0 aftershocks → bucket 0 ("0-2")
  });
});

// =========================================================================
// Theatre: Swarm Watch
// =========================================================================

describe('Swarm Watch', () => {
  it('creates a theatre with b-value computation', () => {
    const t = createSwarmWatch({
      zone_name: 'Salton Sea',
      centroid: [-115.6, 33.2],
      radius_km: 50,
      magnitude_threshold: 5.0,
      seed_magnitudes: [2.1, 2.5, 3.0, 2.8, 2.2, 2.6, 2.3, 2.7, 2.9, 3.1, 2.4, 2.0],
    });
    assert.ok(t);
    assert.equal(t.template, 'swarm_watch');
    assert.ok(t.current_position > 0);
    assert.ok(t.current_position < 1);
    assert.ok(t.b_value.current !== null);
  });

  it('resolves YES when threshold is crossed', () => {
    const t = createSwarmWatch({
      zone_name: 'Test Zone',
      centroid: [-121, 37],
      radius_km: 50,
      magnitude_threshold: 5.0,
      seed_magnitudes: [2.5, 3.0, 2.8, 2.2, 2.6, 2.3, 2.7, 2.9, 3.1, 2.4],
    });

    const bigBundle = buildBundle(makeFeature({
      properties: { mag: 5.2, status: 'reviewed' },
    }));
    bigBundle.evidence_class = 'ground_truth';

    const updated = processSwarmWatch(t, bigBundle);
    assert.equal(updated.state, 'resolved');
    assert.equal(updated.outcome, true);
  });

  it('expires as NO when swarm dissipates', () => {
    const t = createSwarmWatch({
      zone_name: 'Test',
      centroid: [-121, 37],
      radius_km: 50,
      magnitude_threshold: 5.0,
      seed_magnitudes: [2.5, 3.0, 2.8, 2.2, 2.6, 2.3, 2.7, 2.9, 3.1, 2.4],
    });

    const expired = expireSwarmWatch(t);
    assert.equal(expired.state, 'resolved');
    assert.equal(expired.outcome, false);
  });
});

describe('computeBValue', () => {
  it('returns ~1.0 for typical GR distribution', () => {
    // Synthetic catalog following GR with b≈1.0
    const mags = [];
    for (let m = 2.0; m <= 5.0; m += 0.1) {
      const count = Math.round(Math.pow(10, 5 - m));
      for (let i = 0; i < Math.min(count, 50); i++) mags.push(m);
    }
    const b = computeBValue(mags, 2.0);
    assert.ok(b !== null);
    assert.ok(b > 0.5 && b < 2.0, `b=${b}, expected near 1.0`);
  });

  it('returns null for too few events', () => {
    assert.equal(computeBValue([3.0, 3.5, 4.0], 2.0), null);
  });
});

// =========================================================================
// Theatre: Depth Regime
// =========================================================================

describe('Depth Regime', () => {
  it('creates a theatre with zone-specific prior', () => {
    const t = createDepthRegime({ zone_id: 'tonga_kermadec' });
    assert.ok(t);
    assert.equal(t.template, 'depth_regime');
    // Tonga-Kermadec is mostly deep → P(shallow) should be low
    assert.ok(t.current_position < 0.5, `P(shallow)=${t.current_position} for Tonga, expected <0.5`);
  });

  it('returns null for unknown zones', () => {
    const t = createDepthRegime({ zone_id: 'nonexistent' });
    assert.equal(t, null);
  });

  it('resolves SHALLOW for reviewed shallow event', () => {
    const t = createDepthRegime({ zone_id: 'cascadia' });
    const bundle = buildBundle(makeFeature({
      properties: { mag: 6.0, status: 'reviewed' },
      geometry: { type: 'Point', coordinates: [-125, 45, 15] }, // 15km = shallow
    }));
    bundle.evidence_class = 'ground_truth';

    const updated = processDepthRegime(t, bundle);
    assert.equal(updated.state, 'resolved');
    assert.equal(updated.outcome, true); // true = shallow
  });

  it('resolves DEEP for reviewed deep event', () => {
    const t = createDepthRegime({ zone_id: 'japan_trench' });
    const bundle = buildBundle(makeFeature({
      properties: { mag: 5.8, status: 'reviewed' },
      geometry: { type: 'Point', coordinates: [143, 38, 150] }, // 150km = deep
    }));
    bundle.evidence_class = 'ground_truth';

    const updated = processDepthRegime(t, bundle);
    assert.equal(updated.state, 'resolved');
    assert.equal(updated.outcome, false); // false = deep
  });

  it('expires with null outcome when no qualifying event', () => {
    const t = createDepthRegime({ zone_id: 'cascadia' });
    const expired = expireDepthRegime(t);
    assert.equal(expired.state, 'expired');
    assert.equal(expired.outcome, null);
  });
});
