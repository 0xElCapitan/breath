/**
 * Proton Event Cascade Theatre
 *
 * Multi-class market: "Given X-class flare at T₀, how many R1+ radio
 * blackouts in 72 hours?"
 *
 * Buckets: 0-1, 2-3, 4-6, 7-10, 11+
 *
 * This is the solar equivalent of TREMOR's Aftershock Cascade.
 * After a major flare, an active region often produces additional
 * flares and proton events in a cascade pattern.
 *
 * The key prior model is the Wheatland (2001) waiting-time distribution
 * for solar flares, which follows a piecewise power law similar to
 * the Omori law for aftershocks.
 *
 * R-scale (NOAA Radio Blackout Scale):
 *   R1: M1+ flare (Minor)
 *   R2: M5+ flare (Moderate)
 *   R3: X1+ flare (Strong)
 *   R4: X10+ flare (Severe)
 *   R5: X20+ flare (Extreme)
 */

import { flareRank } from '../oracles/swpc.js';

const BUCKETS = [
  { label: '0-1',  min: 0,  max: 1 },
  { label: '2-3',  min: 2,  max: 3 },
  { label: '4-6',  min: 4,  max: 6 },
  { label: '7-10', min: 7,  max: 10 },
  { label: '11+',  min: 11, max: Infinity },
];

/**
 * R-scale threshold for counting qualifying events.
 * R1 = M1.0 flare, R2 = M5.0, R3 = X1.0
 */
const R_SCALE_THRESHOLDS = {
  R1: 'M1.0',
  R2: 'M5.0',
  R3: 'X1.0',
};

/**
 * Active region productivity parameters.
 *
 * After a large flare, an active region's flare rate follows
 * a modified Wheatland waiting-time distribution.
 *
 * Parameters by McIntosh classification complexity:
 *   - Simple (alpha/beta): lower productivity
 *   - Complex (beta-gamma-delta): higher productivity
 *
 * Since we often don't have McIntosh class in real-time,
 * we estimate from the triggering flare's class.
 */
const PRODUCTIVITY_PARAMS = {
  X_class: { lambda: 8,  decay: 0.85 },  // X-class trigger → very productive
  M_class: { lambda: 4,  decay: 0.90 },  // M-class trigger
  default: { lambda: 3,  decay: 0.92 },
};

/**
 * Estimate expected R1+ event count from productivity model.
 *
 * @param {string} triggerClass - Flare class of triggering event (e.g. "X2.5")
 * @param {number} windowHours - Prediction window
 * @returns {number} Expected count of R1+ events
 */
function estimateExpectedCount(triggerClass, windowHours) {
  const letter = (triggerClass ?? 'M1.0')[0].toUpperCase();
  const params = letter === 'X' ? PRODUCTIVITY_PARAMS.X_class :
    letter === 'M' ? PRODUCTIVITY_PARAMS.M_class :
    PRODUCTIVITY_PARAMS.default;

  // Flare number within class affects productivity
  const number = parseFloat((triggerClass ?? 'M1.0').slice(1)) || 1;
  const intensityMultiplier = letter === 'X' ? (1 + number * 0.15) : (1 + number * 0.05);

  // Integrate decaying rate: N(T) = lambda * (1 - decay^(T/24)) / (1 - decay)
  const days = windowHours / 24;
  const expectedN = params.lambda * intensityMultiplier *
    (1 - Math.pow(params.decay, days)) / (1 - params.decay);

  return Math.max(0, expectedN);
}

/**
 * Convert expected count to bucket probabilities using Poisson distribution.
 */
function countToBucketProbabilities(expectedCount) {
  const probs = BUCKETS.map(({ min, max }) => {
    let p = 0;
    const upper = Math.min(max, 40);
    for (let k = min; k <= upper; k++) {
      p += poissonPMF(expectedCount, k);
    }
    if (max === Infinity) {
      let tailP = 0;
      for (let k = 0; k < min; k++) {
        tailP += poissonPMF(expectedCount, k);
      }
      p = Math.max(p, 1 - tailP);
    }
    return p;
  });

  const total = probs.reduce((s, p) => s + p, 0);
  return probs.map((p) => Math.round((p / total) * 1000) / 1000);
}

function poissonPMF(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  const logP = k * Math.log(lambda) - lambda - logFactorial(k);
  return Math.exp(logP);
}

function logFactorial(n) {
  if (n <= 1) return 0;
  let sum = 0;
  for (let i = 2; i <= n; i++) sum += Math.log(i);
  return sum;
}

// =========================================================================
// Theatre lifecycle
// =========================================================================

/**
 * Create a Proton Event Cascade theatre.
 *
 * @param {object} params
 * @param {object} params.triggerBundle - Evidence bundle for the triggering flare
 * @param {string} [params.r_scale_threshold] - Minimum R-scale for counting (default R1)
 * @param {number} [params.window_hours] - Prediction window (default 72)
 * @returns {object|null} Theatre definition
 */
export function createProtonEventCascade({
  triggerBundle,
  r_scale_threshold = 'R1',
  window_hours = 72,
}) {
  const flare = triggerBundle.payload.flare;
  if (!flare) return null;

  // Require M5+ trigger to open a cascade theatre
  const triggerRank = flare.rank;
  if (triggerRank < flareRank('M5.0')) return null;

  const now = Date.now();
  const countThreshold = R_SCALE_THRESHOLDS[r_scale_threshold] ?? 'M1.0';
  const expectedCount = estimateExpectedCount(flare.class_string, window_hours);
  const initialProbs = countToBucketProbabilities(expectedCount);

  return {
    id: `T4-PROTON-CASCADE-${triggerBundle.payload.event_id}-${now}`,
    template: 'proton_event_cascade',
    question: `${flare.class_string} trigger: how many ${r_scale_threshold}+ blackouts within ${window_hours}h?`,

    trigger: {
      event_id: triggerBundle.payload.event_id,
      class_string: flare.class_string,
      rank: triggerRank,
      time: triggerBundle.payload.timing?.begin ?? now,
      active_region: triggerBundle.payload.active_region ?? null,
    },

    r_scale_threshold,
    count_threshold_class: countThreshold,
    count_threshold_rank: flareRank(countThreshold),

    opens_at: now,
    closes_at: now + window_hours * 60 * 60 * 1000,
    state: 'open',
    outcome: null,

    // Productivity model
    productivity: {
      expected_count: Math.round(expectedCount * 10) / 10,
      model: 'wheatland_modified',
    },

    bucket_labels: BUCKETS.map((b) => b.label),
    current_position: initialProbs,
    qualifying_event_count: 0,
    qualifying_events: [],

    position_history: [
      {
        t: now,
        p: initialProbs,
        qualifying_count: 0,
        evidence: triggerBundle.bundle_id,
        reason: `Wheatland prior: expected ${expectedCount.toFixed(1)} ${r_scale_threshold}+ events from ${flare.class_string} trigger`,
      },
    ],
    evidence_bundles: [triggerBundle.bundle_id],
    resolving_bundle_id: null,
    resolved_at: null,
  };
}

/**
 * Process evidence against a Proton Event Cascade.
 */
export function processProtonEventCascade(theatre, bundle) {
  if (theatre.state === 'resolved' || theatre.state === 'expired') return theatre;

  const updated = { ...theatre };
  updated.evidence_bundles = [...theatre.evidence_bundles, bundle.bundle_id];

  const payload = bundle.payload;

  // Only count flare events
  if (payload.event_type !== 'solar_flare') {
    // Proton flux events are informational but don't increment the count
    if (payload.event_type === 'proton_flux' && payload.proton?.above_s1) {
      updated.position_history = [
        ...theatre.position_history,
        {
          t: Date.now(),
          p: theatre.current_position,
          qualifying_count: theatre.qualifying_event_count,
          evidence: bundle.bundle_id,
          reason: `S1+ proton event detected — correlated but not counted`,
        },
      ];
    }
    return updated;
  }

  const flare = payload.flare;
  const meetsThreshold = flare.rank >= theatre.count_threshold_rank;

  if (!meetsThreshold) {
    // Sub-threshold flare — informational
    updated.position_history = [
      ...theatre.position_history,
      {
        t: Date.now(),
        p: theatre.current_position,
        qualifying_count: theatre.qualifying_event_count,
        evidence: bundle.bundle_id,
        reason: `Sub-threshold ${flare.class_string} — no count change`,
      },
    ];
    return updated;
  }

  // Qualifying event
  const newCount = theatre.qualifying_event_count + 1;
  updated.qualifying_event_count = newCount;
  updated.qualifying_events = [
    ...theatre.qualifying_events,
    {
      bundle_id: bundle.bundle_id,
      class_string: flare.class_string,
      rank: flare.rank,
      time: payload.timing?.begin ?? Date.now(),
      evidence_class: bundle.evidence_class,
    },
  ];

  // Recompute bucket probabilities
  const elapsed = (Date.now() - theatre.opens_at) / 3600_000;
  const remaining = Math.max(1, (theatre.closes_at - Date.now()) / 3600_000);
  const totalWindow = (theatre.closes_at - theatre.opens_at) / 3600_000;

  // Observed rate extrapolation with productivity decay correction
  const rate = elapsed > 0 ? newCount / elapsed : newCount;
  const projectedTotal = newCount + rate * remaining * 0.75; // decay correction

  // Blend Wheatland prior with observed projection
  const priorWeight = Math.max(0.1, 1 - (elapsed / totalWindow));
  const obsWeight = 1 - priorWeight;
  const blendedExpected =
    priorWeight * theatre.productivity.expected_count +
    obsWeight * projectedTotal;

  const newProbs = countToBucketProbabilities(blendedExpected);

  updated.current_position = newProbs;
  updated.position_history = [
    ...theatre.position_history,
    {
      t: Date.now(),
      p: newProbs,
      qualifying_count: newCount,
      evidence: bundle.bundle_id,
      reason:
        `${flare.class_string} ${theatre.r_scale_threshold}+ event #${newCount} — ` +
        `rate=${rate.toFixed(2)}/hr, projected=${projectedTotal.toFixed(1)}, ` +
        `blended=${blendedExpected.toFixed(1)} (prior_w=${priorWeight.toFixed(2)})`,
    },
  ];

  return updated;
}

/**
 * Resolve the Proton Event Cascade at theatre close.
 */
export function resolveProtonEventCascade(theatre) {
  if (theatre.state === 'resolved') return theatre;

  const count = theatre.qualifying_event_count;
  const outcomeIndex = BUCKETS.findIndex(
    ({ min, max }) => count >= min && count <= max
  );

  return {
    ...theatre,
    state: 'resolved',
    outcome: outcomeIndex >= 0 ? outcomeIndex : BUCKETS.length - 1,
    resolved_at: Date.now(),
    position_history: [
      ...theatre.position_history,
      {
        t: Date.now(),
        p: theatre.current_position,
        qualifying_count: count,
        evidence: null,
        reason: `Theatre closed — final count: ${count} → bucket "${BUCKETS[outcomeIndex >= 0 ? outcomeIndex : BUCKETS.length - 1].label}"`,
      },
    ],
  };
}

export { BUCKETS };
