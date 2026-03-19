/**
 * TREMOR — Threshold Resolution & Earth Movement Oracle
 *
 * Construct entrypoint. Manages the polling loop, theatre lifecycle,
 * and RLMF certificate export.
 *
 * Usage:
 *   import { TremorConstruct } from './index.js';
 *   const tremor = new TremorConstruct();
 *   tremor.start();
 */

import { pollAndIngest } from './oracles/usgs.js';
import { crossValidateEMSC } from './oracles/emsc.js';
import { createMagnitudeGate, processMagnitudeGate, expireMagnitudeGate } from './theatres/mag-gate.js';
import { createOracleDivergence, resolveOracleDivergence } from './theatres/paradox.js';
import { createAftershockCascade, processAftershockCascade, resolveAftershockCascade } from './theatres/aftershock.js';
import { createSwarmWatch, processSwarmWatch, expireSwarmWatch } from './theatres/swarm.js';
import { createDepthRegime, processDepthRegime, expireDepthRegime } from './theatres/depth.js';
import { exportCertificate } from './rlmf/certificates.js';

export class TremorConstruct {
  constructor(config = {}) {
    this.constructId = config.constructId ?? 'TREMOR';
    this.feedType = config.feedType ?? 'm4.5_hour';
    this.pollIntervalMs = config.pollIntervalMs ?? 60_000;
    this.enableCrossValidation = config.enableCrossValidation ?? false;

    // State
    this.theatres = new Map();      // id → theatre
    this.revisionHistories = new Map(); // eventId → [{timestamp, mag, magType, status}]
    this.processedEvents = new Set();   // `${id}-${updated}` dedup keys
    this.certificates = [];            // exported RLMF certs
    this.pollTimer = null;

    // Stats
    this.stats = {
      polls: 0,
      bundles_ingested: 0,
      theatres_created: 0,
      theatres_resolved: 0,
      certificates_exported: 0,
    };
  }

  // =========================================================================
  // Theatre management
  // =========================================================================

  /**
   * Register a pre-configured theatre.
   */
  addTheatre(theatre) {
    this.theatres.set(theatre.id, theatre);
    this.stats.theatres_created++;
    console.log(`[TREMOR] Theatre added: ${theatre.id}`);
  }

  /**
   * Create and register a Magnitude Gate theatre.
   */
  openMagnitudeGate(params) {
    const theatre = createMagnitudeGate(params);
    this.addTheatre(theatre);
    return theatre;
  }

  /**
   * Create and register an Aftershock Cascade theatre.
   * Auto-called on M≥6.0 detections.
   */
  openAftershockCascade(params) {
    const theatre = createAftershockCascade(params);
    if (theatre) this.addTheatre(theatre);
    return theatre;
  }

  /**
   * Create and register a Swarm Watch theatre.
   */
  openSwarmWatch(params) {
    const theatre = createSwarmWatch(params);
    this.addTheatre(theatre);
    return theatre;
  }

  /**
   * Create and register a Depth Regime theatre.
   */
  openDepthRegime(params) {
    const theatre = createDepthRegime(params);
    if (theatre) this.addTheatre(theatre);
    return theatre;
  }

  /**
   * Get all active theatres as an array (for the ingestion config).
   */
  getActiveTheatres() {
    return Array.from(this.theatres.values()).filter(
      (t) => t.state === 'open' || t.state === 'provisional_hold'
    );
  }

  /**
   * Check for expired theatres and resolve them.
   */
  checkExpiries() {
    const now = Date.now();
    for (const [id, theatre] of this.theatres) {
      if (theatre.state !== 'open') continue;
      if (now >= theatre.closes_at) {
        let expired;
        switch (theatre.template) {
          case 'magnitude_gate':
            expired = expireMagnitudeGate(theatre);
            break;
          case 'aftershock_cascade':
            expired = resolveAftershockCascade(theatre);
            break;
          case 'swarm_watch':
            expired = expireSwarmWatch(theatre);
            break;
          case 'depth_regime':
            expired = expireDepthRegime(theatre);
            break;
          default:
            expired = { ...theatre, state: 'expired', resolved_at: Date.now() };
        }
        this.theatres.set(id, expired);
        if (expired.state === 'resolved') {
          this._exportCertificate(expired);
        }
        console.log(`[TREMOR] Theatre expired: ${id} → outcome=${expired.outcome}`);
        }
      }
    }
  }

  // =========================================================================
  // Core loop
  // =========================================================================

  /**
   * Single poll cycle: fetch feed → build bundles → process theatres.
   */
  async poll() {
    const config = {
      activeTheatres: this.getActiveTheatres(),
      revisionHistories: this.revisionHistories,
      crossValidation: null,
    };

    const result = await pollAndIngest(this.feedType, config, this.processedEvents);
    this.stats.polls++;
    this.stats.bundles_ingested += result.bundles.length;

    for (const bundle of result.bundles) {
      // Cross-validate with EMSC if enabled
      if (this.enableCrossValidation && bundle.evidence_class === 'provisional') {
        // Note: in production this would be queued/batched to respect rate limits
        const emscResult = await crossValidateEMSC({
          properties: {
            mag: bundle.payload.magnitude.value,
            time: bundle.payload.event_time,
          },
          geometry: {
            coordinates: [
              bundle.payload.location.longitude,
              bundle.payload.location.latitude,
              bundle.payload.location.depth_km,
            ],
          },
        });
        if (emscResult) {
          bundle.cross_validation = emscResult;
        }
      }

      // Auto-spawn Oracle Divergence theatres for automatic M4.5+ events
      if (
        bundle.evidence_class === 'provisional' &&
        bundle.payload.magnitude.value >= 4.5
      ) {
        const divergeTheatre = createOracleDivergence(bundle);
        if (divergeTheatre) {
          this.addTheatre(divergeTheatre);
        }
      }

      // Auto-spawn Aftershock Cascade for M≥6.0 events
      if (bundle.payload.magnitude.value >= 6.0) {
        const cascadeTheatre = createAftershockCascade({
          mainshockBundle: bundle,
        });
        if (cascadeTheatre) {
          this.addTheatre(cascadeTheatre);
        }
      }

      // Process against all matching theatres
      for (const theatreId of bundle.theatre_refs) {
        const theatre = this.theatres.get(theatreId);
        if (!theatre) continue;

        let updated;
        switch (theatre.template) {
          case 'magnitude_gate':
            updated = processMagnitudeGate(theatre, bundle);
            break;
          case 'oracle_divergence':
            if (bundle.evidence_class === 'ground_truth') {
              updated = resolveOracleDivergence(theatre, bundle);
            } else {
              updated = theatre;
            }
            break;
          case 'aftershock_cascade':
            updated = processAftershockCascade(theatre, bundle);
            break;
          case 'swarm_watch':
            updated = processSwarmWatch(theatre, bundle);
            break;
          case 'depth_regime':
            updated = processDepthRegime(theatre, bundle);
            break;
          default:
            updated = theatre;
        }

        this.theatres.set(theatreId, updated);

        // If theatre just resolved, export certificate
        if (updated.state === 'resolved' && theatre.state !== 'resolved') {
          this._exportCertificate(updated);
        }
      }
    }

    // Check for expired theatres
    this.checkExpiries();

    return result;
  }

  /**
   * Export RLMF certificate for a resolved theatre.
   */
  _exportCertificate(theatre) {
    try {
      const cert = exportCertificate(theatre, {
        construct_id: this.constructId,
      });
      this.certificates.push(cert);
      this.stats.theatres_resolved++;
      this.stats.certificates_exported++;
      console.log(
        `[TREMOR] Certificate exported: ${cert.certificate_id} ` +
        `brier=${cert.performance.brier_score} ` +
        `outcome=${theatre.outcome}`
      );
    } catch (err) {
      console.error(`[TREMOR] Certificate export failed for ${theatre.id}:`, err.message);
    }
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Start the polling loop.
   */
  start() {
    if (this.pollTimer) throw new Error('TREMOR is already running');

    console.log(
      `[TREMOR] Starting. Feed: ${this.feedType}, ` +
      `interval: ${this.pollIntervalMs}ms, ` +
      `theatres: ${this.theatres.size}, ` +
      `cross-validation: ${this.enableCrossValidation}`
    );

    // Initial poll
    this.poll().catch((err) => console.error('[TREMOR] Initial poll error:', err.message));

    // Recurring poll
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => console.error('[TREMOR] Poll error:', err.message));
    }, this.pollIntervalMs);
  }

  /**
   * Stop the polling loop.
   */
  stop() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      console.log('[TREMOR] Stopped.');
    }
  }

  /**
   * Get current construct state for debugging / health checks.
   */
  getState() {
    const theatresByState = {};
    for (const t of this.theatres.values()) {
      theatresByState[t.state] = (theatresByState[t.state] ?? 0) + 1;
    }

    return {
      construct: this.constructId,
      running: this.pollTimer !== null,
      stats: this.stats,
      theatres: {
        total: this.theatres.size,
        by_state: theatresByState,
      },
      tracked_events: this.revisionHistories.size,
      processed_revisions: this.processedEvents.size,
      certificates_exported: this.certificates.length,
    };
  }

  /**
   * Get all exported certificates (for RLMF pipeline consumption).
   */
  getCertificates() {
    return this.certificates;
  }

  /**
   * Flush certificates (after RLMF pipeline has consumed them).
   */
  flushCertificates() {
    const flushed = this.certificates.length;
    this.certificates = [];
    return flushed;
  }
}

// Re-export components for granular use
export { pollAndIngest } from './oracles/usgs.js';
export { crossValidateEMSC } from './oracles/emsc.js';
export { buildBundle } from './processor/bundles.js';
export { computeQuality } from './processor/quality.js';
export { buildMagnitudeUncertainty, thresholdCrossingProbability } from './processor/magnitude.js';
export { assessStatusFlip } from './processor/settlement.js';
export { findRegion, REGION_PROFILES } from './processor/regions.js';
export { createMagnitudeGate, processMagnitudeGate, expireMagnitudeGate } from './theatres/mag-gate.js';
export { createOracleDivergence, resolveOracleDivergence } from './theatres/paradox.js';
export { createAftershockCascade, processAftershockCascade, resolveAftershockCascade } from './theatres/aftershock.js';
export { createSwarmWatch, processSwarmWatch, expireSwarmWatch, computeBValue } from './theatres/swarm.js';
export { createDepthRegime, processDepthRegime, expireDepthRegime, ZONE_PROFILES } from './theatres/depth.js';
export { exportCertificate, brierScoreBinary, brierScoreMultiClass } from './rlmf/certificates.js';
