/**
 * XMR (Xibo Message Relay) Wrapper
 *
 * Integrates the official @xibosignage/xibo-communication-framework
 * to enable real-time push commands from CMS via WebSocket.
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

import { Xmr } from '@xibosignage/xibo-communication-framework';
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
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000; // 5 seconds
    this.lastXmrUrl = null;
    this.lastCmsKey = null;
    this.reconnectTimer = null;
    this.intentionalShutdown = false;
  }

  /**
   * Initialize and start XMR connection
   * @param {string} xmrUrl - WebSocket URL (ws:// or wss://)
   * @param {string} cmsKey - CMS authentication key
   * @returns {Promise<boolean>} Success status
   */
  async start(xmrUrl, cmsKey) {
    try {
      log.info('Initializing connection to:', xmrUrl);

      // Clear intentional shutdown flag (we're starting again)
      this.intentionalShutdown = false;

      // Save connection details for reconnection
      this.lastXmrUrl = xmrUrl;
      this.lastCmsKey = cmsKey;

      // Cancel any pending reconnect attempts
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      // Create XMR instance with channel ID (or reuse if already exists)
      if (!this.xmr) {
        const channel = this.config.xmrChannel || `player-${this.config.hardwareKey}`;
        this.xmr = new Xmr(channel);
        // Setup event handlers before connecting (only once)
        this.setupEventHandlers();
      }

      // Initialize and connect
      await this.xmr.init();
      await this.xmr.start(xmrUrl, cmsKey);

      this.connected = true;
      this.reconnectAttempts = 0;
      log.info('Connected successfully');

      return true;
    } catch (error) {
      log.warn('Failed to start:', error.message);
      log.info('Continuing in polling mode (XMDS only)');

      // Schedule reconnection attempt
      this.scheduleReconnect(xmrUrl, cmsKey);

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
      this.reconnectAttempts = 0;
      this.player.updateStatus?.('XMR connected');
    });

    this.xmr.on('disconnected', () => {
      log.warn('WebSocket disconnected');
      this.connected = false;
      this.player.updateStatus?.('XMR disconnected (polling mode)');

      // Attempt to reconnect if we have the connection details
      // BUT not if this was an intentional shutdown
      if (this.lastXmrUrl && this.lastCmsKey && !this.intentionalShutdown) {
        log.info('Connection lost, scheduling reconnection...');
        this.scheduleReconnect(this.lastXmrUrl, this.lastCmsKey);
      }
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
      // Linux clients always report valid license
      // No action needed - clientType: "linux" bypasses commercial license
    });

    // CMS command: Change Layout
    this.xmr.on('changeLayout', async (layoutId) => {
      log.info('Received changeLayout command:', layoutId);
      try {
        await this.player.changeLayout(layoutId);
        log.debug('changeLayout completed successfully');
      } catch (error) {
        log.error('changeLayout failed:', error);
      }
    });

    // CMS command: Overlay Layout
    this.xmr.on('overlayLayout', async (layoutId) => {
      log.info('Received overlayLayout command:', layoutId);
      try {
        await this.player.overlayLayout(layoutId);
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
    this.xmr.on('commandAction', async (data) => {
      log.info('Received commandAction command:', data);
      try {
        await this.player.executeCommand(data?.commandCode || data, data?.commands);
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

    // CMS command: Screen Shot (alternative event name)
    this.xmr.on('screenshot', async () => {
      log.info('Received screenshot command from CMS');
      try {
        await this.player.captureScreenshot();
      } catch (error) {
        log.error('screenshot failed:', error);
      }
    });

    // CMS command: Criteria Update
    this.xmr.on('criteriaUpdate', async (data) => {
      log.info('Received criteriaUpdate command:', data);
      try {
        // Trigger immediate collection to get updated display criteria
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
          // CMS is pushing coordinates to us
          if (this.player.reportGeoLocation) {
            this.player.reportGeoLocation(data);
            log.debug('currentGeoLocation: coordinates applied');
          } else {
            log.warn('Geo location reporting not implemented in player');
          }
        } else {
          // CMS is asking us to report our location via browser API
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
   * Schedule reconnection attempt
   */
  scheduleReconnect(xmrUrl, cmsKey) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.warn('Max reconnection attempts reached, giving up');
      log.info('Will retry on next collection cycle');
      return;
    }

    // Cancel any existing reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;

    log.debug(`Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      log.debug('Attempting to reconnect...');
      this.reconnectTimer = null;
      this.start(xmrUrl, cmsKey);
    }, delay);
  }

  /**
   * Stop XMR connection
   */
  async stop() {
    // Mark as intentional shutdown to prevent reconnection
    this.intentionalShutdown = true;

    // Cancel any pending reconnect attempts
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (!this.xmr) return;

    try {
      await this.xmr.stop();
      this.connected = false;
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
