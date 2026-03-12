// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * DataConnectorManager - Manages real-time data connectors from CMS
 *
 * Data connectors allow widgets to receive real-time data from CMS-configured
 * data sources. The CMS sends data connector configuration via the schedule XML,
 * and this manager periodically polls the data source URLs, stores the data,
 * and emits events so the IC /realtime route can serve it to widgets.
 *
 * Usage:
 *   const manager = new DataConnectorManager();
 *   manager.setConnectors(schedule.dataConnectors);
 *   manager.startPolling();
 *
 *   // Get data for a widget
 *   const data = manager.getData('weather_data');
 *
 *   // Listen for updates
 *   manager.on('data-updated', (dataKey, data) => { ... });
 */

import { EventEmitter, createLogger, fetchWithRetry } from '@xiboplayer/utils';

const log = createLogger('DataConnector');

export class DataConnectorManager extends EventEmitter {
  constructor() {
    super();

    // dataKey -> { config, data, timer, lastFetch }
    this.connectors = new Map();
  }

  /**
   * Set active connectors from schedule
   * Stops any existing polling and reconfigures with new connector list.
   * @param {Array} connectors - Array of connector config objects from schedule XML
   *   Each: { id, dataConnectorId, dataKey, url, updateInterval }
   */
  setConnectors(connectors) {
    // Stop existing polling before reconfiguring
    this.stopPolling();

    // Clear previous connectors
    this.connectors.clear();

    if (!connectors || connectors.length === 0) {
      log.debug('No data connectors configured');
      return;
    }

    for (const connector of connectors) {
      if (!connector.dataKey || !connector.url) {
        log.warn('Skipping data connector with missing dataKey or url:', connector);
        continue;
      }

      this.connectors.set(connector.dataKey, {
        config: connector,
        data: null,
        timer: null,
        lastFetch: null
      });

      log.info(`Registered data connector: ${connector.dataKey} (interval: ${connector.updateInterval}s)`);
    }

    log.info(`${this.connectors.size} data connector(s) configured`);
  }

  /**
   * Start polling for all active connectors
   * Performs an initial fetch immediately, then sets up periodic polling.
   */
  startPolling() {
    for (const [dataKey, entry] of this.connectors.entries()) {
      const { config } = entry;
      const intervalMs = (config.updateInterval || 300) * 1000;

      // Fetch immediately on start
      this.fetchData(entry).catch(err => {
        log.error(`Initial fetch failed for ${dataKey}:`, err);
      });

      // Set up periodic polling
      entry.timer = setInterval(() => {
        this.fetchData(entry).catch(err => {
          log.error(`Polling fetch failed for ${dataKey}:`, err);
        });
      }, intervalMs);

      log.debug(`Started polling for ${dataKey} every ${config.updateInterval}s`);
    }
  }

  /**
   * Stop all polling timers
   */
  stopPolling() {
    for (const [dataKey, entry] of this.connectors.entries()) {
      if (entry.timer) {
        clearInterval(entry.timer);
        entry.timer = null;
        log.debug(`Stopped polling for ${dataKey}`);
      }
    }
  }

  /**
   * Get current data for a dataKey
   * @param {string} dataKey - The data key to look up
   * @returns {Object|null} The stored data, or null if not available
   */
  getData(dataKey) {
    const entry = this.connectors.get(dataKey);
    if (!entry) {
      log.debug(`No data connector found for key: ${dataKey}`);
      return null;
    }
    return entry.data;
  }

  /**
   * Get all data keys that have data available
   * @returns {string[]} Array of data keys with data
   */
  getAvailableKeys() {
    const keys = [];
    for (const [dataKey, entry] of this.connectors.entries()) {
      if (entry.data !== null) {
        keys.push(dataKey);
      }
    }
    return keys;
  }

  /**
   * Internal: fetch data from CMS data source
   * @param {Object} entry - Connector entry from this.connectors
   */
  async fetchData(entry) {
    const { config } = entry;
    const { dataKey, url } = config;

    log.debug(`Fetching data for ${dataKey}: ${url}`);

    try {
      const response = await fetchWithRetry(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      }, { maxRetries: 2, baseDelayMs: 2000 });

      if (!response.ok) {
        log.warn(`Data connector ${dataKey} returned ${response.status}: ${response.statusText}`);
        return;
      }

      const contentType = response.headers.get('Content-Type') || '';
      let data;

      if (contentType.includes('application/json')) {
        data = await response.json();
      } else {
        // Store as raw text if not JSON
        data = await response.text();
      }

      const previousData = entry.data;
      entry.data = data;
      entry.lastFetch = Date.now();

      log.debug(`Data updated for ${dataKey} (fetched at ${new Date(entry.lastFetch).toISOString()})`);

      // Emit event for listeners (IC route, platform layer)
      this.emit('data-updated', dataKey, data);

      // Emit a specific event if data actually changed
      if (JSON.stringify(previousData) !== JSON.stringify(data)) {
        this.emit('data-changed', dataKey, data);
      }

    } catch (error) {
      log.error(`Failed to fetch data for ${dataKey}:`, error);
      this.emit('fetch-error', dataKey, error);
    }
  }

  /**
   * Cleanup - stop all polling and remove listeners
   */
  cleanup() {
    this.stopPolling();
    this.connectors.clear();
    this.removeAllListeners();
    log.debug('DataConnectorManager cleaned up');
  }
}
