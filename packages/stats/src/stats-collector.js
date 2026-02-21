/**
 * StatsCollector - Proof of play tracking for Xibo CMS
 *
 * Tracks layout and widget playback for reporting to CMS via XMDS.
 * Uses IndexedDB for persistent storage across sessions.
 *
 * @module @xiboplayer/stats/collector
 */

import { createLogger } from '@xiboplayer/utils';

const log = createLogger('@xiboplayer/stats');

// IndexedDB configuration
const DB_NAME = 'xibo-player-stats';
const DB_VERSION = 1;
const STATS_STORE = 'stats';

/**
 * Stats collector for proof of play tracking
 *
 * Stores layout and widget playback statistics in IndexedDB.
 * Stats are submitted to CMS via XMDS SubmitStats API.
 *
 * @example
 * const collector = new StatsCollector();
 * await collector.init();
 *
 * // Track layout
 * await collector.startLayout(123, 456);
 * // ... layout plays ...
 * await collector.endLayout(123, 456);
 *
 * // Get stats for submission
 * const stats = await collector.getStatsForSubmission(50);
 * const xml = formatStats(stats);
 * // ... submit to CMS ...
 * await collector.clearSubmittedStats(stats);
 */
export class StatsCollector {
  constructor() {
    this.db = null;
    this.inProgressStats = new Map(); // Track in-progress stats by key
  }

  /**
   * Initialize IndexedDB
   *
   * Creates stats store with index on 'submitted' field for fast queries.
   * Safe to call multiple times (idempotent).
   *
   * @returns {Promise<void>}
   * @throws {Error} If IndexedDB is not available or initialization fails
   */
  async init() {
    if (this.db) {
      log.debug('Stats collector already initialized');
      return;
    }

    return new Promise((resolve, reject) => {
      // Check if IndexedDB is available
      if (typeof indexedDB === 'undefined') {
        const error = new Error('IndexedDB not available');
        log.error('IndexedDB not available - stats will not be persisted');
        reject(error);
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        const error = new Error(`Failed to open IndexedDB: ${request.error}`);
        log.error('Failed to open stats database:', request.error);
        reject(error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        log.info('Stats database initialized');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Create stats store if it doesn't exist
        if (!db.objectStoreNames.contains(STATS_STORE)) {
          const store = db.createObjectStore(STATS_STORE, {
            keyPath: 'id',
            autoIncrement: true
          });

          // Index on 'submitted' for fast queries
          store.createIndex('submitted', 'submitted', { unique: false });

          log.info('Stats store created');
        }
      };
    });
  }

  /**
   * Start tracking a layout
   *
   * Creates a new layout stat entry and tracks it as in-progress.
   * If a layout with the same ID is already in progress (replay),
   * silently ends the previous cycle and starts a new one.
   *
   * @param {number} layoutId - Layout ID from CMS
   * @param {number} scheduleId - Schedule ID that triggered this layout
   * @returns {Promise<void>}
   */
  async startLayout(layoutId, scheduleId) {
    if (!this.db) {
      log.warn('Stats database not initialized');
      return;
    }

    // Key excludes scheduleId: only one layout instance can be in-progress at a time,
    // and scheduleId may change mid-play when a collection cycle completes.
    const key = `layout-${layoutId}`;

    // Layout replay: end previous cycle silently before starting new one
    if (this.inProgressStats.has(key)) {
      const prev = this.inProgressStats.get(key);
      prev.end = new Date();
      prev.duration = Math.floor((prev.end - prev.start) / 1000);
      await this._saveStatSplit(prev);
      this.inProgressStats.delete(key);
      log.debug(`Layout ${layoutId} replay - ended previous cycle (${prev.duration}s)`);
    }

    const stat = {
      type: 'layout',
      layoutId,
      scheduleId,
      start: new Date(),
      end: null,
      duration: 0,
      count: 1,
      submitted: 0 // Use 0/1 instead of boolean for IndexedDB compatibility
    };

    this.inProgressStats.set(key, stat);
    log.debug(`Started tracking layout ${layoutId} (schedule ${scheduleId})`);
  }

  /**
   * End tracking a layout
   *
   * Finalizes the layout stat entry and saves it to IndexedDB.
   * Calculates duration in seconds.
   *
   * @param {number} layoutId - Layout ID from CMS
   * @param {number} scheduleId - Schedule ID that triggered this layout
   * @returns {Promise<void>}
   */
  async endLayout(layoutId, scheduleId) {
    if (!this.db) {
      log.warn('Stats database not initialized');
      return;
    }

    const key = `layout-${layoutId}`;
    const stat = this.inProgressStats.get(key);

    if (!stat) {
      log.debug(`Layout ${layoutId} not found in progress (may have been ended by replay)`);
      return;
    }

    // Calculate duration in seconds
    stat.end = new Date();
    stat.duration = Math.floor((stat.end - stat.start) / 1000);

    // Save to database (splitting at hour boundaries for CMS aggregation)
    try {
      await this._saveStatSplit(stat);
      this.inProgressStats.delete(key);
      log.debug(`Ended tracking layout ${layoutId} (${stat.duration}s)`);
    } catch (error) {
      log.error(`Failed to save layout stat ${layoutId}:`, error);
      throw error;
    }
  }

  /**
   * Start tracking a widget/media
   *
   * Creates a new media stat entry and tracks it as in-progress.
   * If a widget with the same key is already in progress (replay),
   * silently ends the previous cycle and starts a new one.
   *
   * @param {number} mediaId - Media ID from CMS
   * @param {number} layoutId - Parent layout ID
   * @param {number} scheduleId - Schedule ID
   * @returns {Promise<void>}
   */
  async startWidget(mediaId, layoutId, scheduleId) {
    if (!this.db) {
      log.warn('Stats database not initialized');
      return;
    }

    // Key excludes scheduleId: it may change mid-play during collection cycles.
    const key = `media-${mediaId}-${layoutId}`;

    // Widget replay: end previous cycle silently before starting new one
    if (this.inProgressStats.has(key)) {
      const prev = this.inProgressStats.get(key);
      prev.end = new Date();
      prev.duration = Math.floor((prev.end - prev.start) / 1000);
      await this._saveStatSplit(prev);
      this.inProgressStats.delete(key);
      log.debug(`Widget ${mediaId} replay - ended previous cycle (${prev.duration}s)`);
    }

    const stat = {
      type: 'media',
      mediaId,
      layoutId,
      scheduleId,
      start: new Date(),
      end: null,
      duration: 0,
      count: 1,
      submitted: 0 // Use 0/1 instead of boolean for IndexedDB compatibility
    };

    this.inProgressStats.set(key, stat);
    log.debug(`Started tracking widget ${mediaId} in layout ${layoutId}`);
  }

  /**
   * End tracking a widget/media
   *
   * Finalizes the media stat entry and saves it to IndexedDB.
   * Calculates duration in seconds.
   *
   * @param {number} mediaId - Media ID from CMS
   * @param {number} layoutId - Parent layout ID
   * @param {number} scheduleId - Schedule ID
   * @returns {Promise<void>}
   */
  async endWidget(mediaId, layoutId, scheduleId) {
    if (!this.db) {
      log.warn('Stats database not initialized');
      return;
    }

    const key = `media-${mediaId}-${layoutId}`;
    const stat = this.inProgressStats.get(key);

    if (!stat) {
      log.debug(`Widget ${mediaId} not found in progress (expected during layout transitions)`);
      return;
    }

    // Calculate duration in seconds
    stat.end = new Date();
    stat.duration = Math.floor((stat.end - stat.start) / 1000);

    // Save to database (splitting at hour boundaries for CMS aggregation)
    try {
      await this._saveStatSplit(stat);
      this.inProgressStats.delete(key);
      log.debug(`Ended tracking widget ${mediaId} (${stat.duration}s)`);
    } catch (error) {
      log.error(`Failed to save widget stat ${mediaId}:`, error);
      throw error;
    }
  }

  /**
   * Record an event stat (point-in-time engagement data)
   *
   * Creates an instant stat entry with no duration. Used for tracking
   * interactive touches, webhook triggers, and other engagement events.
   * Unlike layout/widget stats, events have no start/end cycle.
   *
   * @param {string} tag - Event tag describing the interaction (e.g. 'touch', 'webhook')
   * @param {number} layoutId - Layout ID where the event occurred
   * @param {number} widgetId - Widget ID that triggered the event
   * @param {number} scheduleId - Schedule ID for the current schedule
   * @returns {Promise<void>}
   */
  async recordEvent(tag, layoutId, widgetId, scheduleId) {
    if (!this.db) {
      log.warn('Stats database not initialized');
      return;
    }

    const now = new Date();
    const stat = {
      type: 'event',
      tag,
      layoutId,
      widgetId,
      scheduleId,
      start: now,
      end: now,
      duration: 0,
      count: 1,
      submitted: 0
    };

    try {
      await this._saveStat(stat);
      log.debug(`Recorded event '${tag}' for widget ${widgetId} in layout ${layoutId}`);
    } catch (error) {
      log.error(`Failed to record event '${tag}':`, error);
      throw error;
    }
  }

  /**
   * Get stats ready for submission to CMS
   *
   * Returns unsubmitted stats up to the specified limit.
   * Stats are ordered by ID (oldest first).
   *
   * @param {number} limit - Maximum number of stats to return (default: 50)
   * @returns {Promise<Array>} Array of stat objects
   */
  async getStatsForSubmission(limit = 50) {
    if (!this.db) {
      log.warn('Stats database not initialized');
      return [];
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STATS_STORE], 'readonly');
      const store = transaction.objectStore(STATS_STORE);
      const index = store.index('submitted');

      // Query for unsubmitted stats (0 = false)
      const request = index.openCursor(IDBKeyRange.only(0));
      const stats = [];

      request.onsuccess = (event) => {
        const cursor = event.target.result;

        if (cursor && stats.length < limit) {
          stats.push(cursor.value);
          cursor.continue();
        } else {
          log.debug(`Retrieved ${stats.length} unsubmitted stats`);
          resolve(stats);
        }
      };

      request.onerror = () => {
        log.error('Failed to retrieve stats:', request.error);
        reject(new Error(`Failed to retrieve stats: ${request.error}`));
      };
    });
  }

  /**
   * Clear submitted stats from database
   *
   * Deletes stats that were successfully submitted to CMS.
   *
   * @param {Array} stats - Array of stat objects to delete
   * @returns {Promise<void>}
   */
  async clearSubmittedStats(stats) {
    if (!this.db) {
      log.warn('Stats database not initialized');
      return;
    }

    if (!stats || stats.length === 0) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STATS_STORE], 'readwrite');
      const store = transaction.objectStore(STATS_STORE);

      let deletedCount = 0;

      stats.forEach((stat) => {
        if (stat.id) {
          const request = store.delete(stat.id);
          request.onsuccess = () => {
            deletedCount++;
          };
          request.onerror = () => {
            log.error(`Failed to delete stat ${stat.id}:`, request.error);
          };
        }
      });

      transaction.oncomplete = () => {
        log.debug(`Deleted ${deletedCount} submitted stats`);
        resolve();
      };

      transaction.onerror = () => {
        log.error('Failed to delete submitted stats:', transaction.error);
        reject(new Error(`Failed to delete stats: ${transaction.error}`));
      };
    });
  }

  /**
   * Get aggregated stats for submission
   *
   * Groups stats by (type, layoutId, mediaId, scheduleId, hour) and sums
   * durations/counts. Used when CMS aggregationLevel is 'Aggregate'.
   *
   * @param {number} limit - Maximum number of raw stats to read (default: 50)
   * @returns {Promise<Array>} Aggregated stat objects
   */
  async getAggregatedStatsForSubmission(limit = 50) {
    const rawStats = await this.getStatsForSubmission(limit);
    if (rawStats.length === 0) return [];

    // Group by (type, layoutId, mediaId, scheduleId, hour)
    const groups = new Map();
    for (const stat of rawStats) {
      const hour = stat.start instanceof Date
        ? stat.start.toISOString().slice(0, 13)
        : new Date(stat.start).toISOString().slice(0, 13);
      const key = `${stat.type}|${stat.layoutId}|${stat.mediaId || ''}|${stat.widgetId || ''}|${stat.tag || ''}|${stat.scheduleId}|${hour}`;

      if (groups.has(key)) {
        const group = groups.get(key);
        group.count += stat.count || 1;
        group.duration += stat.duration || 0;
        // Keep earliest start and latest end
        const statStart = stat.start instanceof Date ? stat.start : new Date(stat.start);
        const statEnd = stat.end instanceof Date ? stat.end : new Date(stat.end || stat.start);
        if (statStart < group.start) group.start = statStart;
        if (statEnd > group.end) group.end = statEnd;
        group._rawIds.push(stat.id);
      } else {
        groups.set(key, {
          ...stat,
          start: stat.start instanceof Date ? stat.start : new Date(stat.start),
          end: stat.end instanceof Date ? stat.end : new Date(stat.end || stat.start),
          count: stat.count || 1,
          _rawIds: [stat.id]
        });
      }
    }

    return Array.from(groups.values());
  }

  /**
   * Get all stats (for debugging)
   *
   * @returns {Promise<Array>} All stats in database
   */
  async getAllStats() {
    if (!this.db) {
      log.warn('Stats database not initialized');
      return [];
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STATS_STORE], 'readonly');
      const store = transaction.objectStore(STATS_STORE);
      const request = store.getAll();

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        log.error('Failed to get all stats:', request.error);
        reject(new Error(`Failed to get all stats: ${request.error}`));
      };
    });
  }

  /**
   * Clear all stats (for testing)
   *
   * @returns {Promise<void>}
   */
  async clearAllStats() {
    if (!this.db) {
      log.warn('Stats database not initialized');
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STATS_STORE], 'readwrite');
      const store = transaction.objectStore(STATS_STORE);
      const request = store.clear();

      request.onsuccess = () => {
        log.debug('Cleared all stats');
        this.inProgressStats.clear();
        resolve();
      };

      request.onerror = () => {
        log.error('Failed to clear all stats:', request.error);
        reject(new Error(`Failed to clear stats: ${request.error}`));
      };
    });
  }

  /**
   * Save a stat to IndexedDB
   * @private
   */
  async _saveStat(stat) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STATS_STORE], 'readwrite');
      const store = transaction.objectStore(STATS_STORE);
      const request = store.add(stat);

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        // Check for quota exceeded error
        if (request.error.name === 'QuotaExceededError') {
          log.error('IndexedDB quota exceeded - cleaning old stats');
          this._cleanOldStats().then(() => {
            // Retry once after cleanup
            const retryRequest = store.add(stat);
            retryRequest.onsuccess = () => resolve(retryRequest.result);
            retryRequest.onerror = () => reject(retryRequest.error);
          }).catch(reject);
        } else {
          reject(request.error);
        }
      };
    });
  }

  /**
   * Split a stat record at hour boundaries.
   * If a stat spans multiple hours (e.g. 12:50→13:10), it is split into
   * separate records at each hour boundary for correct CMS aggregation.
   * Returns an array of one or more stat objects.
   * @param {Object} stat - Finalized stat with start, end, duration
   * @returns {Object[]}
   * @private
   */
  _splitAtHourBoundaries(stat) {
    const start = stat.start;
    const end = stat.end;

    // No split needed if start and end are in the same hour
    if (start.getFullYear() === end.getFullYear() &&
        start.getMonth() === end.getMonth() &&
        start.getDate() === end.getDate() &&
        start.getHours() === end.getHours()) {
      return [stat];
    }

    const results = [];
    let segStart = new Date(start.getTime());

    while (segStart < end) {
      // Next hour boundary: top of the next hour from segStart
      const nextHour = new Date(segStart.getTime());
      nextHour.setMinutes(0, 0, 0);
      nextHour.setHours(nextHour.getHours() + 1);

      const segEnd = nextHour < end ? nextHour : end;
      const duration = Math.floor((segEnd - segStart) / 1000);

      results.push({
        ...stat,
        start: new Date(segStart.getTime()),
        end: new Date(segEnd.getTime()),
        duration,
        count: 1
      });

      segStart = segEnd;
    }

    return results;
  }

  /**
   * Save a stat to IndexedDB, splitting at hour boundaries first.
   * @param {Object} stat - Finalized stat with start, end, duration
   * @private
   */
  async _saveStatSplit(stat) {
    const parts = this._splitAtHourBoundaries(stat);
    for (const part of parts) {
      await this._saveStat(part);
    }
  }

  /**
   * Clean old stats when quota is exceeded
   * Deletes oldest 100 submitted stats
   * @private
   */
  async _cleanOldStats() {
    if (!this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STATS_STORE], 'readwrite');
      const store = transaction.objectStore(STATS_STORE);
      const index = store.index('submitted');

      // Get oldest 100 submitted stats (use 1 for boolean true in IndexedDB)
      const request = index.openCursor(1);
      const toDelete = [];

      request.onsuccess = (event) => {
        const cursor = event.target.result;

        if (cursor && toDelete.length < 100) {
          toDelete.push(cursor.value.id);
          cursor.continue();
        } else {
          // Delete collected IDs
          toDelete.forEach((id) => {
            store.delete(id);
          });

          log.info(`Cleaned ${toDelete.length} old stats due to quota`);
          resolve();
        }
      };

      request.onerror = () => {
        log.error('Failed to clean old stats:', request.error);
        reject(request.error);
      };
    });
  }
}

/**
 * Format stats as XML for XMDS submission
 *
 * Converts array of stat objects to XML format expected by CMS.
 *
 * XML format:
 * ```xml
 * <stats>
 *   <stat type="layout" fromdt="2026-02-10 12:00:00" todt="2026-02-10 12:05:00"
 *         scheduleid="123" layoutid="456" count="1" duration="300" />
 *   <stat type="media" fromdt="2026-02-10 12:00:00" todt="2026-02-10 12:01:00"
 *         scheduleid="123" layoutid="456" mediaid="789" count="1" duration="60" />
 * </stats>
 * ```
 *
 * @param {Array} stats - Array of stat objects from getStatsForSubmission()
 * @returns {string} XML string for XMDS SubmitStats
 *
 * @example
 * const stats = await collector.getStatsForSubmission(50);
 * const xml = formatStats(stats);
 * await xmds.submitStats(xml);
 */
export function formatStats(stats) {
  if (!stats || stats.length === 0) {
    return '<stats></stats>';
  }

  const statElements = stats.map((stat) => {
    // Format dates as "YYYY-MM-DD HH:MM:SS"
    const fromdt = formatDateTime(stat.start);
    const todt = formatDateTime(stat.end || stat.start);

    // Build attributes
    const attrs = [
      `type="${escapeXml(stat.type)}"`,
      `fromdt="${escapeXml(fromdt)}"`,
      `todt="${escapeXml(todt)}"`,
      `scheduleid="${stat.scheduleId}"`,
      `layoutid="${stat.layoutId}"`,
    ];

    // Add mediaId and widgetId for media/widget stats
    if (stat.type === 'media') {
      if (stat.mediaId) {
        attrs.push(`mediaid="${stat.mediaId}"`);
      }
      // Include widgetId for non-library widgets (native widgets have no mediaId)
      if (stat.widgetId) {
        attrs.push(`widgetid="${stat.widgetId}"`);
      }
    }

    // Add tag and widgetId for event stats
    if (stat.type === 'event') {
      if (stat.tag) {
        attrs.push(`tag="${escapeXml(stat.tag)}"`);
      }
      if (stat.widgetId) {
        attrs.push(`widgetid="${stat.widgetId}"`);
      }
    }

    // Add count and duration
    attrs.push(`count="${stat.count}"`);
    attrs.push(`duration="${stat.duration}"`);

    return `  <stat ${attrs.join(' ')} />`;
  });

  return `<stats>\n${statElements.join('\n')}\n</stats>`;
}

/**
 * Format Date object as "YYYY-MM-DD HH:MM:SS"
 * @private
 */
function formatDateTime(date) {
  if (!(date instanceof Date)) {
    date = new Date(date);
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Escape XML special characters
 * @private
 */
function escapeXml(str) {
  if (typeof str !== 'string') {
    return str;
  }

  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
