// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * CMS Protocol Auto-Detector
 *
 * Probes the CMS to determine which communication protocol to use:
 *   - REST/PlayerRestApi — optimized JSON protocol (custom CMS image)
 *   - SOAP/XMDS — universal XML protocol (any vanilla Xibo CMS)
 *
 * Detection logic:
 *   1. GET {cmsUrl}${PLAYER_API}/health with a generous timeout
 *   2. If 200 + valid JSON → REST
 *   3. If 404/error/timeout → SOAP (fallback)
 *
 * After a fallback to XMDS, the detector can run an automatic background
 * re-probe loop with exponential backoff so the player promotes back to
 * REST as soon as the CMS recovers. The re-probe loop also acts as a
 * visibility signal: each failed probe emits a warning that names the
 * next attempt, so it's obvious at a glance that the player is still
 * running on the wrong transport.
 *
 * @example
 *   import { ProtocolDetector, RestClient, XmdsClient } from '@xiboplayer/xmds';
 *
 *   const detector = new ProtocolDetector(config.cmsUrl, RestClient, XmdsClient);
 *   const { client, protocol } = await detector.detect(config);
 *   let xmds = client;
 *
 *   if (protocol === 'xmds') {
 *     detector.startAutoReprobe(config, (newClient) => {
 *       // REST recovered — swap the live client pointer
 *       xmds = newClient;
 *     });
 *   }
 */

import { createLogger } from '@xiboplayer/utils';
import { assertCmsClient } from './cms-client.js';

const log = createLogger('Protocol');

/**
 * Default timeout for the FIRST probe at startup.
 * Intentionally generous: a cold CMS has to warm up PHP-FPM workers,
 * negotiate TLS, populate OpCache, and possibly fill MariaDB query plan
 * caches. Empirically a healthy cold CMS can take 5-6 seconds on the
 * very first request after a restart — the old 3000ms default was too
 * tight and would lock the player into XMDS fallback on cold start.
 */
const FIRST_PROBE_TIMEOUT_MS = 10000;

/**
 * Default timeout for re-probes after fallback is engaged.
 * Shorter than the first probe because by the time we're re-probing we
 * already know the CMS was reachable at some point — either it's up
 * now or it isn't.
 */
const REPROBE_TIMEOUT_MS = 5000;

/** Starting delay before the first auto-reprobe after XMDS fallback. */
const REPROBE_MIN_DELAY_MS = 5000;
/** Ceiling delay for the backoff — we re-probe at least this often forever. */
const REPROBE_MAX_DELAY_MS = 120000;
/** Exponential factor applied after each failed reprobe. */
const REPROBE_BACKOFF_FACTOR = 2;

export class ProtocolDetector {
  /**
   * @param {string} cmsUrl - CMS base URL
   * @param {typeof import('./rest-client.js').RestClient} RestClientClass - RestClient constructor
   * @param {typeof import('./xmds-client.js').XmdsClient} XmdsClientClass - XmdsClient constructor
   * @param {Object} [options]
   * @param {number} [options.firstProbeTimeoutMs=10000] - Timeout for the initial probe
   * @param {number} [options.reprobeTimeoutMs=5000] - Timeout for re-probes after fallback
   * @param {number} [options.probeTimeoutMs] - Back-compat: sets BOTH first and reprobe timeouts to the same value
   * @param {number} [options.reprobeMinDelayMs=5000] - Initial delay before the first auto-reprobe
   * @param {number} [options.reprobeMaxDelayMs=120000] - Ceiling delay between auto-reprobes
   */
  constructor(cmsUrl, RestClientClass, XmdsClientClass, options = {}) {
    this.cmsUrl = cmsUrl;
    this.RestClient = RestClientClass;
    this.XmdsClient = XmdsClientClass;

    // Back-compat: if a single probeTimeoutMs is provided, use it for both
    // first and reprobe. New callers should pass the split options.
    const legacy = options.probeTimeoutMs;
    this.firstProbeTimeoutMs = options.firstProbeTimeoutMs ?? legacy ?? FIRST_PROBE_TIMEOUT_MS;
    this.reprobeTimeoutMs = options.reprobeTimeoutMs ?? legacy ?? REPROBE_TIMEOUT_MS;

    this.reprobeMinDelayMs = options.reprobeMinDelayMs ?? REPROBE_MIN_DELAY_MS;
    this.reprobeMaxDelayMs = options.reprobeMaxDelayMs ?? REPROBE_MAX_DELAY_MS;

    /** @type {'rest'|'xmds'|null} Detected protocol (null = not yet probed) */
    this.protocol = null;

    /** @type {number} Timestamp of last probe attempt */
    this.lastProbeTime = 0;

    /** @type {ReturnType<typeof setTimeout>|null} Scheduled auto-reprobe timer */
    this._reprobeTimer = null;

    /** @type {number} Current backoff delay (ms) — resets on successful probe or stop */
    this._reprobeDelay = this.reprobeMinDelayMs;
  }

  /**
   * Probe the CMS health endpoint to determine protocol availability.
   * @param {Object} [opts]
   * @param {boolean} [opts.first=false] - Use the longer first-probe timeout
   * @returns {Promise<boolean>} true if REST/PlayerRestApi is available
   */
  async probe(opts = {}) {
    const timeoutMs = opts.first ? this.firstProbeTimeoutMs : this.reprobeTimeoutMs;
    const available = await this.RestClient.isAvailable(this.cmsUrl, {
      maxRetries: 0,
      timeoutMs,
    });
    this.lastProbeTime = Date.now();
    return available;
  }

  /**
   * Detect the best protocol and create the appropriate client.
   * On first call, probes the CMS with the generous first-probe timeout.
   * On subsequent calls, returns the cached protocol unless reprobe() is called.
   *
   * @param {Object} config - Player configuration (passed to client constructor)
   * @param {string} [forceProtocol] - 'rest'|'xmds' to skip detection
   * @returns {Promise<{client: any, protocol: 'rest'|'xmds'}>}
   */
  async detect(config, forceProtocol) {
    if (forceProtocol === 'rest') {
      this.protocol = 'rest';
      log.info('Using REST transport (forced)');
      const client = new this.RestClient(config);
      assertCmsClient(client, 'RestClient');
      return { client, protocol: 'rest' };
    }

    if (forceProtocol === 'xmds') {
      this.protocol = 'xmds';
      log.info('Using XMDS/SOAP transport (forced)');
      const client = new this.XmdsClient(config);
      assertCmsClient(client, 'XmdsClient');
      return { client, protocol: 'xmds' };
    }

    // Auto-detect
    log.info(`Probing CMS for REST API availability (timeout ${this.firstProbeTimeoutMs}ms)...`);
    let isRest = false;
    try {
      isRest = await this.probe({ first: true });
    } catch (e) {
      log.warn('REST probe failed:', e?.message || e);
    }

    if (isRest) {
      this.protocol = 'rest';
      log.info('REST transport detected — using PlayerRestApi');
      const client = new this.RestClient(config);
      assertCmsClient(client, 'RestClient');
      return { client, protocol: 'rest' };
    }

    this.protocol = 'xmds';
    log.warn('REST unavailable — falling back to XMDS/SOAP transport');
    const client = new this.XmdsClient(config);
    assertCmsClient(client, 'XmdsClient');
    return { client, protocol: 'xmds' };
  }

  /**
   * Re-probe the CMS once and potentially switch protocols.
   * Called either externally on connection errors, or internally by the
   * auto-reprobe loop.
   *
   * @param {Object} config - Player configuration
   * @returns {Promise<{client: any, protocol: 'rest'|'xmds', changed: boolean}>}
   */
  async reprobe(config) {
    const previousProtocol = this.protocol;

    let isRest = false;
    try {
      isRest = await this.probe({ first: false });
    } catch (e) {
      log.warn('Re-probe failed:', e?.message || e);
    }

    const newProtocol = isRest ? 'rest' : 'xmds';
    const changed = newProtocol !== previousProtocol;

    if (changed) {
      log.info(`Protocol changed: ${previousProtocol} → ${newProtocol}`);
      this.protocol = newProtocol;
      const client = isRest ? new this.RestClient(config) : new this.XmdsClient(config);
      assertCmsClient(client, isRest ? 'RestClient' : 'XmdsClient');
      return { client, protocol: newProtocol, changed: true };
    }

    return { client: null, protocol: newProtocol, changed: false };
  }

  /**
   * Start an automatic background re-probe loop while on XMDS fallback.
   * Uses exponential backoff from reprobeMinDelayMs up to reprobeMaxDelayMs
   * (defaults: 5s → 2min). Each failed reprobe logs a visibility warning
   * that names the current fallback state and the next probe time, so an
   * operator reading the log after any interval can see at a glance that
   * the player is still running on the wrong transport.
   *
   * When a reprobe succeeds (detects REST is back), the callback is invoked
   * with the new client and the loop stops. No-op if the current protocol
   * is not 'xmds'.
   *
   * @param {Object} config - Player configuration passed to reprobe()
   * @param {(client: any) => void} onRestPromoted - Called when REST recovers
   */
  startAutoReprobe(config, onRestPromoted) {
    if (this.protocol !== 'xmds') {
      // Only meaningful while in fallback
      return;
    }
    // Cancel any existing timer before scheduling a fresh one
    this.stopAutoReprobe();
    this._reprobeDelay = this.reprobeMinDelayMs;

    const schedule = () => {
      const nextInMs = this._reprobeDelay;
      this._reprobeTimer = setTimeout(async () => {
        this._reprobeTimer = null;
        let result;
        try {
          result = await this.reprobe(config);
        } catch (e) {
          log.warn('Auto-reprobe error:', e?.message || e);
          result = { changed: false, protocol: 'xmds', client: null };
        }

        if (result.changed && result.protocol === 'rest') {
          log.info('REST recovered — promoting back from XMDS fallback');
          this._reprobeDelay = this.reprobeMinDelayMs;
          try {
            onRestPromoted(result.client);
          } catch (e) {
            log.warn('onRestPromoted callback threw:', e?.message || e);
          }
          return; // stop — we're back on REST
        }

        // Still on XMDS — back off and try again
        const nextDelay = Math.min(
          this._reprobeDelay * REPROBE_BACKOFF_FACTOR,
          this.reprobeMaxDelayMs,
        );
        log.warn(
          `Still on XMDS fallback — REST probe failed, next attempt in ${Math.round(nextDelay / 1000)}s`,
        );
        this._reprobeDelay = nextDelay;
        schedule();
      }, nextInMs);
    };

    log.info(
      `Auto-reprobe scheduled — first attempt in ${Math.round(this._reprobeDelay / 1000)}s (backoff up to ${Math.round(this.reprobeMaxDelayMs / 1000)}s)`,
    );
    schedule();
  }

  /**
   * Cancel any pending auto-reprobe timer. Safe to call multiple times.
   * Call this when the player is shutting down, or when the protocol is
   * swapped back to REST by an external caller.
   */
  stopAutoReprobe() {
    if (this._reprobeTimer) {
      clearTimeout(this._reprobeTimer);
      this._reprobeTimer = null;
    }
    this._reprobeDelay = this.reprobeMinDelayMs;
  }

  /**
   * Get the currently detected protocol.
   * @returns {'rest'|'xmds'|null}
   */
  getProtocol() {
    return this.protocol;
  }
}
