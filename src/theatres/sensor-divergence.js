/**
 * T2: Sensor Divergence — Paradox Engine Native Theatre
 *
 * Self-resolving binary market: Do two PurpleAir sensors in the same region
 * report significantly different AQI for a sustained period? This pattern is
 * a Paradox Engine diagnostic signal — divergence suggests one sensor is degraded
 * or measuring a localised phenomenon not visible to its neighbour.
 *
 * Resolves entirely within PurpleAir data. No EPA AirNow involvement.
 *
 * State flow:
 *   open → resolved (YES)   (consecutive_hours_divergent >= required_hours)
 *   open → resolved (NO)    (Theatre closes without condition met)
 */

/**
 * Create a Sensor Divergence theatre.
 *
 * @param {object} params
 *   @param {string}  [params.id]
 *   @param {string}  [params.region_name='']
 *   @param {number[]} [params.region_bbox=null]
 *   @param {number}  params.sensor_a_index          - PurpleAir sensor_index for sensor A
 *   @param {number}  params.sensor_b_index          - PurpleAir sensor_index for sensor B
 *   @param {number}  [params.aqi_divergence_threshold=50]  - |AQI_A - AQI_B| must exceed this
 *   @param {number}  [params.required_hours=2]       - Consecutive readings above threshold for YES
 *   @param {number}  [params.window_hours=24]        - Total Theatre window
 *   @param {number}  [params.base_rate=0.10]
 * @returns {object} Theatre state
 */
export function createSensorDivergence({
  id,
  region_name = '',
  region_bbox = null,
  sensor_a_index,
  sensor_b_index,
  aqi_divergence_threshold = 50,
  required_hours = 2,
  window_hours = 24,
  base_rate = 0.10,
}) {
  const now = Date.now();
  const theatreId = id || `T2-${sensor_a_index}v${sensor_b_index}-${now}`;
  return {
    id: theatreId,
    template: 'sensor_divergence',
    question: `Will sensors ${sensor_a_index} and ${sensor_b_index} diverge by >${aqi_divergence_threshold} AQI for ${required_hours}+ consecutive readings?`,
    region_name,
    region_bbox,
    sensor_a_index,
    sensor_b_index,
    aqi_divergence_threshold,
    required_hours,
    window_hours,
    opens_at:    now,
    closes_at:   now + window_hours * 3_600_000,
    state:       'open',
    outcome:     null,
    position_history: [{
      t:        now,
      p:        base_rate,
      evidence: null,
      reason:   `Base rate: P(sensors ${sensor_a_index} vs ${sensor_b_index} diverge >${aqi_divergence_threshold} for ${required_hours} consecutive readings)`,
    }],
    current_position:          base_rate,
    evidence_bundles:          [],
    resolving_bundle_id:       null,
    resolved_at:               null,
    divergence_window:         [],
    consecutive_hours_divergent: 0,
    _last_aqi_a:               undefined,
    _last_aqi_b:               undefined,
  };
}

/**
 * Process an evidence bundle against a Sensor Divergence theatre.
 *
 * Only bundles from sensor_a or sensor_b are processed. A divergence window
 * entry is computed whenever both sensors have been seen. Position is
 * updated smoothly as divergent readings accumulate.
 *
 * @param {object} theatre
 * @param {object} bundle
 * @returns {object} Updated theatre state
 */
export function processSensorDivergence(theatre, bundle) {
  if (theatre.state === 'resolved') return theatre;

  const sensorId = bundle.payload?.location?.sensor_id;
  if (sensorId !== theatre.sensor_a_index && sensorId !== theatre.sensor_b_index) {
    return theatre;
  }

  const updated = { ...theatre };
  updated.evidence_bundles = [...theatre.evidence_bundles, bundle.bundle_id];

  const aqi = bundle.payload?.aqi?.value ?? 0;

  // Update the reading for this sensor
  if (sensorId === theatre.sensor_a_index) {
    updated._last_aqi_a = aqi;
  } else {
    updated._last_aqi_b = aqi;
  }

  // Cannot compute divergence until both sensors have reported at least once
  if (updated._last_aqi_a === undefined || updated._last_aqi_b === undefined) {
    return updated;
  }

  const aqiA = updated._last_aqi_a;
  const aqiB = updated._last_aqi_b;
  const diff = Math.abs(aqiA - aqiB);
  const exceeded = diff > theatre.aqi_divergence_threshold;

  updated.divergence_window = [...theatre.divergence_window, {
    t: Date.now(), aqi_a: aqiA, aqi_b: aqiB, diff, exceeded,
  }];

  // Consecutive counter: increments on exceeded, resets on non-exceeded
  updated.consecutive_hours_divergent = exceeded
    ? theatre.consecutive_hours_divergent + 1
    : 0;

  // Position: fraction of required_hours window that have exceeded (smooth 0→1)
  const recentExceeded = updated.divergence_window
    .slice(-updated.required_hours)
    .filter(e => e.exceeded).length;

  const resolving = updated.consecutive_hours_divergent >= updated.required_hours;
  updated.current_position = resolving
    ? 1.0
    : Math.max(0.01, Math.min(0.99, recentExceeded / updated.required_hours));

  updated.position_history = [...theatre.position_history, {
    t:        Date.now(),
    p:        updated.current_position,
    evidence: bundle.bundle_id,
    reason:   `Sensor ${theatre.sensor_a_index}:${aqiA} vs ${theatre.sensor_b_index}:${aqiB} (diff=${diff}, exceeded=${exceeded}, consecutive=${updated.consecutive_hours_divergent})`,
  }];

  if (resolving) {
    updated.state               = 'resolved';
    updated.outcome             = true;
    updated.resolving_bundle_id = bundle.bundle_id;
    updated.resolved_at         = Date.now();
  }

  return updated;
}

/**
 * Expire a Sensor Divergence theatre at window close without meeting the condition.
 *
 * Called by the BreathConstruct lifecycle loop when closes_at is reached and the
 * theatre is still open. Resolves with outcome: false.
 *
 * @param {object} theatre
 * @returns {object} Updated theatre state
 */
export function expireSensorDivergence(theatre) {
  if (theatre.state === 'resolved') return theatre;
  const now = Date.now();
  return {
    ...theatre,
    state:       'resolved',
    outcome:     false,
    resolved_at: now,
    position_history: [...theatre.position_history, {
      t:        now,
      p:        theatre.current_position,
      evidence: null,
      reason:   `Theatre expired — divergence condition not met (consecutive=${theatre.consecutive_hours_divergent}/${theatre.required_hours})`,
    }],
  };
}
