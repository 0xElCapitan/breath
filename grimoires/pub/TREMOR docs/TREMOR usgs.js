/**
 * USGS real-time GeoJSON feed poller.
 *
 * Fetches the USGS earthquake feed, deduplicates against previously
 * seen events, and passes new/updated features to the bundle builder.
 */

import { buildBundle } from '../processor/bundles.js';

const FEED_URLS = {
  significant_hour: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_hour.geojson',
  'm4.5_hour':      'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_hour.geojson',
  'm2.5_hour':      'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_hour.geojson',
  'm4.5_day':       'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson',
  'm2.5_day':       'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
  all_hour:         'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
  all_day:          'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
};

/**
 * Fetch a USGS feed.
 *
 * @param {string} feedType - One of the FEED_URLS keys
 * @returns {object} USGS GeoJSON FeatureCollection
 */
export async function fetchFeed(feedType = 'm4.5_hour') {
  const url = FEED_URLS[feedType];
  if (!url) throw new Error(`Unknown feed type: ${feedType}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`USGS feed error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Fetch the detail endpoint for a specific event.
 * Returns the full GeoJSON feature with extended properties
 * (magError, horizontalError, depthError, etc.)
 *
 * @param {string} detailUrl - The feature.properties.detail URL
 * @returns {object} Detailed USGS GeoJSON feature
 */
export async function fetchDetail(detailUrl) {
  const response = await fetch(detailUrl);
  if (!response.ok) {
    throw new Error(`USGS detail error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Poll the USGS feed and ingest all new/updated features.
 *
 * @param {string} feedType - Feed to poll
 * @param {object} config - Ingestion config (activeTheatres, revisionHistories, etc.)
 * @param {Set} processedEvents - Set of `{id}-{updated}` strings for dedup
 * @returns {object} Poll result with bundles, skipped, unmatched counts
 */
export async function pollAndIngest(feedType, config, processedEvents) {
  const feed = await fetchFeed(feedType);
  const polledAt = Date.now();

  const bundles = [];
  let skipped = 0;
  let unmatched = 0;

  for (const feature of feed.features) {
    // Dedup by event ID + updated timestamp
    const revisionKey = `${feature.id}-${feature.properties.updated}`;
    if (processedEvents.has(revisionKey)) continue;

    const bundle = buildBundle(feature, config);

    if (bundle === null) {
      skipped++;
      continue;
    }

    if (bundle.theatre_refs.length === 0) {
      unmatched++;
    }

    bundles.push(bundle);
    processedEvents.add(revisionKey);

    // Track revision history
    const histories = config.revisionHistories ?? new Map();
    const history = histories.get(feature.id) ?? [];
    history.push({
      timestamp: polledAt,
      magnitude: feature.properties.mag ?? 0,
      magType: feature.properties.magType ?? 'unknown',
      status: feature.properties.status,
    });
    histories.set(feature.id, history);
  }

  return {
    bundles,
    skipped,
    unmatched,
    feed_generated: feed.metadata.generated,
    feed_count: feed.metadata.count,
    polled_at: polledAt,
  };
}

// --- CLI entrypoint for standalone testing ---

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''));
if (isMain) {
  const feedType = process.argv[2] || 'm4.5_day';
  console.log(`[TREMOR] Polling USGS feed: ${feedType}`);

  const config = {
    activeTheatres: [],
    revisionHistories: new Map(),
  };
  const processed = new Set();

  try {
    const result = await pollAndIngest(feedType, config, processed);
    console.log(`[TREMOR] Poll complete:`, {
      bundles: result.bundles.length,
      skipped: result.skipped,
      unmatched: result.unmatched,
      feed_count: result.feed_count,
    });

    // Print first bundle as example
    if (result.bundles.length > 0) {
      console.log('\n[TREMOR] Example bundle:');
      console.log(JSON.stringify(result.bundles[0], null, 2));
    }
  } catch (err) {
    console.error('[TREMOR] Poll error:', err.message);
    process.exit(1);
  }
}
