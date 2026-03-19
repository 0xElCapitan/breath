/**
 * T3: Wildfire Cascade — Multi-class Theatre
 *
 * Analogous to TREMOR's Aftershock Cascade. Tracks what fraction of PurpleAir
 * sensors in a downwind region exceed AQI 200 (Very Unhealthy) as wildfire
 * smoke arrives. Markets resolve into one of five buckets.
 *
 * The sensor set is frozen at Theatre creation time — late-arriving sensors do
 * not affect the tracked cohort. This ensures consistent denominator across
 * the Theatre's lifecycle.
 *
 * State flow:
 *   open → resolved   (at closes_at via resolveWildfireCascade)
 */

/**
 * Five cascade buckets: what fraction of sensors exceed AQI 200?
 *
 * Bucket ranges are half-open [low, high). The final bucket uses 1.01
 * to include the 100% case (pct_exceeded = 1.0).
 */
export const WILDFIRE_BUCKETS = [
  { index: 0, label: '0–10%',  range: [0,    0.10] },
  { index: 1, label: '10–30%', range: [0.10, 0.30] },
  { index: 2, label: '30–50%', range: [0.30, 0.50] },
  { index: 3, label: '50–70%', range: [0.50, 0.70] },
  { index: 4, label: '70%+',   range: [0.70, 1.01] },
];

/**
 * Find the bucket index for a percentage value.
 * Returns 4 (highest bucket) if pct is outside all ranges (e.g. exactly 1.0).
 *
 * @param {number} pct - 0.0–1.0
 * @returns {number} Bucket index 0–4
 */
function findBucketIndex(pct) {
  const idx = WILDFIRE_BUCKETS.findIndex(b => pct >= b.range[0] && pct < b.range[1]);
  return idx !== -1 ? idx : 4;
}

/**
 * Shift the observed bucket's probability by 0.15 and renormalize.
 * Always produces a valid probability distribution summing to 1.0.
 *
 * @param {number[]} probs   - Current bucket probabilities (length 5, sum ≈ 1)
 * @param {number}   pct     - Observed current_pct_exceeded (0–1)
 * @returns {number[]} Updated probabilities
 */
function updateBucketProbabilities(probs, pct) {
  const observed = findBucketIndex(pct);
  const updated = [...probs];
  updated[observed] = Math.min(1.0, updated[observed] + 0.15);
  const total = updated.reduce((a, b) => a + b, 0);
  return updated.map(p => p / total);
}

/**
 * Create a Wildfire Cascade theatre.
 *
 * @param {object} params
 *   @param {string}   [params.id]
 *   @param {string}   [params.region_name='']
 *   @param {number[]} [params.region_bbox=null]
 *   @param {string}   [params.wildfire_trigger='MANUAL']  - 'AIRNOW_FIRE_SMOKE' | 'MANUAL'
 *   @param {string}   [params.trigger_region='']          - Fire origin label
 *   @param {object}   [params.target_region]              - { name, bbox }
 *   @param {number}   [params.threshold_aqi=200]          - AQI level that counts as "exceeded"
 *   @param {number[]} params.tracked_sensors              - Array of sensor_index IDs (frozen snapshot)
 *   @param {number}   [params.window_hours=24]
 *   @param {number}   [params.base_rate=0.20]             - Used only for initial position_history entry
 * @returns {object} Theatre state
 * @throws {Error} If tracked_sensors is not an array
 */
export function createWildfireCascade({
  id,
  region_name = '',
  region_bbox = null,
  wildfire_trigger = 'MANUAL',
  trigger_region = '',
  target_region,
  threshold_aqi = 200,
  tracked_sensors,
  window_hours = 24,
  base_rate = 0.20,
}) {
  if (!Array.isArray(tracked_sensors)) {
    throw new Error('tracked_sensors must be an array of sensor_index values');
  }

  const now = Date.now();
  const effectiveRegionName = target_region?.name ?? region_name;
  const effectiveRegionBbox = target_region?.bbox ?? region_bbox;
  const theatreId = id ||
    `T3-${effectiveRegionName.replace(/\s+/g, '_').toUpperCase()}-${now}`;

  return {
    id: theatreId,
    template: 'wildfire_cascade',
    question: `What fraction of sensors in ${effectiveRegionName} will exceed AQI ${threshold_aqi}?`,
    region_name: effectiveRegionName,
    region_bbox: effectiveRegionBbox,
    wildfire_trigger,
    trigger_region,
    target_region: target_region ?? { name: region_name, bbox: region_bbox },
    threshold_aqi,
    tracked_sensors: [...tracked_sensors], // frozen at creation — new sensors don't affect this Theatre
    sensor_snapshot_time: now,
    window_hours,
    opens_at:             now,
    closes_at:            now + window_hours * 3_600_000,
    state:                'open',
    outcome:              null,
    position_history: [{
      t:                   now,
      p:                   base_rate,
      bucket_probabilities: [0.2, 0.2, 0.2, 0.2, 0.2],
      evidence:            null,
      reason:              `Base rate: uniform prior over ${WILDFIRE_BUCKETS.length} buckets`,
    }],
    current_position:     0,
    current_pct_exceeded: 0,
    bucket_probabilities: [0.2, 0.2, 0.2, 0.2, 0.2],
    evidence_bundles:     [],
    resolving_bundle_id:  null,
    resolved_at:          null,
    _sensor_readings:     {}, // sensorId → latest AQI (internal, not part of exported schema)
  };
}

/**
 * Process an evidence bundle against a Wildfire Cascade theatre.
 *
 * Only bundles from tracked sensors are processed. Updates current_pct_exceeded
 * and shifts bucket_probabilities toward the observed bucket.
 *
 * @param {object} theatre
 * @param {object} bundle
 * @returns {object} Updated theatre state
 */
export function processWildfireCascade(theatre, bundle) {
  if (theatre.state === 'resolved') return theatre;

  const sensorId = bundle.payload?.location?.sensor_id;
  if (!theatre.tracked_sensors.includes(sensorId)) return theatre;

  const updated = { ...theatre };
  updated.evidence_bundles = [...theatre.evidence_bundles, bundle.bundle_id];

  const aqi = bundle.payload?.aqi?.value ?? 0;
  updated._sensor_readings = { ...theatre._sensor_readings, [sensorId]: aqi };

  const trackedCount   = theatre.tracked_sensors.length;
  const exceededCount  = theatre.tracked_sensors
    .filter(id => (updated._sensor_readings[id] ?? 0) >= theatre.threshold_aqi)
    .length;
  updated.current_pct_exceeded = trackedCount > 0 ? exceededCount / trackedCount : 0;
  updated.current_position     = updated.current_pct_exceeded;

  updated.bucket_probabilities = updateBucketProbabilities(
    theatre.bucket_probabilities,
    updated.current_pct_exceeded,
  );

  updated.position_history = [...theatre.position_history, {
    t:                    Date.now(),
    p:                    updated.current_pct_exceeded,
    bucket_probabilities: [...updated.bucket_probabilities],
    evidence:             bundle.bundle_id,
    reason:               `${exceededCount}/${trackedCount} sensors exceed AQI ${theatre.threshold_aqi} (${Math.round(updated.current_pct_exceeded * 100)}%)`,
  }];

  return updated;
}

/**
 * Resolve a Wildfire Cascade theatre at closes_at.
 *
 * Computes the final outcome bucket from current_pct_exceeded.
 *
 * @param {object} theatre
 * @returns {object} Resolved theatre with integer outcome 0–4
 */
export function resolveWildfireCascade(theatre) {
  if (theatre.state === 'resolved') return theatre;

  const pct     = theatre.current_pct_exceeded;
  const outcome = findBucketIndex(pct);
  const now     = Date.now();

  return {
    ...theatre,
    state:       'resolved',
    outcome,
    resolved_at: now,
    position_history: [...theatre.position_history, {
      t:                    now,
      p:                    pct,
      bucket_probabilities: [...theatre.bucket_probabilities],
      evidence:             null,
      reason:               `Theatre closed: ${Math.round(pct * 100)}% sensors exceeded AQI ${theatre.threshold_aqi} → bucket ${outcome} (${WILDFIRE_BUCKETS[outcome].label})`,
    }],
  };
}
