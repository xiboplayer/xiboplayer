/**
 * CacheManager - Dependant tracking and cache lifecycle
 *
 * After the storage unification, all downloads and file retrieval go through
 * the proxy's ContentStore (via StoreClient/DownloadClient). This class retains:
 * - Dependant tracking (which layouts reference which media)
 * - Cache key generation
 */

import { createLogger } from '@xiboplayer/utils';

const log = createLogger('Cache');

// Dynamic base path for multi-variant deployment (pwa, pwa-xmds, pwa-xlr)
const BASE = (typeof window !== 'undefined')
  ? window.location.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, '') || '/player/pwa'
  : '/player/pwa';

export class CacheManager {
  constructor() {
    // Dependants: mediaId → Set<layoutId> — tracks which layouts use each media file
    this.dependants = new Map();
  }

  /**
   * Get cache key for a file
   * For media, uses the actual filename; for layouts, uses the ID
   */
  getCacheKey(type, id, filename = null) {
    const key = filename || id;
    return `${BASE}/cache/${type}/${key}`;
  }

  /**
   * Track that a media file is used by a layout (dependant)
   * @param {string|number} mediaId
   * @param {string|number} layoutId
   */
  addDependant(mediaId, layoutId) {
    const key = String(mediaId);
    if (!this.dependants.has(key)) {
      this.dependants.set(key, new Set());
    }
    this.dependants.get(key).add(String(layoutId));
  }

  /**
   * Remove a layout from all dependant sets (layout removed from schedule)
   * @param {string|number} layoutId
   * @returns {string[]} Media IDs that are now orphaned (no layouts reference them)
   */
  removeLayoutDependants(layoutId) {
    const lid = String(layoutId);
    const orphaned = [];

    for (const [mediaId, layouts] of this.dependants) {
      layouts.delete(lid);
      if (layouts.size === 0) {
        this.dependants.delete(mediaId);
        orphaned.push(mediaId);
      }
    }

    if (orphaned.length > 0) {
      log.info(`${orphaned.length} media files orphaned after layout ${layoutId} removed:`, orphaned);
    }
    return orphaned;
  }

  /**
   * Check if a media file is still referenced by any layout
   * @param {string|number} mediaId
   * @returns {boolean}
   */
  isMediaReferenced(mediaId) {
    const layouts = this.dependants.get(String(mediaId));
    return layouts ? layouts.size > 0 : false;
  }

  /**
   * Clear all cached files via proxy
   */
  async clearAll() {
    this.dependants.clear();
  }
}

export const cacheManager = new CacheManager();
