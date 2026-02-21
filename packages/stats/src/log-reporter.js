/**
 * LogReporter - CMS logging for Xibo Players
 *
 * Collects and submits logs to CMS via XMDS.
 * Uses IndexedDB for persistent storage across sessions.
 *
 * @module @xiboplayer/stats/logger
 */

import { createLogger } from '@xiboplayer/utils';

const log = createLogger('@xiboplayer/stats');

// IndexedDB configuration
const DB_NAME = 'xibo-player-logs';
const DB_VERSION = 1;
const LOGS_STORE = 'logs';

/**
 * Log reporter for CMS logging
 *
 * Stores log entries in IndexedDB and submits to CMS via XMDS.
 * Supports multiple log levels: error, audit, info, debug.
 *
 * @example
 * const reporter = new LogReporter();
 * await reporter.init();
 *
 * // Log messages
 * await reporter.error('Failed to load layout', 'PLAYER');
 * await reporter.info('Layout loaded successfully', 'PLAYER');
 *
 * // Get logs for submission
 * const logs = await reporter.getLogsForSubmission(100);
 * const xml = formatLogs(logs);
 * // ... submit to CMS ...
 * await reporter.clearSubmittedLogs(logs);
 */
export class LogReporter {
  constructor() {
    this.db = null;
    this._reportedFaults = new Map(); // code -> timestamp (deduplication)
  }

  /**
   * Initialize IndexedDB
   *
   * Creates logs store with index on 'submitted' field for fast queries.
   * Safe to call multiple times (idempotent).
   *
   * @returns {Promise<void>}
   * @throws {Error} If IndexedDB is not available or initialization fails
   */
  async init() {
    if (this.db) {
      log.debug('Log reporter already initialized');
      return;
    }

    return new Promise((resolve, reject) => {
      // Check if IndexedDB is available
      if (typeof indexedDB === 'undefined') {
        const error = new Error('IndexedDB not available');
        log.error('IndexedDB not available - logs will not be persisted');
        reject(error);
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        const error = new Error(`Failed to open IndexedDB: ${request.error}`);
        log.error('Failed to open logs database:', request.error);
        reject(error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        log.info('Logs database initialized');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Create logs store if it doesn't exist
        if (!db.objectStoreNames.contains(LOGS_STORE)) {
          const store = db.createObjectStore(LOGS_STORE, {
            keyPath: 'id',
            autoIncrement: true
          });

          // Index on 'submitted' for fast queries
          store.createIndex('submitted', 'submitted', { unique: false });

          log.info('Logs store created');
        }
      };
    });
  }

  /**
   * Log a message
   *
   * Stores a log entry in IndexedDB for later submission to CMS.
   *
   * @param {string} level - Log level: 'error', 'audit', 'info', or 'debug'
   * @param {string} message - Log message
   * @param {string} category - Log category (default: 'PLAYER')
   * @param {Object} [extra] - Optional extra fields (alertType, eventType)
   * @returns {Promise<void>}
   */
  async log(level, message, category = 'PLAYER', extra = null) {
    if (!this.db) {
      // Use console directly — NOT the logger — to avoid infinite feedback loop.
      // The logger dispatches to log sinks, and this method IS the sink target.
      console.warn('[LogReporter] Database not initialized, dropping log entry');
      return;
    }

    // Validate log level
    const validLevels = ['error', 'warning', 'audit', 'info', 'debug'];
    if (!validLevels.includes(level)) {
      level = 'info';
    }

    const logEntry = {
      level,
      message,
      category,
      timestamp: new Date(),
      submitted: 0 // Use 0/1 instead of boolean for IndexedDB compatibility
    };

    // Add alert fields for faults (triggers CMS dashboard alerts)
    if (extra) {
      if (extra.alertType) logEntry.alertType = extra.alertType;
      if (extra.eventType) logEntry.eventType = extra.eventType;
    }

    try {
      await this._saveLog(logEntry);
      // NOTE: Do NOT call log.debug() here — it dispatches to sinks, which call
      // logReporter.log() again, creating an infinite async loop.
    } catch (error) {
      // Use console directly to avoid feedback loop
      console.error('[LogReporter] Failed to save log entry:', error);
      throw error;
    }
  }

  /**
   * Report a fault to CMS (special log entry that triggers alerts)
   *
   * Faults are log entries with alertType/eventType fields that cause the
   * CMS to show alerts on the display dashboard and optionally send emails.
   * Deduplicates by code: same fault code won't be reported again within
   * the cooldown period (default 5 minutes).
   *
   * @param {string} code - Fault code (e.g., 'LAYOUT_LOAD_FAILED')
   * @param {string} reason - Human-readable description
   * @param {number} [cooldownMs=300000] - Dedup cooldown in ms (default 5 min)
   * @returns {Promise<void>}
   */
  async reportFault(code, reason, cooldownMs = 300000) {
    // Deduplication: skip if same code was reported recently
    const lastReported = this._reportedFaults.get(code);
    if (lastReported && (Date.now() - lastReported) < cooldownMs) {
      return;
    }

    this._reportedFaults.set(code, Date.now());

    await this.log('error', reason, 'PLAYER', {
      alertType: 'Player Fault',
      eventType: code
    });

    log.info(`Fault reported: ${code} - ${reason}`);
  }

  /**
   * Log an error message
   *
   * Shorthand for log('error', message, category)
   *
   * @param {string} message - Error message
   * @param {string} category - Log category (default: 'PLAYER')
   * @returns {Promise<void>}
   */
  async error(message, category = 'PLAYER') {
    return this.log('error', message, category);
  }

  /**
   * Log an audit message
   *
   * Shorthand for log('audit', message, category)
   *
   * @param {string} message - Audit message
   * @param {string} category - Log category (default: 'PLAYER')
   * @returns {Promise<void>}
   */
  async audit(message, category = 'PLAYER') {
    return this.log('audit', message, category);
  }

  /**
   * Log an info message
   *
   * Shorthand for log('info', message, category)
   *
   * @param {string} message - Info message
   * @param {string} category - Log category (default: 'PLAYER')
   * @returns {Promise<void>}
   */
  async info(message, category = 'PLAYER') {
    return this.log('info', message, category);
  }

  /**
   * Log a debug message
   *
   * Shorthand for log('debug', message, category)
   *
   * @param {string} message - Debug message
   * @param {string} category - Log category (default: 'PLAYER')
   * @returns {Promise<void>}
   */
  async debug(message, category = 'PLAYER') {
    return this.log('debug', message, category);
  }

  /**
   * Get logs ready for submission to CMS
   *
   * Returns unsubmitted logs up to a limit determined by backlog size:
   * - Normal: up to 50 logs per submission
   * - Backlog (> 50 pending): up to 300 logs per submission
   * Aligns with upstream Xibo player spec limits.
   *
   * @param {number} [limit] - Override limit (omit for auto-detection)
   * @returns {Promise<Array>} Array of log objects
   */
  async getLogsForSubmission(limit) {
    if (!this.db) {
      log.warn('Logs database not initialized');
      return [];
    }

    // Auto-detect limit based on backlog size if not explicitly provided
    if (limit === undefined) {
      const pending = await this._countUnsubmitted();
      limit = pending > 50 ? 300 : 50;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([LOGS_STORE], 'readonly');
      const store = transaction.objectStore(LOGS_STORE);
      const index = store.index('submitted');

      // Query for unsubmitted logs (0 = false)
      const request = index.openCursor(IDBKeyRange.only(0));
      const logs = [];

      request.onsuccess = (event) => {
        const cursor = event.target.result;

        if (cursor && logs.length < limit) {
          logs.push(cursor.value);
          cursor.continue();
        } else {
          log.debug(`Retrieved ${logs.length} unsubmitted logs (limit: ${limit})`);
          resolve(logs);
        }
      };

      request.onerror = () => {
        log.error('Failed to retrieve logs:', request.error);
        reject(new Error(`Failed to retrieve logs: ${request.error}`));
      };
    });
  }

  /**
   * Count unsubmitted logs in the database.
   * @returns {Promise<number>}
   */
  async _countUnsubmitted() {
    return new Promise((resolve) => {
      try {
        const transaction = this.db.transaction([LOGS_STORE], 'readonly');
        const store = transaction.objectStore(LOGS_STORE);
        const index = store.index('submitted');
        const request = index.count(IDBKeyRange.only(0));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(0);
      } catch (_) {
        resolve(0);
      }
    });
  }

  /**
   * Clear submitted logs from database
   *
   * Deletes logs that were successfully submitted to CMS.
   *
   * @param {Array} logs - Array of log objects to delete
   * @returns {Promise<void>}
   */
  async clearSubmittedLogs(logs) {
    if (!this.db) {
      log.warn('Logs database not initialized');
      return;
    }

    if (!logs || logs.length === 0) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([LOGS_STORE], 'readwrite');
      const store = transaction.objectStore(LOGS_STORE);

      let deletedCount = 0;

      logs.forEach((logEntry) => {
        if (logEntry.id) {
          const request = store.delete(logEntry.id);
          request.onsuccess = () => {
            deletedCount++;
          };
          request.onerror = () => {
            log.error(`Failed to delete log ${logEntry.id}:`, request.error);
          };
        }
      });

      transaction.oncomplete = () => {
        log.debug(`Deleted ${deletedCount} submitted logs`);
        resolve();
      };

      transaction.onerror = () => {
        log.error('Failed to delete submitted logs:', transaction.error);
        reject(new Error(`Failed to delete logs: ${transaction.error}`));
      };
    });
  }

  /**
   * Get all logs (for debugging)
   *
   * @returns {Promise<Array>} All logs in database
   */
  async getAllLogs() {
    if (!this.db) {
      log.warn('Logs database not initialized');
      return [];
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([LOGS_STORE], 'readonly');
      const store = transaction.objectStore(LOGS_STORE);
      const request = store.getAll();

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        log.error('Failed to get all logs:', request.error);
        reject(new Error(`Failed to get all logs: ${request.error}`));
      };
    });
  }

  /**
   * Clear all logs (for testing)
   *
   * @returns {Promise<void>}
   */
  async clearAllLogs() {
    if (!this.db) {
      log.warn('Logs database not initialized');
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([LOGS_STORE], 'readwrite');
      const store = transaction.objectStore(LOGS_STORE);
      const request = store.clear();

      request.onsuccess = () => {
        log.debug('Cleared all logs');
        resolve();
      };

      request.onerror = () => {
        log.error('Failed to clear all logs:', request.error);
        reject(new Error(`Failed to clear logs: ${request.error}`));
      };
    });
  }

  /**
   * Save a log entry to IndexedDB
   * @private
   */
  async _saveLog(logEntry) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([LOGS_STORE], 'readwrite');
      const store = transaction.objectStore(LOGS_STORE);
      const request = store.add(logEntry);

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        // Check for quota exceeded error
        if (request.error.name === 'QuotaExceededError') {
          console.warn('[LogReporter] IndexedDB quota exceeded - cleaning old logs');
          this._cleanOldLogs().then(() => {
            // Retry once after cleanup
            const retryRequest = store.add(logEntry);
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
   * Clean old logs when quota is exceeded
   * Deletes oldest 100 submitted logs
   * @private
   */
  async _cleanOldLogs() {
    if (!this.db) {
      return;
    }

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([LOGS_STORE], 'readwrite');
      const store = transaction.objectStore(LOGS_STORE);
      const index = store.index('submitted');

      // Get oldest 100 submitted logs (use 1 for boolean true in IndexedDB)
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

          console.log(`[LogReporter] Cleaned ${toDelete.length} old logs due to quota`);
          resolve();
        }
      };

      request.onerror = () => {
        console.error('[LogReporter] Failed to clean old logs:', request.error);
        reject(request.error);
      };
    });
  }
}

/**
 * Format logs as XML for XMDS submission
 *
 * Converts array of log objects to XML format expected by CMS.
 *
 * XML format (spec-compliant):
 * ```xml
 * <logs>
 *   <log date="2026-02-10 12:00:00" category="error">
 *     <thread>main</thread>
 *     <method>collect</method>
 *     <message>Failed to load layout 123</message>
 *     <scheduleID>0</scheduleID>
 *   </log>
 * </logs>
 * ```
 *
 * @param {Array} logs - Array of log objects from getLogsForSubmission()
 * @returns {string} XML string for XMDS SubmitLog
 *
 * @example
 * const logs = await reporter.getLogsForSubmission(100);
 * const xml = formatLogs(logs);
 * await xmds.submitLog(xml);
 */
export function formatLogs(logs) {
  if (!logs || logs.length === 0) {
    return '<logs></logs>';
  }

  const logElements = logs.map((logEntry) => {
    // Format date as "YYYY-MM-DD HH:MM:SS"
    const date = formatDateTime(logEntry.timestamp);

    // Spec categories: only "error" and "audit" are valid
    const category = (logEntry.level === 'error' || logEntry.level === 'audit')
      ? logEntry.level : 'audit';

    // Build attributes on <log> element
    const attrs = [
      `date="${escapeXml(date)}"`,
      `category="${escapeXml(category)}"`
    ];

    // Fault alert fields (triggers CMS dashboard alerts)
    if (logEntry.alertType) {
      attrs.push(`alertType="${escapeXml(logEntry.alertType)}"`);
    }
    if (logEntry.eventType) {
      attrs.push(`eventType="${escapeXml(logEntry.eventType)}"`);
    }

    // Build child elements (spec format: thread, method, message, scheduleID)
    const thread = escapeXml(logEntry.thread || 'main');
    const method = escapeXml(logEntry.method || logEntry.category || 'PLAYER');
    const message = escapeXml(logEntry.message);
    const scheduleId = escapeXml(String(logEntry.scheduleId || '0'));

    return `  <log ${attrs.join(' ')}>\n    <thread>${thread}</thread>\n    <method>${method}</method>\n    <message>${message}</message>\n    <scheduleID>${scheduleId}</scheduleID>\n  </log>`;
  });

  return `<logs>\n${logElements.join('\n')}\n</logs>`;
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
