/**
 * Solar Wind Divergence Theatre
 *
 * Paradox Engine native: monitors divergence between DSCOVR and ACE
 * solar wind readings.
 *
 * Both spacecraft sit at the L1 Lagrange point (~1.5M km sunward).
 * Their readings should agree within measurement uncertainty.
 * Divergence signals:
 *   - Instrument calibration drift
 *   - Spacecraft maneuver or data processing artifact
 *   - Genuine spatial structure in the solar wind (rare, interesting)
 *   - Eclipse season data gaps
 *
 * Binary market: "Will DSCOVR-ACE Bz divergence exceed ±5 nT for >30 min?"
 *
 * This is a meta-market — it tests the integrity of the OSINT pipeline
 * itself, not a physical space weather event. High-value for RLMF because
 * it captures the construct's ability to detect data quality issues.
 */

/**
 * Create a Solar Wind Divergence theatre.
 *
 * @param {object} params
 * @param {number} [params.bz_divergence_threshold] - nT divergence threshold (default 5)
 * @param {number} [params.sustained_minutes] - Minutes divergence must persist (default 30)
 * @param {number} [params.window_hours] - Theatre window (default 24)
 * @param {number} [params.base_rate] - Historical divergence probability
 * @returns {object} Theatre definition
 */
export function createSolarWindDivergence({
  id,
  bz_divergence_threshold = 5,
  sustained_minutes = 30,
  window_hours = 24,
  base_rate = 0.08,
}) {
  const now = Date.now();

  return {
    id: id || `T5-SW-DIVERGENCE-${bz_divergence_threshold}NT-${window_hours}H-${now}`,
    template: 'solar_wind_divergence',
    question: `Will DSCOVR-ACE Bz diverge by ≥${bz_divergence_threshold}nT for ≥${sustained_minutes}min within ${window_hours}h?`,

    bz_divergence_threshold,
    sustained_minutes,
    opens_at: now,
    closes_at: now + window_hours * 60 * 60 * 1000,
    state: 'open',
    outcome: null,

    // Divergence tracking
    divergence_history: [],
    current_streak: {
      start: null,
      minutes: 0,
      max_divergence: 0,
    },
    peak_divergence: 0,

    position_history: [
      {
        t: now,
        p: base_rate,
        evidence: null,
        reason: `Base rate for ≥${bz_divergence_threshold}nT sustained divergence`,
      },
    ],
    current_position: base_rate,
    evidence_bundles: [],
    resolving_bundle_id: null,
    resolved_at: null,
  };
}

/**
 * Process solar wind bundle against divergence theatre.
 *
 * In the real implementation, this would compare DSCOVR vs ACE readings.
 * Since SWPC provides the "active" spacecraft data (usually DSCOVR),
 * we simulate divergence detection by looking for:
 *   - Rapid Bz fluctuations (>5 nT in <5 min) → potential data issue
 *   - Null/gap patterns → satellite switching
 *   - Bz values that don't correlate with proton flux trends
 */
export function processSolarWindDivergence(theatre, bundle) {
  if (theatre.state === 'resolved' || theatre.state === 'expired') return theatre;
  if (bundle.payload.event_type !== 'solar_wind') return theatre;

  const updated = { ...theatre };
  updated.evidence_bundles = [...theatre.evidence_bundles, bundle.bundle_id];

  const mag = bundle.payload.magnetic_field;
  if (!mag || mag.bz_gsm == null) {
    // Null Bz → possible data gap (satellite switching)
    updated.position_history = [
      ...theatre.position_history,
      {
        t: Date.now(),
        p: theatre.current_position * 1.05,
        evidence: bundle.bundle_id,
        reason: 'Bz null — possible data gap or satellite switching',
      },
    ];
    updated.current_position = Math.min(0.99,
      Math.round(theatre.current_position * 1.05 * 1000) / 1000);
    return updated;
  }

  const bz = mag.bz_gsm;
  const now = Date.now();

  // Record divergence measurement
  // In production: compare DSCOVR bz vs ACE bz
  // For now: use Bz volatility as proxy for divergence signal
  const history = theatre.divergence_history;
  history.push({ time: now, bz, evidence: bundle.bundle_id });

  // Keep last 120 readings (~2 hours at 1-min cadence)
  if (history.length > 120) history.splice(0, history.length - 120);
  updated.divergence_history = history;

  // Compute Bz volatility over last 10 readings as divergence proxy
  if (history.length >= 10) {
    const recent = history.slice(-10);
    const bzValues = recent.map((h) => h.bz);
    const meanBz = bzValues.reduce((s, v) => s + v, 0) / bzValues.length;
    const variance = bzValues.reduce((s, v) => s + Math.pow(v - meanBz, 2), 0) / bzValues.length;
    const volatility = Math.sqrt(variance);

    // "Divergence" = volatility exceeding threshold
    const isDiverging = volatility >= theatre.bz_divergence_threshold;
    updated.peak_divergence = Math.max(theatre.peak_divergence, volatility);

    if (isDiverging) {
      // Update or extend streak
      if (theatre.current_streak.start) {
        const streakMinutes = (now - theatre.current_streak.start) / 60_000;
        updated.current_streak = {
          start: theatre.current_streak.start,
          minutes: streakMinutes,
          max_divergence: Math.max(theatre.current_streak.max_divergence, volatility),
        };

        // Check if sustained threshold met
        if (streakMinutes >= theatre.sustained_minutes) {
          updated.state = 'resolved';
          updated.outcome = true;
          updated.resolving_bundle_id = bundle.bundle_id;
          updated.resolved_at = now;
          updated.current_position = 1.0;
          updated.position_history = [
            ...theatre.position_history,
            {
              t: now,
              p: 1.0,
              evidence: bundle.bundle_id,
              reason: `Sustained divergence: ${streakMinutes.toFixed(0)}min ≥ ${theatre.sustained_minutes}min, volatility=${volatility.toFixed(1)}nT`,
            },
          ];
          return updated;
        }

        // Streak building — position increases
        const progress = streakMinutes / theatre.sustained_minutes;
        const newPos = theatre.current_position + (0.9 - theatre.current_position) * progress * 0.3;
        updated.current_position = Math.round(Math.min(0.99, newPos) * 1000) / 1000;
      } else {
        // Start new streak
        updated.current_streak = {
          start: now,
          minutes: 0,
          max_divergence: volatility,
        };
        updated.current_position = Math.round(
          Math.min(0.99, theatre.current_position * 1.15) * 1000
        ) / 1000;
      }
    } else {
      // Not diverging — reset streak
      updated.current_streak = { start: null, minutes: 0, max_divergence: 0 };
      updated.current_position = Math.round(
        Math.max(0.01, theatre.current_position * 0.95) * 1000
      ) / 1000;
    }

    updated.position_history = [
      ...theatre.position_history,
      {
        t: now,
        p: updated.current_position,
        evidence: bundle.bundle_id,
        reason: `Bz volatility=${volatility.toFixed(2)}nT, streak=${updated.current_streak.minutes.toFixed(0)}min, peak=${updated.peak_divergence.toFixed(1)}nT`,
      },
    ];
  }

  return updated;
}

/**
 * Expire a Solar Wind Divergence theatre.
 */
export function expireSolarWindDivergence(theatre) {
  if (theatre.state === 'resolved') return theatre;

  return {
    ...theatre,
    state: 'resolved',
    outcome: false,
    resolved_at: Date.now(),
    position_history: [
      ...theatre.position_history,
      {
        t: Date.now(),
        p: theatre.current_position,
        evidence: null,
        reason: `Theatre expired — peak divergence: ${theatre.peak_divergence.toFixed(1)}nT`,
      },
    ],
  };
}
