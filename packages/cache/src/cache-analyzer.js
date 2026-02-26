/**
 * CacheAnalyzer - Stale media detection and storage health monitoring
 *
 * Compares cached files against RequiredFiles from the CMS to identify
 * orphaned media that is no longer needed. Logs a summary every collection
 * cycle. Only evicts when storage pressure exceeds a configurable threshold.
 *
 * Works entirely through StoreClient (REST to proxy) — no IndexedDB,
 * no direct Cache API access.
 */

import { createLogger } from '@xiboplayer/utils';

const log = createLogger('CacheAnalyzer');

/**
 * Format bytes into human-readable string (e.g. 1.2 GB, 350 MB)
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (!Number.isFinite(bytes)) return '∞';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export class CacheAnalyzer {
  /**
   * @param {import('./store-client.js').StoreClient} cache - StoreClient instance
   * @param {object} [options]
   * @param {number} [options.threshold=80] - Storage usage % above which eviction triggers
   */
  constructor(cache, { threshold = 80 } = {}) {
    this.cache = cache;
    this.threshold = threshold;
  }

  /**
   * Analyze cache health by comparing cached files against required files.
   *
   * @param {Array<{id: string, type: string}>} requiredFiles - Current RequiredFiles from CMS
   * @returns {Promise<object>} Analysis report
   */
  async analyze(requiredFiles) {
    const cachedFiles = await this.cache.list();
    const storage = await this._getStorageEstimate();

    // Build set of required file IDs (as strings for consistent comparison)
    const requiredIds = new Set(requiredFiles.map(f => String(f.id)));

    // Categorize cached files
    const required = [];
    const orphaned = [];

    for (const file of cachedFiles) {
      if (requiredIds.has(String(file.id))) {
        required.push(file);
      } else if (file.type === 'widget') {
        // Widget HTML IDs are "layoutId/regionId/widgetId" — check parent layout
        const parentLayoutId = String(file.id).split('/')[0];
        if (requiredIds.has(parentLayoutId)) {
          required.push(file);
        } else {
          orphaned.push(file);
        }
      } else if (file.type === 'static') {
        // Static files (bundle.min.js, fonts.css, fonts, images) are shared widget
        // dependencies — never orphan them, they're referenced from widget HTML
        required.push(file);
      } else {
        orphaned.push(file);
      }
    }

    // Sort orphaned by cachedAt ascending (oldest first — evict these first)
    orphaned.sort((a, b) => (a.cachedAt || 0) - (b.cachedAt || 0));

    const orphanedSize = orphaned.reduce((sum, f) => sum + (f.size || 0), 0);

    const report = {
      timestamp: Date.now(),
      storage: {
        usage: storage.usage,
        quota: storage.quota,
        percent: storage.quota > 0 ? Math.round((storage.usage / storage.quota) * 100) : 0,
      },
      files: {
        required: required.length,
        orphaned: orphaned.length,
        total: cachedFiles.length,
      },
      orphaned: orphaned.map(f => ({
        id: f.id,
        type: f.type,
        size: f.size || 0,
        cachedAt: f.cachedAt || 0,
      })),
      orphanedSize,
      evicted: [],
      threshold: this.threshold,
    };

    // Log summary
    log.info(`Storage: ${formatBytes(storage.usage)} / ${formatBytes(storage.quota)} (${report.storage.percent}%)`);
    log.info(`Cache: ${required.length} required, ${orphaned.length} orphaned (${formatBytes(orphanedSize)} reclaimable)`);

    if (orphaned.length > 0) {
      for (const f of orphaned) {
        const age = Date.now() - (f.cachedAt || 0);
        const days = Math.floor(age / 86400000);
        const hours = Math.floor((age % 86400000) / 3600000);
        const ageStr = days > 0 ? `${days}d ago` : `${hours}h ago`;
        log.info(`  Orphaned: ${f.type}/${f.id} (${formatBytes(f.size || 0)}, cached ${ageStr})`);
      }
    }

    // Evict only when storage exceeds threshold
    if (report.storage.percent > this.threshold && orphaned.length > 0) {
      log.warn(`Storage exceeds ${this.threshold}% threshold — evicting orphaned files`);
      const targetBytes = storage.usage - (storage.quota * this.threshold / 100);
      report.evicted = await this._evict(orphaned, targetBytes);
    } else {
      log.info(`No eviction needed (threshold: ${this.threshold}%)`);
    }

    return report;
  }

  /**
   * Get storage estimate from the browser.
   * Falls back to { usage: 0, quota: Infinity } in environments without the API.
   */
  async _getStorageEstimate() {
    try {
      if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
        const { usage, quota } = await navigator.storage.estimate();
        return { usage: usage || 0, quota: quota || Infinity };
      }
    } catch (e) {
      log.warn('Storage estimate unavailable:', e.message);
    }
    return { usage: 0, quota: Infinity };
  }

  /**
   * Evict orphaned files (oldest first) until targetBytes are freed.
   * Delegates deletion to StoreClient.remove() which routes to proxy.
   *
   * @param {Array} orphanedFiles - Files to evict, sorted oldest-first
   * @param {number} targetBytes - Bytes to free
   * @returns {Promise<Array>} Evicted file records
   */
  async _evict(orphanedFiles, targetBytes) {
    const toEvict = [];
    let plannedBytes = 0;

    for (const file of orphanedFiles) {
      if (plannedBytes >= targetBytes) break;
      toEvict.push(file);
      plannedBytes += file.size || 0;
    }

    if (toEvict.length === 0) return [];

    try {
      const filesToDelete = toEvict.map(f => ({ type: f.type, id: f.id }));
      await this.cache.remove(filesToDelete);

      for (const f of toEvict) {
        log.info(`  Evicted: ${f.type}/${f.id} (${formatBytes(f.size || 0)})`);
      }
      log.info(`Evicted ${toEvict.length} files, freed ${formatBytes(plannedBytes)}`);
    } catch (err) {
      log.warn('Eviction failed:', err.message);
      return [];
    }

    return toEvict.map(f => ({
      id: f.id,
      type: f.type,
      size: f.size || 0,
      cachedAt: f.cachedAt || 0,
    }));
  }
}

export { formatBytes };
