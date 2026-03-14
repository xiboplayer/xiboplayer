// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * XMR (Xibo Message Relay) Wrapper
 *
 * Integrates the native XmrClient (xmr-client.js) to enable real-time
 * push commands from CMS via WebSocket.
 *
 * Connection lifecycle is delegated to XmrClient, which has a
 * built-in 60s health-check interval that reconnects automatically.
 * This wrapper only routes events to player callbacks.
 *
 * Supported commands:
 * - collectNow: Trigger immediate XMDS collection cycle
 * - screenShot/screenshot: Capture and upload screenshot
 * - licenceCheck: No-op for Linux clients (always valid)
 * - changeLayout: Switch to a specific layout immediately
 * - overlayLayout: Push overlay layout on top of current content
 * - revertToSchedule: Return to normal scheduled content
 * - purgeAll: Clear all cached files and re-download
 * - commandAction: Execute a player command (HTTP only in browser)
 * - triggerWebhook: Fire a webhook trigger action
 * - dataUpdate: Force refresh of data connectors
 * - rekey: RSA key pair rotation (for XMR encryption)
 * - criteriaUpdate: Update display criteria and re-collect
 * - currentGeoLocation: Report current geo location to CMS
 */

import { XmrClient } from './xmr-client.js';
import { createLogger } from '@xiboplayer/utils';

const log = createLogger('XMR');

export class XmrWrapper {
  /**
   * @param {Object} config - Player configuration
   * @param {Object} player - Player instance for callbacks
   */
  constructor(config, player) {
    this.config = config;
    this.player = player;
    this.xmr = null;
    this.connected = false;
  }

  /**
   * Initialize and start XMR connection.
   *
   * Creates a single Xmr instance and lets the framework manage
   * reconnection via its internal 60s health-check timer.
   * Calling start() again on an already-running instance is safe —
   * the framework skips if already connected to the same URL.
   *
   * @param {string} xmrUrl - WebSocket URL (ws:// or wss://)
   * @param {string} cmsKey - CMS authentication key
   * @returns {Promise<boolean>} Success status
   */
  async start(xmrUrl, cmsKey) {
    try {
      // Reuse existing instance — the framework handles reconnection.
      // Only create a new instance on first call or after stop().
      if (!this.xmr) {
        log.info('Initializing connection to:', xmrUrl);
        const channel = this.config.xmrChannel || `player-${this.config.hardwareKey}`;
        this.xmr = new XmrClient(channel);
        this.setupEventHandlers();
        await this.xmr.init();
      }

      await this.xmr.start(xmrUrl, cmsKey);
      this.connected = true;
      log.info('Connected successfully');

      return true;
    } catch (error) {
      log.warn('Failed to start:', error.message);
      log.info('Framework will retry automatically every 60s');

      return false;
    }
  }

  /**
   * Setup event handlers for CMS commands
   */
  setupEventHandlers() {
    if (!this.xmr) return;

    // Connection events
    this.xmr.on('connected', () => {
      log.info('WebSocket connected');
      this.connected = true;
      this.player.emit?.('xmr-status', { connected: true });
    });

    this.xmr.on('disconnected', () => {
      log.warn('WebSocket disconnected (framework will reconnect)');
      this.connected = false;
      this.player.emit?.('xmr-status', { connected: false });
    });

    this.xmr.on('error', (error) => {
      log.error('WebSocket error:', error);
    });

    // CMS command: Collect Now
    this.xmr.on('collectNow', async () => {
      log.info('Received collectNow command from CMS');
      try {
        await this.player.collect();
        log.debug('collectNow completed successfully');
      } catch (error) {
        log.error('collectNow failed:', error);
      }
    });

    // CMS command: Screenshot
    this.xmr.on('screenShot', async () => {
      log.info('Received screenShot command from CMS');
      try {
        await this.player.captureScreenshot();
        log.debug('screenShot completed successfully');
      } catch (error) {
        log.error('screenShot failed:', error);
      }
    });

    // CMS command: License Check (no-op for Linux clients)
    this.xmr.on('licenceCheck', () => {
      log.debug('Received licenceCheck (no-op for Linux client)');
    });

    // CMS command: Change Layout
    // Payload may be a layoutId string or an object with { layoutId, duration, downloadRequired, changeMode }
    this.xmr.on('changeLayout', async (data) => {
      const layoutId = typeof data === 'object' ? (data.layoutId || data) : data;
      const duration = typeof data === 'object' ? (parseInt(data.duration) || 0) : 0;
      const changeMode = typeof data === 'object' ? (data.changeMode || 'replace') : 'replace';
      log.info('Received changeLayout command:', layoutId, duration ? `duration=${duration}s` : '', changeMode !== 'replace' ? `mode=${changeMode}` : '');
      try {
        if (typeof data === 'object' && data.downloadRequired === true) {
          log.info('changeLayout: downloadRequired — triggering collection first');
          await this.player.collect();
        }
        await this.player.changeLayout(layoutId, { duration, changeMode });
        log.debug('changeLayout completed successfully');
      } catch (error) {
        log.error('changeLayout failed:', error);
      }
    });

    // CMS command: Overlay Layout
    // Payload may be a layoutId string or an object with { layoutId, duration, downloadRequired }
    this.xmr.on('overlayLayout', async (data) => {
      const layoutId = typeof data === 'object' ? (data.layoutId || data) : data;
      const duration = typeof data === 'object' ? (parseInt(data.duration) || 0) : 0;
      log.info('Received overlayLayout command:', layoutId, duration ? `duration=${duration}s` : '');
      try {
        if (typeof data === 'object' && data.downloadRequired === true) {
          log.info('overlayLayout: downloadRequired — triggering collection first');
          await this.player.collect();
        }
        await this.player.overlayLayout(layoutId, { duration });
        log.debug('overlayLayout completed successfully');
      } catch (error) {
        log.error('overlayLayout failed:', error);
      }
    });

    // CMS command: Revert to Schedule
    this.xmr.on('revertToSchedule', async () => {
      log.info('Received revertToSchedule command');
      try {
        await this.player.revertToSchedule();
        log.debug('revertToSchedule completed successfully');
      } catch (error) {
        log.error('revertToSchedule failed:', error);
      }
    });

    // CMS command: Purge All
    this.xmr.on('purgeAll', async () => {
      log.info('Received purgeAll command');
      try {
        await this.player.purgeAll();
        log.debug('purgeAll completed successfully');
      } catch (error) {
        log.error('purgeAll failed:', error);
      }
    });

    // CMS command: Execute Command
    // Resolve command from local display settings (from RegisterDisplay), not from XMR payload
    this.xmr.on('commandAction', async (data) => {
      const commandCode = data?.commandCode || data;
      log.info('Received commandAction command:', commandCode);
      try {
        const localCommands = this.player.displayCommands || data?.commands;
        await this.player.executeCommand(commandCode, localCommands);
        log.debug('commandAction completed successfully');
      } catch (error) {
        log.error('commandAction failed:', error);
      }
    });

    // CMS command: Trigger Webhook
    this.xmr.on('triggerWebhook', async (data) => {
      log.info('Received triggerWebhook command:', data);
      try {
        this.player.triggerWebhook(data?.triggerCode || data);
        log.debug('triggerWebhook completed successfully');
      } catch (error) {
        log.error('triggerWebhook failed:', error);
      }
    });

    // CMS command: Data Update (force refresh data connectors)
    this.xmr.on('dataUpdate', async () => {
      log.info('Received dataUpdate command');
      try {
        this.player.refreshDataConnectors();
        log.debug('dataUpdate completed successfully');
      } catch (error) {
        log.error('dataUpdate failed:', error);
      }
    });

    // CMS command: Rekey (RSA key pair rotation) — spec event name is 'rekeyAction'
    this.xmr.on('rekeyAction', async () => {
      log.info('Received rekeyAction command - rotating RSA key pair');
      try {
        this.config.data.xmrPubKey = '';
        this.config.data.xmrPrivKey = '';
        await this.config.ensureXmrKeyPair();
        await this.player.collect();
        log.info('RSA key pair rotated successfully');
      } catch (error) {
        log.error('Key rotation failed:', error);
      }
    });

    // CMS command: Criteria Update
    this.xmr.on('criteriaUpdate', async (data) => {
      log.info('Received criteriaUpdate command:', data);
      try {
        await this.player.collect();
        log.debug('criteriaUpdate completed successfully');
      } catch (error) {
        log.error('criteriaUpdate failed:', error);
      }
    });

    // CMS command: Current Geo Location
    // Dual-path: if data has coordinates, CMS is telling us our location.
    // If data is empty/no coordinates, CMS is asking us to report our location.
    this.xmr.on('currentGeoLocation', async (data) => {
      log.info('Received currentGeoLocation command:', data);
      try {
        const hasCoordinates = data && data.latitude != null && data.longitude != null;

        if (hasCoordinates) {
          if (this.player.reportGeoLocation) {
            this.player.reportGeoLocation(data);
            log.debug('currentGeoLocation: coordinates applied');
          } else {
            log.warn('Geo location reporting not implemented in player');
          }
        } else {
          if (this.player.requestGeoLocation) {
            await this.player.requestGeoLocation();
            log.debug('currentGeoLocation: browser location requested');
          } else {
            log.warn('Geo location request not implemented in player');
          }
        }
      } catch (error) {
        log.error('currentGeoLocation failed:', error);
      }
    });
  }

  /**
   * Stop XMR connection and clean up the framework instance.
   * The framework's internal 60s timer is cleared when the instance
   * is discarded, so no reconnection will occur after stop().
   */
  async stop() {
    if (!this.xmr) return;

    try {
      await this.xmr.stop();
      this.connected = false;
      this.xmr = null;
      log.info('Stopped');
    } catch (error) {
      log.error('Error stopping:', error);
    }
  }

  /**
   * Check if XMR is connected
   * @returns {boolean}
   */
  isConnected() {
    return this.connected;
  }

  /**
   * Send a message to CMS (if needed for future features)
   * @param {string} action - Action name
   * @param {Object} data - Data payload
   */
  async send(action, data) {
    if (!this.connected || !this.xmr) {
      log.warn('Cannot send - not connected');
      return false;
    }

    try {
      await this.xmr.send(action, data);
      return true;
    } catch (error) {
      log.error('Error sending:', error);
      return false;
    }
  }
}
