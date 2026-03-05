/**
 * CMS Protocol Auto-Detector
 *
 * Probes the CMS to determine which communication protocol to use:
 *   - REST/PlayerApiV2 — optimized JSON protocol (custom CMS image)
 *   - SOAP/XMDS — universal XML protocol (any vanilla Xibo CMS)
 *
 * Detection logic:
 *   1. GET {cmsUrl}/api/v2/player/health with a 3-second timeout
 *   2. If 200 + valid JSON → REST
 *   3. If 404/error/timeout → SOAP (fallback)
 *
 * The detected protocol is cached and can be re-probed on connection errors.
 *
 * @example
 *   import { ProtocolDetector } from '@xiboplayer/xmds';
 *   import { RestClient, XmdsClient } from '@xiboplayer/xmds';
 *
 *   const detector = new ProtocolDetector(config.cmsUrl, RestClient, XmdsClient);
 *   const xmds = await detector.detect(config);
 *   // xmds is either a RestClient or XmdsClient instance
 *
 *   // On connection errors, re-probe:
 *   const newXmds = await detector.reprobe(config);
 */

import { createLogger } from '@xiboplayer/utils';

const log = createLogger('Protocol');

/** Default probe timeout in milliseconds */
const PROBE_TIMEOUT_MS = 3000;

export class ProtocolDetector {
  /**
   * @param {string} cmsUrl - CMS base URL
   * @param {typeof import('./rest-client.js').RestClient} RestClientClass - RestClient constructor
   * @param {typeof import('./xmds-client.js').XmdsClient} XmdsClientClass - XmdsClient constructor
   * @param {Object} [options]
   * @param {number} [options.probeTimeoutMs=3000] - Timeout for health probe
   */
  constructor(cmsUrl, RestClientClass, XmdsClientClass, options = {}) {
    this.cmsUrl = cmsUrl;
    this.RestClient = RestClientClass;
    this.XmdsClient = XmdsClientClass;
    this.probeTimeoutMs = options.probeTimeoutMs || PROBE_TIMEOUT_MS;

    /** @type {'rest'|'xmds'|null} Detected protocol (null = not yet probed) */
    this.protocol = null;

    /** @type {number} Timestamp of last successful probe */
    this.lastProbeTime = 0;
  }

  /**
   * Probe the CMS health endpoint to determine protocol availability.
   * @returns {Promise<boolean>} true if REST/PlayerApiV2 is available
   */
  async probe() {
    const available = await this.RestClient.isAvailable(this.cmsUrl, {
      maxRetries: 0,
      timeoutMs: this.probeTimeoutMs,
    });
    this.lastProbeTime = Date.now();
    return available;
  }

  /**
   * Detect the best protocol and create the appropriate client.
   * On first call, probes the CMS. On subsequent calls, returns the cached
   * protocol unless reprobe() is called.
   *
   * @param {Object} config - Player configuration (passed to client constructor)
   * @param {string} [forceProtocol] - 'rest'|'xmds' to skip detection
   * @returns {Promise<{client: any, protocol: 'rest'|'xmds'}>}
   */
  async detect(config, forceProtocol) {
    if (forceProtocol === 'rest') {
      this.protocol = 'rest';
      log.info('Using REST transport (forced)');
      return { client: new this.RestClient(config), protocol: 'rest' };
    }

    if (forceProtocol === 'xmds') {
      this.protocol = 'xmds';
      log.info('Using XMDS/SOAP transport (forced)');
      return { client: new this.XmdsClient(config), protocol: 'xmds' };
    }

    // Auto-detect
    log.info('Probing CMS for REST API availability...');
    let isRest = false;
    try {
      isRest = await this.probe();
    } catch (e) {
      log.warn('REST probe failed:', e?.message || e);
    }

    if (isRest) {
      this.protocol = 'rest';
      log.info('REST transport detected — using PlayerApiV2');
      return { client: new this.RestClient(config), protocol: 'rest' };
    }

    this.protocol = 'xmds';
    log.info('REST unavailable — using XMDS/SOAP transport');
    return { client: new this.XmdsClient(config), protocol: 'xmds' };
  }

  /**
   * Re-probe the CMS and potentially switch protocols.
   * Called on connection errors to check if the CMS was upgraded/downgraded.
   *
   * @param {Object} config - Player configuration
   * @returns {Promise<{client: any, protocol: 'rest'|'xmds', changed: boolean}>}
   */
  async reprobe(config) {
    const previousProtocol = this.protocol;

    log.info('Re-probing CMS protocol...');
    let isRest = false;
    try {
      isRest = await this.probe();
    } catch (e) {
      log.warn('Re-probe failed:', e?.message || e);
    }

    const newProtocol = isRest ? 'rest' : 'xmds';
    const changed = newProtocol !== previousProtocol;

    if (changed) {
      log.info(`Protocol changed: ${previousProtocol} → ${newProtocol}`);
      this.protocol = newProtocol;
      const client = isRest ? new this.RestClient(config) : new this.XmdsClient(config);
      return { client, protocol: newProtocol, changed: true };
    }

    log.info(`Protocol unchanged: ${newProtocol}`);
    return { client: null, protocol: newProtocol, changed: false };
  }

  /**
   * Get the currently detected protocol.
   * @returns {'rest'|'xmds'|null}
   */
  getProtocol() {
    return this.protocol;
  }
}
