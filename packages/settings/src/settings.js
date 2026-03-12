// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * DisplaySettings - CMS display settings management
 *
 * Parses and applies configuration from RegisterDisplay response.
 * Based on upstream electron-player implementation.
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────┐
 * │ PlayerCore                                          │
 * │ - Receives RegisterDisplay response                 │
 * │ - Passes to DisplaySettings.applySettings()         │
 * └─────────────────────────────────────────────────────┘
 *                          ↓
 * ┌─────────────────────────────────────────────────────┐
 * │ DisplaySettings (this module)                       │
 * │ - Parse all CMS settings                            │
 * │ - Validate and normalize values                     │
 * │ - Apply collection interval                         │
 * │ - Check download windows                            │
 * │ - Handle screenshot requests                        │
 * │ - Emit events on changes                            │
 * └─────────────────────────────────────────────────────┘
 *                          ↓
 * ┌─────────────────────────────────────────────────────┐
 * │ Platform Layer (PWA/Electron/Mobile)                │
 * │ - Listen for setting change events                  │
 * │ - Update UI with display name                       │
 * │ - Handle screenshot requests                        │
 * │ - Respect download windows                          │
 * └─────────────────────────────────────────────────────┘
 *
 * Usage:
 *   const settings = new DisplaySettings();
 *   settings.applySettings(regResult.settings);
 *
 *   // Get settings
 *   const collectInterval = settings.getCollectInterval();
 *   const canDownload = settings.isInDownloadWindow();
 *
 *   // Listen for changes
 *   settings.on('interval-changed', (newInterval) => { ... });
 */

import { EventEmitter, createLogger } from '@xiboplayer/utils';

const log = createLogger('DisplaySettings');

export class DisplaySettings extends EventEmitter {
  constructor() {
    super();

    // Current settings (with defaults)
    this.settings = {
      // Collection
      collectInterval: 300, // seconds (5 minutes default)

      // Display info
      displayName: 'Unknown Display',
      sizeX: 1920,
      sizeY: 1080,

      // Stats
      statsEnabled: false,
      aggregationLevel: 'Individual', // or 'Aggregate'

      // Logging
      logLevel: 'error', // 'error', 'audit', 'info', 'debug'

      // XMR
      xmrNetworkAddress: null,
      xmrWebSocketAddress: null,
      xmrCmsKey: null,

      // Features
      preventSleep: true,
      embeddedServerPort: 9696,
      screenshotInterval: 120, // seconds

      // Download windows
      downloadStartWindow: null,
      downloadEndWindow: null,

      // License
      licenceCode: null,

      // SSP (ad space)
      isSspEnabled: false,
    };
  }

  /**
   * Apply settings from RegisterDisplay response
   * @param {Object} settings - Raw settings from CMS
   * @returns {Object} Applied settings with changes
   */
  applySettings(settings) {
    if (!settings) {
      log.warn('No settings provided');
      return { changed: [], settings: this.settings };
    }

    const changes = [];
    const oldInterval = this.settings.collectInterval;

    // Parse all settings with defaults
    // Handle both lowercase and CamelCase (uppercase first letter)
    this.settings.collectInterval = this.parseCollectInterval(settings.collectInterval || settings.CollectInterval);
    this.settings.displayName = settings.displayName || settings.DisplayName || this.settings.displayName;
    this.settings.sizeX = parseInt(settings.sizeX || settings.SizeX || this.settings.sizeX);
    this.settings.sizeY = parseInt(settings.sizeY || settings.SizeY || this.settings.sizeY);

    // Stats
    this.settings.statsEnabled = this.parseBoolean(settings.statsEnabled || settings.StatsEnabled);
    this.settings.aggregationLevel = settings.aggregationLevel || settings.AggregationLevel || this.settings.aggregationLevel;

    // Logging
    this.settings.logLevel = settings.logLevel || settings.LogLevel || this.settings.logLevel;

    // XMR
    this.settings.xmrNetworkAddress = settings.xmrNetworkAddress || settings.XmrNetworkAddress || this.settings.xmrNetworkAddress;
    this.settings.xmrWebSocketAddress = settings.xmrWebSocketAddress || settings.XmrWebSocketAddress || this.settings.xmrWebSocketAddress;
    this.settings.xmrCmsKey = settings.xmrCmsKey || settings.XmrCmsKey || this.settings.xmrCmsKey;

    // Features
    this.settings.preventSleep = this.parseBoolean(settings.preventSleep || settings.PreventSleep, true);
    this.settings.embeddedServerPort = parseInt(settings.embeddedServerPort || settings.EmbeddedServerPort || this.settings.embeddedServerPort);
    this.settings.screenshotInterval = parseInt(settings.screenshotInterval || settings.ScreenshotInterval || this.settings.screenshotInterval);

    // Download windows
    this.settings.downloadStartWindow = settings.downloadStartWindow || settings.DownloadStartWindow || this.settings.downloadStartWindow;
    this.settings.downloadEndWindow = settings.downloadEndWindow || settings.DownloadEndWindow || this.settings.downloadEndWindow;

    // License
    this.settings.licenceCode = settings.licenceCode || settings.LicenceCode || this.settings.licenceCode;

    // SSP
    this.settings.isSspEnabled = this.parseBoolean(settings.isAdspaceEnabled || settings.IsAdspaceEnabled);

    // Detect changes
    if (oldInterval !== this.settings.collectInterval) {
      changes.push('collectInterval');
      this.emit('interval-changed', this.settings.collectInterval);
    }

    // Emit generic settings-applied event
    this.emit('settings-applied', this.settings, changes);

    log.info('Applied settings:', {
      collectInterval: this.settings.collectInterval,
      displayName: this.settings.displayName,
      statsEnabled: this.settings.statsEnabled,
      changes
    });

    return { changed: changes, settings: this.settings };
  }

  /**
   * Parse collection interval (seconds)
   * @param {*} value - Raw value from CMS
   * @returns {number} Collection interval in seconds
   */
  parseCollectInterval(value) {
    const interval = parseInt(value, 10);

    // Validate range (minimum 60s, maximum 86400s = 24h)
    if (isNaN(interval) || interval < 60) {
      return 300; // 5 minutes default
    }

    if (interval > 86400) {
      return 86400; // 24 hours max
    }

    return interval;
  }

  /**
   * Parse boolean setting
   * @param {*} value - Raw value from CMS (string '1' or '0', or boolean)
   * @param {boolean} defaultValue - Default if not set
   * @returns {boolean}
   */
  parseBoolean(value, defaultValue = false) {
    if (value === true || value === false) {
      return value;
    }

    if (value === '1' || value === 1) {
      return true;
    }

    if (value === '0' || value === 0) {
      return false;
    }

    return defaultValue;
  }

  /**
   * Get collection interval in seconds
   * @returns {number}
   */
  getCollectInterval() {
    return this.settings.collectInterval;
  }

  /**
   * Get display name
   * @returns {string}
   */
  getDisplayName() {
    return this.settings.displayName;
  }

  /**
   * Get display size
   * @returns {{ width: number, height: number }}
   */
  getDisplaySize() {
    return {
      width: this.settings.sizeX,
      height: this.settings.sizeY
    };
  }

  /**
   * Check if stats are enabled
   * @returns {boolean}
   */
  isStatsEnabled() {
    return this.settings.statsEnabled;
  }

  /**
   * Get all settings
   * @returns {Object}
   */
  getAllSettings() {
    return { ...this.settings };
  }

  /**
   * Get a specific setting by key
   * @param {string} key - Setting key
   * @param {*} defaultValue - Default value if not set
   * @returns {*}
   */
  getSetting(key, defaultValue = null) {
    return this.settings[key] !== undefined ? this.settings[key] : defaultValue;
  }

  /**
   * Check if current time is within download window
   * @returns {boolean}
   */
  isInDownloadWindow() {
    // If no download window configured, always allow
    // CMS sends ":" when unconfigured, treat as empty
    if (!this.settings.downloadStartWindow || !this.settings.downloadEndWindow ||
        this.settings.downloadStartWindow === ':' || this.settings.downloadEndWindow === ':') {
      return true;
    }

    try {
      const now = new Date();
      const currentTime = now.getHours() * 60 + now.getMinutes();

      const start = this.parseTimeWindow(this.settings.downloadStartWindow);
      const end = this.parseTimeWindow(this.settings.downloadEndWindow);

      // Handle overnight window (e.g., 22:00 - 06:00)
      if (start > end) {
        // Overnight: allow if AFTER start OR BEFORE end
        return currentTime >= start || currentTime < end;
      } else {
        // Same day: allow if AFTER start AND BEFORE end
        return currentTime >= start && currentTime < end;
      }
    } catch (error) {
      log.warn('Failed to parse download window:', error);
      return true; // Allow downloads if parsing fails
    }
  }

  /**
   * Parse time window string to minutes since midnight
   * @param {string} timeStr - Time string (e.g., "14:30", "22:00")
   * @returns {number} Minutes since midnight
   */
  parseTimeWindow(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') {
      throw new Error('Invalid time window format');
    }

    const parts = timeStr.split(':');
    if (parts.length !== 2) {
      throw new Error('Invalid time window format (expected HH:MM)');
    }

    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);

    if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      throw new Error('Invalid time window values');
    }

    return hours * 60 + minutes;
  }

  /**
   * Get next download window start time
   * @returns {Date|null} Next window start, or null if always allowed
   */
  getNextDownloadWindow() {
    if (!this.settings.downloadStartWindow || !this.settings.downloadEndWindow ||
        this.settings.downloadStartWindow === ':' || this.settings.downloadEndWindow === ':') {
      return null;
    }

    try {
      const now = new Date();
      const currentTime = now.getHours() * 60 + now.getMinutes();
      const start = this.parseTimeWindow(this.settings.downloadStartWindow);

      const nextWindow = new Date(now);

      if (currentTime < start) {
        // Window is later today
        nextWindow.setHours(Math.floor(start / 60), start % 60, 0, 0);
      } else {
        // Window is tomorrow
        nextWindow.setDate(nextWindow.getDate() + 1);
        nextWindow.setHours(Math.floor(start / 60), start % 60, 0, 0);
      }

      return nextWindow;
    } catch (error) {
      log.warn('Failed to calculate next download window:', error);
      return null;
    }
  }

  /**
   * Check if screenshot interval has elapsed
   * @param {Date} lastScreenshot - Last screenshot timestamp
   * @returns {boolean}
   */
  shouldTakeScreenshot(lastScreenshot) {
    if (!lastScreenshot) {
      return true;
    }

    const elapsed = (Date.now() - lastScreenshot.getTime()) / 1000;
    return elapsed >= this.settings.screenshotInterval;
  }
}
