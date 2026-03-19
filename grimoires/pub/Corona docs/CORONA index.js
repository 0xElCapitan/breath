/**
 * CORONA — Coronal Oracle & Realtime Observation Network Agent
 *
 * Space weather intelligence construct for the Echelon protocol.
 * Monitors solar activity, geomagnetic storms, and CME propagation
 * through structured prediction markets (Theatres).
 *
 * Data sources:
 *   - NOAA SWPC: GOES X-ray flux, Kp index, proton flux, DSCOVR solar wind
 *   - NASA DONKI: Solar flares, CMEs, geomagnetic storms, interplanetary shocks
 *
 * Theatre templates:
 *   T1 — Flare Class Gate (binary, GOES X-ray resolves)
 *   T2 — Geomagnetic Storm Gate (binary, 3-hour Kp resolves)
 *   T3 — CME Arrival Prediction (binary, solar wind shock resolves)
 *   T4 — Proton Event Cascade (multi-bucket, maps to Aftershock Cascade)
 *   T5 — Solar Wind Divergence (Paradox Engine native)
 *
 * Usage:
 *   import { CoronaConstruct } from './index.js';
 *   const corona = new CoronaConstruct();
 *   corona.start();
 */

import { pollAndIngest as pollSWPC } from './oracles/swpc.js';
import { pollAndIngest as pollDONKI } from './oracles/donki.js';
import { createFlareClassGate, processFlareClassGate, expireFlareClassGate } from './theatres/flare-gate.js';
import { createGeomagneticStormGate, processGeomagneticStormGate, expireGeomagneticStormGate } from './theatres/geomag-gate.js';
import { createCMEArrival, processCMEArrival, expireCMEArrival } from './theatres/cme-arrival.js';
import { createProtonEventCascade, processProtonEventCascade, resolveProtonEventCascade } from './theatres/proton-cascade.js';
import { createSolarWindDivergence, processSolarWindDivergence, expireSolarWindDivergence } from './theatres/solar-wind-divergence.js';
import { exportCertificate } from './rlmf/certificates.js';
import { flareRank } from './oracles/swpc.js';

export class CoronaConstruct {
  constructor(config = {}) {
    this.constructId = config.constructId ?? 'CORONA';
    this.swpcIntervalMs = config.swpcIntervalMs ?? 60_000;     // 1 min for SWPC
    this.donkiIntervalMs = config.donkiIntervalMs ?? 300_000;  // 5 min for DONKI

    // State
    this.theatres = new Map();
    this.revisionHistories = new Map();
    this.processedEvents = new Set();
    this.certificates = [];
    this.swpcTimer = null;
    this.donkiTimer = null;

    // Stats
    this.stats = {
      swpc_polls: 0,
      donki_polls: 0,
      bundles_ingested: 0,
      theatres_created: 0,
      theatres_resolved: 0,
      certificates_exported: 0,
    };
  }

  // =========================================================================
  // Theatre management
  // =========================================================================

  addTheatre(theatre) {
    this.theatres.set(theatre.id, theatre);
    this.stats.theatres_created++;
    console.log(`[CORONA] Theatre added: ${theatre.id}`);
  }

  openFlareClassGate(params) {
    const theatre = createFlareClassGate(params);
    this.addTheatre(theatre);
    return theatre;
  }

  openGeomagneticStormGate(params) {
    const theatre = createGeomagneticStormGate(params);
    this.addTheatre(theatre);
    return theatre;
  }

  openCMEArrival(params) {
    const theatre = createCMEArrival(params);
    if (theatre) this.addTheatre(theatre);
    return theatre;
  }

  openProtonEventCascade(params) {
    const theatre = createProtonEventCascade(params);
    if (theatre) this.addTheatre(theatre);
    return theatre;
  }

  openSolarWindDivergence(params) {
    const theatre = createSolarWindDivergence(params);
    this.addTheatre(theatre);
    return theatre;
  }

  getActiveTheatres() {
    return Array.from(this.theatres.values()).filter(
      (t) => t.state === 'open' || t.state === 'provisional_hold'
    );
  }

  checkExpiries() {
    const now = Date.now();
    for (const [id, theatre] of this.theatres) {
      if (theatre.state !== 'open') continue;
      if (now >= theatre.closes_at) {
        let expired;
        switch (theatre.template) {
          case 'flare_class_gate':
            expired = expireFlareClassGate(theatre);
            break;
          case 'geomagnetic_storm_gate':
            expired = expireGeomagneticStormGate(theatre);
            break;
          case 'cme_arrival':
            expired = expireCMEArrival(theatre);
            break;
          case 'proton_event_cascade':
            expired = resolveProtonEventCascade(theatre);
            break;
          case 'solar_wind_divergence':
            expired = expireSolarWindDivergence(theatre);
            break;
          default:
            expired = { ...theatre, state: 'expired', resolved_at: Date.now() };
        }
        this.theatres.set(id, expired);
        if (expired.state === 'resolved') {
          this._exportCertificate(expired);
        }
        console.log(`[CORONA] Theatre expired: ${id} → outcome=${expired.outcome}`);
      }
    }
  }

  // =========================================================================
  // Core polling
  // =========================================================================

  async pollSWPC() {
    const config = {
      activeTheatres: this.getActiveTheatres(),
      revisionHistories: this.revisionHistories,
    };

    const result = await pollSWPC(config, this.processedEvents);
    this.stats.swpc_polls++;
    this.stats.bundles_ingested += result.bundles.length;

    this._processIngestedBundles(result.bundles);
    this.checkExpiries();
    return result;
  }

  async pollDONKI() {
    const config = {
      activeTheatres: this.getActiveTheatres(),
      revisionHistories: this.revisionHistories,
    };

    const result = await pollDONKI(config, this.processedEvents);
    this.stats.donki_polls++;
    this.stats.bundles_ingested += result.bundles.length;

    this._processIngestedBundles(result.bundles);
    this.checkExpiries();
    return result;
  }

  /**
   * Process ingested bundles against all matching theatres.
   * Also handles auto-spawning of derivative theatres.
   */
  _processIngestedBundles(bundles) {
    for (const bundle of bundles) {
      // Auto-spawn CME Arrival theatre for Earth-directed CMEs
      if (
        bundle.payload.event_type === 'cme' &&
        bundle.payload.earth_arrival?.estimated_arrival
      ) {
        const cmeTheatre = createCMEArrival({ cmeBundle: bundle });
        if (cmeTheatre) this.addTheatre(cmeTheatre);
      }

      // Auto-spawn Proton Event Cascade for M5+ flares
      if (
        bundle.payload.event_type === 'solar_flare' &&
        bundle.payload.flare?.rank >= flareRank('M5.0')
      ) {
        const cascadeTheatre = createProtonEventCascade({
          triggerBundle: bundle,
        });
        if (cascadeTheatre) this.addTheatre(cascadeTheatre);
      }

      // Process against all matching theatres
      for (const theatreId of bundle.theatre_refs) {
        const theatre = this.theatres.get(theatreId);
        if (!theatre) continue;

        let updated;
        switch (theatre.template) {
          case 'flare_class_gate':
            updated = processFlareClassGate(theatre, bundle);
            break;
          case 'geomagnetic_storm_gate':
            updated = processGeomagneticStormGate(theatre, bundle);
            break;
          case 'cme_arrival':
            updated = processCMEArrival(theatre, bundle);
            break;
          case 'proton_event_cascade':
            updated = processProtonEventCascade(theatre, bundle);
            break;
          case 'solar_wind_divergence':
            updated = processSolarWindDivergence(theatre, bundle);
            break;
          default:
            updated = theatre;
        }

        this.theatres.set(theatreId, updated);

        if (updated.state === 'resolved' && theatre.state !== 'resolved') {
          this._exportCertificate(updated);
        }
      }
    }
  }

  _exportCertificate(theatre) {
    try {
      const cert = exportCertificate(theatre, {
        construct_id: this.constructId,
      });
      this.certificates.push(cert);
      this.stats.theatres_resolved++;
      this.stats.certificates_exported++;
      console.log(
        `[CORONA] Certificate exported: ${cert.certificate_id} ` +
        `brier=${cert.performance.brier_score} ` +
        `outcome=${theatre.outcome}`
      );
    } catch (err) {
      console.error(`[CORONA] Certificate export failed for ${theatre.id}:`, err.message);
    }
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  start() {
    if (this.swpcTimer) throw new Error('CORONA is already running');

    console.log(
      `[CORONA] Starting. ` +
      `SWPC interval: ${this.swpcIntervalMs}ms, ` +
      `DONKI interval: ${this.donkiIntervalMs}ms, ` +
      `theatres: ${this.theatres.size}`
    );

    // Initial polls
    this.pollSWPC().catch((err) => console.error('[CORONA] SWPC poll error:', err.message));
    this.pollDONKI().catch((err) => console.error('[CORONA] DONKI poll error:', err.message));

    // Recurring polls
    this.swpcTimer = setInterval(() => {
      this.pollSWPC().catch((err) => console.error('[CORONA] SWPC poll error:', err.message));
    }, this.swpcIntervalMs);

    this.donkiTimer = setInterval(() => {
      this.pollDONKI().catch((err) => console.error('[CORONA] DONKI poll error:', err.message));
    }, this.donkiIntervalMs);
  }

  stop() {
    if (this.swpcTimer) {
      clearInterval(this.swpcTimer);
      this.swpcTimer = null;
    }
    if (this.donkiTimer) {
      clearInterval(this.donkiTimer);
      this.donkiTimer = null;
    }
    console.log('[CORONA] Stopped.');
  }

  getState() {
    const theatresByState = {};
    for (const t of this.theatres.values()) {
      theatresByState[t.state] = (theatresByState[t.state] ?? 0) + 1;
    }

    return {
      construct: this.constructId,
      running: this.swpcTimer !== null,
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

  getCertificates() {
    return this.certificates;
  }

  flushCertificates() {
    const flushed = this.certificates.length;
    this.certificates = [];
    return flushed;
  }
}

// Re-exports for granular use
export { pollAndIngest as pollSWPC } from './oracles/swpc.js';
export { pollAndIngest as pollDONKI } from './oracles/donki.js';
export { classifyFlux, classToFlux, flareRank, kpToGScale } from './oracles/swpc.js';
export { parseSourceLocation, getBestCMEAnalysis, getEarthArrival } from './oracles/donki.js';
export { buildBundle } from './processor/bundles.js';
export { computeQuality } from './processor/quality.js';
export { buildFlareUncertainty, flareThresholdProbability, buildKpUncertainty, kpThresholdProbability, buildCMEArrivalUncertainty, cmeArrivalWindowProbability } from './processor/uncertainty.js';
export { assessSettlement } from './processor/settlement.js';
export { createFlareClassGate, processFlareClassGate, expireFlareClassGate } from './theatres/flare-gate.js';
export { createGeomagneticStormGate, processGeomagneticStormGate, expireGeomagneticStormGate } from './theatres/geomag-gate.js';
export { createCMEArrival, processCMEArrival, expireCMEArrival } from './theatres/cme-arrival.js';
export { createProtonEventCascade, processProtonEventCascade, resolveProtonEventCascade } from './theatres/proton-cascade.js';
export { createSolarWindDivergence, processSolarWindDivergence, expireSolarWindDivergence } from './theatres/solar-wind-divergence.js';
export { exportCertificate, brierScoreBinary, brierScoreMultiClass, calibrationBucket } from './rlmf/certificates.js';
